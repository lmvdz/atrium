import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * The `GIT_*` variables that RETARGET where git reads and writes (#120 F1). Left
 * inherited from `process.env`, ANY of these lets a hostile server env — or a
 * harness that exported them — point the adapter's own `git add`/`commit`/
 * `worktree` at a DIFFERENT repository than the scratch checkout: a harness
 * command like `git update-ref refs/heads/main HEAD` under an inherited
 * `GIT_DIR` moves a trunk the covenant says only a human may move. Every git the
 * adapter runs (and every harness, see `worktree-provider.ts`) is bound to its
 * `cwd` by SCRUBBING these, so git can only touch the directory it was pointed at.
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
 * A `process.env` with every repo-retargeting `GIT_*` var removed and config
 * lookups pinned to nothing — the base every adapter git and every harness runs
 * under (#120 F1/F4). System and global gitconfig are disabled and HOME points
 * at an empty dir, so no `/etc/gitconfig`, `~/.gitconfig`, or inherited `GIT_DIR`
 * can redirect the operation off its `cwd`.
 */
export async function scrubbedGitBaseEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of DANGEROUS_GIT_VARS) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.HOME = await cleanHome();
  return env;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const base = await scrubbedGitBaseEnv();
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...base, ...GIT_ENV },
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
  await git(dir, ['commit', '-q', '-m', 'seed: atrium execution scratch']);
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
  return { dir, branch, repoDir: repo.dir };
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
  await git(checkout.dir, ['add', '-A']);
  const status = await git(checkout.dir, ['status', '--porcelain']);
  if (status === '') return null;
  await git(checkout.dir, ['commit', '-q', '-m', message]);
  return git(checkout.dir, ['rev-parse', 'HEAD']);
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
  // colliding local branch.
  await git(checkout.dir, [
    'push',
    artifact.dir,
    `refs/heads/${checkout.branch}:refs/heads/${checkout.branch}`,
  ]);
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

function short(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session';
}
