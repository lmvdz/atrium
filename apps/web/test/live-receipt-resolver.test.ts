import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anchorCertifies, precomputedGlyphResolver } from '@/lib/covenant-read';
import type { ReplayData } from '../lib/replay-data';
import { replayReceiptSubject } from '../lib/replay-view';
import { workspacePath } from './support/workspace-path';

/* ═══════════════════════════════════════════════════════════════════════════
 * P6F-4 / #198 fix-round — THE LIVE RECEIPT PATH READS THE SAME AUTHORITY AS REPLAY.
 *
 * The gauntlet residual: `LiveRoomSession` threaded `glyphResolver` into
 * `liveRoomView` but called `replayReceiptSubject` WITHOUT it, while
 * `ReplaySession` passed it. `replayReceiptSubject` does not merely look a subject
 * up — for a subject absent from `view.objects` it RECONSTRUCTS one through
 * `stateForObject`, which derives the glyph from the resolver. Objectives are
 * excluded from `view.objects` by construction (`replayView` filters
 * `type !== 'objective'`), so an objective receipt ALWAYS takes the reconstructing
 * path — and on base it reconstructed with `resolver === undefined`, forcing `~`.
 *
 * The result was a split verdict on one object: `/replay` rendered the server's
 * `ok` as `✓`, the live room rendered the same receipt as `~`. A false NEGATIVE,
 * so nothing was over-certified — but "the same object, two glyphs, depending on
 * which surface you opened it from" is exactly the cross-surface inconsistency the
 * ONE read authority exists to forbid.
 *
 * Three assertions, in the order that makes the fix non-theatrical:
 *   1. The resolver is LOAD-BEARING on this path (flip the input, the glyph moves).
 *   2. The live call site actually PASSES it — the mutation check that fails on
 *      base 679af70, where the 4th argument is absent.
 *   3. Live and replay, driven from the SAME `data.covenantReads`, agree on every
 *      status: `ok` ⇒ `✓` on both, `drift` / absent / no-reads ⇒ `~` on both.
 * ═════════════════════════════════════════════════════════════════════════ */

const liveRoomSession = workspacePath('apps/web/app/app/[workspace]/[room]/LiveRoomSession.tsx');
const replaySession = workspacePath('apps/web/app/replay/[workspace]/[room]/ReplaySession.tsx');

const AT = new Date('2026-08-17T12:00:00.000Z');
const OBJECTIVE_ID = 'o_objective';

/**
 * A snapshot carrying ONE accepted objective and nothing else. `replayReceiptSubject`
 * reads exactly three fields (`participants`, `objects`, `proposals`), so the rest of
 * `ReplayData` is not reconstructed — the cast is over the untouched remainder, never
 * over anything the resolution depends on.
 */
function snapshotWith(reads: ReplayData['covenantReads']): ReplayData {
  return {
    participants: [{ id: 'alice', name: 'alice', avatarUrl: null, principalKind: 'human' }],
    proposals: [],
    objects: [
      {
        id: OBJECTIVE_ID,
        roomId: 'room',
        objectiveId: null,
        type: 'objective' as const,
        payload: { title: 'Choose a regeneration strategy.', status: 'open' as const },
        proposalId: null,
        sessionId: null,
        interpretationId: null,
        retractedAt: null,
        supersededById: null,
        // A REAL human acceptance — the provenance that used to be the tick. It is
        // present on purpose: the point of #181/SL-6 is that provenance alone no
        // longer mints `✓`, so with the authority saying `drift` this must stay `~`.
        humanTouchedAt: AT,
        acceptedByKind: 'human' as const,
        acceptedBy: 'alice',
        revision: 0,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    covenantReads: reads,
  } as unknown as ReplayData;
}

/** The LIVE surface's decision, reproduced exactly: resolver from `data.covenantReads`,
    threaded into the receipt-subject reconstruction. `view.objects` is empty of
    objectives by construction, which is what forces the reconstructing path. */
function liveReceiptVerification(reads: ReplayData['covenantReads']): string | undefined {
  const data = snapshotWith(reads);
  const subject = replayReceiptSubject(
    data,
    /* view.objects — objectives are filtered out of it */ [],
    OBJECTIVE_ID,
    precomputedGlyphResolver(data.covenantReads),
  );
  return subject?.state.verification;
}

describe('the live receipt subject is reconstructed through the covenant authority (#198)', () => {
  /**
   * Mutation: drop the resolver argument (base 679af70's live call). Every
   * reconstructed receipt subject then reports `proposed` — `~` — no matter what
   * the server resolved, and the resolver plumbing is ornament on this path.
   */
  it('the resolver decides the reconstructed glyph — flip it and the verdict moves', () => {
    const data = snapshotWith({ [OBJECTIVE_ID]: 'ok' });
    const withAuthority = replayReceiptSubject(
      data,
      [],
      OBJECTIVE_ID,
      precomputedGlyphResolver(data.covenantReads),
    );
    const withoutAuthority = replayReceiptSubject(data, [], OBJECTIVE_ID);

    // The subject IS reconstructed (it is not in `objects`), and it is the objective.
    expect(withAuthority?.id).toBe(OBJECTIVE_ID);
    expect(withAuthority?.kind).toBe('objective');

    expect(withAuthority?.state.verification).toBe('accepted'); // `✓`
    expect(withoutAuthority?.state.verification).toBe('proposed'); // `~` — base
    // …and the two disagree, which is precisely why the argument cannot be omitted.
    expect(withAuthority?.state.verification).not.toBe(withoutAuthority?.state.verification);
  });

  /**
   * Mutation: revert `LiveRoomSession`'s call to the 3-argument form. This is the
   * assertion that FAILS on base 679af70 — the seam above is correct there too; only
   * the caller was wrong, so only a caller assertion catches it.
   */
  it('LiveRoomSession passes the SAME resolver to replayReceiptSubject that liveRoomView reads', () => {
    const session = readFileSync(liveRoomSession, 'utf8');

    // One resolver, built once from the server-resolved read map.
    expect(session).toContain(
      'const glyphResolver = useMemo(\n    () => precomputedGlyphResolver(data.covenantReads),\n    [data.covenantReads],\n  );',
    );
    // …threaded into BOTH readers, by that same binding.
    expect(session).toContain(
      'liveRoomView(data, viewerId, live, frozenUnreadWindow, glyphResolver)',
    );
    expect(session).toContain('replayReceiptSubject(data, view.objects, receiptId, glyphResolver)');
    // The base form must be gone — a 3-argument call is the defect itself.
    expect(session).not.toContain('replayReceiptSubject(data, view.objects, receiptId)');

    // Replay was already correct; asserted here so the two surfaces stay paired and a
    // future edit cannot silently un-wire whichever one is not being looked at.
    const replay = readFileSync(replaySession, 'utf8');
    expect(replay).toContain('replayReceiptSubject(data, objects, receiptId, glyphResolver)');
  });

  /**
   * Mutation: let either surface source the glyph from anything but the shared
   * authority (provenance, a local doc, a default `ok`). The two then drift apart on
   * some status, which is the class of bug this whole round is closing.
   */
  it('live and replay read one object identically, for every status the authority can return', () => {
    const cases: ReadonlyArray<{
      readonly reads: ReplayData['covenantReads'];
      readonly glyph: string;
      readonly why: string;
    }> = [
      { reads: { [OBJECTIVE_ID]: 'ok' }, glyph: 'accepted', why: 'certified, unchanged ⇒ ✓' },
      { reads: { [OBJECTIVE_ID]: 'drift' }, glyph: 'proposed', why: 'edited under the anchor ⇒ ~' },
      { reads: { [OBJECTIVE_ID]: 'unresolved' }, glyph: 'proposed', why: 'no verdict ⇒ ~' },
      { reads: { other: 'ok' }, glyph: 'proposed', why: 'absent from the map ⇒ ~' },
      { reads: undefined, glyph: 'proposed', why: 'no authority wired ⇒ ~' },
    ];

    for (const { reads, glyph, why } of cases) {
      const data = snapshotWith(reads);
      const resolver = precomputedGlyphResolver(data.covenantReads);
      const live = liveReceiptVerification(reads);
      // The replay surface's call — same data, same resolver, its own argument list.
      const replay = replayReceiptSubject(data, [], OBJECTIVE_ID, resolver)?.state.verification;

      expect(live, why).toBe(glyph);
      expect(replay, why).toBe(glyph);
      expect(live, `live and replay must agree: ${why}`).toBe(replay);
      // And the glyph is the authority's own answer, not a coincidence.
      expect(anchorCertifies(resolver, OBJECTIVE_ID)).toBe(glyph === 'accepted');
    }
  });
});
