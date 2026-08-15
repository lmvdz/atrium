import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCauseSettled, OutcomeJournal } from '../src/journal.js';

/**
 * The durable outcome journal (#139 resolution 2, #148). Two properties matter
 * and both are exercised here: it RECONSTRUCTS on reload (a fresh process reads
 * the same cursor and per-cause state), and it draws the line between a TERMINAL
 * cause (a replay skips it) and a mid-flight one (a replay resumes it) — which is
 * the whole basis of the crash-replay guarantee.
 */

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atrium-loop-journal-'));
  path = join(dir, 'loop.journal');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function reopen(journal: OutcomeJournal): Promise<OutcomeJournal> {
  await journal.close();
  return OutcomeJournal.open(path);
}

describe('reconstruction on reload', () => {
  it('rebuilds the cursor, causes, plans, and sessions from the file', async () => {
    let j = await OutcomeJournal.open(path);
    await j.record({ roomSeq: 5, outcome: { kind: 'plan_requested', cause: 'g1' } });
    await j.record({
      roomSeq: 6,
      outcome: { kind: 'draw_taken', cause: 'g1', planId: 'p1', retry: false },
    });
    await j.record({
      roomSeq: 7,
      outcome: { kind: 'session_opened', cause: 'g1', sessionId: 's1', planId: 'p1' },
    });
    await j.record({
      roomSeq: 8,
      outcome: { kind: 'session_terminal', sessionId: 's1', planId: 'p1' },
    });

    j = await reopen(j);
    expect(j.cursor).toBe(8);
    expect(j.causes.get('g1')?.step).toBe('draw_taken');
    expect(j.causes.get('g1')?.planId).toBe('p1');
    expect(j.sessions.get('s1')).toBe('p1');
    const plan = j.plans.get('p1');
    expect(plan?.sessions.has('s1')).toBe(true);
    expect(plan?.terminal.has('s1')).toBe(true);
    expect(plan?.settled).toBe(false);
    await j.close();
  });

  it('the cursor is the max roomSeq seen, monotonic across an advance', async () => {
    const j = await OutcomeJournal.open(path);
    await j.record({ roomSeq: 3, outcome: { kind: 'ignored', cause: 'x' } });
    await j.record({ roomSeq: 4, outcome: { kind: 'advance' } });
    expect(j.cursor).toBe(4);
    await j.close();
  });
});

describe('terminal vs mid-flight — the replay decision', () => {
  it('a plan_requested cause is NOT settled: a replay must resume the draw', async () => {
    // This is the crash window: open_plan journaled, the draw outcome not yet.
    let j = await OutcomeJournal.open(path);
    await j.record({ roomSeq: 5, outcome: { kind: 'plan_requested', cause: 'g1' } });
    j = await reopen(j);
    expect(isCauseSettled(j.causes.get('g1'))).toBe(false);
    await j.close();
  });

  it('a drawn / refused / funded / steered / answered / ignored cause IS settled', async () => {
    const j = await OutcomeJournal.open(path);
    await j.record({
      roomSeq: 1,
      outcome: { kind: 'draw_taken', cause: 'a', planId: 'p', retry: false },
    });
    await j.record({ roomSeq: 2, outcome: { kind: 'draw_refused', cause: 'b', planId: 'p' } });
    await j.record({ roomSeq: 3, outcome: { kind: 'funded_terminal', cause: 'c', planId: 'p' } });
    await j.record({ roomSeq: 4, outcome: { kind: 'steered', cause: 'd', sessionId: 's' } });
    await j.record({ roomSeq: 5, outcome: { kind: 'answered', cause: 'e', clientMessageId: 'k' } });
    await j.record({ roomSeq: 6, outcome: { kind: 'ignored', cause: 'f' } });
    for (const cause of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(isCauseSettled(j.causes.get(cause))).toBe(true);
    }
    await j.close();
  });

  it('a budget-refused draw records retryable=false until a retry marks it', async () => {
    let j = await OutcomeJournal.open(path);
    await j.record({ roomSeq: 2, outcome: { kind: 'draw_refused', cause: 'b', planId: 'p' } });
    j = await reopen(j);
    expect(j.causes.get('b')?.retried).toBe(false);
    // The single post-funding retry marks it, so a second funding will not re-route.
    await j.record({
      roomSeq: 4,
      outcome: { kind: 'draw_taken', cause: 'b', planId: 'p', retry: true },
    });
    expect(j.causes.get('b')?.retried).toBe(true);
    expect(j.causes.get('b')?.step).toBe('draw_taken');
    await j.close();
  });
});

describe('durability', () => {
  it('every record is on disk before its cursor advance is visible', async () => {
    const j = await OutcomeJournal.open(path);
    await j.record({ roomSeq: 9, outcome: { kind: 'ignored', cause: 'z' } });
    // The file already holds the line (fsync'd inside record, before this read).
    const contents = await readFile(path, 'utf8');
    expect(contents.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(contents.trim())).toMatchObject({ roomSeq: 9, outcome: { kind: 'ignored' } });
    await j.close();
  });
});
