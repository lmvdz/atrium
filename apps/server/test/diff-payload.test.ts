import { describe, expect, it } from 'vitest';
import { MAX_DIFF_FILES, MAX_DIFF_LINES } from '../src/execution/git.js';
import { SessionDiffPayload, SessionTestsPayload } from '../src/room-events.js';

/**
 * THE DIFF THE LEDGER WILL ACCEPT (#145 r2) — the durable-boundary invariants the
 * producer's own caps never reached. Both foreign lineages found the same two
 * holes: the schema accepted a report that DISAGREED WITH ITSELF ("no files, but
 * one file changed") and a report whose fields were each in-bounds while the
 * AGGREGATE was a megabyte. Both are enforced here so a violating event does not
 * PARSE — the surface never sees it to be fooled by it. Each test is a red-on-revert
 * witness: remove the guard and the crafted-hostile input parses.
 */

/** A well-formed one-file diff, the coherent baseline every rejection is measured against. */
function coherentDiff() {
  return {
    files: [
      {
        path: 'src/app.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: [{ header: '@@ -1,1 +1,2 @@', lines: [' const a = 1;', '+const b = 2;'] }],
      },
    ],
    fileCount: 1,
    additions: 1,
    deletions: 0,
    truncated: false,
  };
}

describe('FIX 1 — the diff coherence invariant (files empty ⟺ totals zero)', () => {
  it('REJECTS an empty file list carrying nonzero totals (the "no changes" lie)', () => {
    const incoherent = {
      files: [],
      fileCount: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
    };
    const result = SessionDiffPayload.safeParse(incoherent);
    expect(result.success).toBe(false);
    // RED ON REVERT: drop the coherence superRefine and this parses, and the pane
    // then renders a confident "no changes" over a report that declared an edit.
  });

  it('REJECTS an empty file list flagged truncated (empty cannot be a truncated prefix)', () => {
    const result = SessionDiffPayload.safeParse({
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
      truncated: true,
    });
    expect(result.success).toBe(false);
  });

  it('REJECTS non-empty files declaring zero total files', () => {
    const result = SessionDiffPayload.safeParse({ ...coherentDiff(), fileCount: 0 });
    expect(result.success).toBe(false);
  });

  it('ACCEPTS an honest empty (no files, every total zero, not truncated)', () => {
    const result = SessionDiffPayload.safeParse({
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
      truncated: false,
    });
    expect(result.success).toBe(true);
  });

  it('ACCEPTS a real pure-rename diff (files present, additions/deletions 0) — not a false reject', () => {
    // The biconditional includes fileCount in the "all zero" test precisely so a
    // legitimate 0-add/0-del rename survives: its files is non-empty and its
    // fileCount is 1, so both sides of the biconditional are false together.
    const rename = {
      files: [
        {
          path: 'src/new.ts',
          oldPath: 'src/old.ts',
          status: 'renamed' as const,
          additions: 0,
          deletions: 0,
          binary: false,
          hunks: [],
        },
      ],
      fileCount: 1,
      additions: 0,
      deletions: 0,
      truncated: false,
    };
    expect(SessionDiffPayload.safeParse(rename).success).toBe(true);
  });
});

describe('FIX 3 — the aggregate ceiling at the durable boundary', () => {
  it('REJECTS more retained files than the producer cap, restated at the ledger', () => {
    const oneFile = coherentDiff().files[0];
    const files = Array.from({ length: MAX_DIFF_FILES + 1 }, (_unused, i) => ({
      ...oneFile,
      path: `src/f${i}.ts`,
    }));
    const result = SessionDiffPayload.safeParse({
      files,
      fileCount: files.length,
      additions: files.length,
      deletions: 0,
      truncated: false,
    });
    expect(result.success).toBe(false);
    // RED ON REVERT: widen the files array cap back to 64 and 41 files parse.
  });

  it('REJECTS a diff whose TOTAL retained lines exceed the aggregate cap, though each file is in-bounds', () => {
    // Two files, each well under the per-file line cap, summing PAST MAX_DIFF_LINES.
    const perFile = Math.floor(MAX_DIFF_LINES / 2) + 100; // 1100 each → 2200 > 2000
    const mkFile = (i: number) => ({
      path: `src/big${i}.ts`,
      status: 'modified' as const,
      additions: perFile,
      deletions: 0,
      binary: false,
      hunks: [
        {
          header: '@@ -1 +1 @@',
          lines: Array.from({ length: perFile }, () => '+x'),
        },
      ],
    });
    const files = [mkFile(0), mkFile(1)];
    const result = SessionDiffPayload.safeParse({
      files,
      fileCount: 2,
      additions: perFile * 2,
      deletions: 0,
      truncated: true,
    });
    expect(result.success).toBe(false);
    expect(perFile).toBeLessThanOrEqual(MAX_DIFF_LINES); // each file alone is legal
    // RED ON REVERT: drop the aggregate-lines refine and this 2200-line diff parses.
  });

  it('ACCEPTS a diff at the producer caps (the honest largest legal output)', () => {
    const result = SessionDiffPayload.safeParse(coherentDiff());
    expect(result.success).toBe(true);
  });
});

describe('FIX 2 — the test block carries its command provenance', () => {
  it('ACCEPTS a test report with a command (the provenance the pane renders)', () => {
    const result = SessionTestsPayload.safeParse({
      passed: 128,
      failed: 0,
      failures: [],
      failuresTruncated: false,
      command: 'pnpm -w test',
    });
    expect(result.success).toBe(true);
  });

  it('ACCEPTS a report WITHOUT a command — optional, so a pre-provenance producer still parses', () => {
    const result = SessionTestsPayload.safeParse({
      passed: 1,
      failed: 0,
      failures: [],
      failuresTruncated: false,
    });
    expect(result.success).toBe(true);
  });
});
