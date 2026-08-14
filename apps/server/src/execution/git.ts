import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { SessionDiff, SessionDiffFile } from '@atrium/db';
import {
  assertUpstreamSeed,
  configuredUpstreamMintOverlap,
  pathsOverlap,
  type UpstreamSeed,
  upstreamLocalPath,
} from './upstream.js';

export type { UpstreamSeed } from './upstream.js';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE UPSTREAM IS NEVER WRITTEN (#141) — restated here, at the plumbing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Real-repo mode (#141) points execution at a REAL repository: the scratch
 * trunk is seeded from `UpstreamSeed`, worktrees fork THAT, and a session's
 * branch is a diff against a repo a human actually cares about. The covenant
 * that made the empty-trunk seam safe — "the artifact is a branch, never a
 * land" — now has a second, sharper edge: the repository being forked is not
 * the provider's toy, and NOTHING in this process may write it.
 *
 * The invariant is restated at three layers, each with its own refusal and its
 * own red-on-revert witness, because a guard that exists on one layer and not
 * the adjacent one is the #89 bypass class:
 *
 *  1. **Config** (`env.ts`, `assertExecutionProviderSafe`) — an upstream that
 *     OVERLAPS a path this server writes (the scratch dir, the artifact dir) is
 *     a boot failure. You cannot configure the write.
 *  2. **Plumbing** (this file) — `createArtifactRepo` refuses to `init` AT the
 *     upstream, and `pushArtifactBranch` refuses to push INTO it. These are the
 *     only two operations in this file that write a repository other than a
 *     worktree, and each refuses independently of the config gate above.
 *  3. **Provider** (`worktree-provider.ts` / `shim.ts`, via
 *     `assertArtifactRemoteIsNotUpstream`) — an upstream-seeded provider must
 *     hold a durable artifact remote that is DISTINCT from the upstream, or it
 *     refuses to be built at all.
 *
 * The seeding operation itself is `git fetch <url> <ref>` and nothing else: no
 * remote is ever added (so no `pushurl` can be configured on one), no `clone`
 * writes an `origin`, and no ref in the upstream is ever named as a push
 * destination. `fetch` is read-only at the source — verified by the integration
 * witness, which hashes every file in the upstream before and after a full
 * session and asserts byte-identity.
 *
 * ## What "never" is quantified over (#141 r2 — the honest boundary)
 *
 * Everything above is about ATRIUM'S code, and holds unconditionally. It is not
 * a claim about the HARNESS. The worktree provider's harness is arbitrary,
 * unsandboxed code with write access to its worktree's git config, and
 * `git config url.<upstream>.pushInsteadOf <artifact-dir>` makes git rewrite the
 * destination of `pushArtifactBranch`'s own push — same argv, every check here
 * satisfied, ref created in the upstream. No path guard in this file can see it,
 * and no guard-shaped fix exists: a harness that can write git config can push
 * to the upstream directly.
 *
 * So the CLAIM is scoped rather than the guard re-decorated. `env.ts` refuses to
 * boot real-repo mode under `EXECUTION_PROVIDER=worktree` at all; it is available
 * on `shim` (which runs no harness command) and, once #138 lands, under real
 * containment. The functions below are what the sandboxed provider will inherit.
 */
export const UPSTREAM_IS_NEVER_WRITTEN =
  'the execution upstream is fetched from and never written to (#141)';

/** A scratch git repo the provider controls — the "remote" the artifact lives in. */
export interface ScratchRepo {
  /** Absolute path to the repo. Doubles as the `remote` on the artifact. */
  readonly dir: string;
  /** The trunk commit the seed landed on — for proving trunk never moves. */
  readonly seedCommit: string;
  /**
   * The upstream this trunk was seeded FROM (#141), or `undefined` for the
   * classic empty-trunk repo. Carried on the repo so every downstream layer can
   * ask "is there an upstream, and where is it?" without re-reading config.
   */
  readonly upstream?: UpstreamSeed & { readonly commit: string };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RUNTIME-UNFORGEABLE PROVENANCE (#141 r5) — a ScratchRepo cannot be forged.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ScratchRepo` is a plain STRUCTURAL object, and its OWN FIELDS describe its
 * provenance: `upstream` says "this trunk was seeded from a real repository". The
 * type system enforces that shape at COMPILE time only. A caller with the
 * unsandboxed opt-in can therefore hand-build a plain object — `{ dir, seedCommit }`
 * with NO `upstream` field — that points at a genuinely seeded scratch repo on
 * disk yet reads, structurally, as an innocent empty-trunk repo. Both foreign
 * lineages EXECUTED exactly this (F1): the forged handle sails past
 * `createWorktreeCommandProvider`'s `repo.upstream !== undefined` refusal, the
 * provider builds a real harness over a seeded repo, and that harness installs
 * `url.<upstream>.pushInsteadOf` to redirect Atrium's own push into the upstream.
 *
 * The fix closes the whole forgeable-object class, not the one field: authenticity
 * is a runtime CAPABILITY only the factory can mint. A module-private `WeakSet`
 * holds every ScratchRepo `createScratchRepo` returns; a hand-built object is not
 * in the set, however faithfully it copies the fields. The brand lives in a closure
 * no caller can reach, so it cannot be copied onto a forgery. `WeakSet` (not a
 * symbol property) keeps the interface structurally unchanged — no brand field to
 * type around — and lets a discarded repo be garbage-collected.
 */
const authenticScratchRepos = new WeakSet<ScratchRepo>();

/**
 * Brand a factory-minted ScratchRepo as authentic, FREEZE it, and return it.
 *
 * FREEZE (#141 r6, FINDING A — both critics): the `readonly` fields are a
 * COMPILE-time promise only; at runtime a caller keeps a genuinely-branded object
 * and reassigns `repo.dir = <upstream>` or `repo.upstream = undefined`, sailing
 * past the brand check (same object, still in the WeakSet) with swapped fields —
 * `addWorktree` then runs `git worktree add` in the reassigned `dir`, writing
 * worktree admin state into the upstream. `Object.freeze` makes the fields
 * runtime-immutable, so a reassignment throws in strict mode (a no-op otherwise)
 * and the branded object a guard trusts is the branded object a git-write uses.
 * The nested `upstream` handle is frozen too — else `repo.upstream.url` stays
 * mutable and could re-point the overlap decisions that read it.
 */
function brandScratchRepo(repo: ScratchRepo): ScratchRepo {
  if (repo.upstream !== undefined) Object.freeze(repo.upstream);
  authenticScratchRepos.add(repo);
  return Object.freeze(repo);
}

/**
 * Was this ScratchRepo minted by `createScratchRepo`? The trust-boundary consumer
 * (`createWorktreeCommandProvider`) verifies this and REJECTS any handle that is
 * not authentic — a forged `{ dir, seedCommit }` is not in the set (#141 r5, F1).
 */
export function isAuthenticScratchRepo(repo: ScratchRepo): boolean {
  return authenticScratchRepos.has(repo);
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
  /**
   * The ABSOLUTE common git dir (the shared object store + `refs/heads/*`),
   * captured at resolve time alongside `gitDir` (#120 round-6, grok F2). Pinning
   * only `GIT_DIR` left the per-worktree gitdir's OWN `commondir` and `HEAD` files
   * writable by a same-UID harness: rewriting `$GIT_DIR/commondir` at a victim
   * repo (and `$GIT_DIR/HEAD` at `refs/heads/main`) would send the adapter's own
   * `commit`/`update-ref` into the victim's trunk. The adapter pins
   * `GIT_COMMON_DIR` to THIS captured value, so a rewritten `commondir` file is
   * ignored and refs resolve in the real scratch repo. `undefined` for older
   * checkouts, which fall back to `commondir`-file discovery.
   */
  readonly commonDir?: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RUNTIME-UNFORGEABLE PROVENANCE (#141 r6) — a WorktreeCheckout cannot be forged.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The THIRD forgeable handle, closed for the same reason as ScratchRepo and
 * ArtifactRepo (#141 r5). `WorktreeCheckout` is a plain structural object whose
 * `dir`/`gitDir`/`commonDir`/`repoDir` fields are what the adapter's own git-writes
 * are POINTED AT: `commitWorktree` pins `GIT_DIR`/`GIT_WORK_TREE` to `gitDir`/`dir`
 * and runs `git commit`; `removeWorktree` runs `git worktree remove` in `repoDir`
 * and `rm -rf`s `dir`. A caller with the opt-in who hand-builds `{ dir, branch,
 * repoDir, gitDir: '<upstream>/.git', commonDir: '<upstream>/.git' }` drives the
 * adapter's own commit straight into the upstream's HEAD, or deletes the upstream —
 * the git-retarget PIN does not defend against this, because the pin USES the
 * forged `gitDir`. (Both round-5 critics enumerated ScratchRepo and ArtifactRepo;
 * this round's "verify there are no OTHERS" step found the checkout is the same
 * class, so it is closed the same way rather than deferred.)
 *
 * Authenticity is minted by `addWorktree` (a module-private `WeakSet`) and verified
 * by every consumer that reaches a git-write through a checkout. A hand-built
 * checkout is not in the set, so it is refused before its fields point a write.
 */
const authenticWorktreeCheckouts = new WeakSet<WorktreeCheckout>();

/** Brand a factory-minted WorktreeCheckout as authentic, FREEZE it, and return it. */
function brandWorktreeCheckout(checkout: WorktreeCheckout): WorktreeCheckout {
  authenticWorktreeCheckouts.add(checkout);
  return Object.freeze(checkout);
}

/**
 * Was this WorktreeCheckout minted by `addWorktree`? The git-write consumers
 * (`commitWorktree`, `removeWorktree`, `pushArtifactBranch`) verify this and refuse
 * any handle that is not — a hand-built `{ dir, gitDir, … }` is not in the set, so
 * its fields never get to point the adapter's own commit/remove/push (#141 r6).
 */
export function isAuthenticWorktreeCheckout(checkout: WorktreeCheckout): boolean {
  return authenticWorktreeCheckouts.has(checkout);
}

/**
 * REFUSAL 13 — a provider's `run` only ever touches a FACTORY-MINTED checkout's
 * directory (#141 r7, the fs-mutation sibling of Finding B).
 *
 * The git()-scoped gates (commit/remove/push) all verify the checkout brand — but
 * a provider's `run` reaches `checkout.dir` through operations that are NOT `git()`
 * calls and happen BEFORE any of those gates: the shim `writeFile`s its artifact
 * INTO `checkout.dir`, and the worktree adapter SPAWNS the harness with
 * `checkout.dir` as its cwd. A caller who hands `run` a forged workspace whose
 * `checkout.dir` is the upstream would write a file into the upstream, or run a
 * command inside it, before `commitWorktree`'s brand gate is ever consulted. So the
 * checkout's authenticity is verified at the TOP of every `run`, before its `dir`
 * points a filesystem mutation. An authentic checkout's `dir` is always a fresh
 * `mkdtemp(tmpdir())` (see `addWorktree`), never the upstream, so this refuses only
 * a forgery.
 */
export const RUN_CHECKOUT_NOT_AUTHENTIC_REFUSAL =
  'refusing to run a harness over a worktree checkout that is not a factory-minted handle (#141 r7) ' +
  "— a provider's run writes its artifact into checkout.dir (the shim) or spawns the harness with " +
  'checkout.dir as its cwd (the worktree adapter) BEFORE any git-write brand gate, so a hand-built ' +
  'checkout aimed at the upstream would write a file into it or execute inside it; only a ' +
  'factory-branded checkout may host a run';

/**
 * Verify a checkout is factory-minted before a provider's `run` points its `dir` at
 * a filesystem mutation. Called at the top of every provider `run`.
 */
export function assertAuthenticRunCheckout(checkout: WorktreeCheckout): void {
  if (!isAuthenticWorktreeCheckout(checkout)) {
    throw new Error(RUN_CHECKOUT_NOT_AUTHENTIC_REFUSAL);
  }
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
  /**
   * The trusted common dir captured at resolve (#120 round-6 grok F2). When set,
   * `GIT_COMMON_DIR` is pinned to it so a rewritten `$GIT_DIR/commondir` file
   * cannot move where `refs/heads/*` resolve. `undefined` for older checkouts.
   */
  readonly commonDir?: string;
}

async function git(cwd: string, args: readonly string[], pin?: GitDirPin): Promise<string> {
  const base = await scrubbedGitBaseEnv();
  // `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` are on `DANGEROUS_GIT_VARS` and were
  // deleted from `base` — that scrub keeps an INHERITED retarget out. Here the
  // adapter sets them ITSELF, to the trusted per-worktree git dir and common dir
  // captured before the harness ran, so git reads/writes THIS checkout and resolves
  // refs in the REAL scratch repo regardless of what the harness did to the
  // worktree's `.git` file or the gitdir's `commondir`. Applied AFTER the spread so
  // they win.
  const env: NodeJS.ProcessEnv = { ...base, ...GIT_ENV };
  if (pin) {
    env.GIT_DIR = pin.gitDir;
    env.GIT_WORK_TREE = pin.workTree;
    if (pin.commonDir !== undefined) env.GIT_COMMON_DIR = pin.commonDir;
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
 * ═══════════════════════════════════════════════════════════════════════════
 *  REFUSAL 11 — THE CONSTRUCTION-TIME INVARIANT (#141 r7): no authentic handle
 *  is ever MINTED naming the configured upstream.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every prior round moved the guard closer to the write: the boot gate, the
 * operation-time overlap re-check, the runtime brand verified at each git-write.
 * A final gauntlet still found two same-class sites the per-site enumeration
 * missed, and both share ONE root cause — the overlap check that keeps a handle
 * off the upstream runs only when a caller passes the seed/upstream ARGUMENT:
 *
 *  - Finding A: `createArtifactRepo(upstreamDir)` with the `upstream` arg LEFT OFF
 *    mints a genuinely-branded ArtifactRepo AT the upstream (`upstreamPath: null`),
 *    and `pushArtifactBranch`/`pinSettledArtifact` then trust the brand — the null
 *    path skips their overlap re-check. The factory itself minted the forbidden
 *    object. `createScratchRepo(upstreamDir)` with no seed is the same at the
 *    scratch factory: a branded scratch repo INSIDE the upstream that `addWorktree`
 *    then trusts.
 *
 * The architectural fix moves the invariant to CONSTRUCTION, ABOVE the per-site
 * brands (which stay, as defense in depth). The configured upstream is a
 * process-wide fact the trust boundary records once (`setConfiguredExecutionUpstream`,
 * from the same URL the boot gate reads); EVERY mint consults it UNCONDITIONALLY —
 * seed passed or not — and refuses to brand+return a handle whose directory
 * overlaps it. A caller can no longer omit the argument into the gap, because the
 * fact is not an argument: `createArtifactRepo(upstreamDir)` seedless now THROWS
 * instead of minting, so the whole downstream use-site surface is moot for the one
 * thing it was protecting — an authentic handle can never name the upstream. When
 * there is NO configured upstream (empty-trunk, or remote), there is nothing to
 * overlap and this is a no-op, exactly the pre-#141 behaviour.
 */
export const MINT_AT_UPSTREAM_REFUSAL =
  'refusing to mint an execution repo handle whose directory overlaps the configured execution ' +
  'upstream (#141 r7) — the construction-time invariant is that no factory-branded ScratchRepo or ' +
  'ArtifactRepo may ever name the upstream, whether or not a seed is passed, so a seedless ' +
  'createArtifactRepo/createScratchRepo aimed at it is refused at the mint rather than trusted by ' +
  'every downstream write';

/**
 * The construction-time gate both factories call before they brand+return a
 * handle. Reads the process-recorded configured upstream (a value no factory
 * CALLER can write — that is the whole point, per Finding A), not a per-call
 * argument, and canonicalises via `pathsOverlap` so a symlinked mint dir is
 * caught by realpath too.
 */
function assertMintDirNotConfiguredUpstream(dir: string): void {
  const overlap = configuredUpstreamMintOverlap(dir);
  if (overlap !== null) {
    throw new Error(`${MINT_AT_UPSTREAM_REFUSAL}: ${dir} overlaps ${overlap}`);
  }
}

/**
 * REFUSAL 7 — the scratch repo is never CREATED at or inside the upstream (#141
 * r3, FIX 2).
 *
 * `createScratchRepo` runs `mkdir` + `git init` + `git worktree add` under
 * `baseDir` (`EXECUTION_SCRATCH_DIR`). Pointed at (or inside) the upstream, every
 * one of those writes the repository the session forks. The config gate refuses
 * an overlapping `EXECUTION_SCRATCH_DIR` at boot; this is the same refusal moved
 * to the OPERATION, so a `baseDir` that only became an overlap AFTER boot — a
 * symlink swapped in — is caught at the moment of the write rather than trusted
 * from a stale boot-time comparison.
 *
 * ## TRUSTED-DIRECTORY OWNERSHIP ASSUMPTION — the honest boundary (#141 r3)
 *
 * This recheck NARROWS the check-then-use (TOCTOU) window; it does not close it.
 * Between `pathsOverlap` returning "no overlap" and the `mkdir`/`git init` that
 * follows, a sufficiently-privileged local attacker could still swap a component
 * of `baseDir` (or the artifact dir) for a symlink into the upstream. Closing
 * that fully needs the directories to be (re)built through no-follow descriptors
 * — `O_NOFOLLOW`/`openat2(RESOLVE_NO_SYMLINKS)` on each component, then
 * operations relative to the verified fd — which is a larger change tracked as a
 * FOLLOW-UP (see docs/real-repo-execution.md).
 *
 * Until then the boundary is stated, not pretended: the scratch, artifact and
 * upstream PARENT directories are ASSUMED operator-owned and not attacker-writable.
 * The recheck plus that stated assumption is the honest guarantee — the recheck
 * defeats a stale-boot spelling and a link already present at operation time; the
 * assumption is what covers the residual race a pure path check cannot.
 */
export const SCRATCH_REPO_AT_UPSTREAM_REFUSAL =
  'refusing to create the execution scratch repo at a path that overlaps the execution upstream ' +
  '(#141) — the per-session worktrees forked here would be written inside the repository they ' +
  'fork, re-checked at creation against a directory swapped in after the boot-time gate';

/**
 * Create a scratch repo whose trunk is the thing sessions fork from.
 *
 * WITHOUT `seed` (the shipped #120 behaviour, unchanged): a single synthetic
 * commit on `main` holding `README.atrium`. Nothing real is under it, so a
 * session's branch is a diff against nothing.
 *
 * WITH `seed` (#141 real-repo mode): trunk is FETCHED from a real upstream at an
 * exact ref, so `addWorktree`'s `worktree add … main` forks the real tree and a
 * session's branch is a genuine diff against the repository a human merges into.
 *
 * ## The fetch is the whole interaction with the upstream
 *
 * `git fetch <url> <ref>` and nothing else. No `clone` (which would write an
 * `origin` remote whose `pushurl` a later edit could aim back), no `remote add`,
 * no ref in the upstream ever named as a destination. `fetch` reads the source
 * and writes only here — the integration witness hashes every file in the
 * upstream before and after a full session and asserts byte-identity.
 *
 * The `--` separator is load-bearing: without it a location beginning with `-`
 * is parsed as an OPTION, and `--upload-pack=<cmd>` is remote code execution
 * where a repository was expected. `assertUpstreamSeed` refuses that shape
 * first; the separator is the second lock, verified against git 2.43 ("strange
 * pathname … blocked").
 *
 * The scratch repo's OWN working tree is deliberately left empty on the seeded
 * path — no `checkout`/`reset --hard` after the fetch. Nothing reads it (every
 * real checkout is a `git worktree`), and materialising a second full copy of a
 * real repository per boot buys nothing but I/O.
 */
export async function createScratchRepo(
  baseDir?: string,
  seed?: UpstreamSeed,
): Promise<ScratchRepo> {
  // ── CONSTRUCTION-TIME INVARIANT (#141 r7, Finding A) ───────────────────────
  // Refuse to mint a scratch repo INSIDE the configured upstream, UNCONDITIONALLY —
  // seed passed or not — against the process-recorded upstream (not a caller arg).
  // This runs BEFORE the mkdir/init below, so `createScratchRepo(upstreamDir)` with
  // no seed throws here instead of writing a branded scratch repo into the upstream.
  // When no upstream is configured (empty-trunk seam), this is a no-op.
  if (baseDir !== undefined) assertMintDirNotConfiguredUpstream(baseDir);
  if (seed !== undefined) {
    // Validate on the ONLY path that fetches, not merely at config load — a
    // caller that builds a seed by hand gets the same refusal the operator does.
    assertUpstreamSeed(seed);
    // ── FIX 2 (#141 r3): the write-overlap check, RE-RUN AT OPERATION TIME ─────
    //
    // The boot gate (`assertExecutionUpstreamSafe`) already refused a scratch dir
    // that overlaps the upstream — but that is a boot-time comparison, and this is
    // check-then-use: a symlink swapped into `baseDir` in the window between boot
    // and now makes the boot answer stale, and the mkdtemp+`init`+worktrees below
    // would then land INSIDE the upstream. So the overlap is re-checked HERE,
    // immediately before the dir is created, against `realpath` — `pathsOverlap`
    // canonicalises the deepest existing prefix, so a link substituted after boot
    // is caught. This narrows, but does NOT by itself close, the TOCTOU window:
    // see the TRUSTED-DIRECTORY OWNERSHIP ASSUMPTION on `SCRATCH_REPO_AT_UPSTREAM_REFUSAL`.
    if (baseDir !== undefined) {
      const upstreamPath = upstreamLocalPath(seed.url);
      if (upstreamPath !== null && pathsOverlap(baseDir, upstreamPath)) {
        throw new Error(`${SCRATCH_REPO_AT_UPSTREAM_REFUSAL}: ${baseDir} overlaps ${upstreamPath}`);
      }
    }
  }
  const dir = baseDir
    ? await (async () => {
        await mkdir(baseDir, { recursive: true });
        return mkdtemp(join(baseDir, 'atrium-exec-'));
      })()
    : await mkdtemp(join(tmpdir(), 'atrium-exec-'));
  // `-b main` so the trunk name is stable regardless of the host's git default.
  await git(dir, ['init', '-q', '-b', 'main']);

  if (seed !== undefined) {
    // `--no-tags`: seed the trunk, not the upstream's whole tag namespace.
    await git(dir, ['fetch', '--no-tags', '--quiet', '--', seed.url, seed.ref]);
    // `^{commit}` so an ANNOTATED tag resolves to the commit it wraps —
    // `update-ref refs/heads/*` refuses a tag object, and a ref is a legal seed.
    const commit = await git(dir, ['rev-parse', `FETCH_HEAD^{commit}`]);
    // `main` is unborn here and IS the checked-out branch, which is why the fetch
    // above lands in `FETCH_HEAD` rather than fetching straight into it (git
    // refuses: "refusing to fetch into branch … checked out at").
    await git(dir, ['update-ref', 'refs/heads/main', commit]);
    // BRAND this as a factory-minted repo (#141 r5): the trust-boundary consumer
    // verifies the brand, so a hand-built `{ dir, seedCommit }` copy — which cannot
    // reach this closure — is rejected there even when it points at THIS repo.
    return brandScratchRepo({ dir, seedCommit: commit, upstream: { ...seed, commit } });
  }

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
  return brandScratchRepo({ dir, seedCommit });
}

/**
 * REFUSAL 8 — a worktree is only ever added in a FACTORY-MINTED scratch repo (#141
 * r6, FINDING B — both critics).
 *
 * `addWorktree` runs `git worktree add` in `repo.dir`, which writes worktree admin
 * state (`.git/worktrees/<id>`, a new ref) INTO that repo. It is reached by both
 * providers' `resolve` AND by direct callers of this exported function. Round 5
 * branded the scratch repo and checked the brand at `createWorktreeCommandProvider`
 * — but NOT here, so a hand-built `{ dir: '<upstream>', seedCommit }` handed
 * straight to `addWorktree` registered a worktree inside the upstream with no gate.
 * So the brand is verified at the WRITE, not only at provider construction.
 */
export const ADD_WORKTREE_NOT_AUTHENTIC_REFUSAL =
  'refusing to add a per-session worktree in a scratch repo that is not a factory-minted handle ' +
  '(#141 r6) — `git worktree add` writes worktree admin state into the repo it is given, so a ' +
  'hand-built handle aimed at the upstream would register a worktree inside a repository the ' +
  'provider does not own; only a factory-branded scratch repo may host a worktree';

/**
 * RESOLVE an isolated workspace: a git worktree on a fresh per-session branch,
 * forked from trunk. Two sessions get two directories, two branches, one shared
 * object store — the isolation the ticket's "per-session workspace keyed on
 * session id" names.
 */
export async function addWorktree(repo: ScratchRepo, sessionId: string): Promise<WorktreeCheckout> {
  // BRAND GATE (#141 r6, FINDING B): the scratch repo must be factory-minted before
  // `git worktree add` writes into it. Verified HERE, at the write, so a direct
  // caller who never passed through `createWorktreeCommandProvider` cannot point
  // this at the upstream with a forged handle.
  if (!isAuthenticScratchRepo(repo)) {
    throw new Error(ADD_WORKTREE_NOT_AUTHENTIC_REFUSAL);
  }
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
  // Capture the ABSOLUTE per-worktree git dir AND the shared common dir NOW, while
  // the `.git` file (and the gitdir's `commondir`) are still the trusted ones git
  // just wrote and no harness has run (#120 round-5 F5b + round-6 grok F2). The
  // adapter's own later commit/push pin GIT_DIR/GIT_COMMON_DIR to these, so a
  // harness rewriting `<dir>/.git` OR `$GIT_DIR/commondir`/`$GIT_DIR/HEAD` cannot
  // redirect the adapter's own git off this checkout or onto a victim's trunk.
  const gitDir = await git(dir, ['rev-parse', '--absolute-git-dir']);
  const commonDir = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  // BRAND + FREEZE (#141 r6): this checkout is the authentic product of a factory
  // scratch repo. The git-write consumers verify the brand, so a hand-built checkout
  // (which cannot reach this mint) is refused before its fields point a write.
  return brandWorktreeCheckout({ dir, branch, repoDir: repo.dir, gitDir, commonDir });
}

/**
 * REFUSAL 9 — a git-write is only ever driven through a FACTORY-MINTED checkout
 * (#141 r6, the "no OTHERS" closure).
 *
 * `commitWorktree` pins `GIT_DIR`/`GIT_WORK_TREE` to the checkout's own
 * `gitDir`/`dir` and commits; `removeWorktree` runs `git worktree remove` in
 * `repoDir` and `rm -rf`s `dir`; `pushArtifactBranch` resolves the push source
 * through the checkout's pinned gitDir. Every one of those is pointed by
 * checkout-supplied fields, so a hand-built checkout aimed at the upstream drives
 * the adapter's own commit/remove into it. The git-retarget pin does NOT stop
 * this — it USES the (forged) gitDir. So the checkout's authenticity is verified
 * before its fields point any write.
 */
export const WORKTREE_CHECKOUT_NOT_AUTHENTIC_REFUSAL =
  'refusing to drive a git write through a worktree checkout that addWorktree did not mint ' +
  "(#141 r6) — a checkout's own gitDir/workTree/repoDir are what the adapter's commit, push and " +
  'remove are pinned to, so a hand-built checkout aimed at the upstream would send those writes ' +
  'straight into it; only a factory-branded worktree checkout is trusted to point a git write';

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
  // BRAND GATE (#141 r6): the checkout must be factory-minted before its gitDir/dir
  // pin points the adapter's own `add`/`commit`. A forged checkout aimed at the
  // upstream is refused here, before the pin is built.
  if (!isAuthenticWorktreeCheckout(checkout)) {
    throw new Error(WORKTREE_CHECKOUT_NOT_AUTHENTIC_REFUSAL);
  }
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
  // RE-ASSERT HEAD to this session's branch before the adapter's own commit (#120
  // round-6 grok F2). With `GIT_COMMON_DIR` pinned, a rewritten `$GIT_DIR/commondir`
  // can no longer move where refs resolve — but `git commit` still updates whatever
  // `$GIT_DIR/HEAD` names, and a same-UID harness can rewrite that file to
  // `ref: refs/heads/main`. Pointing HEAD back at the session branch here (the
  // harness has already exited; this runs in the adapter's own synchronous
  // sequence) means the commit lands on the session branch in the real scratch
  // repo, never on a trunk. `symbolic-ref` writes `$GIT_DIR/HEAD` under the pin.
  if (checkout.gitDir !== undefined) {
    await git(checkout.dir, ['symbolic-ref', 'HEAD', `refs/heads/${checkout.branch}`], pin);
  }
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
    : { gitDir: checkout.gitDir, workTree: checkout.dir, commonDir: checkout.commonDir };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  THE REAL STRUCTURED DIFF (#145) — what the producer computes and reports.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `diffWorktree` computes the ACTUAL git diff of a session's checkout against the
 * ref it forked from (`main`, which in real-repo mode #141 is the seeded upstream
 * commit and never moves — the covenant's negative proof). It returns per-file
 * structured hunks the review pane renders directly, so the surface shows the real
 * change rather than a one-line stat. A stubbed-constant diff fails the shim's
 * flip-the-input test; this reads git.
 *
 * THE CAP IS HONEST. The retained `files` and their hunk lines are bounded so a
 * huge diff can never blow the jsonb row or the DB. The whole-diff totals come
 * from `git diff --numstat` (one line per file — it survives a diff far too large
 * to buffer as a patch), so `fileCount`/`additions`/`deletions` describe the REAL
 * change even when the carried hunks are a truncated prefix; `truncated` says so.
 */

/** Cap on retained files — a diff wider than this carries a prefix, `truncated:true`. */
export const MAX_DIFF_FILES = 40;
/** Cap on retained hunk BODY lines, summed across all files. */
export const MAX_DIFF_LINES = 2000;
/** Cap on a single hunk line's length — a minified megabyte-line is trimmed. */
export const MAX_DIFF_LINE_LEN = 500;

/** One file's whole-diff counts, from `git diff --numstat -z` (survives huge diffs). */
interface NumstatEntry {
  readonly path: string;
  readonly oldPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

/**
 * Parse `git diff --numstat --find-renames -z` output. The `-z` form is
 * NUL-terminated and never path-quotes, so an arbitrary real-repo path (spaces,
 * unicode) parses without ambiguity. A normal record is `adds\tdels\tpath\0`; a
 * rename is `adds\tdels\t\0oldpath\0newpath\0` (empty inline path, two extra
 * tokens). A binary file reports `-\t-` for the counts.
 */
function parseNumstatZ(raw: string): NumstatEntry[] {
  const tokens = raw.split('\0');
  const out: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head === undefined || head === '') {
      i += 1;
      continue;
    }
    const tab1 = head.indexOf('\t');
    const tab2 = head.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) {
      i += 1;
      continue;
    }
    const addsRaw = head.slice(0, tab1);
    const delsRaw = head.slice(tab1 + 1, tab2);
    const inlinePath = head.slice(tab2 + 1);
    const binary = addsRaw === '-' && delsRaw === '-';
    const additions = binary ? 0 : Number.parseInt(addsRaw, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(delsRaw, 10) || 0;
    if (inlinePath === '') {
      // A rename/copy: the old and new paths are the next two NUL-separated tokens.
      const oldPath = tokens[i + 1] ?? '';
      const path = tokens[i + 2] ?? '';
      out.push({ path, oldPath, additions, deletions, binary });
      i += 3;
    } else {
      out.push({ path: inlinePath, additions, deletions, binary });
      i += 1;
    }
  }
  return out;
}

/** One file's shape from the unified-diff patch text — status + hunks + paths. */
interface PatchFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly binary: boolean;
  readonly hunks: { header: string; lines: string[] }[];
}

/** Strip git's `a/`/`b/` image prefix from a `---`/`+++` path. */
function stripImagePrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/**
 * Parse a `git diff --no-color` patch into per-file blocks with their hunks. Keyed
 * later against numstat by post-image path, so the counts come from numstat (the
 * whole-file truth) and the hunk BODIES come from here (bounded by the caller).
 * The paths come from the `+++ b/…`/`--- a/…` lines (unquoted under
 * `core.quotePath=false`), falling back to the `Binary files … differ` line for a
 * binary file that has no image lines.
 */
function parseUnifiedDiff(patch: string): PatchFile[] {
  if (patch === '') return [];
  const files: PatchFile[] = [];
  const lines = patch.split('\n');
  let cur: {
    path: string;
    oldPath?: string;
    status: PatchFile['status'];
    binary: boolean;
    hunks: { header: string; lines: string[] }[];
    minus?: string;
    plus?: string;
  } | null = null;
  let hunk: { header: string; lines: string[] } | null = null;

  const flush = () => {
    if (cur === null) return;
    // Resolve the path: prefer the post-image (`+++ b/…`), then the pre-image for a
    // deletion, then an explicit rename-to, then whatever the header parsed.
    const path =
      cur.plus !== undefined && cur.plus !== '/dev/null'
        ? cur.plus
        : cur.minus !== undefined && cur.minus !== '/dev/null'
          ? cur.minus
          : cur.path;
    files.push({
      path,
      oldPath: cur.oldPath,
      status: cur.status,
      binary: cur.binary,
      hunks: cur.hunks,
    });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      hunk = null;
      // Header paths are a last resort; `+++`/`---` below are authoritative.
      cur = { path: '', status: 'modified', binary: false, hunks: [] };
      continue;
    }
    if (cur === null) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
      cur.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length);
      cur.status = 'renamed';
    } else if (line.startsWith('Binary files ')) {
      cur.binary = true;
      // `Binary files a/x and b/y differ` — recover the post-image path.
      const m = /^Binary files .* and (.*) differ$/.exec(line);
      if (m?.[1]) cur.path = stripImagePrefix(m[1]);
    } else if (line.startsWith('--- ')) {
      cur.minus = stripImagePrefix(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      cur.plus = stripImagePrefix(line.slice(4));
    } else if (line.startsWith('@@')) {
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
    } else if (
      hunk !== null &&
      (line.startsWith(' ') ||
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith('\\'))
    ) {
      hunk.lines.push(line);
    }
  }
  flush();
  return files;
}

/**
 * Compute the REAL structured diff of a session checkout against `base` (#145).
 *
 * Two git reads: `--numstat -z` for the whole-diff totals and per-file counts
 * (huge-diff-safe), and the `--no-color` patch for the hunk bodies. They are
 * merged by post-image path, then the hunks are trimmed to the caps. An unchanged
 * checkout returns an HONEST EMPTY (`files: []`, all counts `0`, `truncated:false`)
 * — a real "no changes", which the caller carries as PRESENT-but-empty, distinct
 * from never reporting a diff at all.
 *
 * `base...HEAD` (three-dot) diffs against the fork point, so the result is exactly
 * what the session added since it branched from trunk.
 */
export async function diffWorktree(
  checkout: WorktreeCheckout,
  base = 'main',
): Promise<SessionDiff> {
  // BRAND GATE (#141 r6): the checkout's pinned gitDir is what the diff reads
  // through, so a forged checkout would point the read at another repo. Refuse it
  // here, the same as every other git-driving consumer.
  if (!isAuthenticWorktreeCheckout(checkout)) {
    throw new Error(WORKTREE_CHECKOUT_NOT_AUTHENTIC_REFUSAL);
  }
  const pin = worktreePin(checkout);
  const range = `${base}...HEAD`;
  const numstatRaw = await git(
    checkout.dir,
    ['diff', '--numstat', '--find-renames', '-z', range],
    pin,
  );
  const numstat = parseNumstatZ(numstatRaw);
  const fileCount = numstat.length;
  const additions = numstat.reduce((n, f) => n + f.additions, 0);
  const deletions = numstat.reduce((n, f) => n + f.deletions, 0);
  if (fileCount === 0) {
    return { files: [], fileCount: 0, additions: 0, deletions: 0, truncated: false };
  }

  // `core.quotePath=false` so a non-ASCII path is emitted raw and the parser sees
  // the same string numstat's `-z` gave. `-c` must precede the subcommand.
  const patchRaw = await git(
    checkout.dir,
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--find-renames', range],
    pin,
  );
  const patchByPath = new Map(parseUnifiedDiff(patchRaw).map((f) => [f.path, f]));

  const files: SessionDiffFile[] = [];
  let truncated = false;
  let lineBudget = MAX_DIFF_LINES;
  for (const entry of numstat) {
    if (files.length >= MAX_DIFF_FILES) {
      truncated = true;
      break;
    }
    const patchFile = patchByPath.get(entry.path);
    const status: SessionDiffFile['status'] =
      patchFile?.status ?? (entry.oldPath !== undefined ? 'renamed' : 'modified');
    const oldPath = patchFile?.oldPath ?? entry.oldPath;
    const binary = entry.binary || (patchFile?.binary ?? false);
    const hunks: { header: string; lines: string[] }[] = [];
    if (!binary && patchFile) {
      for (const h of patchFile.hunks) {
        if (lineBudget <= 0) {
          truncated = true;
          break;
        }
        const kept: string[] = [];
        for (const raw of h.lines) {
          if (lineBudget <= 0) {
            truncated = true;
            break;
          }
          if (raw.length > MAX_DIFF_LINE_LEN) {
            kept.push(`${raw.slice(0, MAX_DIFF_LINE_LEN)}…`);
            truncated = true;
          } else {
            kept.push(raw);
          }
          lineBudget -= 1;
        }
        hunks.push({ header: h.header, lines: kept });
      }
    }
    files.push({
      path: entry.path,
      ...(oldPath !== undefined && oldPath !== '' ? { oldPath } : {}),
      status,
      additions: entry.additions,
      deletions: entry.deletions,
      binary,
      hunks,
    });
  }

  return { files, fileCount, additions, deletions, truncated };
}

/** Reclaim the ephemeral checkout. The branch it produced is left intact. */
export async function removeWorktree(checkout: WorktreeCheckout): Promise<void> {
  // BRAND GATE (#141 r6): a forged checkout would `git worktree remove` in an
  // arbitrary `repoDir` and `rm -rf` an arbitrary `dir` — aim it at the upstream
  // and this deletes it. The reclaim is best-effort AFTER this point, but the gate
  // is not: an unbranded handle is refused before any destructive call.
  if (!isAuthenticWorktreeCheckout(checkout)) {
    throw new Error(WORKTREE_CHECKOUT_NOT_AUTHENTIC_REFUSAL);
  }
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

/**
 * REFUSAL 12 — the scratch repo is only ever DELETED through a FACTORY-MINTED
 * handle (#141 r7, FINDING B — grok, executed).
 *
 * `disposeScratchRepo` `rm -rf`s `repo.dir`. That is a FILESYSTEM mutation, not a
 * `git()` call, so the git()-scoped enumeration that gated every other write in
 * this file (r5/r6) never covered it — the exact "the gap is on the path nobody
 * enumerated" class. A hand-built `{ dir: <upstream> }` handed here deletes a live
 * repository the provider does not own (grok EXECUTED this). So the brand is
 * verified before the rm, the same runtime-capability check every git-write does,
 * extended to the one fs-mutation that trusts a caller-supplied repo dir.
 */
export const DISPOSE_SCRATCH_NOT_AUTHENTIC_REFUSAL =
  'refusing to delete a scratch repo that is not a factory-minted handle (#141 r7, Finding B) — ' +
  'disposeScratchRepo removes repo.dir with a filesystem rm rather than a git() call, so a ' +
  'hand-built { dir: <upstream> } handed here would rm -rf a repository the provider does not own; ' +
  'only a factory-branded scratch repo may be disposed';

/** Tear down the whole scratch repo. */
export async function disposeScratchRepo(repo: ScratchRepo): Promise<void> {
  // BRAND GATE (#141 r7, FINDING B): a forged handle would `rm -rf` an arbitrary
  // `dir` — aim it at the upstream and this deletes it. The reclaim is best-effort,
  // but the gate is not: an unbranded handle is refused before the destructive call.
  if (!isAuthenticScratchRepo(repo)) {
    throw new Error(DISPOSE_SCRATCH_NOT_AUTHENTIC_REFUSAL);
  }
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
  /**
   * The LOCAL path of the configured execution upstream (#141), when there is one
   * and it is local; `null` when no upstream is configured or it is remote.
   * Carried so `pushArtifactBranch` can re-assert THE UPSTREAM IS NEVER WRITTEN at
   * the moment of the write, not only at the moment of the open.
   *
   * MANDATORY, not optional (#141 r4). It was `upstreamPath?: string`, and an
   * optional field is a fail-open: a hand-assembled `ArtifactRepo` that simply
   * OMITTED it slipped past `pushArtifactBranch`'s `!== undefined` guard silently —
   * the exact "the gap is on the path nobody thought of" class. As a required
   * `string | null` the type forces every constructor to STATE provenance: a path,
   * or an explicit `null` meaning "no local upstream". Omitting it is now a compile
   * error, witnessed by a `@ts-expect-error` in the guard tests.
   */
  readonly upstreamPath: string | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RUNTIME-UNFORGEABLE PROVENANCE (#141 r5) — an ArtifactRepo cannot be forged.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ArtifactRepo` is a plain STRUCTURAL object whose own `upstreamPath` field is the
 * thing `pushArtifactBranch` trusts to decide the overlap. Round 4 made the field
 * MANDATORY so it could not be OMITTED — but a required field can still LIE.
 * Both foreign lineages EXECUTED this (F2): `pushArtifactBranch({ dir: upstream.dir,
 * upstreamPath: null })` — a hand-built handle pointed AT the upstream that falsely
 * declares `null` ("no local upstream, nothing to overlap"). The `!== null` guard
 * reads the lie at face value, skips the overlap check, and pushes a session branch
 * straight into the human's repository.
 *
 * A guard can only be as honest as the fields it reads, and a caller who builds the
 * object writes the fields. So authenticity is minted, not declared: a module-private
 * `WeakSet` holds every ArtifactRepo `createArtifactRepo` returns, and
 * `pushArtifactBranch` rejects any handle not in it BEFORE reading `upstreamPath`.
 * The overlap decision is then made against a `upstreamPath` the FACTORY recorded
 * from the configured upstream, never one a caller supplied.
 */
const authenticArtifactRepos = new WeakSet<ArtifactRepo>();

/**
 * Brand a factory-minted ArtifactRepo as authentic, FREEZE it, and return it.
 *
 * FREEZE (#141 r6, FINDING A — both critics): as with `brandScratchRepo`, the
 * `readonly` fields are compile-time only. A caller keeps a genuinely-branded
 * artifact repo (brand check passes) and reassigns `repo.dir = <upstream>` and
 * `repo.upstreamPath = null` — the `null` reads as "nothing to overlap", the
 * overlap re-check is skipped, and `pushArtifactBranch`/`pinSettledArtifact` write
 * a ref straight into the upstream. `Object.freeze` makes both fields
 * runtime-immutable, so the swap throws (strict mode) or is a no-op, and the
 * fields a guard reads cannot diverge from the fields a git-write uses.
 */
function brandArtifactRepo(repo: ArtifactRepo): ArtifactRepo {
  authenticArtifactRepos.add(repo);
  return Object.freeze(repo);
}

/**
 * Was this ArtifactRepo minted by `createArtifactRepo`? `pushArtifactBranch`
 * verifies this and refuses any handle that is not — a forged `{ dir, upstreamPath }`
 * is not in the set, so its lying `upstreamPath` never gets to decide the overlap.
 */
export function isAuthenticArtifactRepo(repo: ArtifactRepo): boolean {
  return authenticArtifactRepos.has(repo);
}

/**
 * REFUSAL 6 — the push destination must be a FACTORY-MINTED artifact repo (#141 r5).
 *
 * The primary gate that closes F2. A forged `ArtifactRepo` — whatever it claims in
 * `upstreamPath` — is not in the authenticity `WeakSet`, so it is refused before the
 * overlap check ever reads a caller-controlled field. `pushArtifactBranch` then makes
 * its overlap decision only against a factory-recorded `upstreamPath`. The overlap
 * check itself is RETAINED as defense-in-depth (a branded repo whose on-disk realpath
 * comes to overlap the upstream after creation — a TOCTOU symlink swap — is still
 * caught), but a hand-built handle no longer reaches it at all.
 */
export const ARTIFACT_REPO_NOT_AUTHENTIC_REFUSAL =
  'refusing to push a session branch through an ArtifactRepo that createArtifactRepo did not mint ' +
  '(#141 r5) — a hand-built handle can declare any upstreamPath it likes (a forged `null` reads as ' +
  '"nothing to overlap" and slips the guard), so only a factory-branded artifact repo is trusted ' +
  'to decide where the push may land';

/**
 * REFUSAL 3 — the durable artifact repo is never opened AT the upstream (#141).
 *
 * `createArtifactRepo` runs `init --bare` and two `config` writes. Pointed at a
 * real repository that is somebody's checkout, `init --bare` converts the
 * directory it is given, and `config core.hooksPath` edits that repository's
 * config. Both are writes to the repo the human merges INTO — the exact thing
 * the invariant forbids — and they happen at BOOT, before any session runs, so a
 * guard that only watched the push would never see them.
 */
export const ARTIFACT_REPO_AT_UPSTREAM_REFUSAL =
  'refusing to open the durable artifact repo at a path that overlaps the execution upstream ' +
  '(#141) — `init --bare` plus the hook-guard config writes would modify the very repository a ' +
  'session forks from and a human merges into';

/**
 * REFUSAL 4 — a session branch is never pushed INTO the upstream (#141).
 *
 * The push is the one operation in this seam that writes a repository the
 * process does not own, so it re-checks the destination against the recorded
 * upstream ITSELF rather than trusting that `createArtifactRepo` was the thing
 * that built its argument. An `ArtifactRepo` is a plain object; a caller that
 * assembles one by hand (a test, a future daemon, a refactor that inlines the
 * factory) reaches this function without ever passing the boot gate.
 *
 * The direction of the covenant is the point: the artifact is a branch the human
 * PULLS from a repo the provider controls. The provider pushing INTO the human's
 * repository is the same act as landing it, one `git merge` earlier.
 */
export const PUSH_INTO_UPSTREAM_REFUSAL =
  'refusing to push a session branch into a destination that overlaps the execution upstream ' +
  '(#141) — the settled artifact is a branch a human FETCHES from the provider-owned repo; ' +
  'nothing here ever writes a ref in the repository the session forked';

/**
 * Open (creating if absent) the durable bare artifact repo at `dir`. Idempotent:
 * a path that is already an artifact repo is reused across boots, so its refs
 * accumulate rather than being thrown away with each process. Never disposed on
 * shutdown — that is the whole point.
 *
 * `upstream`, when given, is the configured execution upstream: opening the
 * artifact repo anywhere that overlaps it is refused BEFORE the first `mkdir`.
 * Its location is CANONICALISED first — every `file://` spelling (any host, git
 * drops the authority) and a symlinked destination both name the same directory
 * as a plain path, and a `file://` URL that cannot be canonicalised throws rather
 * than being read as "remote, therefore no overlap".
 *
 * This overlap check IS the operation-time recheck for the artifact repo (#141
 * r3, FIX 2): it runs here, in the function that performs `init --bare`, right
 * before the `mkdir`, against `realpath` — not only at the boot gate — so a
 * symlink swapped into `dir` after boot is caught at the write. It narrows but
 * does not alone close the TOCTOU window; the residual race is covered by the
 * trusted-directory ownership assumption stated on `SCRATCH_REPO_AT_UPSTREAM_REFUSAL`.
 */
export async function createArtifactRepo(
  dir: string,
  upstream?: UpstreamSeed,
): Promise<ArtifactRepo> {
  // ── CONSTRUCTION-TIME INVARIANT (#141 r7, Finding A) ───────────────────────
  // Refuse to mint the durable repo AT the configured upstream, UNCONDITIONALLY —
  // whether or not this call passed the `upstream` argument. Finding A was exactly
  // the seedless call `createArtifactRepo(upstreamDir)`: with `upstream` omitted the
  // check below no-ops (`upstreamPath` is null), so the factory ran `init --bare`
  // straight into the upstream and branded the result. Reading the process-recorded
  // upstream (a value no caller writes) closes that at the mint, before the mkdir.
  assertMintDirNotConfiguredUpstream(dir);
  const upstreamPath = upstream === undefined ? null : upstreamLocalPath(upstream.url);
  if (upstreamPath !== null && pathsOverlap(dir, upstreamPath)) {
    throw new Error(`${ARTIFACT_REPO_AT_UPSTREAM_REFUSAL}: ${dir} overlaps ${upstreamPath}`);
  }
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
  // Always carry `upstreamPath` — a path when the upstream is local, else `null`.
  // The field is mandatory (#141 r4): a repo that means "no upstream" says so with
  // `null`, it does not communicate it by absence, so no caller can omit provenance
  // into `pushArtifactBranch`'s fail-open. BRANDED as factory-minted (#141 r5) so the
  // push can reject a hand-built handle whose `upstreamPath` lies — the r4 "cannot be
  // omitted" is now also "cannot be forged".
  return brandArtifactRepo({ dir, upstreamPath });
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
  // CHECKOUT BRAND GATE (#141 r6): the push SOURCE is resolved through the
  // checkout's pinned gitDir, so a forged checkout could feed a victim repo's
  // objects into the durable artifact repo. The write DESTINATION is the branded
  // artifact (gated below), so this is defense-in-depth for the source — but it
  // keeps all three checkout consumers uniformly self-defending. Checked first so
  // an authentic checkout (the only kind a real run produces) passes straight to
  // the artifact gates below.
  if (!isAuthenticWorktreeCheckout(checkout)) {
    throw new Error(WORKTREE_CHECKOUT_NOT_AUTHENTIC_REFUSAL);
  }
  // PRIMARY GATE (#141 r5, F2): the push destination must be a FACTORY-MINTED
  // artifact repo. `ArtifactRepo` is a plain object any caller can assemble, and the
  // r4 "the field cannot be OMITTED" did not stop a caller from forging a required
  // field that LIES — `{ dir: upstream.dir, upstreamPath: null }` declared "nothing
  // to overlap" and reached the push. Authenticity is a runtime brand only
  // `createArtifactRepo` can mint (a `WeakSet` in a closure), so a hand-built handle
  // is refused HERE, before the overlap check reads any caller-controlled field.
  if (!isAuthenticArtifactRepo(artifact)) {
    throw new Error(ARTIFACT_REPO_NOT_AUTHENTIC_REFUSAL);
  }
  // THE UPSTREAM IS NEVER WRITTEN, re-asserted at the write (#141) — now DEFENSE IN
  // DEPTH behind the brand. `upstreamPath` is a MANDATORY `string | null` (#141 r4)
  // the FACTORY recorded (#141 r5), never a caller's: `null` is "no local upstream";
  // a path is checked. `pathsOverlap` canonicalises both sides, so this is also the
  // on-disk realpath RE-CHECK that catches a branded repo whose `dir` or upstream was
  // symlink-swapped to overlap AFTER creation (the TOCTOU the brand alone cannot see).
  if (artifact.upstreamPath !== null && pathsOverlap(artifact.dir, artifact.upstreamPath)) {
    throw new Error(
      `${PUSH_INTO_UPSTREAM_REFUSAL}: ${artifact.dir} overlaps ${artifact.upstreamPath}`,
    );
  }
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
 * REFUSAL 10 — a settled pin is only ever written into a FACTORY-MINTED artifact
 * repo (#141 r6, FINDING B — both critics).
 *
 * The sibling of `ARTIFACT_REPO_NOT_AUTHENTIC_REFUSAL`, for the OTHER git-write that
 * trusts a caller-supplied `artifact.dir`: `pinSettledArtifact`'s `git update-ref`.
 * Round 5 gated the push; this gates the pin, so both writes into the durable repo
 * verify the brand rather than just the push somebody remembered.
 */
export const PIN_ARTIFACT_NOT_AUTHENTIC_REFUSAL =
  'refusing to pin a settled artifact in an artifact repo that is not a factory-minted handle ' +
  '(#141 r6) — `git update-ref` writes a ref into the repo it is given, so a hand-built handle ' +
  'aimed at the upstream would create a settled ref inside a repository the provider does not own; ' +
  'only a factory-branded artifact repo may be pinned into';

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
  // BRAND GATE (#141 r6, FINDING B): `git update-ref` writes a ref into
  // `artifact.dir`, so a hand-built handle aimed at the upstream would create
  // `refs/atrium/settled/*` inside it. Round 5 branded the artifact repo and
  // checked it at `pushArtifactBranch` but NOT here — the second git-write that
  // trusts a caller-supplied artifact dir. Verified before the write.
  if (!isAuthenticArtifactRepo(artifact)) {
    throw new Error(PIN_ARTIFACT_NOT_AUTHENTIC_REFUSAL);
  }
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

/**
 * REFUSAL 5 — an upstream-seeded provider must have somewhere ELSE to publish
 * to (#141).
 *
 * The config gate and the two plumbing gates each stop a specific WRITE. This
 * one stops a specific WIRING, which is a different failure and reachable
 * without any of the others: a provider built with an upstream-seeded scratch
 * repo but NO durable artifact repo falls back to reporting the scratch repo as
 * the artifact `remote`. That repo is torn down at shutdown, so a real-repo
 * session would settle with a receipt naming a remote nobody can fetch from —
 * the acceptance test's "its branch reachable for a manual merge" quietly
 * unsatisfied, with no error anywhere.
 *
 * And the adjacent shape: a durable repo that IS (or sits inside) the upstream.
 * `createArtifactRepo` refuses to open one there, so on the wired path this arm
 * is unreachable — which is exactly why it is asserted here too. Providers take
 * an `ArtifactRepo` object, not a path, and an object can arrive from anywhere.
 */
export const UPSTREAM_ARTIFACT_REMOTE_REFUSAL =
  'refusing to build an upstream-seeded execution provider without a durable artifact remote ' +
  'distinct from the upstream (#141) — a real-repo session settles with a branch a human must ' +
  'be able to fetch, so its remote may be neither the disposable scratch repo nor the upstream';

/**
 * Assert the provider-layer half of THE UPSTREAM IS NEVER WRITTEN. Called by
 * every provider factory that holds a scratch repo, so the check binds on each
 * construction path rather than on the one somebody remembered.
 */
export function assertArtifactRemoteIsNotUpstream(
  repo: ScratchRepo,
  artifactRepo: ArtifactRepo | undefined,
): void {
  if (repo.upstream === undefined) return;
  if (artifactRepo === undefined) {
    throw new Error(`${UPSTREAM_ARTIFACT_REMOTE_REFUSAL}: no artifact repo was wired`);
  }
  const upstreamPath = upstreamLocalPath(repo.upstream.url);
  if (upstreamPath !== null && pathsOverlap(artifactRepo.dir, upstreamPath)) {
    throw new Error(
      `${UPSTREAM_ARTIFACT_REMOTE_REFUSAL}: ${artifactRepo.dir} overlaps ${upstreamPath}`,
    );
  }
}

function short(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session';
}
