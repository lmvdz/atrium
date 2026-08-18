import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodeYElectricDocFrame } from '@/lib/room-replica-manager';

/* ═══════════════════════════════════════════════════════════════════════════
 * #220 / T6 — the y-electric document-update FRAME decode.
 *
 * `ydoc_updates.op` is NOT a bare Yjs update: the y-electric transport PUTs
 * `writeVarUint8Array(update)` — a lib0 varUint length prefix + the raw update. The
 * server replica reads the same column and must strip the prefix (exactly as the
 * client's `readVarUint8Array` does) before `Y.applyUpdate`. Without it every fold
 * throws and the replica never advances (the certify → `replica_lagging` bug this
 * decode fixes). These pin the decode against a REAL Yjs update and the exact
 * lib0 `writeVarUint8Array` framing.
 * ═════════════════════════════════════════════════════════════════════════ */

/** lib0 `writeVarUint8Array`: unsigned-LEB128 length prefix, then the bytes. */
function frame(update: Uint8Array): Uint8Array {
  const prefix: number[] = [];
  let n = update.length;
  while (n > 0x7f) {
    prefix.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  prefix.push(n);
  const out = new Uint8Array(prefix.length + update.length);
  out.set(prefix, 0);
  out.set(update, prefix.length);
  return out;
}

describe('decodeYElectricDocFrame strips the y-electric varUint frame', () => {
  it('round-trips a real Yjs update through the frame (short length, single prefix byte)', () => {
    const doc = new Y.Doc();
    doc.getArray('m').push(['{"id":"x","time":"12:00","kind":"human"}']);
    const update = Y.encodeStateAsUpdate(doc);
    expect(update.length).toBeLessThan(128); // one prefix byte

    const decoded = decodeYElectricDocFrame(frame(update));
    expect(Array.from(decoded)).toEqual(Array.from(update));

    // And it actually applies to a fresh doc, reproducing the content.
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, decoded);
    expect(fresh.getArray('m').get(0)).toContain('"kind":"human"');
  });

  it('round-trips a LARGE update whose length needs a multi-byte varUint prefix', () => {
    const doc = new Y.Doc();
    // A big body forces the update past 127 bytes → a 2+ byte varUint prefix.
    doc.getArray('m').push([`{"id":"x","text":"${'z'.repeat(500)}"}`]);
    const update = Y.encodeStateAsUpdate(doc);
    expect(update.length).toBeGreaterThan(127);

    const decoded = decodeYElectricDocFrame(frame(update));
    expect(Array.from(decoded)).toEqual(Array.from(update));
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, decoded);
    expect(String(fresh.getArray('m').get(0))).toContain('z'.repeat(500));
  });

  it('a bare (unframed) Yjs update is REFUSED, not silently misread (fail-closed)', () => {
    // A bare update fed to the decoder either throws (declared length exceeds the
    // frame) or yields bytes that are NOT the original — never a silent false fold.
    const doc = new Y.Doc();
    doc.getArray('m').push(['{"id":"x"}']);
    const bare = Y.encodeStateAsUpdate(doc);
    let mismatchedOrThrew = false;
    try {
      const decoded = decodeYElectricDocFrame(bare);
      mismatchedOrThrew = Array.from(decoded).join(',') !== Array.from(bare).join(',');
    } catch {
      mismatchedOrThrew = true;
    }
    expect(mismatchedOrThrew).toBe(true);
  });

  it('a truncated frame (declared length exceeds the bytes) throws — quarantined as poison', () => {
    const doc = new Y.Doc();
    doc.getArray('m').push(['{"id":"x"}']);
    const good = frame(Y.encodeStateAsUpdate(doc));
    const truncated = good.subarray(0, good.length - 3);
    expect(() => decodeYElectricDocFrame(truncated)).toThrow();
  });
});
