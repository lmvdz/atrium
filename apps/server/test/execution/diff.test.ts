import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorktree,
  commitWorktree,
  createScratchRepo,
  diffWorktree,
  disposeScratchRepo,
  MAX_DIFF_FILES,
  MAX_DIFF_LINES,
  removeWorktree,
  type ScratchRepo,
  type WorktreeCheckout,
} from '../../src/execution/git.js';

/**
 * THE REAL STRUCTURED DIFF (#145) — computed from git, not a stub.
 *
 * These are the producer-side red/green witnesses the ticket asks for: the hunks
 * carry the EXACT changed lines, flip-the-input moves them, an unchanged checkout
 * is an HONEST EMPTY (not absent), a rename/binary is classified honestly, and a
 * huge diff is CAPPED with totals that still describe the whole. A `diffWorktree`
 * that returned a canned constant fails the first two; one that dropped the cap
 * fails the last two.
 */

let repo: ScratchRepo;

beforeEach(async () => {
  repo = await createScratchRepo();
});

afterEach(async () => {
  await disposeScratchRepo(repo);
});

async function checkoutWith(mutate: (dir: string) => Promise<void>): Promise<WorktreeCheckout> {
  const co = await addWorktree(repo, randomUUID());
  await mutate(co.dir);
  await commitWorktree(co, 'test change');
  return co;
}

describe('diffWorktree computes the real structured diff', () => {
  it('carries the exact added hunks of a new file', async () => {
    const co = await checkoutWith(async (dir) => {
      await writeFile(join(dir, 'greeting.txt'), 'hello\nworld\n');
    });
    const diff = await diffWorktree(co);
    await removeWorktree(co);

    expect(diff.files).toHaveLength(1);
    const file = diff.files[0];
    expect(file?.path).toBe('greeting.txt');
    expect(file?.status).toBe('added');
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
    expect(file?.binary).toBe(false);
    const body = (file?.hunks ?? []).flatMap((h) => h.lines).join('\n');
    // The EXACT lines, with git's own markers — not a summary.
    expect(body).toContain('+hello');
    expect(body).toContain('+world');
    expect((file?.hunks[0]?.header ?? '').startsWith('@@')).toBe(true);

    expect(diff.fileCount).toBe(1);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.truncated).toBe(false);
  });

  it('renders a modification as context + added/removed lines against the seeded base', async () => {
    const co = await checkoutWith(async (dir) => {
      const current = await readFile(join(dir, 'README.atrium'), 'utf8');
      await writeFile(join(dir, 'README.atrium'), `${current}a new trailing line\n`);
    });
    const diff = await diffWorktree(co);
    await removeWorktree(co);

    expect(diff.files).toHaveLength(1);
    const file = diff.files[0];
    expect(file?.path).toBe('README.atrium');
    expect(file?.status).toBe('modified');
    expect(file?.additions).toBe(1);
    const body = (file?.hunks ?? []).flatMap((h) => h.lines).join('\n');
    expect(body).toContain('+a new trailing line');
    // A modification carries CONTEXT (a leading-space line), not only the change.
    expect((file?.hunks ?? []).some((h) => h.lines.some((l) => l.startsWith(' ')))).toBe(true);
  });

  it('an unchanged checkout is an HONEST EMPTY — not absent', async () => {
    const co = await addWorktree(repo, randomUUID());
    const diff = await diffWorktree(co);
    await removeWorktree(co);
    // PRESENT with no files — the producer computed a diff and it was empty. The
    // caller carries this as present-but-empty, distinct from never reporting one.
    expect(diff.files).toEqual([]);
    expect(diff.fileCount).toBe(0);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(diff.truncated).toBe(false);
  });

  it('flips the input: a different edit yields different hunks (a constant would fail)', async () => {
    const a = await checkoutWith(async (dir) => {
      await writeFile(join(dir, 'f.txt'), 'alpha\n');
    });
    const b = await checkoutWith(async (dir) => {
      await writeFile(join(dir, 'f.txt'), 'bravo\n');
    });
    const da = await diffWorktree(a);
    const db = await diffWorktree(b);
    await removeWorktree(a);
    await removeWorktree(b);

    const bodyA = da.files
      .flatMap((f) => f.hunks)
      .flatMap((h) => h.lines)
      .join('\n');
    const bodyB = db.files
      .flatMap((f) => f.hunks)
      .flatMap((h) => h.lines)
      .join('\n');
    expect(bodyA).toContain('+alpha');
    expect(bodyB).toContain('+bravo');
    expect(bodyA).not.toBe(bodyB);
  });

  it('classifies a rename via --find-renames, carrying the old path', async () => {
    const co = await checkoutWith(async (dir) => {
      const content = await readFile(join(dir, 'README.atrium'), 'utf8');
      await rm(join(dir, 'README.atrium'));
      await writeFile(join(dir, 'RENAMED.atrium'), content);
    });
    const diff = await diffWorktree(co);
    await removeWorktree(co);

    expect(diff.files).toHaveLength(1);
    const file = diff.files[0];
    expect(file?.status).toBe('renamed');
    expect(file?.path).toBe('RENAMED.atrium');
    expect(file?.oldPath).toBe('README.atrium');
  });

  it('classifies a binary file honestly and carries no textual hunks', async () => {
    const co = await checkoutWith(async (dir) => {
      await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 3, 0]));
    });
    const diff = await diffWorktree(co);
    await removeWorktree(co);

    const file = diff.files.find((f) => f.path === 'blob.bin');
    expect(file?.binary).toBe(true);
    expect(file?.hunks).toEqual([]);
  });

  it('CAPS a diff with too many files — retained prefix, honest whole-diff totals', async () => {
    const extra = 6;
    const co = await checkoutWith(async (dir) => {
      for (let i = 0; i < MAX_DIFF_FILES + extra; i++) {
        await writeFile(join(dir, `file-${String(i).padStart(3, '0')}.txt`), `content ${i}\n`);
      }
    });
    const diff = await diffWorktree(co);
    await removeWorktree(co);

    // The carried files are the capped prefix; the totals describe the WHOLE diff.
    expect(diff.files).toHaveLength(MAX_DIFF_FILES);
    expect(diff.fileCount).toBe(MAX_DIFF_FILES + extra);
    expect(diff.truncated).toBe(true);
    expect(diff.additions).toBe(MAX_DIFF_FILES + extra);
  });

  it('CAPS a diff with too many lines — retained lines bounded, totals honest', async () => {
    const lines = MAX_DIFF_LINES + 250;
    const co = await checkoutWith(async (dir) => {
      await writeFile(
        join(dir, 'big.txt'),
        `${Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')}\n`,
      );
    });
    const diff = await diffWorktree(co);
    await removeWorktree(co);

    expect(diff.fileCount).toBe(1);
    // numstat reports the WHOLE file's additions, even though the hunks were cut.
    expect(diff.additions).toBe(lines);
    expect(diff.truncated).toBe(true);
    const kept = diff.files.flatMap((f) => f.hunks).reduce((n, h) => n + h.lines.length, 0);
    expect(kept).toBeLessThanOrEqual(MAX_DIFF_LINES);
  });
});
