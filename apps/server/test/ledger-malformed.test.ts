import { randomUUID } from 'node:crypto';
import type { Database } from '@atrium/db';
import { describe, expect, it } from 'vitest';
import { createLedger, isMalformedEntry } from '../src/ledger.js';
import type { Logger } from '../src/logger.js';

/**
 * #46 — a malformed ledger row is survivable at read: skipped-and-reported, not
 * fatal.
 *
 * This is the unit seam the acceptance criterion rests on. It drives `catchUp`
 * (through `sync`, which is `catchUp` under the in-process lock) against a fake
 * database whose page contains a row whose payload does not satisfy `RoomEvent`
 * — a `message_posted` with `body: ""`, the exact `z.string().min(1)` violation
 * the ticket names — sitting between two readable rows.
 *
 * ## The mutation-red guard
 *
 * The test **`skips and reports a malformed row without throwing, folding the
 * rest`** is the one that goes red if the safe-skip is removed: restoring
 * `RoomEvent.parse` (which throws) in `parseRow` makes `sync()` reject on the
 * bad row instead of returning it as a marker, and every assertion below is
 * downstream of `sync()` resolving. It fails by name.
 */

/** The row shape `catchUp` selects — the keys of the module's `ROW` projection. */
interface FakeRow {
  seq: number;
  roomSeq: number;
  roomId: string;
  payload: unknown;
  actorKind: string;
  actorId: string | null;
  trustedMessages: unknown;
  occurredAt: string;
}

/**
 * A database whose `select(...).from(...).where(...).orderBy(...).limit(...)`
 * chain resolves to a fixed page. `catchUp` breaks its loop as soon as a page
 * comes back shorter than `PAGE` (500), so one short page is one pass.
 */
function fakeDatabase(rows: FakeRow[]): Database {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => query } as unknown as Database;
}

interface Captured {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

function capturingLogger(): { logger: Logger; lines: Captured[] } {
  const lines: Captured[] = [];
  const record =
    (level: Captured['level']) => (message: string, fields?: Record<string, unknown>) =>
      void lines.push({ level, message, fields });
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    lines,
  };
}

function messageRow(seq: number, body: string, overrides: Partial<FakeRow> = {}): FakeRow {
  const roomId = overrides.roomId ?? randomUUID();
  const at = new Date(1_700_000_000_000 + seq * 1000).toISOString();
  return {
    seq,
    roomSeq: seq,
    roomId,
    payload: {
      id: randomUUID(),
      at,
      type: 'message_posted',
      roomId,
      messageId: randomUUID(),
      body,
    },
    actorKind: 'human',
    actorId: randomUUID(),
    trustedMessages: null,
    // `occurred_at` is pinned to `payload.at` by a CHECK in production; mirror it.
    occurredAt: at,
    ...overrides,
  };
}

describe('#46 malformed rows are survivable at read', () => {
  it('skips and reports a malformed row without throwing, folding the rest', async () => {
    const rows = [
      messageRow(1, 'first is fine'),
      // body: "" violates z.string().min(1); SQL runs no zod, so it landed.
      messageRow(2, ''),
      messageRow(3, 'third still arrives'),
    ];
    const { logger, lines } = capturingLogger();
    const ledger = createLedger({ db: fakeDatabase(rows), logger });

    // The whole point: this resolves rather than rejecting. Restore the throw in
    // parseRow and this line rejects, failing the test by name.
    const folded = await ledger.sync();

    expect(folded).toHaveLength(3);
    expect(folded[0]?.kind).toBe('event');
    expect(folded[2]?.kind).toBe('event');

    const malformed = folded.filter(isMalformedEntry);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.seq).toBe(2);
    expect(malformed[0]?.roomSeq).toBe(2);
    expect(malformed[0]?.reason).toMatch(/body/);

    // Counted for the operator, and logged once, naming which row and why.
    expect(ledger.malformedCount()).toBe(1);
    const warned = lines.filter((line) => line.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({ seq: 2, reason: expect.stringContaining('body') });
  });

  it('does not double-report the same malformed row across repeated folds', async () => {
    const rows = [messageRow(1, ''), messageRow(2, 'fine')];
    const { logger, lines } = capturingLogger();
    const ledger = createLedger({ db: fakeDatabase(rows), logger });

    await ledger.sync();
    // A second fold advances from the same lastSeq; catchUp reads strictly past
    // it, so the bad row is not revisited and the WARN is not repeated.
    await ledger.sync();

    expect(ledger.malformedCount()).toBe(1);
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
  });

  it('hydrate completes over a page holding a malformed row', async () => {
    const rows = [messageRow(1, 'a'), messageRow(2, ''), messageRow(3, 'c')];
    const { logger } = capturingLogger();
    const ledger = createLedger({ db: fakeDatabase(rows), logger });

    await expect(ledger.hydrate()).resolves.toBeUndefined();
    expect(ledger.malformedCount()).toBe(1);
    expect(ledger.lastSeq()).toBe(3);
  });

  /**
   * #46, HIGH 3 — a drifted `actor_kind` on an otherwise-valid payload used to
   * `throw` from `actorFromColumns` inside `parseRow`, re-crashing every read the
   * same way an unparseable payload did, one column over.
   *
   * This is a mutation-red guard for HIGH 3: reverting `parseRow` to call the
   * throwing `actorFromColumns` makes `sync()` reject on the drifted row and this
   * test fails by name.
   */
  it('reads a corrupt actor_kind as a malformed marker without throwing', async () => {
    const rows = [
      messageRow(1, 'fine'),
      // A valid payload whose actor_kind is not one the enum has — a drifted or
      // corrupt column. The payload parses; the actor does not.
      messageRow(2, 'valid payload, drifted actor', { actorKind: 'wizard' }),
      messageRow(3, 'still fine'),
    ];
    const { logger } = capturingLogger();
    const ledger = createLedger({ db: fakeDatabase(rows), logger });

    const folded = await ledger.sync();

    expect(folded).toHaveLength(3);
    const malformed = folded.filter(isMalformedEntry);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.seq).toBe(2);
    expect(malformed[0]?.reason).toMatch(/actor_kind/);
    expect(ledger.malformedCount()).toBe(1);
  });

  /**
   * grok's `trusted_messages` nuance, adjudicated: a bad receipt window discards
   * an otherwise-valid payload's fold ONLY when the window is load-bearing for
   * that event kind. The reducer reads the window for exactly one kind
   * (`object_accepted`), so a `message_posted` — which never consults it — folds
   * with the bad window dropped and reported, rather than losing a good event.
   */
  it('folds a valid non-acceptance event whose trusted_messages window is unreadable', async () => {
    const rows = [
      messageRow(1, 'before'),
      // A window that does not satisfy ProvenanceMessage[] on a kind that never
      // reads one. Under round 1 this marked the whole row malformed.
      messageRow(2, 'valid message, bad window', {
        trustedMessages: [{ id: 42 }] as unknown as FakeRow['trustedMessages'],
      }),
      messageRow(3, 'after'),
    ];
    const { logger, lines } = capturingLogger();
    const ledger = createLedger({ db: fakeDatabase(rows), logger });

    const folded = await ledger.sync();

    // All three folded as events; nothing was marked malformed.
    expect(folded.map((entry) => entry.kind)).toEqual(['event', 'event', 'event']);
    expect(ledger.malformedCount()).toBe(0);
    // The bad window was still reported, once, so an operator sees it.
    const warned = lines.filter(
      (line) => line.level === 'warn' && /trusted_messages/.test(line.message),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({ seq: 2 });
  });
});
