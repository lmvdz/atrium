import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorktree,
  commitWorktree,
  createArtifactRepo,
  createScratchRepo,
  disposeScratchRepo,
  pushArtifactBranch,
  removeWorktree,
  scrubbedGitBaseEnv,
} from '../../src/execution/git.js';

/**
 * THE GIT ENV IS AN ALLOWLIST, NOT A DENYLIST (#120 round-3 F1).
 *
 * Round 2's blind gauntlet PROBED this, both lineages independently: the scrub
 * was `{...process.env}` minus the `GIT_DIR` family, which leaves the entire git
 * CONFIG-INJECTION family inherited. `GIT_CONFIG_PARAMETERS`,
 * `GIT_CONFIG_COUNT`/`KEY`/`VALUE`, and `GIT_TEMPLATE_DIR` each let a hostile
 * process env install `core.hooksPath` (or a template `hooks/`) under EVERY git
 * the adapter spawns — the "safe" shim path and `pushArtifactBranch` on the
 * DURABLE bare repo included. The hook then runs with the server's whole
 * environment: `DATABASE_URL`, `BETTER_AUTH_SECRET`, gateway keys.
 *
 * A denylist's gaps fail OPEN and SILENT. These tests assert the compliant form
 * instead: the git env is built from `{}` and carries only the allowlist, so a
 * config-injection var has no way in and no secret has a way out.
 *
 * RED ON REVERT: restore `scrubbedGitBaseEnv` to `{ ...process.env }` minus
 * `DANGEROUS_GIT_VARS` and every test below fires the attacker's hook.
 */

/** Env keys these tests plant and must restore — never leak into the rest of the run. */
const HOSTILE_KEYS = [
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_TEMPLATE_DIR',
  'ATRIUM_TEST_SENTINEL_SECRET',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
] as const;

const SENTINEL = 'atrium-sentinel-do-not-leak-6f2b1c';

interface Bait {
  /** Where the hook writes when it fires. Absent file = never fired. */
  readonly log: string;
  /** A `core.hooksPath` directory holding the hooks. */
  readonly hooksDir: string;
  /** A `GIT_TEMPLATE_DIR` whose `hooks/` are copied into every `git init`. */
  readonly templateDir: string;
  readonly base: string;
}

/**
 * A hook that RECORDS rather than attacks: it appends its cwd and its whole
 * environment to a log. Firing at all is the failure; the env dump is the second
 * half of the proof (no secret may reach a git child, let alone a hook).
 */
async function plantBait(): Promise<Bait> {
  const base = await mkdtemp(join(tmpdir(), 'atrium-bait-'));
  const log = join(base, 'fired.log');
  const hooksDir = join(base, 'hooks');
  const templateDir = join(base, 'template');
  const script = `#!/bin/sh\n{ echo "FIRED $(basename "$0") cwd=$PWD"; env; } >> ${JSON.stringify(log)}\n`;
  await mkdir(hooksDir, { recursive: true });
  await mkdir(join(templateDir, 'hooks'), { recursive: true });
  // `post-commit` catches the adapter's own commit; `post-receive`/`update` catch
  // the push onto the DURABLE bare repo — the ref a settled receipt indexes.
  for (const dir of [hooksDir, join(templateDir, 'hooks')]) {
    for (const hook of ['post-commit', 'post-receive', 'update', 'pre-receive']) {
      const path = join(dir, hook);
      await writeFile(path, script);
      await chmod(path, 0o755);
    }
  }
  return { base, log, hooksDir, templateDir };
}

async function firedLog(bait: Bait): Promise<string | null> {
  return readFile(bait.log, 'utf8').catch(() => null);
}

/** Drive the full adapter git path: init → worktree → commit → push to durable. */
async function runFullGitPath(scratchBase: string): Promise<void> {
  const repo = await createScratchRepo(scratchBase);
  const artifact = await createArtifactRepo(join(scratchBase, 'durable'));
  const checkout = await addWorktree(repo, randomUUID());
  await writeFile(join(checkout.dir, 'work.txt'), 'session work\n');
  await commitWorktree(checkout, 'session work');
  await pushArtifactBranch(checkout, artifact);
  await removeWorktree(checkout);
  await disposeScratchRepo(repo);
}

describe('the adapter git env is an allowlist (#120 r3 F1)', () => {
  const saved = new Map<string, string | undefined>();
  let bait: Bait;
  let scratchBase: string;

  beforeEach(async () => {
    for (const key of HOSTILE_KEYS) saved.set(key, process.env[key]);
    bait = await plantBait();
    scratchBase = await mkdtemp(join(tmpdir(), 'atrium-gitenv-'));
    // The secrets a real server carries. None may reach a git child.
    process.env.ATRIUM_TEST_SENTINEL_SECRET = SENTINEL;
    process.env.DATABASE_URL = `postgres://user:${SENTINEL}@db/atrium`;
    process.env.BETTER_AUTH_SECRET = SENTINEL;
  });

  afterEach(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    await rm(bait.base, { recursive: true, force: true }).catch(() => {});
    await rm(scratchBase, { recursive: true, force: true }).catch(() => {});
  });

  it('carries ONLY the allowlist — no secret reaches a git process', async () => {
    const env = await scrubbedGitBaseEnv();
    // Stated INDEPENDENTLY of the implementation's own constant, deliberately: a
    // test that imports the allowlist it is checking proves only self-agreement.
    // Widening the real allowlist must fail here until somebody widens this too.
    const permitted = new Set<string>([
      'PATH',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TZ',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_TERMINAL_PROMPT',
      'HOME',
    ]);
    expect(Object.keys(env).filter((key) => !permitted.has(key))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(SENTINEL);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it('refuses an inherited GIT_CONFIG_PARAMETERS core.hooksPath', async () => {
    process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath'='${bait.hooksDir}'`;
    await runFullGitPath(scratchBase);
    const log = await firedLog(bait);
    expect(log, `attacker hook FIRED:\n${log ?? ''}`).toBeNull();
  });

  it('refuses an inherited GIT_CONFIG_COUNT/KEY/VALUE core.hooksPath', async () => {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = bait.hooksDir;
    await runFullGitPath(scratchBase);
    const log = await firedLog(bait);
    expect(log, `attacker hook FIRED:\n${log ?? ''}`).toBeNull();
  });

  it('refuses an inherited GIT_TEMPLATE_DIR that installs hooks at init', async () => {
    process.env.GIT_TEMPLATE_DIR = bait.templateDir;
    await runFullGitPath(scratchBase);
    const log = await firedLog(bait);
    expect(log, `attacker hook FIRED:\n${log ?? ''}`).toBeNull();
  });
});
