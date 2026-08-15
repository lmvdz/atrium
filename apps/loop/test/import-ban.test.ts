import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * THE IMPORT-BAN, WITNESSED (#148).
 *
 * The covenant obligation is that apps/loop talks to the server only over the
 * wire — it must NOT reach into apps/server (or apps/web, or @atrium/db, or
 * @atrium/auth). That obligation is a biome `noRestrictedImports` override scoped
 * to `apps/loop/**`.
 *
 * A lint rule that is never exercised is decoration. This test is the RED-ON-
 * REVERT witness: it writes a real `.ts` file into `apps/loop/src` containing a
 * forbidden import, runs the SAME `biome check` the gate runs, and asserts it
 * reds ON THAT RULE. Delete the override from biome.json and this test fails —
 * which is exactly what "red-on-revert" means. A control file with only allowed
 * imports proves the rule is specific, not a blanket ban on all imports.
 *
 * The file is written under `apps/loop/src` (not `test`) because the override is
 * scoped there; a fixture placed anywhere else would test a different path than
 * the one the ban protects.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const biome = fileURLToPath(new URL('../../../node_modules/.bin/biome', import.meta.url));

const written: string[] = [];

afterEach(async () => {
  for (const path of written.splice(0)) await rm(path, { force: true });
});

async function checkFixture(contents: string): Promise<{ code: number; output: string }> {
  const path = `${SRC_DIR}__import_ban_fixture_${randomUUID()}.ts`;
  written.push(path);
  await writeFile(path, contents, 'utf8');
  try {
    await run(biome, ['check', path], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, output: '' };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('the apps/loop import ban reds on a forbidden import', () => {
  it('reds on a relative reach into apps/server, naming noRestrictedImports', async () => {
    const { code, output } = await checkFixture(
      "import { createCommandService } from '../../server/src/commands.js';\nvoid createCommandService;\n",
    );
    expect(code).not.toBe(0);
    expect(output).toContain('noRestrictedImports');
  });

  it('reds on the bare @atrium/server specifier', async () => {
    const { code, output } = await checkFixture(
      "import * as server from '@atrium/server';\nvoid server;\n",
    );
    expect(code).not.toBe(0);
    expect(output).toContain('noRestrictedImports');
  });

  it('reds on a reach into @atrium/db (schema isolation)', async () => {
    const { code, output } = await checkFixture(
      "import { plans } from '@atrium/db';\nvoid plans;\n",
    );
    expect(code).not.toBe(0);
    expect(output).toContain('noRestrictedImports');
  });

  it('is SPECIFIC: a file importing only allowed modules passes', async () => {
    // The control. If this reds too, the ban is a blanket "no imports" rule and
    // proves nothing about the server boundary in particular.
    const { code, output } = await checkFixture(
      "import { z } from 'zod';\nexport const s = z.string();\n",
    );
    expect(output).not.toContain('noRestrictedImports');
    expect(code).toBe(0);
  });
});
