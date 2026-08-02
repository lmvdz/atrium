/* ---------------------------------------------------------------------------
 * ROUND 9. THE FOUR THINGS THE SCREEN SAID THAT WERE NOT TRUE OF THE RECORD,
 * AND THE ONE CHECK THAT COMPARES A SURFACE WITH ITS NEIGHBOUR.
 *
 * All four r8 defects were painted with `pnpm -r typecheck` at 0, 830 unit tests
 * green, `pnpm lint` at 0 and 82 e2e runs passing. The reviewer named why, and
 * it is the finding behind the findings:
 *
 *   the counting tests do exactly what they claim, and NONE OF THEM COMPARES
 *   TWO NUMBERS THAT ARE SIMULTANEOUSLY ON THE PAGE.
 *
 * So the last describe in this file runs `e2e/agreement.ts` — the same analyser
 * the browser suite runs, evaluated against jsdom — over the driven page. One
 * analyser, two harnesses: a unit check and an e2e check that can drift apart
 * are two checks, and the one that is easier to keep green is the one that
 * survives.
 * ------------------------------------------------------------------------- */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { sessionView } from '../app/gallery/rooms';
import { RoomSession } from '../app/RoomSession';
import type { AgreementReport } from '../e2e/agreement';
import { agreementScript } from '../e2e/agreement';
import { AttentionCard, ReceiptView } from '../src/components';
import type { EpistemicState, ObjectKind, Verification } from '../src/components/model';
import {
  checkedFeed,
  GLYPHS,
  glyphFor,
  glyphMeaning,
  happenedKindFor,
  messageEntry,
  stateForHappened,
} from '../src/components/model';
import { renderWith } from './harness';

afterEach(cleanup);

/* ---------------------------------------------------------------------------
 * D1 + D2 — ONE ACT, ONE REGISTER, EVERY SURFACE.
 * ------------------------------------------------------------------------- */

describe('an act moves every surface that counts it', () => {
  /* CATCHES: `sessionView` handing back `view.objects` instead of the objects
     with the act applied — the r8 shape, where `objects` came off the unsettled
     view while `attention` was filtered. Mutating either half makes the lens
     disagree with the pin. */
  it('the lens stops counting an item the pin has stopped counting', () => {
    const before = sessionView('r2', []);
    expect(before.attention.map((item) => item.id)).toEqual(['IQ1']);
    expect(before.objects.filter((o) => o.state.owedToViewer).map((o) => o.id)).toEqual(['IQ1']);

    const after = sessionView('r2', ['IQ1']);
    expect(after.attention).toEqual([]);
    expect(after.objects.filter((o) => o.state.owedToViewer)).toEqual([]);
    /* …and the object is still THERE. An act is not a deletion: the question is
       still in the room's current state, it just no longer needs this person. */
    expect(after.objects.map((o) => o.id)).toEqual(before.objects.map((o) => o.id));
  });

  /* CATCHES the exact r8 line: `owed: roomView(room.id).attention.length` in
     `railRooms`, the unfiltered array, written on the line below a docblock
     about round 6 leaving the rail and the head disagreeing. Restore it and the
     chip stays at 1 while the pin goes to 0. */
  it('the rail chip for a room counts what that room still owes', () => {
    const chip = (view: ReturnType<typeof sessionView>, name: string) => {
      const found = view.rooms.find((room) => room.name === name);
      if (found === undefined) throw new Error(`no chip for ${name}`);
      return found.owed;
    };
    expect(chip(sessionView('r2', []), 'identity-service')).toBe(1);
    expect(chip(sessionView('r2', ['IQ1']), 'identity-service')).toBe(0);
  });

  /* CATCHES: the rail reading only the room on screen. D2's first repro is an
     act in #users-migration that has to move #users-migration's chip WHILE YOU
     ARE STANDING IN #identity-service — a per-room count that only settles the
     current room is the same defect one room over. */
  it('an act in one room moves that room’s chip from every other room', () => {
    const elsewhere = sessionView('r2', ['K2']);
    const chip = elsewhere.rooms.find((room) => room.name === 'users-migration');
    expect(chip?.owed).toBe(3);
  });

  /* CATCHES: `overdue` going back to a hand-written number. `trailerFor` takes a
     COUNT, and a count beside the objects it describes cannot be filtered — so
     signing off the one late commitment left the trailer still saying one thing
     was late. */
  it('settling the late commitment stops the trailer counting it', () => {
    expect(sessionView('r1', []).trailer.overdue).toBe(1);
    expect(sessionView('r1', ['K2']).trailer.overdue).toBe(0);
  });

  /* CATCHES: the feed's "needs you" tag going back to a fixture string. It is
     the fifth surface and the only one that states its claim in prose, so no
     count check can see it — which is why it survived every counting test r8
     had. Rebuild the row from the item and the tag cannot outlive the item. */
  it('the feed row for an item drops its needs-you tag when the item is settled', () => {
    const owedFeed = sessionView('r2', []).timeline({
      seen: false,
      filter: null,
      routineOpen: false,
    });
    const tagged = owedFeed.filter(
      (entry) => entry.type === 'message' && entry.tag !== null && entry.tag.tone === 'needs',
    );
    expect(tagged.length).toBe(1);

    const settledFeed = sessionView('r2', ['IQ1']).timeline({
      seen: false,
      filter: null,
      routineOpen: false,
    });
    expect(
      settledFeed.filter(
        (entry) => entry.type === 'message' && entry.tag !== null && entry.tag.tone === 'needs',
      ),
    ).toEqual([]);
  });

  /* CATCHES: a hand-written owed tag being added back to any fixture row.
     `checkedFeed` refuses a row that claims your attention on its own
     authority, so the class is unrepresentable rather than merely absent. */
  it('a feed row that says it needs you with no owed item behind it is refused', () => {
    const record = f.MESSAGES.m10;
    if (record === undefined) throw new Error('fixture: no m10');
    const rogue = messageEntry(record, {
      state: {
        kind: 'decision',
        verification: 'proposed',
        owedToViewer: true,
        irreversible: false,
      },
      tag: { label: '◆ needs lars', tone: 'needs' },
    });
    expect(() => checkedFeed([rogue], [], 'test')).toThrow(/says it needs the viewer/);
    /* …and it is legal the moment something owed cites it. */
    expect(() => checkedFeed([rogue], [f.item('P1')], 'test')).not.toThrow();
  });

  /* CATCHES: `/gallery/pin/[n]` going back to the static fixtures beside a
     synthetic pin — D2 with zero clicks, where the rail said 4, the lens said 4
     and the footer said 60. */
  it('the pin-load route derives every surface from the one number', () => {
    for (const n of [4, 60]) {
      const load = f.loadRoom(n);
      expect(load.attention.length).toBe(n);
      expect(load.objects.filter((o) => o.state.owedToViewer).length).toBe(n);
      expect(load.rooms.find((room) => room.current)?.owed).toBe(n);
      expect(load.viewerNote).toContain(`${n} owed to you`);
    }
  });
});

/* ---------------------------------------------------------------------------
 * D3 — HERE VERSUS ELSEWHERE, COMPARED RATHER THAN ASSUMED.
 * ------------------------------------------------------------------------- */

describe('a message is elsewhere only when it is somewhere else', () => {
  const item = f.item('Q1'); // source: m-legal, which lives in #identity-service

  /* CATCHES: `record.room !== null` coming back at `AttentionCard`'s source
     link. Both directions in one test, because the r8 code passed the
     cross-room case perfectly — it was only ever wrong about the local one. */
  it('the card’s source link compares the record against the room on screen', () => {
    const { container } = renderWith(
      f.RECORDS,
      <AttentionCard item={item} viewer="lars" />,
      'identity-service',
    );
    const link = container.querySelector('[data-jumps-to]');
    expect(link?.getAttribute('data-source-where')).toBe('here');
    expect(link?.textContent).toBe('jump to source →');
    expect(link?.getAttribute('title')).toMatch(/in #identity-service — this room/);

    cleanup();
    const away = renderWith(
      f.RECORDS,
      <AttentionCard item={item} viewer="lars" />,
      'users-migration',
    ).container.querySelector('[data-jumps-to]');
    expect(away?.getAttribute('data-source-where')).toBe('elsewhere');
    expect(away?.textContent).toBe('source in #identity-service →');
    expect(away?.getAttribute('title')).toMatch(/in #identity-service, not here/);
  });

  /* CATCHES: the same defect in the opposite direction at `ProvenanceRow`,
     where `excerpt.room === null` printed "typed in this room" for a record
     that says nothing about its room and "in #X" for one standing in #X. The
     receipt's third excerpt cites m-legal. */
  it('the receipt’s excerpt row compares too', () => {
    const local = renderWith(
      f.RECORDS,
      <ReceiptView receipt={f.RECEIPT} />,
      'identity-service',
    ).container;
    const wheres = [...local.querySelectorAll('[data-source-where]')].map((el) =>
      el.getAttribute('data-source-where'),
    );
    /* m10 and m21 live in #users-migration, m-legal in #identity-service — so
       from #identity-service exactly one excerpt is local and two are away. */
    expect(wheres.filter((w) => w === 'here').length).toBe(1);
    expect(wheres.filter((w) => w === 'elsewhere').length).toBeGreaterThan(1);

    cleanup();
    const home = renderWith(
      f.RECORDS,
      <ReceiptView receipt={f.RECEIPT} />,
      'users-migration',
    ).container;
    const fromHome = [...home.querySelectorAll('[data-source-where]')].map((el) =>
      el.getAttribute('data-source-where'),
    );
    expect(fromHome.filter((w) => w === 'elsewhere').length).toBe(1);
    expect(fromHome.filter((w) => w === 'here').length).toBeGreaterThan(1);
  });

  /* CATCHES: `CorrectionLink` going back to printing "(in #X)" whenever the
     record carries a room. The correction chain links m10 and m-chosen, both in
     #users-migration. */
  it('the correction link says "in #X" only when X is not the room on screen', () => {
    const home = renderWith(
      f.RECORDS,
      <ReceiptView receipt={f.RECEIPT} />,
      'users-migration',
    ).container;
    expect(home.textContent).not.toContain('(in #users-migration)');

    cleanup();
    const away = renderWith(
      f.RECORDS,
      <ReceiptView receipt={f.RECEIPT} />,
      'identity-service',
    ).container;
    expect(away.textContent).toContain('(in #users-migration)');
  });
});

/* ---------------------------------------------------------------------------
 * D4 — THE ROUND TRIP THAT DROPPED THE ONE DISTINCTION THAT MATTERS.
 * ------------------------------------------------------------------------- */

const KINDS: readonly ObjectKind[] = ['decision', 'commitment', 'question', 'claim', 'event'];
const VERIFICATIONS: readonly Verification[] = [
  'verified',
  'accepted',
  'proposed',
  'unverified',
  'self_reported',
  'open',
  'failed',
  'routine',
];

function everyState(): readonly EpistemicState[] {
  const out: EpistemicState[] = [];
  for (const kind of KINDS) {
    for (const verification of VERIFICATIONS) {
      for (const owedToViewer of [true, false]) {
        for (const irreversible of [true, false]) {
          out.push({ kind, verification, owedToViewer, irreversible });
        }
      }
    }
  }
  return out;
}

describe('a history line wears the glyph of the thing it is about', () => {
  /* CATCHES: deleting the `destructive` arm from `HappenedKind`, or
     `happenedKindFor` going back to collapsing every owed object to `gate`.
     Both put a ■ object's history back in ◆ with a tooltip that says the
     opposite of the receipt title three lines above it.
     The whole cross-product, not a spot check: r8's derivation was correct for
     every state but one, and one is what shipped. */
  it('the state → kind → state round trip is lossless where it is visible', () => {
    const broken = everyState().filter(
      (state) => glyphFor(stateForHappened(happenedKindFor(state))) !== glyphFor(state),
    );
    expect(
      broken.map(
        (s) =>
          `${glyphFor(s)} ${JSON.stringify(s)} → ${glyphFor(stateForHappened(happenedKindFor(s)))}`,
      ),
      'a state goes into the history-line vocabulary and comes back out as a different glyph',
    ).toEqual([]);
    expect(everyState().length).toBe(160);
  });

  /* CATCHES: `receiptFromObject` going back to its own inline ternary. X1 is
     the shipped case: `irreversible: true`, a press-and-hold on the card, a
     receipt title reading "destructive, and not undoable", and three history
     lines — one of which is the word `destructive` — painted "a reversible gate
     waiting on a human". */
  it('the destructive decision’s receipt is destructive all the way down', () => {
    const receipt = f.receiptFor('X1');
    expect(glyphFor(receipt.state)).toBe('■');
    const lineGlyphs = receipt.happened.map((line) => glyphFor(stateForHappened(line.kind)));
    expect(new Set(lineGlyphs)).toEqual(new Set(['■']));
    expect(receipt.happened.map((line) => line.id).length).toBe(3);
  });

  /* CATCHES: the legend going back to a hand-written list. r8 enumerated five
     of seven while the section above it emitted ■ and · and explained neither.
     Rendered, not read off the source: a legend that is right in the module and
     wrong on the screen is the defect. */
  it('the printed legend explains every glyph in the vocabulary', () => {
    const { container } = renderWith(f.RECORDS, <ReceiptView receipt={f.receiptFor('X1')} />);
    const legend = [...container.querySelectorAll('div')]
      .map((el) => el.textContent ?? '')
      .find((text) => text.includes(glyphMeaning('✓')));
    expect(legend, 'no legend rendered under WHAT HAPPENED').toBeDefined();
    expect(GLYPHS.length).toBe(7);
    for (const glyph of GLYPHS) {
      expect(legend, `the legend does not explain ${glyph}`).toContain(glyphMeaning(glyph));
    }
  });
});

/* ---------------------------------------------------------------------------
 * THE NEW ASSERTION, IN JSDOM.
 * ------------------------------------------------------------------------- */

/*
 * ONE ANALYSER, TWO HARNESSES. `agreementScript` is the same source string
 * `e2e/agreement.spec.ts` hands to `page.evaluate`; here it runs against jsdom.
 * Two copies of it would be two checks, and the weaker one would set the bar —
 * which is the shape of half the findings in this repo's history. `Function`
 * rather than `eval` so the analyser cannot reach this file's scope: it reads
 * the DOM and nothing else, in both harnesses.
 */
function look(): AgreementReport {
  return new Function(`return ${agreementScript({ roots: null })}`)() as AgreementReport;
}

describe('no two elements on screen state different answers to the same question', () => {
  /* CATCHES: any of the six surfaces above going back to the unsettled view —
     this is the check that does not care WHICH one did. It is the r8 screen's
     own test: drive the page the way the critic did and ask whether it still
     agrees with itself. */
  it('the page agrees with itself before and after every act', () => {
    render(<RoomSession />);
    const seen: number[] = [];

    const step = (what: string) => {
      const report = look();
      seen.push(report.claims.length);
      expect(report.unlabelledCounts, `${what}: a bare number with nothing naming it`).toEqual([]);
      expect(report.unparsed, `${what}: an owed count in a form the check cannot read`).toEqual([]);
      expect(report.contradictions, `${what}: the screen disagrees with itself`).toEqual([]);
    };

    step('as it loads');

    const chip = [...document.querySelectorAll('nav[aria-label="Rooms and people"] button')].find(
      (button) => /#identity-service/.test(button.getAttribute('aria-label') ?? ''),
    );
    act(() => {
      fireEvent.click(chip as Element);
    });
    step('in #identity-service');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer it' }));
    });
    step('after answering the last owed item');

    /* THE DENOMINATOR. A sweep that found nothing reports exactly like one that
       found everything in agreement. */
    expect(Math.min(...seen), 'the analysis found almost no claims to compare').toBeGreaterThan(6);
  });

  /* BOTH DIRECTIONS. A check only ever observed passing is a check nobody has
     seen work, and this one's entire claim is that it would have caught r8. The
     rail chip is given back the stale number r8 painted; nothing else moves. */
  it('and it fails on the screen r8 shipped', () => {
    render(<RoomSession />);
    const chip = [...document.querySelectorAll('nav[aria-label="Rooms and people"] button')].find(
      (button) => /#identity-service/.test(button.getAttribute('aria-label') ?? ''),
    );
    act(() => {
      fireEvent.click(chip as Element);
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer it' }));
    });
    expect(look().contradictions).toEqual([]);

    const current = document.querySelector(
      'nav[aria-label="Rooms and people"] [aria-current="true"]',
    );
    current?.setAttribute('aria-label', '#identity-service — 1 owed to you');
    expect(
      look().contradictions.map((c) => c.question),
      'r8’s stale rail count was put back and the analysis did not notice',
    ).toContain('owed:here == owed:#identity-service');
  });

  /* CATCHES: the wordless-count path being dropped. The prototype lane's
     equivalent check was defeated by a badge whose entire text was "3" — every
     pattern it matched needed a noun beside the number. The rail's owed badge
     is literally `◆4`; it reaches the comparison through its label, and this is
     the assertion that says so. */
  it('a count with no word in it still reaches the comparison', () => {
    render(<RoomSession />);
    const report = look();
    expect(report.wordlessCounts, 'no wordless counts on a page that has several').toBeGreaterThan(
      2,
    );
    expect(report.wordlessClaims, 'no wordless count produced a claim').toBeGreaterThan(0);
    const badge = report.claims.find((claim) => claim.via === 'wordless-count');
    expect(badge, 'the badge path produced no claim at all').toBeDefined();
  });
});
