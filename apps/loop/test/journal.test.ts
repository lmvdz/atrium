import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCauseSettled, OutcomeJournal } from '../src/journal.js';

/**
 * The durable outcome journal (#139 resolution 2, #148). Four properties matter
 * and all are exercised here: it RECONSTRUCTS on reload (a fresh process reads
 * the same cursor and per-cause state); it draws the line between a TERMINAL
 * cause (a replay skips it) and a mid-flight one (a replay resumes it) — the
 * whole basis of the crash-replay guarantee; it FAILS CLOSED on a corrupt /
 * wrong-room / non-monotonic record (#148 FIX 2); and it COMPACTS crash-safely
 * so the log stays bounded while every idempotency fact survives (#148 FIX 3).
 */

const ROOM = 'room-1111-2222-3333';
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
  return OutcomeJournal.open(path, ROOM);
}

describe('reconstruction on reload', () => {
  it('rebuilds the cursor, causes, plans, and sessions from the file', async () => {
    let j = await OutcomeJournal.open(path, ROOM);
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
    const j = await OutcomeJournal.open(path, ROOM);
    await j.record({ roomSeq: 3, outcome: { kind: 'ignored', cause: 'x' } });
    await j.record({ roomSeq: 4, outcome: { kind: 'advance' } });
    expect(j.cursor).toBe(4);
    await j.close();
  });
});

describe('terminal vs mid-flight — the replay decision', () => {
  it('a plan_requested cause is NOT settled: a replay must resume the draw', async () => {
    // This is the crash window: open_plan journaled, the draw outcome not yet.
    let j = await OutcomeJournal.open(path, ROOM);
    await j.record({ roomSeq: 5, outcome: { kind: 'plan_requested', cause: 'g1' } });
    j = await reopen(j);
    expect(isCauseSettled(j.causes.get('g1'))).toBe(false);
    await j.close();
  });

  it('a drawn / refused / funded / steered / answered / ignored cause IS settled', async () => {
    const j = await OutcomeJournal.open(path, ROOM);
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
    let j = await OutcomeJournal.open(path, ROOM);
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
    const j = await OutcomeJournal.open(path, ROOM);
    await j.record({ roomSeq: 9, outcome: { kind: 'ignored', cause: 'z' } });
    // The file already holds the header line and the record line (both fsync'd).
    const contents = await readFile(path, 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(2); // header + one record
    expect(JSON.parse(lines[0] as string)).toMatchObject({ v: 1, roomId: ROOM });
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      roomSeq: 9,
      outcome: { kind: 'ignored' },
    });
    await j.close();
  });
});

describe('FIX 2 — fail closed on a journal it cannot trust', () => {
  it('refuses to start on a corrupt-but-valid-JSON record (an unknown outcome kind)', async () => {
    const j = await OutcomeJournal.open(path, ROOM);
    await j.record({ roomSeq: 5, outcome: { kind: 'ignored', cause: 'real' } });
    await j.close();
    // Valid JSON, valid roomSeq, but not a known record — the old reader cast it
    // and advanced the cursor to 999, silently skipping every event under it.
    const forged = `${JSON.stringify({ roomSeq: 999, outcome: { kind: 'teleport' } })}\n`;
    await writeFile(path, (await readFile(path, 'utf8')) + forged);
    await expect(OutcomeJournal.open(path, ROOM)).rejects.toThrow();
  });

  it('refuses to start on a line that is not valid JSON', async () => {
    const j = await OutcomeJournal.open(path, ROOM);
    await j.record({ roomSeq: 5, outcome: { kind: 'ignored', cause: 'real' } });
    await j.close();
    await writeFile(path, `${await readFile(path, 'utf8')}{not json at all\n`);
    await expect(OutcomeJournal.open(path, ROOM)).rejects.toThrow(/unparseable/);
  });

  it('refuses to open a journal that belongs to another room', async () => {
    const j = await OutcomeJournal.open(path, ROOM);
    await j.record({ roomSeq: 5, outcome: { kind: 'ignored', cause: 'real' } });
    await j.close();
    // A different room's daemon must NOT fold this room's cursor/causes into itself.
    await expect(OutcomeJournal.open(path, 'a-different-room-9999')).rejects.toThrow(
      /belongs to room/,
    );
  });

  it('refuses to start on a non-monotonic record (roomSeq moving backward)', async () => {
    const j = await OutcomeJournal.open(path, ROOM);
    await j.record({ roomSeq: 10, outcome: { kind: 'ignored', cause: 'real' } });
    await j.close();
    const backward = `${JSON.stringify({ roomSeq: 3, outcome: { kind: 'advance' } })}\n`;
    await writeFile(path, (await readFile(path, 'utf8')) + backward);
    await expect(OutcomeJournal.open(path, ROOM)).rejects.toThrow(/non-monotonic/);
  });

  it('refuses to start on a header that is missing or the wrong version', async () => {
    // A file whose first line is a record, not a header, is a wrong-format journal.
    await writeFile(path, `${JSON.stringify({ roomSeq: 1, outcome: { kind: 'advance' } })}\n`);
    await expect(OutcomeJournal.open(path, ROOM)).rejects.toThrow();
  });
});

describe('FIX 3 — crash-safe compaction keeps the log bounded and the state whole', () => {
  it('compacts after the threshold, bounding size, and replay reconstructs the same state', async () => {
    const j = await OutcomeJournal.open(path, ROOM, { compactEvery: 50 });
    // A processed, settled cause BEFORE compaction — the idempotency fact that
    // must survive the rewrite (its message must still be skipped afterward).
    await j.record({
      roomSeq: 1,
      outcome: { kind: 'draw_taken', cause: 'pre-compaction', planId: 'pA', retry: false },
    });
    await j.record({
      roomSeq: 2,
      outcome: { kind: 'session_opened', cause: 'pre-compaction', sessionId: 'sA', planId: 'pA' },
    });
    // Then a long run of bare advances — the quiet-room event that would grow the
    // log without bound. These trigger a compaction.
    for (let seq = 3; seq < 400; seq += 1) {
      await j.record({ roomSeq: seq, outcome: { kind: 'advance' } });
    }
    const compactedSize = (await stat(path)).size;
    const lineCount = (await readFile(path, 'utf8')).trim().split('\n').length;
    // Compaction ran: the on-disk log is a header + a snapshot + a short tail, not
    // ~400 record lines. Bounded, not linear in events processed.
    expect(lineCount).toBeLessThan(60);
    expect(compactedSize).toBeLessThan(4096);

    // Replay after compaction reconstructs the identical idempotency state.
    const reopened = await OutcomeJournal.open(path, ROOM, { compactEvery: 50 });
    expect(reopened.cursor).toBe(399);
    // The pre-compaction cause is still present and settled — its message is still
    // skipped, exactly as before compaction.
    expect(isCauseSettled(reopened.causes.get('pre-compaction'))).toBe(true);
    expect(reopened.causes.get('pre-compaction')?.step).toBe('draw_taken');
    expect(reopened.sessions.get('sA')).toBe('pA');
    const plan = reopened.plans.get('pA');
    expect(plan?.sessions.has('sA')).toBe(true);
    await reopened.close();
    await j.close();
  });

  it('a snapshot followed by fresh events folds both, in order', async () => {
    const j = await OutcomeJournal.open(path, ROOM, { compactEvery: 10 });
    await j.record({ roomSeq: 1, outcome: { kind: 'ignored', cause: 'old' } });
    for (let seq = 2; seq <= 15; seq += 1) {
      await j.record({ roomSeq: seq, outcome: { kind: 'advance' } });
    }
    // Post-compaction event.
    await j.record({ roomSeq: 16, outcome: { kind: 'ignored', cause: 'new' } });
    const reopened = await OutcomeJournal.open(path, ROOM);
    expect(isCauseSettled(reopened.causes.get('old'))).toBe(true);
    expect(isCauseSettled(reopened.causes.get('new'))).toBe(true);
    expect(reopened.cursor).toBe(16);
    await reopened.close();
    await j.close();
  });
});
