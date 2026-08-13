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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
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
  await git(repo.dir, ['worktree', 'add', '-q', '-b', branch, dir, 'main']);
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

function short(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session';
}
