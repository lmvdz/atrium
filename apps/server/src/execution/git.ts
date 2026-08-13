import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The git plumbing both real providers share (#120).
 *
 * The verified artifact is a BRANCH/COMMIT in a scratch git the provider
 * controls, and the isolation is a git worktree keyed on the session id. Both
 * the deterministic shim (`shim.ts`) and the real worktree adapter
 * (`worktree-provider.ts`) use exactly these operations; they differ only in
 * what runs BETWEEN resolving the worktree and committing it — a fixed fake
 * routine versus a real spawned command.
 *
 * ## Why `execFile`, never a shell
 *
 * Every argument here — a session id, a branch name, a repo path — is passed as
 * an argv element to `execFile`, never interpolated into a shell string. A
 * session id is a uuid the server minted, but the rule is the rule: nothing on
 * this path is ever handed to `/bin/sh`, so there is no command to inject into.
 *
 * ## The branch is never `main`, and never merged
 *
 * `main` is the scratch repo's trunk; the seed commit is the only thing on it.
 * A session's work lands on `atrium/session/<id>` and stays there. NOTHING in
 * this file merges, fast-forwards, or resets `main` — the land is a human `✓`
 * (the covenant), and the artifact is a branch waiting for one. The
 * `mainCommit` helper exists so a test can PROVE trunk never moved.
 */

const run = promisify(execFile);

/**
 * THE ABSOLUTE GIT BINARY, RESOLVED ONCE FROM THE BOOT PATH (#120 round-5 F5a).
 *
 * Every git spawn used to be `run('git', …)`, which re-runs the child's own
 * `PATH` lookup on EVERY call. A `PATH` whose earlier entry holds an attacker
 * `git` then selects that binary — a PATH-hijack the seam did nothing to close.
 * Round 4's grok probe planted exactly this. `PATH` is the process's own trust
 * boundary (the server cannot run git at all without it), but the fix is to
 * resolve `git` to an ABSOLUTE path ONCE, from the trusted boot environment,
 * and invoke that path forever after — so a `PATH` mutated later in the process
 * (or a `PATH` handed to the child that differs from boot) can never reselect
 * which binary is `git`. Cached, because the resolution itself is the thing
 * being protected: doing it per-call would reintroduce the very lookup.
 *
 * `EXECUTION_GIT_BINARY`, if set to an absolute path, pins it explicitly for a
 * deployment that wants no PATH search at all.
 */
let gitBinaryCache: string | null = null;
export async function resolveGitBinary(): Promise<string> {
  if (gitBinaryCache !== null) return gitBinaryCache;
  const override = process.env.EXECUTION_GIT_BINARY;
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(`EXECUTION_GIT_BINARY must be an ABSOLUTE path, got: ${override}`);
    }
    await access(override, fsConstants.X_OK);
    gitBinaryCache = override;
    return override;
  }
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'git');
    try {
      await access(candidate, fsConstants.X_OK);
      gitBinaryCache = candidate;
      return candidate;
    } catch {
      // Not here — keep scanning the boot PATH.
    }
  }
  throw new Error(
    'could not resolve an absolute path to the git binary on PATH (#120 F5) — refusing to fall ' +
      'back to a bare "git" that a later PATH mutation could hijack',
  );
}

/** Reset the cached git binary — TEST-ONLY, so a suite can probe PATH resolution. */
export function resetGitBinaryCacheForTest(): void {
  gitBinaryCache = null;
}

/** A scratch git repo the provider controls — the "remote" the artifact lives in. */
export interface ScratchRepo {
  /** Absolute path to the repo. Doubles as the `remote` on the artifact. */
  readonly dir: string;
  /** The trunk commit the seed landed on — for proving trunk never moves. */
  readonly seedCommit: string;
}

/** One resolved worktree — an isolated checkout on a fresh per-session branch. */
export interface WorktreeCheckout {
  readonly dir: string;
  readonly branch: string;
  readonly repoDir: string;
  /**
   * The ABSOLUTE per-worktree git dir, captured at resolve time BEFORE any
   * harness runs (#120 round-5 F5b). The adapter's own later commit/push pin
   * `GIT_DIR`/`GIT_WORK_TREE` to this, so a harness that rewrites the worktree's
   * `.git` FILE (retargeting it at a victim repo) cannot redirect the adapter's
   * own git off this checkout. `undefined` only for checkouts built by an older
   * path that predates the capture — those fall back to `.git`-file discovery.
   */
  readonly gitDir?: string;
}

const GIT_ENV = {
  // Deterministic, machine-owned identity and no interactive prompts, ever.
  GIT_AUTHOR_NAME: 'atrium-execution',
  GIT_AUTHOR_EMAIL: 'execution@atrium.local',
  GIT_COMMITTER_NAME: 'atrium-execution',
  GIT_COMMITTER_EMAIL: 'execution@atrium.local',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/**
 * THE ONLY `process.env` KEYS THAT CROSS INTO A GIT PROCESS (#120 round-3 F1).
 *
 * The git env is built from `{}` and this list, never from `{ ...process.env }`
 * minus a denylist. Round 2's blind gauntlet probed the denylist form from both
 * foreign lineages and it fails OPEN: `GIT_DIR` and friends were removed, but the
 * whole git CONFIG-INJECTION family was still inherited —
 * `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n`, `GIT_TEMPLATE_DIR` — and any one of them installs
 * `core.hooksPath` (or a template `hooks/`) under EVERY git the adapter spawns,
 * the durable bare repo's `receive-pack` included. The hook then ran with the
 * server's entire environment: `DATABASE_URL`, `BETTER_AUTH_SECRET`, gateway and
 * object-store keys, straight into an attacker-controlled script.
 *
 * This is the campaign's standing lesson — *allowlist the compliant form; a
 * denylist's gaps fail open and silent* — and it is why the list is short and why
 * each entry has to argue for itself:
 *
 *  - `PATH` — git must find its own `git-*` subcommands and `git-receive-pack`.
 *    Unavoidable, and the one genuinely load-bearing inheritance here.
 *  - `LANG` / `LC_ALL` / `LC_CTYPE` — so a pathname carrying non-ASCII bytes
 *    round-trips through `add`/`status --porcelain` instead of being mangled by a
 *    C-locale fallback. Encoding, not behaviour.
 *  - `TZ` — so a commit's recorded local offset is the host's, matching every
 *    other timestamp the server writes.
 *
 * Deliberately ABSENT, though a "reasonable" list might carry them: `TERM` (git
 * only needs it to pick a pager, and nothing here is a tty), `USER`/`HOME` (the
 * identity is pinned in `GIT_ENV` and `HOME` is overwritten with `cleanHome()`),
 * `SSH_AUTH_SOCK` (nothing on this path talks to a network remote — the durable
 * "remote" is a local directory, and lending an agent socket to a git the harness
 * can influence is exactly the credential reach this seam exists to deny), and
 * every `GIT_*` (each is either set explicitly below or has no business here).
 *
 * The mirror of `harnessEnv` in `worktree-provider.ts`, which held under the same
 * probes for the same reason.
 */
export const GIT_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const;

/**
 * The `GIT_*` variables that RETARGET where git reads and writes (#120 F1).
 *
 * NOTE (round 3): this list is now BELT AND SUSPENDERS, not the boundary. The
 * boundary is `GIT_ENV_ALLOWLIST` above — nothing reaches a git process unless it
 * is on that list, so none of these can be inherited in the first place. It is
 * kept, and still applied, because `harnessEnv` composes its own env and because
 * a reader deserves the intent stated where the hazard is: left inherited, ANY of
 * these points the adapter's own `git add`/`commit`/`worktree` at a DIFFERENT
 * repository than the scratch checkout, and `git update-ref refs/heads/main HEAD`
 * under an inherited `GIT_DIR` moves a trunk the covenant says only a human moves.
 *
 * Do not add to this list in response to a new escape. Adding to a denylist is
 * how round 1 fixed the instances and left the class; the fix is the allowlist.
 */
export const DANGEROUS_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
] as const;

/** A lazily-created empty HOME with no `~/.gitconfig` — nothing to read secrets from. */
let cleanHomeDir: string | null = null;
export async function cleanHome(): Promise<string> {
  if (cleanHomeDir === null) {
    cleanHomeDir = await mkdtemp(join(tmpdir(), 'atrium-git-home-'));
  }
  return cleanHomeDir;
}

/**
 * A lazily-created directory used as `core.hooksPath` on every adapter git (#120
 * round-4). It is created EMPTY, so pointing git at it means git finds no hook to
 * run where it would otherwise consult a repo-local `.git/hooks/*`.
 *
 * NOT-A-SANDBOX HONESTY (#120 round-5 F6): "empty at creation" is the whole of the
 * claim — this is NOT tamper-proof. The directory lives under the shared temp dir,
 * one instance for the whole process, and a same-UID harness (the worktree
 * provider is opt-in, dev-only, and NOT a security boundary) can WRITE a
 * `pre-commit`/`post-commit` INTO it and have the adapter's own next git run it.
 * That is the unsandboxed provider being unsandboxed, by design; the real boundary
 * is the BUY sandbox seam. Redirecting hooksPath here defeats a hook planted in a
 * worktree's OWN `.git/hooks`, not a same-UID writer who reaches this shared dir.
 */
let emptyHooksDirCache: string | null = null;
export async function emptyHooksDir(): Promise<string> {
  if (emptyHooksDirCache === null) {
    emptyHooksDirCache = await mkdtemp(join(tmpdir(), 'atrium-git-nohooks-'));
  }
  return emptyHooksDirCache;
}

/**
 * The `-c` overrides prepended to EVERY adapter git spawn (#120 round-4 F2).
 *
 * Round-3 F1 closed the INHERITED-env hook vector (`GIT_CONFIG_*`,
 * `GIT_TEMPLATE_DIR`) by construction. It did NOT close the REPO-LOCAL vector: a
 * harness with write access to a worktree can plant `.git/hooks/pre-commit`,
 * `commit-msg`, `post-commit`, or set `core.fsmonitor=<script>` in the repo
 * config, and those fire — as the adapter identity — on the adapter's own later
 * `commitWorktree`/`status`/`add`. The env scrub does not contain a writer that is
 * already inside the tree.
 *
 * `-c` is the highest-precedence config source and beats a repo's `.git/config`,
 * so pinning `core.hooksPath` to an empty directory and `core.fsmonitor=false`
 * here defeats a hook planted in a worktree's OWN `.git/hooks` and an fsmonitor
 * set in its config. (The DURABLE bare repo's `receive-pack` runs in a SEPARATE
 * process that reads the DEST repo config, not these flags, so its hooks are
 * neutered by a persisted `core.hooksPath` set in `createArtifactRepo`.)
 *
 * NOT-A-SANDBOX HONESTY (#120 round-5 F6): this is real hardening against a
 * repo-local hook, not containment. It redirects hooksPath to a shared directory
 * a same-UID harness can WRITE INTO (see `emptyHooksDir`), and it does nothing
 * about `filter.clean`/`filter.smudge`, `commit.gpgsign`, `diff.external`, or a
 * `url.insteadOf` push redirect the harness can set in its own worktree config —
 * all code-exec or redirect primitives an unsandboxed same-UID harness keeps.
 * The worktree provider is opt-in, dev-only, and NOT a security boundary; the
 * real boundary is the BUY sandbox. These `-c` flags shrink the repo-local
 * attack surface; they do not close it.
 */
async function hookGuardArgs(): Promise<string[]> {
  return ['-c', `core.hooksPath=${await emptyHooksDir()}`, '-c', 'core.fsmonitor=false'];
}

/**
 * The base environment EVERY adapter git runs under (#120 F1, round 3).
 *
 * Built from `{}` — not from `process.env` — plus `GIT_ENV_ALLOWLIST` and the
 * hardening below. Two properties follow, and both are asserted by
 * `test/execution/git-env.test.ts` with a real attacker hook:
 *
 *  1. **No config injection.** A var that is not on the allowlist cannot be
 *     inherited, so `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`KEY`/`VALUE`,
 *     `GIT_TEMPLATE_DIR`, `GIT_EXEC_PATH`, `GIT_SSH*`, `GIT_PROXY_COMMAND`,
 *     `GIT_EXTERNAL_DIFF`, `GIT_EDITOR`/`GIT_PAGER`/`GIT_SEQUENCE_EDITOR`,
 *     `GIT_ATTR_SYSTEM` and every future sibling are gone by construction rather
 *     than by enumeration. System, global AND `GIT_CONFIG_SYSTEM` are pinned to
 *     nothing and `HOME` is an empty dir, so no `/etc/gitconfig`, `~/.gitconfig`
 *     or template can reintroduce one.
 *  2. **No secret reaches git.** `DATABASE_URL`, `BETTER_AUTH_SECRET`, gateway
 *     and S3 keys are not on the allowlist, so they are absent from the git
 *     process — and therefore absent from any hook that somehow still ran. Under
 *     the old denylist they were all present, which is what made a hooksPath
 *     injection an exfiltration primitive and not merely code execution.
 *
 * `PATH` is the one inheritance with real reach: a hostile `PATH` still selects
 * which `git` binary runs. That is the process's own trust boundary — the server
 * cannot execute git at all without it — and it is unchanged by this seam.
 */
export async function scrubbedGitBaseEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  // `GIT_CONFIG_NOSYSTEM` already suppresses the system file; this pins the path
  // too, so a git built with a different system-config default — or a future
  // read that consults the path before the flag — still lands on nothing.
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.HOME = await cleanHome();
  // Belt and suspenders. Unreachable while the allowlist above holds — none of
  // these is on it — and kept so that a future edit which reintroduces a spread
  // of `process.env` fails the retargeting half loudly instead of silently.
  for (const key of DANGEROUS_GIT_VARS) delete env[key];
  return env;
}

/**
 * Explicitly bind the adapter's own git to a specific repo, overriding the
 * `.git`-file discovery a harness could have rewritten (#120 round-5 F5b). Set
 * on the adapter's own commit/push into a resolved worktree; absent for
 * operations on a trusted directory (repo root, bare artifact repo).
 */
interface GitDirPin {
  readonly gitDir: string;
  readonly workTree: string;
}

async function git(cwd: string, args: readonly string[], pin?: GitDirPin): Promise<string> {
  const base = await scrubbedGitBaseEnv();
  // `GIT_DIR`/`GIT_WORK_TREE` are on `DANGEROUS_GIT_VARS` and were deleted from
  // `base` — that scrub keeps an INHERITED retarget out. Here the adapter sets
  // them ITSELF, to the trusted per-worktree git dir captured before the harness
  // ran, so git reads/writes THIS checkout regardless of what the harness did to
  // the worktree's `.git` file. Applied AFTER the spread so it wins.
  const env: NodeJS.ProcessEnv = { ...base, ...GIT_ENV };
  if (pin) {
    env.GIT_DIR = pin.gitDir;
    env.GIT_WORK_TREE = pin.workTree;
  }
  // Repo-local hook / fsmonitor hardening (#120 round-4 F2) prepended before the
  // subcommand — `-c` only takes effect ahead of the git command it configures.
  // The binary is the ABSOLUTE path resolved once from the boot PATH (F5a), never
  // a bare "git" a later PATH mutation could reselect.
  const { stdout } = await run(await resolveGitBinary(), [...(await hookGuardArgs()), ...args], {
    cwd,
    env,
    // A runaway harness must not hold the event loop; keep the plumbing bounded.
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * The per-session branch name. One namespace, keyed on the session id, so a
 * branch is traceable back to the session that produced it and two sessions can
 * never collide on a ref.
 */
export function sessionBranch(sessionId: string): string {
  return `atrium/session/${sessionId}`;
}

/**
 * Create a scratch repo with a single seed commit on `main`. This is the git
 * "remote" the shim controls under test — branches produced here are the durable
 * artifacts; the working checkouts are the ephemera.
 */
export async function createScratchRepo(baseDir?: string): Promise<ScratchRepo> {
  const dir = baseDir
    ? await (async () => {
        await mkdir(baseDir, { recursive: true });
        return mkdtemp(join(baseDir, 'atrium-exec-'));
      })()
    : await mkdtemp(join(tmpdir(), 'atrium-exec-'));
  // `-b main` so the trunk name is stable regardless of the host's git default.
  await git(dir, ['init', '-q', '-b', 'main']);
  await writeFile(
    join(dir, 'README.atrium'),
    'Atrium execution scratch repo — session work lands on atrium/session/* branches.\n',
  );
  await git(dir, ['add', '-A']);
  // `--no-verify` so no planted commit-msg/pre-commit hook runs on the adapter's
  // own commits (#120 round-4 F2); `hookGuardArgs` already redirects hooksPath,
  // this is the belt to that suspenders and states the intent at the commit.
  await git(dir, ['commit', '-q', '--no-verify', '-m', 'seed: atrium execution scratch']);
  const seedCommit = await git(dir, ['rev-parse', 'HEAD']);
  return { dir, seedCommit };
}

/**
 * RESOLVE an isolated workspace: a git worktree on a fresh per-session branch,
 * forked from trunk. Two sessions get two directories, two branches, one shared
 * object store — the isolation the ticket's "per-session workspace keyed on
 * session id" names.
 */
export async function addWorktree(repo: ScratchRepo, sessionId: string): Promise<WorktreeCheckout> {
  const branch = sessionBranch(sessionId);
  const dir = await mkdtemp(join(tmpdir(), `atrium-wt-${short(sessionId)}-`));
  // `worktree add -b <branch> <dir> main`: a new branch off trunk, checked out
  // in its own directory. `--force` is deliberately absent — a colliding branch
  // (a re-run of the same session id) must fail loudly, not silently reuse.
  try {
    await git(repo.dir, ['worktree', 'add', '-q', '-b', branch, dir, 'main']);
  } catch (error) {
    // The mkdtemp above already created `dir`; if `worktree add` throws (a
    // colliding ref, a wedged repo) the coordinator settles the session failed
    // (#120 F5) — but the temp dir would leak. Reclaim it before rethrowing so a
    // resolve-throw never orphans a directory.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // Capture the ABSOLUTE per-worktree git dir NOW, while the `.git` file is still
  // the trusted one git just wrote and no harness has run (#120 round-5 F5b). The
  // adapter's own later commit/push pin GIT_DIR to this, so a harness rewriting
  // `<dir>/.git` to point at a victim repo cannot redirect the adapter's own git.
  const gitDir = await git(dir, ['rev-parse', '--absolute-git-dir']);
  return { dir, branch, repoDir: repo.dir, gitDir };
}

/**
 * Commit whatever the harness left in the worktree, onto its branch. Returns the
 * commit sha — the verifiable object at the heart of the artifact. A run that
 * staged nothing produces no commit and returns `null`, which the caller reads
 * as "no artifact".
 */
export async function commitWorktree(
  checkout: WorktreeCheckout,
  message: string,
): Promise<string | null> {
  // Pin GIT_DIR/GIT_WORK_TREE to the trusted per-worktree git dir captured at
  // resolve time (#120 round-5 F5b). Without this, a harness that rewrote
  // `<checkout>/.git` to `gitdir: <victim>/.git` would redirect the ADAPTER'S OWN
  // add/commit/update-ref onto the victim repo — grok moved a victim `main` this
  // way. With it, git ignores the rewritten `.git` file and operates on this
  // checkout, or fails safely if the pin no longer resolves.
  const pin = worktreePin(checkout);
  await git(checkout.dir, ['add', '-A'], pin);
  const status = await git(checkout.dir, ['status', '--porcelain'], pin);
  if (status === '') return null;
  // `--no-verify`: the harness owns this worktree and may have planted a
  // `.git/hooks/pre-commit` or `commit-msg`; the adapter's own commit must not run
  // it (#120 round-4 F2). Redundant with `hookGuardArgs`' hooksPath redirect, kept
  // as the explicit second lock the ticket asks for on the adapter's commit.
  await git(checkout.dir, ['commit', '-q', '--no-verify', '-m', message], pin);
  return git(checkout.dir, ['rev-parse', 'HEAD'], pin);
}

/**
 * The GIT_DIR/GIT_WORK_TREE pin for the adapter's own operations in a checkout,
 * or `undefined` for a checkout captured before the round-5 gitDir capture (it
 * falls back to `.git`-file discovery, the pre-F5b behaviour).
 */
function worktreePin(checkout: WorktreeCheckout): GitDirPin | undefined {
  return checkout.gitDir === undefined
    ? undefined
    : { gitDir: checkout.gitDir, workTree: checkout.dir };
}

/** Reclaim the ephemeral checkout. The branch it produced is left intact. */
export async function removeWorktree(checkout: WorktreeCheckout): Promise<void> {
  // Remove git's worktree registration first, then the directory. `--force`
  // because a committed-but-then-dirtied checkout would otherwise refuse.
  await git(checkout.repoDir, ['worktree', 'remove', '--force', checkout.dir]).catch(() => {});
  await rm(checkout.dir, { recursive: true, force: true }).catch(() => {});
}

/** The commit a branch points at in the scratch repo — proof the artifact exists. */
export async function branchCommit(repo: ScratchRepo, branch: string): Promise<string | null> {
  return git(repo.dir, ['rev-parse', '--verify', '-q', branch]).catch(() => null);
}

/**
 * The commit `main` points at. The covenant's negative proof: after any number
 * of sessions run, trunk is still the seed commit — nothing landed autonomously.
 */
export async function mainCommit(repo: ScratchRepo): Promise<string> {
  return git(repo.dir, ['rev-parse', 'main']);
}

/** Read a file from a branch without checking it out — for verifying an artifact. */
export async function readFileAtBranch(
  repo: ScratchRepo,
  branch: string,
  path: string,
): Promise<string | null> {
  return git(repo.dir, ['show', `${branch}:${path}`]).catch(() => null);
}

/**
 * Every per-session branch in the scratch repo. Empty means no session ever
 * resolved a workspace here — the negative the budget refusal must be able to
 * prove ("the adapter never started, so no branch exists").
 */
export async function listSessionBranches(repo: ScratchRepo): Promise<string[]> {
  const out = await git(repo.dir, [
    'branch',
    '--list',
    '--format=%(refname:short)',
    'atrium/session/*',
  ]);
  return out === '' ? [] : out.split('\n').map((line) => line.trim());
}

/** Tear down the whole scratch repo. */
export async function disposeScratchRepo(repo: ScratchRepo): Promise<void> {
  await rm(repo.dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * The DURABLE artifact remote (#120 F3). The scratch working repo — where the
 * per-session worktrees live — is torn down on shutdown; a settled receipt's
 * `{branch,commit,remote}` must resolve AFTER that, so the artifact branch is
 * PUSHED here, to a bare repo at a STABLE, configured path that teardown never
 * deletes. This is the "Delta-style local remote": a git remote the provider
 * controls whose refs outlive the process that produced them.
 */
export interface ArtifactRepo {
  /** Absolute path to the durable bare repo. This is the `remote` on the artifact. */
  readonly dir: string;
}

/**
 * Open (creating if absent) the durable bare artifact repo at `dir`. Idempotent:
 * a path that is already an artifact repo is reused across boots, so its refs
 * accumulate rather than being thrown away with each process. Never disposed on
 * shutdown — that is the whole point.
 */
export async function createArtifactRepo(dir: string): Promise<ArtifactRepo> {
  await mkdir(dir, { recursive: true });
  // `init --bare` is idempotent: on an existing repo it re-initialises without
  // touching refs, so reusing the same durable path across boots is safe. `-b
  // main` fixes the default branch name; nothing ever checks out here.
  await git(dir, ['init', '--bare', '-q', '-b', 'main']);
  // NEUTER RECEIVE HOOKS ON THIS DURABLE REPO (#120 round-4 F2). A push into a
  // local bare repo spawns `git-receive-pack` in a SEPARATE process that reads
  // THIS repo's config, not the pusher's `-c` flags — so a `hooks/pre-receive`
  // (or `update`/`post-receive`) planted here fires on every later shim push. The
  // hooks dir ships empty with `init`, but a harness that can reach this path
  // could plant one; pinning `core.hooksPath` to an empty dir (highest precedence
  // over any `.git/hooks` lookup) means receive-pack finds no hook to run. Set on
  // every open, so a repo created by an older boot is upgraded in place.
  await git(dir, ['config', 'core.hooksPath', await emptyHooksDir()]);
  await git(dir, ['config', 'core.fsmonitor', 'false']);
  return { dir };
}

/**
 * Push a session's branch from its checkout to the durable artifact repo. The
 * commit objects travel with it, so the branch resolves in the durable repo even
 * after the scratch working repo is gone. Returns the commit the durable ref
 * points at — the verifiable, post-shutdown-resolvable object.
 */
export async function pushArtifactBranch(
  checkout: WorktreeCheckout,
  artifact: ArtifactRepo,
): Promise<string> {
  // Explicit refspec, force-free: a colliding ref in the durable repo (a re-run
  // of the same session id) must fail loudly, exactly as `addWorktree` refuses a
  // colliding local branch. Pinned to the trusted per-worktree git dir (#120
  // round-5 F5b) so a rewritten `.git` file cannot make this push read a
  // different repo's objects.
  await git(
    checkout.dir,
    ['push', artifact.dir, `refs/heads/${checkout.branch}:refs/heads/${checkout.branch}`],
    worktreePin(checkout),
  );
  return git(artifact.dir, ['rev-parse', '--verify', `refs/heads/${checkout.branch}`]);
}

/**
 * The commit a branch points at in the DURABLE artifact repo, or `null` if the
 * ref does not exist there. This is what the `settle_session` artifact verifier
 * (#120 F2) resolves the caller-claimed commit against: an artifact must name a
 * git object the provider actually pushed here, or it is not persisted.
 */
export async function artifactBranchCommit(
  artifact: ArtifactRepo,
  branch: string,
): Promise<string | null> {
  return git(artifact.dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).catch(
    () => null,
  );
}

/**
 * The IMMUTABLE pin a settled artifact gets in the durable repo (#120 r3 F4).
 *
 * Outside `refs/heads/*` on purpose: it is not a branch, nothing fetches it as
 * one, and `git branch -D` cannot reach it. One per session, named by session id.
 */
export function settledArtifactRef(sessionId: string): string {
  return `refs/atrium/settled/${sessionId}`;
}

/**
 * PIN a settled commit so the receipt that indexes it never dangles (#120 r3 F4).
 *
 * A branch ref is MUTABLE. `pushArtifactBranch` is force-free, so the provider
 * cannot move one, but nothing stops a later force-push, a `branch -D`, or a
 * teardown pass from moving or deleting `atrium/session/<id>` in the durable
 * repo — and then a `session_settled` event's `{branch,commit}` names an object
 * that is unreachable and eligible for `git gc`. A receipt is supposed to be the
 * durable half of this seam; a receipt pointing at a collectable object is not.
 *
 * So the settle path writes a second ref at the verified commit, under
 * `refs/atrium/settled/`. Refs are GC roots, so the object stays reachable for
 * as long as the pin exists regardless of what happens to the branch.
 *
 * `update-ref <ref> <sha>` fails if the object is not present, so a pin is also a
 * second, independent existence check on the commit being certified.
 *
 * ## CREATE-ONCE — a pin never moves (#120 round-4 F1)
 *
 * The bare `update-ref <ref> <sha>` this used to run has NO old-value guard, so a
 * SECOND verify at a different commit MOVED the pin. Round 3's gauntlet executed
 * exactly that: pin session S at commit C, force-update the branch to D, verify
 * again → the pin followed to D, then `branch -D` + `gc --prune=now` collected C —
 * the very commit the already-written receipt still names. "A settled artifact is
 * durable" was falsified: the receipt dangled.
 *
 * So the write is COMPARE-AND-SWAP create-only: `update-ref <ref> <new> ""` — the
 * empty old-value form fails if the ref already exists (verified: git 2.43 emits
 * "reference already exists"). Once pinned, the object a receipt indexes is frozen
 * regardless of any later verify, force-push, or branch delete. Re-pinning the
 * SAME commit is idempotent (the pin already guarantees exactly what a re-pin
 * would); re-pinning a DIFFERENT commit is the attack and is REFUSED — a session's
 * certified artifact is settled once and does not get a second, different value.
 */
export async function pinSettledArtifact(
  artifact: ArtifactRepo,
  sessionId: string,
  commit: string,
): Promise<void> {
  const ref = settledArtifactRef(sessionId);
  const existing = await git(artifact.dir, ['rev-parse', '--verify', '-q', ref]).catch(() => null);
  if (existing !== null) {
    // Already pinned. Idempotent for the same commit; a request to move it to a
    // different commit is refused — the pin is create-once by contract.
    if (existing === commit) return;
    throw new Error(
      `refusing to move an already-pinned settled artifact for session ${sessionId}: ` +
        `pinned at ${existing}, asked to move to ${commit} — a settled artifact is immutable`,
    );
  }
  // Empty old-value ⇒ create-only. This ALSO closes the check-then-create race: if
  // another writer pinned between the read above and here, the create fails rather
  // than clobbering.
  await git(artifact.dir, ['update-ref', ref, commit, '']);
}

/**
 * Does this commit still resolve in the durable repo, by object rather than by
 * branch? The question a settled receipt actually asks — "is the thing I indexed
 * still here?" — and the one a teardown/GC test must be able to answer after the
 * branch is gone.
 */
export async function artifactCommitResolves(
  artifact: ArtifactRepo,
  commit: string,
): Promise<boolean> {
  return git(artifact.dir, ['cat-file', '-e', `${commit}^{commit}`]).then(
    () => true,
    () => false,
  );
}

function short(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session';
}
