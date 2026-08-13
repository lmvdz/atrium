import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorktree,
  commitWorktree,
  createScratchRepo,
  disposeScratchRepo,
  removeWorktree,
  resetGitBinaryCacheForTest,
  resolveGitBinary,
} from '../../src/execution/git.js';

const rawGit = promisify(execFile);

/**
 * THE ADAPTER'S OWN GIT CANNOT BE REDIRECTED BY A REWRITTEN `.git` FILE (#120 r5 F5b).
 *
 * A linked worktree's `.git` is a FILE — `gitdir: <repo>/.git/worktrees/<name>` —
 * and the harness owns the worktree. Before round 5 the adapter's own
 * `commitWorktree` let git DISCOVER its git dir from that file, so a harness that
 * rewrote it to `gitdir: <victim>/.git` retargeted the adapter's OWN `add`/`commit`
 * onto a victim repo — grok moved a victim `main` exactly this way. The fix pins
 * `GIT_DIR`/`GIT_WORK_TREE` to the per-worktree git dir captured at resolve time
 * (before any harness runs), which git honors OVER the `.git` file.
 *
 * RED ON REVERT: drop the pin (have `commitWorktree` call `git()` without the
 * `worktreePin`) and the adapter commits onto the victim — `victim main` moves.
 */
describe("a rewritten worktree .git file cannot redirect the adapter's own commit (#120 r5 F5b)", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'atrium-retarget-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('leaves the victim repo byte-unchanged and lands the commit on the session branch', async () => {
    // A VICTIM repo with a real commit on `main` — the thing the adapter must not
    // touch when its worktree's `.git` file is pointed here.
    const victim = await createScratchRepo(base);
    const victimGitDir = join(victim.dir, '.git');
    const victimMainBefore = (
      await rawGit('git', ['-C', victim.dir, 'rev-parse', 'main'])
    ).stdout.trim();

    // The adapter's scratch repo and one resolved worktree.
    const repo = await createScratchRepo(base);
    const checkout = await addWorktree(repo, randomUUID());
    await writeFile(join(checkout.dir, 'work.txt'), 'session work\n');

    // THE ATTACK: the harness rewrites its own worktree's `.git` FILE to point at
    // the victim's git dir. Any git that discovers its dir from `.git` now operates
    // on the victim.
    await writeFile(join(checkout.dir, '.git'), `gitdir: ${victimGitDir}\n`);

    // The adapter commits. With the pin it ignores the rewritten `.git` file and
    // uses the trusted per-worktree git dir, so this lands on the session branch.
    const commit = await commitWorktree(checkout, 'session work');
    expect(commit).not.toBeNull();

    // THE VICTIM IS UNTOUCHED — its `main` is byte-identical.
    const victimMainAfter = (
      await rawGit('git', ['-C', victim.dir, 'rev-parse', 'main'])
    ).stdout.trim();
    expect(victimMainAfter).toBe(victimMainBefore);

    // And the commit really landed on the session branch in the adapter's repo.
    const branchTip = (
      await rawGit('git', ['-C', repo.dir, 'rev-parse', checkout.branch])
    ).stdout.trim();
    expect(branchTip).toBe(commit);

    await removeWorktree(checkout);
    await disposeScratchRepo(repo);
    await disposeScratchRepo(victim);
  });
});

/**
 * GIT IS INVOKED BY AN ABSOLUTE PATH RESOLVED ONCE FROM THE BOOT PATH (#120 r5 F5a).
 *
 * Every adapter git spawn used to be `run('git', …)`, which re-runs the child's
 * PATH lookup on every call — so a PATH whose earlier entry holds an attacker
 * `git` selects it. The fix resolves `git` to an absolute path ONCE and invokes
 * that path, so a PATH mutated AFTER resolution cannot reselect the binary.
 *
 * RED ON REVERT: restore `run('git', …)` and the attacker `git` (first on the
 * mutated PATH) is invoked — its sentinel appears.
 */
describe('the adapter invokes git by an absolute path, defeating a later PATH hijack (#120 r5 F5a)', () => {
  let base: string;
  const savedPath = process.env.PATH;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'atrium-pathhijack-'));
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    resetGitBinaryCacheForTest();
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('does not run an attacker git planted earlier on PATH after resolution', async () => {
    // Resolve the REAL git first, from the trusted boot PATH — the "once" that the
    // whole fix hinges on.
    resetGitBinaryCacheForTest();
    const realGit = await resolveGitBinary();
    expect(realGit.startsWith('/')).toBe(true);

    // Now plant a hostile `git` that records it was called, then execs the real
    // git so the operation still completes (firing the sentinel is the failure).
    const attackerDir = join(base, 'evil-bin');
    await mkdir(attackerDir, { recursive: true });
    const sentinel = join(base, 'attacker-git-fired');
    const attackerGit = join(attackerDir, 'git');
    await writeFile(
      attackerGit,
      `#!/bin/sh\necho FIRED >> ${JSON.stringify(sentinel)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    await chmod(attackerGit, 0o755);
    // Prepend the attacker dir so a PATH lookup would pick it first.
    process.env.PATH = `${attackerDir}${delimiter}${savedPath ?? ''}`;

    // Drive the adapter git path — many git() calls, all AFTER the hijack.
    const repo = await createScratchRepo(base);
    const checkout = await addWorktree(repo, randomUUID());
    await writeFile(join(checkout.dir, 'work.txt'), 'session work\n');
    const commit = await commitWorktree(checkout, 'session work');
    expect(commit).not.toBeNull();
    await removeWorktree(checkout);
    await disposeScratchRepo(repo);

    // The attacker git was NEVER the top-level binary — the cached absolute path won.
    const fired = await readFile(sentinel, 'utf8').catch(() => '');
    expect(fired, `attacker git was invoked:\n${fired}`).toBe('');
  });
});
