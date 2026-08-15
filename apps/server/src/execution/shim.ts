import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionTestResults } from '@atrium/db';
import {
  type ArtifactRepo,
  addWorktree,
  assertArtifactRemoteIsNotUpstream,
  assertAuthenticRunCheckout,
  commitWorktree,
  diffWorktree,
  pushArtifactBranch,
  removeWorktree,
  type ScratchRepo,
  type WorktreeCheckout,
} from './git.js';
import {
  type DeliveryOutcome,
  type ExecutionProvider,
  type ExecutionReport,
  MAX_QUEUED_STEERS,
  type SessionContext,
  type SignalDelivery,
  type Workspace,
} from './provider.js';

/**
 * The deterministic shim (#120) — the DEFAULT provider under test.
 *
 * It resolves a real git worktree and produces a real branch/commit, exactly as
 * a real adapter does, but its "harness" is a FIXED, in-process routine rather
 * than a spawned command or a model: no network, no clock, no randomness. The
 * same session context in yields the same artifact out. That determinism is the
 * whole reason it is the tested path — a real sandbox is Atrium's differentiation
 * (`sandbox.ts`), but it is not what a verification gate can depend on.
 *
 * ## Flip-the-input, so the shim is not ornament (the #120 gauntlet's ask)
 *
 * The artifact CONTENT is derived from the session context — the file it writes
 * names the session, plan, harness and model — so two different sessions produce
 * two byte-different commits. The REAL DIFF it reports (#145) is computed from that
 * commit against trunk, so it moves with the content too — a stubbed constant would
 * fail the flip-the-input test. And the TERMINAL is driven by input: a session
 * whose model directive is `EXECUTION_FAIL_DIRECTIVE` exits `ok: false` with no
 * artifact, and `EXECUTION_TESTS_FAIL_DIRECTIVE` settles cleanly but reports a
 * failing test so the TESTS render moves too. Change the input and the output
 * moves; that is what proves the seam is genuinely exercised, not a canned success.
 */

/**
 * The reserved model directive that makes the deterministic harness FAIL. It is
 * a session-context input, so the "a failing harness → session_failed" arm of
 * the acceptance test flips exactly one field and asserts the terminal moved —
 * the shim is reading its input, not returning a constant.
 */
export const EXECUTION_FAIL_DIRECTIVE = '__atrium_shim_fail__';

/**
 * The reserved model directive that makes the deterministic harness settle CLEANLY
 * but report FAILING tests (#145). It is a session-context input, so the
 * flip-the-input witness on the TESTS render changes exactly one field: the default
 * clean run reports all-passing, this one reports a failure with a named test, and
 * the rendered pass/fail summary moves. The work still exists (a branch/commit,
 * a real diff) — a settled session whose tests failed is exactly what the review
 * pane must show a human BEFORE they certify, not hide.
 */
export const EXECUTION_TESTS_FAIL_DIRECTIVE = '__atrium_shim_tests_fail__';

/**
 * The reserved model directive that makes the deterministic harness PARK at one
 * open turn boundary, awaiting a delivered signal (#147). It models a real harness
 * that pauses between turns for the next instruction, and it is what makes STEER
 * and INTERRUPT delivery deterministically testable through the coordinator's
 * `resolve → run` (which leaves no window to inject a signal otherwise):
 *
 *  - a `steer` delivered while parked is queued, incorporated into THIS run's
 *    artifact, and the run then concludes cleanly — the steer's text is observable
 *    on the next-turn artifact (and flip-the-input: change the steer, the artifact
 *    moves);
 *  - an `interrupt` delivered while parked terminates the run at the boundary with
 *    a failed terminal and NO artifact.
 *
 * A backstop deadline keeps a parked run that is never signalled from hanging
 * forever (production never sets this directive; tests always deliver well inside
 * the deadline, so it never gates their timing). The default (no directive) path
 * is unchanged and immediate: it drains any already-queued steer at its boundary
 * and concludes, so a steer delivered BEFORE `run` still lands with zero waiting.
 */
export const EXECUTION_AWAIT_STEER_DIRECTIVE = '__atrium_shim_await_steer__';

/** How long a parked run waits for a signal before concluding on its own (#147). */
const AWAIT_STEER_BACKSTOP_MS = 10_000;

/** The file the fake harness writes — the artifact's payload, on the branch. */
export const SHIM_ARTIFACT_PATH = 'ARTIFACT.json';

/**
 * The deterministic harness's own test report (#145). The shim is a fixed
 * in-process stand-in, so its "suite" is fixed too: the clean run reports a small
 * all-passing suite, and the reserved `EXECUTION_TESTS_FAIL_DIRECTIVE` reports one
 * named failure. Honest by construction — it is what THIS harness's run reported,
 * the same way the shim's artifact content is a pure function of its input.
 */
export function deterministicTestResults(ctx: SessionContext): SessionTestResults {
  // The provenance of these numbers (#145 r2, FIX 2): the shim runs no external
  // runner, so its command names the fixture suite honestly rather than pretending
  // a `pnpm test` ran. The pane renders it beside the `~` reported marker.
  const command = 'atrium deterministic shim — fixture suite (no external runner)';
  if (ctx.model === EXECUTION_TESTS_FAIL_DIRECTIVE) {
    return {
      passed: 2,
      failed: 1,
      failures: ['the deterministic fixture suite reports a failing test'],
      failuresTruncated: false,
      command,
    };
  }
  return { passed: 3, failed: 0, failures: [], failuresTruncated: false, command };
}

export interface DeterministicShimOptions {
  /** The scratch repo the shim controls — where every per-session worktree lands. */
  repo: ScratchRepo;
  /**
   * The DURABLE artifact repo the session branch is pushed to (#120 F3). Present,
   * the artifact's `remote` is this repo (survives shutdown); absent, it points
   * at the scratch repo (test behaviour, not durable).
   */
  artifactRepo?: ArtifactRepo;
}

interface ShimWorkspace extends Workspace {
  readonly checkout: WorktreeCheckout;
}

/**
 * THE PER-SESSION SIGNAL MAILBOX (#147). One per in-flight shim run, created at
 * the START of `resolve` (before its awaited work, #147 FIX 3) and removed when the
 * workspace is disposed. `deliver` posts into it; the run drains it at its turn
 * boundary. It is the whole of what makes a delivered steer observable and an
 * interrupt promptly terminal in a purely in-process harness.
 *
 * The SHIM enforces the turn boundary itself (#147 FIX 4): it is a deterministic
 * in-process harness that drains `steers` at a boundary it controls, so "queued to
 * the next boundary, never mid-token" is a genuine provider guarantee here — unlike
 * the worktree, which can only DELIVER to an inbox a foreign harness reads on its
 * own schedule.
 */
interface ShimMailbox {
  /** Steer bodies queued for the next turn boundary, in delivery order (capped). */
  readonly steers: string[];
  /** Set by a delivered interrupt — checked at every boundary. */
  interrupted: boolean;
  /** Armed by a parked run (the await directive); a delivery resolves it. */
  wake: (() => void) | null;
  /**
   * Signal ids already delivered to this session (#147 FIX 5). A redelivered id —
   * #139's at-least-once dispatch retrying — is ignored so a steer queues once and
   * an interrupt latches once. Ids without a `signalId` are never deduped.
   */
  readonly seen: Set<string>;
}

/**
 * Build the deterministic shim provider over a scratch repo.
 *
 * `resolve` adds a per-session worktree; `run` writes the deterministic artifact
 * file, commits it onto the session branch, and reports terminal + receipt. On
 * the fail directive it writes nothing, commits nothing, and reports a failed
 * terminal — so trunk AND the session branch both stay empty of an artifact,
 * which the covenant proof reads as "no autonomous land, and nothing to land".
 */
export function createDeterministicShimProvider(
  options: DeterministicShimOptions,
): ExecutionProvider {
  const { repo, artifactRepo } = options;
  // THE UPSTREAM IS NEVER WRITTEN, provider layer (#141). Binds on the shim too:
  // real-repo mode is a property of the SCRATCH REPO, so whichever provider is
  // handed a seeded one inherits the obligation.
  assertArtifactRemoteIsNotUpstream(repo, artifactRepo);

  // In-flight mailboxes, keyed by session id (#147). A `deliver` for a session not
  // in this map is a safe no-op (`not-running`): another coordinator may run it.
  const mailboxes = new Map<string, ShimMailbox>();

  /**
   * Park the run at one turn boundary until a signal arrives (the await directive),
   * or the backstop deadline lapses. Resolves as soon as `deliver` posts — either
   * a steer (queued in `mailbox.steers`) or an interrupt (`mailbox.interrupted`).
   */
  function awaitSignalAtBoundary(mailbox: ShimMailbox): Promise<void> {
    if (mailbox.interrupted || mailbox.steers.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        mailbox.wake = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, AWAIT_STEER_BACKSTOP_MS);
      mailbox.wake = done;
    });
  }

  return {
    kind: 'shim',

    async resolve(ctx: SessionContext): Promise<Workspace> {
      // Register the mailbox FIRST, before any awaited work (#147 FIX 3). `resolve`
      // awaits `addWorktree`; a signal that arrives during THAT window used to hit
      // no mailbox and be dropped as `not-running` (never retried). Registering at
      // the very start of resolve — the synchronous prefix that runs before the
      // first await — closes the window: a steer/interrupt in it is queued/latched
      // and applied at the boundary. Revert this to after `addWorktree` and an
      // in-window signal is dropped.
      mailboxes.set(ctx.sessionId, {
        steers: [],
        interrupted: false,
        wake: null,
        seen: new Set<string>(),
      });
      const checkout = await addWorktree(repo, ctx.sessionId);
      const workspace: ShimWorkspace = {
        sessionId: ctx.sessionId,
        dir: checkout.dir,
        branch: checkout.branch,
        remote: artifactRepo?.dir ?? repo.dir,
        checkout,
        dispose: async () => {
          mailboxes.delete(ctx.sessionId);
          await removeWorktree(checkout);
        },
      };
      return workspace;
    },

    async run(workspace: Workspace, ctx: SessionContext): Promise<ExecutionReport> {
      const checkout = (workspace as ShimWorkspace).checkout;
      // BRAND GATE (#141 r7): the write below is `writeFile(checkout.dir, …)`, a
      // filesystem mutation that runs before `commitWorktree`'s own brand gate. A
      // forged workspace whose checkout.dir is the upstream would drop ARTIFACT.json
      // into it. Verified here, before checkout.dir points a write.
      assertAuthenticRunCheckout(checkout);
      const shouldFail = ctx.model === EXECUTION_FAIL_DIRECTIVE;

      if (shouldFail) {
        // The failing harness: no file, no commit, no artifact. The exit is a
        // failure owed triage (§9.5), and the receipt says why.
        return {
          terminal: { ok: false, exitCode: 1, detail: 'harness reported a non-clean exit' },
          receipt: {
            exitSummary: `deterministic shim: harness for session ${ctx.sessionId} failed`,
            spendMicros: 0,
            contextPct: null,
            artifact: null,
          },
        };
      }

      // THE TURN BOUNDARY (#147). The mailbox exists (set at resolve). If the await
      // directive is set, PARK here until a signal is delivered; either way, drain
      // whatever steers are queued and honour an interrupt. A steer delivered
      // BEFORE run (the fast path) is already in `steers` and lands with no wait.
      const mailbox = mailboxes.get(ctx.sessionId) ?? {
        steers: [],
        interrupted: false,
        wake: null,
        seen: new Set<string>(),
      };
      if (ctx.model === EXECUTION_AWAIT_STEER_DIRECTIVE) {
        await awaitSignalAtBoundary(mailbox);
      }
      if (mailbox.interrupted) {
        // An interrupt reached the boundary: terminate promptly, no artifact. The
        // coordinator settles this as `session_failed` — delivery certified nothing.
        return {
          terminal: { ok: false, exitCode: null, detail: 'interrupted by a delivered signal' },
          receipt: {
            exitSummary: `deterministic shim: session ${ctx.sessionId} interrupted`,
            spendMicros: 0,
            contextPct: null,
            artifact: null,
          },
        };
      }
      // Consume the queued steers into this turn — they become part of the artifact.
      const steers = mailbox.steers.splice(0, mailbox.steers.length);

      // The clean harness: write the deterministic artifact, commit it onto the
      // session branch. The content is a pure function of the context (plus any
      // delivered steers), so the commit is reproducible and flip-the-input — a
      // different session OR a different steer — visibly changes it.
      const artifactBody = deterministicArtifact(ctx, steers);
      await writeFile(join(checkout.dir, SHIM_ARTIFACT_PATH), `${artifactBody}\n`);
      const commit = await commitWorktree(
        checkout,
        `session ${ctx.sessionId}: ${ctx.harness}/${ctx.model} settled`,
      );

      if (commit === null) {
        // Defensive: the write above always dirties the tree, so this is
        // unreachable in practice — but a run that produced no object is a
        // failure, not a settle claiming an artifact it does not have.
        return {
          terminal: { ok: false, exitCode: 1, detail: 'harness produced no artifact' },
          receipt: {
            exitSummary: `deterministic shim: session ${ctx.sessionId} produced no commit`,
            spendMicros: 0,
            contextPct: null,
            artifact: null,
          },
        };
      }

      // THE REAL STRUCTURED DIFF (#145): compute the actual git diff of this
      // scratch worktree against the ref it forked from (`main` — in real-repo mode
      // #141 the seeded upstream commit). It carries the exact hunks the review pane
      // renders. Computed from the checkout BEFORE it is disposed, and reported as a
      // fact ALONGSIDE the verified branch/commit. Flip the input (a different
      // session, a different fixture edit) and these hunks move — a stubbed constant
      // fails the shim's flip-the-input test. The test results are the harness's own
      // report, deterministic here.
      const diff = await diffWorktree(checkout);
      const tests = deterministicTestResults(ctx);

      // Push the branch to the DURABLE artifact repo so the receipt resolves
      // after shutdown (#120 F3); the reported commit is the one the durable ref
      // points at. Absent a durable repo, the artifact stays on the scratch repo.
      let remote = repo.dir;
      let durableCommit = commit;
      if (artifactRepo) {
        durableCommit = await pushArtifactBranch(checkout, artifactRepo);
        remote = artifactRepo.dir;
      }

      return {
        terminal: { ok: true, exitCode: 0 },
        receipt: {
          exitSummary:
            `deterministic shim: session ${ctx.sessionId} settled on ${checkout.branch}` +
            // Surface delivered steers on the receipt too, not only in the artifact
            // (#147) — the review pane reads the exit summary, and a steer that
            // shaped the run is part of what a human sees before certifying.
            (steers.length > 0 ? ` after steering: ${steers.join(' · ')}` : ''),
          spendMicros: 0,
          contextPct: null,
          artifact: { branch: checkout.branch, commit: durableCommit, remote, diff, tests },
        },
      };
    },

    // Nothing to cancel (#120 round-7 F4): the shim's "harness" is a synchronous
    // in-process routine — it spawns no child and holds no remote sandbox, so a
    // `run` is either not started or already returned. The seam still answers the
    // question, it just has nothing to kill.
    async cancelAll(): Promise<void> {},

    // DELIVER an already-authorized signal to a parked/in-flight run (#147). The
    // mailbox exists only while a run is resolved-and-not-yet-returned, so a signal
    // for any other session is `not-running` — the safe no-op. Delivery writes
    // NOTHING durable: a steer only queues text, an interrupt only flags the run to
    // terminate (the coordinator writes the `session_failed` receipt), and a resume
    // is the daemon's wake, not a mutation of a run already in flight.
    async deliver(delivery: SignalDelivery): Promise<DeliveryOutcome> {
      if (delivery.kind === 'resume') return { kind: 'ignored', reason: 'resume-noop' };
      const mailbox = mailboxes.get(delivery.sessionId);
      if (!mailbox) return { kind: 'ignored', reason: 'not-running' };
      // DEDUP (#147 FIX 5): a redelivered signal id — #139's at-least-once dispatch
      // retrying — is ignored, so a steer queues once and an interrupt latches once.
      // Deliveries without a durable id are never deduped (each is distinct).
      if (delivery.signalId !== undefined) {
        if (mailbox.seen.has(delivery.signalId)) return { kind: 'ignored', reason: 'duplicate' };
        mailbox.seen.add(delivery.signalId);
      }
      if (delivery.kind === 'interrupt') {
        mailbox.interrupted = true;
        mailbox.wake?.();
        return { kind: 'interrupted' };
      }
      // steer: queue the guidance for the next turn boundary, never mid-token. BOUND
      // the queue (#147 FIX 5): at the cap the steer is dropped, not appended, and
      // the outcome says so — an unbounded producer cannot grow this array without limit.
      if (mailbox.steers.length >= MAX_QUEUED_STEERS) {
        return { kind: 'ignored', reason: 'queue-full' };
      }
      mailbox.steers.push(delivery.body ?? '');
      mailbox.wake?.();
      return { kind: 'delivered' };
    },
  };
}

/**
 * The deterministic artifact content — a stable JSON encoding of the session
 * context, plus any steers delivered into the run (#147). Pure in its inputs, so
 * the commit it becomes is reproducible and a different session — OR a different
 * steer — yields a different object.
 *
 * When no steer was delivered the `steers` key is OMITTED, so the artifact is
 * byte-identical to the pre-#147 encoding: the default run's object does not move,
 * and only a genuinely steered run carries the extra field (the flip-the-input
 * witness — change the steer, the bytes change).
 */
export function deterministicArtifact(ctx: SessionContext, steers: readonly string[] = []): string {
  const base = {
    kind: 'atrium-execution-artifact',
    sessionId: ctx.sessionId,
    planId: ctx.planId,
    roomId: ctx.roomId,
    harness: ctx.harness,
    model: ctx.model,
  };
  const payload = steers.length > 0 ? { ...base, steers: [...steers] } : base;
  return JSON.stringify(payload, null, 2);
}
