import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

/**
 * CLI coverage that never touches the network: the fetch commands are proven
 * against fixtures in `github-thread.test.ts`, so what is exercised here is
 * argument handling, file writing, and the `--check` idempotence gate.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const TRANSCRIPT = join(HERE, 'fixtures', 'transcript.md');

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'atrium-ingest-'));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(workdir, { recursive: true, force: true });
});

describe('main', () => {
  it('prints usage and exits non-zero with no arguments', async () => {
    await expect(main([])).resolves.toBe(2);
  });

  it('prints usage and exits zero for --help', async () => {
    await expect(main(['--help'])).resolves.toBe(0);
  });

  it('lists the registered sources', async () => {
    await expect(main(['list'])).resolves.toBe(0);
  });

  it('rejects an unknown source by name', async () => {
    await expect(main(['no-such-source'])).rejects.toThrow(/unknown source/);
  });

  it('validates the committed corpora by default', async () => {
    const cwd = process.cwd();
    process.chdir(REPO_ROOT);
    try {
      await expect(main(['validate'])).resolves.toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it('reports a broken corpus file with a non-zero exit code', async () => {
    const broken = join(workdir, 'broken.jsonl');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(broken, '{"id":"a","author":"alice","ts":"nope","text":"x"}\n', 'utf8'),
    );
    await expect(main(['validate', broken])).resolves.toBe(1);
  });

  it('converts a markdown transcript to a file and is idempotent under --check', async () => {
    const out = join(workdir, 'transcript.jsonl');
    await expect(main(['markdown', TRANSCRIPT, '--out', out])).resolves.toBe(0);
    const first = await readFile(out, 'utf8');
    expect(first.split('\n').filter(Boolean)).toHaveLength(5);

    await expect(main(['markdown', TRANSCRIPT, '--out', out])).resolves.toBe(0);
    expect(await readFile(out, 'utf8')).toBe(first);
    await expect(main(['markdown', TRANSCRIPT, '--out', out, '--check'])).resolves.toBe(0);
  });

  it('fails --check when the file on disk is missing or would change', async () => {
    const missing = join(workdir, 'nope.jsonl');
    await expect(main(['markdown', TRANSCRIPT, '--out', missing, '--check'])).resolves.toBe(1);

    const drifted = join(workdir, 'drifted.jsonl');
    await import('node:fs/promises').then((fs) => fs.writeFile(drifted, 'stale\n', 'utf8'));
    await expect(main(['markdown', TRANSCRIPT, '--out', drifted, '--check'])).resolves.toBe(1);
  });

  it('honours --source-id when namespacing markdown ids', async () => {
    const out = join(workdir, 'named.jsonl');
    await main(['markdown', TRANSCRIPT, '--out', out, '--source-id', 'sync-2024-03-01']);
    expect(await readFile(out, 'utf8')).toContain('"id":"md:sync-2024-03-01:0001"');
  });

  it('requires a file for the markdown command', async () => {
    await expect(main(['markdown'])).rejects.toThrow(/usage/);
  });
});
