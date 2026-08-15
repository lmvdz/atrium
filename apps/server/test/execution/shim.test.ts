import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ArtifactRepo,
  artifactBranchCommit,
  branchCommit,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  mainCommit,
  readFileAtBranch,
  type ScratchRepo,
  sessionBranch,
} from '../../src/execution/git.js';
import {
  MAX_QUEUED_STEERS,
  MAX_SEEN_SIGNALS,
  type SessionContext,
} from '../../src/execution/provider.js';
import {
  createDeterministicShimProvider,
  deterministicArtifact,
  EXECUTION_AWAIT_STEER_DIRECTIVE,
  EXECUTION_FAIL_DIRECTIVE,
  EXECUTION_TESTS_FAIL_DIRECTIVE,
  SHIM_ARTIFACT_PATH,
} from '../../src/execution/shim.js';

/**
 * The deterministic shim genuinely exercises the seam — the #120 gauntlet's
 * flip-the-input ask, proven here with no database in the way.
 *
 * A shim that returned a canned success would pass every wiring test above it
 * while producing nothing. These tests refuse that: a run makes a REAL git
 * branch/commit whose content is a function of the input, a different session
 * makes a different object, a failing directive makes a failed terminal and NO
 * artifact — and through all of it, trunk never moves (nothing lands itself).
 */

let repo: ScratchRepo;

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: randomUUID(),
    roomId: randomUUID(),
    planId: randomUUID(),
    harness: 'omp',
    model: 'haiku',
    ...overrides,
  };
}

beforeEach(async () => {
  repo = await createScratchRepo();
});

afterEach(async () => {
  await disposeScratchRepo(repo);
});

describe('the deterministic shim produces a real, verifiable artifact', () => {
  it('resolves an isolated worktree and commits a real branch/commit', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();

    const workspace = await provider.resolve(c);
    expect(workspace.sessionId).toBe(c.sessionId);
    expect(workspace.branch).toBe(sessionBranch(c.sessionId));
    expect(workspace.remote).toBe(repo.dir);

    const report = await provider.run(workspace, c);
    await workspace.dispose();

    // The terminal is a clean exit and the receipt carries the artifact.
    expect(report.terminal.ok).toBe(true);
    expect(report.receipt.artifact).not.toBeNull();
    const artifact = report.receipt.artifact;
    expect(artifact?.branch).toBe(sessionBranch(c.sessionId));
    expect(artifact?.remote).toBe(repo.dir);

    // The commit is REAL: the branch exists in the scratch repo and points at
    // exactly the commit the receipt names.
    const onDisk = await branchCommit(repo, sessionBranch(c.sessionId));
    expect(onDisk).toBe(artifact?.commit);

    // And its content is the deterministic artifact for this exact input.
    // (`readFileAtBranch` trims, as all the git plumbing does.)
    const body = await readFileAtBranch(repo, sessionBranch(c.sessionId), SHIM_ARTIFACT_PATH);
    expect(body).toBe(deterministicArtifact(c));

    // The commit is a real CHILD of trunk, not trunk itself.
    expect(artifact?.commit).not.toBe(repo.seedCommit);
  });

  it('flips the input: a different session yields a different artifact', async () => {
    const provider = createDeterministicShimProvider({ repo });
    // Two distinct sessions, run to two distinct branches.
    const c1 = ctx();
    const c2 = ctx();
    const r1 = await provider.run(await provider.resolve(c1), c1);
    const r2 = await provider.run(await provider.resolve(c2), c2);

    expect(r1.receipt.artifact?.branch).not.toBe(r2.receipt.artifact?.branch);
    // Different input, different object — the shim read its input, it did not
    // return a constant.
    expect(r1.receipt.artifact?.commit).not.toBe(r2.receipt.artifact?.commit);
    const body1 = await readFileAtBranch(repo, sessionBranch(c1.sessionId), SHIM_ARTIFACT_PATH);
    const body2 = await readFileAtBranch(repo, sessionBranch(c2.sessionId), SHIM_ARTIFACT_PATH);
    expect(body1).not.toBe(body2);
  });

  it('flips the input: the fail directive produces a failed terminal and NO artifact', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx({ model: EXECUTION_FAIL_DIRECTIVE });

    const workspace = await provider.resolve(c);
    const report = await provider.run(workspace, c);
    await workspace.dispose();

    expect(report.terminal.ok).toBe(false);
    expect(report.receipt.artifact).toBeNull();
    // The worktree branch exists (worktree-add forks it off trunk) but carries
    // NO artifact commit — it still points at the seed. A failed harness produced
    // no verifiable object at all.
    expect(await branchCommit(repo, sessionBranch(c.sessionId))).toBe(repo.seedCommit);
  });

  it('pushes to a DURABLE artifact repo that outlives the scratch repo (#120 F3)', async () => {
    let artifactRepo: ArtifactRepo;
    let durableDir: string;
    // A durable repo on its OWN path, unrelated to the scratch working repo.
    durableDir = await mkdtemp(join(tmpdir(), 'atrium-durable-'));
    artifactRepo = await createArtifactRepo(durableDir);
    try {
      const provider = createDeterministicShimProvider({ repo, artifactRepo });
      const c = ctx();
      const workspace = await provider.resolve(c);
      const report = await provider.run(workspace, c);
      const artifact = report.receipt.artifact;

      // The receipt points at the DURABLE remote, not the scratch working repo.
      expect(artifact?.remote).toBe(durableDir);
      expect(artifact?.branch).toBe(sessionBranch(c.sessionId));

      // Dispose the checkout AND tear the whole scratch working repo down — as a
      // shutdown would (`disposeScratchRepo`). The receipt must STILL resolve.
      await workspace.dispose();
      await disposeScratchRepo(repo);

      const resolved = await artifactBranchCommit(artifactRepo, sessionBranch(c.sessionId));
      expect(resolved).toBe(artifact?.commit);
      // The scratch repo is gone; the durable object remains. Revert F3 (drop the
      // push, point the artifact at the scratch repo) and this reds — the receipt
      // names a branch in a repo that no longer exists.
      expect(resolved).not.toBeNull();

      // Re-seed `repo` so the afterEach dispose is a no-op-safe teardown.
      repo = await createScratchRepo();
    } finally {
      await rm(durableDir, { recursive: true, force: true });
    }
  });

  it('carries the REAL structured diff and a test report on the receipt (#145)', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    const report = await provider.run(await provider.resolve(c), c);

    const artifact = report.receipt.artifact;
    // The diff is PRESENT and non-empty — the shim produced a real commit.
    expect(artifact?.diff).toBeDefined();
    expect(artifact?.diff?.files.length).toBeGreaterThan(0);
    const added = artifact?.diff?.files.find((f) => f.path === SHIM_ARTIFACT_PATH);
    expect(added?.status).toBe('added');
    // The hunk carries the EXACT content — the session id is inside ARTIFACT.json,
    // so a stubbed constant diff would not contain it.
    const body = (added?.hunks ?? []).flatMap((h) => h.lines).join('\n');
    expect(body).toContain(c.sessionId);

    // The test report is present; the clean run is all-passing and carries its
    // command provenance (#145 r2, FIX 2) — the pane renders it as a reported ~ fact.
    expect(artifact?.tests).toEqual({
      passed: 3,
      failed: 0,
      failures: [],
      failuresTruncated: false,
      command: 'atrium deterministic shim — fixture suite (no external runner)',
    });
  });

  it('streams a scripted, session-derived progress sequence, and flips the input (#159)', async () => {
    const provider = createDeterministicShimProvider({ repo });
    // Capture what the run reports through the live-progress seam.
    const capture = () => {
      const reports: import('../../src/execution/provider.js').ProgressReport[] = [];
      const onProgress = async (
        report: import('../../src/execution/provider.js').ProgressReport,
      ) => {
        reports.push(report);
      };
      return { reports, onProgress };
    };

    const a = capture();
    const c1 = ctx({ onProgress: a.onProgress });
    await provider.run(await provider.resolve(c1), c1);

    // The scripted phase timeline marches through all three phases, a heartbeat is
    // reported, and a diff delta is emitted — the whole producer vocabulary.
    const phases = a.reports.flatMap((r) => (r.phase ? [r.phase] : []));
    expect(phases).toEqual(['planning', 'writing', 'testing']);
    expect(a.reports.some((r) => r.heartbeat !== undefined)).toBe(true);
    const delta1 = a.reports.find((r) => r.diffDelta !== undefined)?.diffDelta;
    expect(delta1?.files.length).toBeGreaterThan(0);
    // The diff delta is DERIVED from the real diff — the session id is inside the
    // artifact the run committed, so it shows up in the streamed hunk. A stubbed
    // constant would not carry it. This is the flip-the-input witness on the stream.
    const streamed1 = (delta1?.files ?? []).flatMap((f) => f.hunk?.lines ?? []).join('\n');
    expect(streamed1).toContain(c1.sessionId);

    // Flip the input: a DIFFERENT session streams a different diff — the streamed
    // hunk carries the new session id, never the old one.
    const b = capture();
    const c2 = ctx({ onProgress: b.onProgress });
    await provider.run(await provider.resolve(c2), c2);
    const streamed2 = (b.reports.find((r) => r.diffDelta)?.diffDelta?.files ?? [])
      .flatMap((f) => f.hunk?.lines ?? [])
      .join('\n');
    expect(streamed2).toContain(c2.sessionId);
    expect(streamed2).not.toContain(c1.sessionId);
  });

  it('flips the input on TESTS: the tests-fail directive settles clean but reports a failure', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const pass = ctx();
    const fail = ctx({ model: EXECUTION_TESTS_FAIL_DIRECTIVE });
    const rp = await provider.run(await provider.resolve(pass), pass);
    const rf = await provider.run(await provider.resolve(fail), fail);

    // The tests-fail directive still SETTLES (a real artifact + diff) — the work
    // exists; its tests failed, which the human must see before certifying.
    expect(rf.terminal.ok).toBe(true);
    expect(rf.receipt.artifact?.diff?.files.length).toBeGreaterThan(0);

    // Flip-the-input: the rendered test summary moves with the directive.
    expect(rp.receipt.artifact?.tests?.failed).toBe(0);
    expect(rf.receipt.artifact?.tests?.failed).toBe(1);
    expect(rf.receipt.artifact?.tests?.failures.length).toBe(1);
  });

  it('never moves trunk — no artifact lands itself (the covenant, in git)', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const before = await mainCommit(repo);

    for (let i = 0; i < 3; i++) {
      const c = ctx();
      const workspace = await provider.resolve(c);
      await provider.run(workspace, c);
      await workspace.dispose();
    }

    // Three sessions ran, three branches exist — and `main` is byte-identical to
    // the seed. Nothing merged, nothing fast-forwarded: the land is a human `✓`,
    // never the adapter.
    expect(await mainCommit(repo)).toBe(before);
    expect(before).toBe(repo.seedCommit);
  });
});

/**
 * Delivery of already-authorized signals into a running shim (#147). The shim is
 * the deterministic path, so these prove the observable behaviour with no database
 * and no coordinator in the way: a steer's text lands in the next-turn artifact, an
 * interrupt makes the run terminal with no artifact, and a signal for a session the
 * shim is not running is a safe no-op. #127 already authorized every row; delivery
 * only makes it REACH the harness.
 */
describe('the shim delivers already-authorized signals to a running session (#147)', () => {
  it('queues a steer at the turn boundary and its text lands in the artifact', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    const workspace = await provider.resolve(c);

    // The mailbox exists from `resolve`, so a steer delivered before the run reaches
    // its turn boundary is queued, not dropped.
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'prefer the smaller diff',
    });
    expect(outcome).toEqual({ kind: 'delivered' });

    const report = await provider.run(workspace, c);
    await workspace.dispose();

    expect(report.terminal.ok).toBe(true);
    const body = await readFileAtBranch(repo, sessionBranch(c.sessionId), SHIM_ARTIFACT_PATH);
    // The steer is observable in the next-turn artifact. RED-ON-REVERT: drop the
    // `steers` argument from `deterministicArtifact(ctx, steers)` in run() — the
    // artifact reverts to the unsteered encoding and this line reds.
    expect(body).toBe(deterministicArtifact(c, ['prefer the smaller diff']));
    expect(body).toContain('prefer the smaller diff');
    // The receipt carries it too — the review pane reads the exit summary.
    expect(report.receipt.exitSummary).toContain('prefer the smaller diff');
  });

  it('flips the input: a different steer yields a different steered artifact', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const a = ctx();
    const b = ctx();
    const wa = await provider.resolve(a);
    const wb = await provider.resolve(b);
    await provider.deliver({
      sessionId: a.sessionId,
      roomId: a.roomId,
      kind: 'steer',
      body: 'alpha',
    });
    await provider.deliver({
      sessionId: b.sessionId,
      roomId: b.roomId,
      kind: 'steer',
      body: 'beta',
    });
    await provider.run(wa, a);
    await provider.run(wb, b);

    const bodyA = await readFileAtBranch(repo, sessionBranch(a.sessionId), SHIM_ARTIFACT_PATH);
    const bodyB = await readFileAtBranch(repo, sessionBranch(b.sessionId), SHIM_ARTIFACT_PATH);
    // The delivered content DRIVES the output — not a constant, not the other
    // session's steer. Change the steer, change the artifact.
    expect(bodyA).toContain('alpha');
    expect(bodyA).not.toContain('beta');
    expect(bodyB).toContain('beta');
    expect(bodyB).not.toContain('alpha');
  });

  it('delivers a steer to a PARKED run (await directive) and it lands, then settles', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx({ model: EXECUTION_AWAIT_STEER_DIRECTIVE });
    const workspace = await provider.resolve(c);

    // Start the run: it PARKS at its open turn boundary until a signal arrives. The
    // deliver-during-run window the coordinator's resolve→run leaves no room for
    // otherwise.
    const runP = provider.run(workspace, c);
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'ship it',
    });
    expect(outcome).toEqual({ kind: 'delivered' });

    const report = await runP;
    await workspace.dispose();
    expect(report.terminal.ok).toBe(true);
    const body = await readFileAtBranch(repo, sessionBranch(c.sessionId), SHIM_ARTIFACT_PATH);
    expect(body).toContain('ship it');
  });

  it('an interrupt terminates the run with a failed terminal and NO artifact', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    const workspace = await provider.resolve(c);

    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: 'stop',
    });
    expect(outcome).toEqual({ kind: 'interrupted' });

    const report = await provider.run(workspace, c);
    await workspace.dispose();

    // RED-ON-REVERT: remove the `if (mailbox.interrupted)` early return in run() and
    // this reds — an interrupted session would settle cleanly WITH an artifact.
    expect(report.terminal.ok).toBe(false);
    expect(report.receipt.artifact).toBeNull();
    // An interrupt certifies nothing: the branch never advanced past trunk.
    expect(await branchCommit(repo, sessionBranch(c.sessionId))).toBe(repo.seedCommit);
  });

  it('interrupts a PARKED run promptly (await directive)', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx({ model: EXECUTION_AWAIT_STEER_DIRECTIVE });
    const workspace = await provider.resolve(c);
    const runP = provider.run(workspace, c);
    await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: null,
    });
    const report = await runP;
    await workspace.dispose();
    expect(report.terminal.ok).toBe(false);
    expect(report.receipt.artifact).toBeNull();
  });

  it('a signal for a session the shim is not running is a safe no-op, never a throw', async () => {
    const provider = createDeterministicShimProvider({ repo });
    // No `resolve` for this session — the shim is not running it.
    const steer = await provider.deliver({
      sessionId: randomUUID(),
      roomId: randomUUID(),
      kind: 'steer',
      body: 'nobody home',
    });
    const interrupt = await provider.deliver({
      sessionId: randomUUID(),
      roomId: randomUUID(),
      kind: 'interrupt',
      body: null,
    });
    // RED-ON-REVERT: drop the `if (!mailbox) return not-running` guard in deliver()
    // and the steer path throws on `undefined.steers` instead of no-opping.
    expect(steer).toEqual({ kind: 'ignored', reason: 'not-running' });
    expect(interrupt).toEqual({ kind: 'ignored', reason: 'not-running' });
  });

  it('a resume is the daemon’s wake, not a run mutation — an explicit no-op', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    const workspace = await provider.resolve(c);
    // A resume is `ignored: resume-noop` EVEN for a session the shim is running:
    // waking is opening a fresh run (the daemon's job), not steering this one.
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'resume',
      body: null,
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'resume-noop' });

    // And the run is unaffected — a clean, unsteered artifact.
    await provider.run(workspace, c);
    await workspace.dispose();
    const body = await readFileAtBranch(repo, sessionBranch(c.sessionId), SHIM_ARTIFACT_PATH);
    expect(body).toBe(deterministicArtifact(c));
  });

  // ── FIX 3 (#147): a steer delivered DURING the resolve window (before resolve's
  // awaited `addWorktree` finishes) is applied, not dropped. The mailbox is
  // registered in resolve's synchronous prefix. RED-ON-REVERT: move the
  // `mailboxes.set(...)` back below `addWorktree` in `resolve` and this steer
  // returns `not-running` (dropped) — the artifact reverts to the unsteered bytes.
  it('a steer delivered in the resolve window lands in the artifact, not dropped', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    // Start resolve but DO NOT await — deliver synchronously, inside the window.
    const resolveP = provider.resolve(c);
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'window-steer',
      signalId: 'w1',
    });
    expect(outcome).toEqual({ kind: 'delivered' });

    const workspace = await resolveP;
    await provider.run(workspace, c);
    await workspace.dispose();
    const body = await readFileAtBranch(repo, sessionBranch(c.sessionId), SHIM_ARTIFACT_PATH);
    expect(body).toBe(deterministicArtifact(c, ['window-steer']));
  });

  // ── FIX 5 (#147): a redelivered signal id is deduped — the steer is drained once.
  // RED-ON-REVERT: drop the `mailbox.seen` guard in deliver() and the artifact
  // carries the steer twice.
  it('dedups a redelivered signal id — the steer lands exactly once', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    const workspace = await provider.resolve(c);
    const first = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'once',
      signalId: 'dup-1',
    });
    const second = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'the-retry',
      signalId: 'dup-1',
    });
    expect(first).toEqual({ kind: 'delivered' });
    expect(second).toEqual({ kind: 'ignored', reason: 'duplicate' });

    await provider.run(workspace, c);
    await workspace.dispose();
    const body = await readFileAtBranch(repo, sessionBranch(c.sessionId), SHIM_ARTIFACT_PATH);
    // Queued once: the artifact is the single-steer encoding, not two.
    expect(body).toBe(deterministicArtifact(c, ['once']));
  });

  // ── FIX 5 (#147): the steer queue is BOUNDED. Beyond the cap a steer is dropped
  // with `queue-full`, never an unbounded array append.
  it('bounds the steer queue at the cap and refuses the overflow honestly', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    await provider.resolve(c);
    for (let i = 0; i < MAX_QUEUED_STEERS; i += 1) {
      const outcome = await provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'steer',
        body: `steer-${i}`,
        signalId: `flood-${i}`,
      });
      expect(outcome).toEqual({ kind: 'delivered' });
    }
    const overflow = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'one-too-many',
      signalId: 'flood-overflow',
    });
    expect(overflow).toEqual({ kind: 'ignored', reason: 'queue-full' });
  });

  // ── FIX C part 1 (#147 completing round): a signal id is recorded in `seen` ONLY
  // after its signal is APPLIED. A steer dropped as `queue-full` must NOT be
  // remembered — otherwise a legitimate retry of the SAME id reads as a `duplicate`
  // (already handled) and is silently lost, when it should still be a fresh, honest
  // `queue-full` the caller can act on. RED-ON-REVERT: move `seen.add(signalId)` back
  // ABOVE the queue-cap check in `applyDelivery` and the retry returns `duplicate`.
  it('does not remember a queue-full steer as seen — a retry is queue-full, not duplicate', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    await provider.resolve(c);
    for (let i = 0; i < MAX_QUEUED_STEERS; i += 1) {
      await provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'steer',
        body: `steer-${i}`,
        signalId: `fill-${i}`,
      });
    }
    // This id is dropped (queue-full) — it must not be marked seen.
    const dropped = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'dropped',
      signalId: 'retry-me',
    });
    expect(dropped).toEqual({ kind: 'ignored', reason: 'queue-full' });
    // The at-least-once dispatcher retries the SAME id. It is a fresh refusal
    // (queue-full), NOT a phantom duplicate — the signal was never applied.
    const retry = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'dropped',
      signalId: 'retry-me',
    });
    expect(retry).toEqual({ kind: 'ignored', reason: 'queue-full' });
  });

  // ── FIX C part 2 (#147 completing round): the `seen` dedup set is LRU-BOUNDED at
  // `MAX_SEEN_SIGNALS`, so a long-lived session cannot grow it without limit. Applied
  // signals past the cap EVICT the oldest id; a redelivery of an evicted id is no
  // longer deduped (it re-applies), while a still-recent id is. Interrupts are used
  // to fill the set because they are not bounded by the steer-queue cap. RED-ON-REVERT:
  // drop the eviction loop in `rememberAppliedSignal` and the evicted-oldest id reads
  // as `duplicate` instead of re-applying.
  it('bounds the seen set — the oldest applied id is evicted and re-applies', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    await provider.resolve(c);
    // Apply MAX_SEEN_SIGNALS + 1 unique-id interrupts: the (cap+1)th evicts the first.
    for (let i = 0; i <= MAX_SEEN_SIGNALS; i += 1) {
      await provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'interrupt',
        body: null,
        signalId: `evict-${i}`,
      });
    }
    // The oldest id (`evict-0`) was evicted, so its redelivery is NOT a duplicate —
    // it re-applies (the LRU forgot it, honestly bounding memory).
    const evicted = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: null,
      signalId: 'evict-0',
    });
    expect(evicted).toEqual({ kind: 'interrupted' });
    // A still-recent id is still remembered — dedup within the window is intact.
    const recent = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: null,
      signalId: `evict-${MAX_SEEN_SIGNALS}`,
    });
    expect(recent).toEqual({ kind: 'ignored', reason: 'duplicate' });
  });

  // ── FIX D (#147 completing round): if `resolve` THROWS after the mailbox is
  // registered in its synchronous prefix (FIX 3), the mailbox must be UNREGISTERED —
  // otherwise a later `deliver` acks (`delivered`/`interrupted`) into a session that
  // never ran. A signal after a failed resolve is `not-running`, an honest no-op.
  // RED-ON-REVERT: drop the `try/catch` around `addWorktree` in `resolve` and the
  // steer below returns `delivered` — a false ack into a dead session.
  it('a resolve that throws unregisters the mailbox — a later signal is not-running', async () => {
    const deadRepo = await createScratchRepo();
    const provider = createDeterministicShimProvider({ repo: deadRepo });
    const c = ctx();
    // Dispose the scratch repo out from under resolve, so `addWorktree` throws.
    await disposeScratchRepo(deadRepo);
    await expect(provider.resolve(c)).rejects.toThrow();
    // The mailbox from the sync prefix was cleaned up: delivery finds no session.
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'into-the-void',
      signalId: 'd1',
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'not-running' });
  });

  // ── SERIALIZATION (#147 completing round): concurrent deliveries for one session
  // run atomically — a same-id flood delivered concurrently applies EXACTLY ONCE
  // (one `delivered`, the rest `duplicate`), and a concurrent steer flood past the
  // cap yields exactly `MAX_QUEUED_STEERS` delivered with no double-apply.
  it('serializes concurrent deliveries — cap holds and no double-apply', async () => {
    const provider = createDeterministicShimProvider({ repo });
    const c = ctx();
    const ws = await provider.resolve(c);
    // A same-id pair delivered concurrently applies exactly once.
    const [a, b] = await Promise.all([
      provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'steer',
        body: 'same',
        signalId: 'same-id',
      }),
      provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'steer',
        body: 'same',
        signalId: 'same-id',
      }),
    ]);
    expect([a, b]).toContainEqual({ kind: 'delivered' });
    expect([a, b]).toContainEqual({ kind: 'ignored', reason: 'duplicate' });

    // A concurrent flood of DISTINCT ids, cap + 6 (minus the one already queued):
    // exactly the cap is queued in total, the rest are queue-full — no double-apply.
    const flood = await Promise.all(
      Array.from({ length: MAX_QUEUED_STEERS + 6 }, (_, i) =>
        provider.deliver({
          sessionId: c.sessionId,
          roomId: c.roomId,
          kind: 'steer',
          body: `c-${i}`,
          signalId: `conc-${i}`,
        }),
      ),
    );
    const delivered = flood.filter((o) => o.kind === 'delivered').length;
    const full = flood.filter((o) => o.kind === 'ignored' && o.reason === 'queue-full').length;
    // One slot was taken by 'same-id' above, so the flood fills the remaining cap-1.
    expect(delivered).toBe(MAX_QUEUED_STEERS - 1);
    expect(full).toBe(7);

    await ws.dispose();
  });
});
