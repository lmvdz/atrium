import type { RenderResult } from '@testing-library/react';
import { cleanup, render as reactRender } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { RoomSession } from '../app/RoomSession';
import { ClaimText, Composer, Glyph, ObjectRow, Pin, Rail, TimelineRow } from '../src/components';
import type {
  AttentionItem,
  EpistemicState,
  MessageEntry,
  MessageRecord,
  TrailerSummary,
} from '../src/components/model';
import {
  boundTo,
  messageEntry as buildEntry,
  glyphFor,
  hardestFirst,
  hardestGlyph,
  owedSummary,
  rationale,
  slot,
  trailerFor,
} from '../src/components/model';
import { renderWith } from './harness';

afterEach(cleanup);

const EMPTY_TRAILER: TrailerSummary = trailerFor({ objects: [], objectives: [], overdue: [] });

const RECORD: MessageRecord = {
  id: 'm1',
  at: '11:02',
  actor: 'priya',
  text: 'Cut over Friday.',
  origin: 'seeded',
};

/* Every render in this file goes through the record ledger, because since round
   5 a row looks its actor up rather than carrying it — a row rendered without
   one throws, which test/attribution.test.tsx asserts directly. */
const render = (ui: ReactElement): RenderResult => renderWith([RECORD], ui);

const PROPOSED_GATE: EpistemicState = {
  kind: 'decision',
  verification: 'proposed',
  owedToViewer: true,
  irreversible: false,
};

const VERIFIED: EpistemicState = {
  kind: 'claim',
  verification: 'verified',
  owedToViewer: false,
  irreversible: false,
};

function messageEntry(state: EpistemicState): MessageEntry {
  return buildEntry(RECORD, { state });
}

describe('the glyph cannot be handed in', () => {
  /* CATCHES: adding a `glyph`, `mark`, `icon`, `symbol` or `tone` escape hatch
     to any component that renders epistemic state. `NoGlyph` types all five as
     `never`, so these lines only compile if somebody removed that guard — and
     `@ts-expect-error` turns "it compiles" into a failing typecheck. */
  it('the type rejects a hand-set glyph on every component that renders one', () => {
    // @ts-expect-error — Glyph derives from state; it does not accept one.
    render(<Glyph glyph="✓" state={PROPOSED_GATE} />);
    cleanup();
    // @ts-expect-error — nor does a timeline row.
    render(<TimelineRow entry={messageEntry(PROPOSED_GATE)} mark="✓" />);
    cleanup();
    render(
      <ObjectRow
        // @ts-expect-error — nor does a lens row, by any of its aliases.
        icon="✓"
        object={{
          id: 'o',
          kind: 'claim',
          state: VERIFIED,
          text: 't',
          facts: [],
          objectives: [],
        }}
      />,
    );
    cleanup();
    render(
      <ClaimText
        content={slot('text')}
        state={VERIFIED}
        // @ts-expect-error — and the hue is derived too: no `tone` override.
        tone="verified"
      />,
    );
  });

  /* CATCHES: rendering the glyph without its meaning, or dropping the tone data
     attribute the styling and the e2e contrast check both key off. */
  it('renders the derived glyph with its meaning and tone', () => {
    const { container } = render(<Glyph state={PROPOSED_GATE} />);
    const span = container.querySelector('[data-glyph]');
    expect(span?.getAttribute('data-glyph')).toBe('◆');
    expect(span?.getAttribute('data-tone')).toBe('needs');
    expect(span?.getAttribute('title')).toMatch(/reversible gate/);
  });

  /* CATCHES: suppressing the dotted claim treatment when a row is also a gate.
     The glyph says "answer me"; the underline says "and nothing has checked
     this". Both have to be true at once. */
  it('a gate that is also a proposal renders ◆ and stays dotted', () => {
    const { container } = render(<TimelineRow entry={messageEntry(PROPOSED_GATE)} />);
    expect(container.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('◆');
    expect(container.querySelector('[data-claim="true"]')).not.toBeNull();
  });

  /* CATCHES: dotting settled text. If a verified fact wears the claim
     treatment, the underline stops meaning anything. */
  it('a verified row is not dotted', () => {
    const { container } = render(<TimelineRow entry={messageEntry(VERIFIED)} />);
    expect(container.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('✓');
    expect(container.querySelector('[data-claim="true"]')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * EVERY AGGREGATE GLYPH IS DERIVED FROM THE SET IT COUNTS — ROUND 10, D1.
 *
 * The character rule (`glyph-source.test.ts`) says nobody may WRITE one down.
 * That is necessary and not sufficient: a component can read a derivation and
 * ignore its input, which is the same lie with a function call in front of it.
 * So the input is MUTATED here and every aggregate glyph on the page has to move
 * with it. Nothing below asserts a fixed character except through the set that
 * produced it.
 *
 * The three surfaces are the three the r9 screen disagreed on: the rail's owed
 * chip (the only report of what a room you are NOT in owes you), the pin's head,
 * and the composer's ANSWERING banner.
 * ------------------------------------------------------------------------- */

function owedItem(id: string, state: EpistemicState): AttentionItem {
  return {
    id,
    state,
    title: `${id} — an owed item`,
    rationale: rationale('it is yours and nobody else can carry it'),
    facts: ['raised 09:00'],
    source: null,
    actions: [{ id: 'go', label: 'Answer it', emphasis: 'primary', statement: null }],
  };
}

const DESTRUCTIVE: EpistemicState = {
  kind: 'decision',
  verification: 'proposed',
  owedToViewer: true,
  irreversible: true,
};
const FAILED: EpistemicState = {
  kind: 'event',
  verification: 'failed',
  owedToViewer: true,
  irreversible: false,
};
const OPEN: EpistemicState = {
  kind: 'question',
  verification: 'open',
  owedToViewer: true,
  irreversible: false,
};

/** The set, and the glyph the vocabulary says stands for it. Mutating the set is the test. */
const SETS: readonly { readonly what: string; readonly items: readonly AttentionItem[] }[] = [
  { what: 'a reversible gate alone', items: [owedItem('a', PROPOSED_GATE)] },
  {
    what: 'a destructive decision beside a gate',
    items: [owedItem('a', PROPOSED_GATE), owedItem('b', DESTRUCTIVE)],
  },
  {
    what: 'a failure beside both',
    items: [owedItem('a', PROPOSED_GATE), owedItem('b', DESTRUCTIVE), owedItem('c', FAILED)],
  },
  { what: 'an open question alone', items: [owedItem('a', OPEN)] },
];

describe('an aggregate glyph moves when the set it counts moves', () => {
  const glyphIn = (root: Element | Document, selector: string): string | null =>
    root.querySelector(`${selector} [data-glyph]`)?.getAttribute('data-glyph') ?? null;

  /* CATCHES: the rail going back to a hand-written character beside a count —
     the r9 defect exactly — and any "derivation" that reads the wrong set. On
     `/` the r9 chip said `◆` over four items whose hardest is `■`; here the set
     is changed under it four ways and the chip has to follow every time.
     `hardestGlyph` is the vocabulary's answer, computed independently of the
     component, so the assertion is not a copy of the implementation. */
  it.each(SETS)('the rail chip wears the hardest of $what', ({ items }) => {
    const { container } = render(
      <Rail
        humans={[]}
        rooms={[{ id: 'r1', name: 'here', unseen: 0, owed: owedSummary(items), current: true }]}
        viewer={{ id: 'lars', name: 'lars', presence: 'here', note: null, isViewer: true }}
        viewerNote="here"
        workspaceName="atrium"
        workspaceSub="1 room"
      />,
    );
    expect(glyphIn(container, '[data-owed-chip]')).toBe(hardestGlyph(items));
    /* …and the COUNT beside it comes off the same array, so the two cannot
       disagree about which set they are describing. */
    expect(container.querySelector('[data-owed-chip]')?.textContent).toContain(
      String(items.length),
    );
  });

  /* CATCHES: the pin head going back to `{headGlyph ?? '·'}` or to any character
     at all. Same sets, same expected value, different component — which is the
     point: two surfaces answering one question. */
  it.each(SETS)('the pin head wears the hardest of $what', ({ items }) => {
    const { container } = render(
      <Pin items={items} lastCheck="12:29" trailer={EMPTY_TRAILER} viewer="lars" />,
    );
    expect(glyphIn(container, '[data-pin-glyph]')).toBe(hardestGlyph(items));
  });

  /* CATCHES: the ANSWERING banner going back to a literal `◆`. On `/` at rest it
     is bound to X1, which is `irreversible` and wears `■` on its pin card, in
     the feed tag, in the lens and in its receipt — the banner told the one person
     about to answer it that it was the reversible kind. */
  it.each(SETS)('the composer banner wears the glyph of the item it names, $what', ({ items }) => {
    const bound = hardestFirst(items)[0];
    if (bound === undefined) throw new Error('fixture: no item');
    const { container } = render(
      <Composer binding={boundTo(bound, 'an objective')} roomName="here" />,
    );
    expect(glyphIn(container, '[data-binding="bound"]')).toBe(glyphFor(bound.state));
    /* AND THE LABEL IS THE SAME ITEM'S. `boundTo` is the only constructor, so a
       banner cannot name one thing and glyph another. */
    expect(container.querySelector('[data-binding="bound"]')?.textContent).toContain(bound.title);
  });

  /* THE EMPTY SET HAS NO STATE, SO IT GETS NO GLYPH. `{headGlyph ?? '·'}` put
     `·` — "routine, no attention owed" — over items that are not there.
     CATCHES: reintroducing a fallback character of any kind. */
  it('an empty set renders no glyph rather than a borrowed one', () => {
    const { container } = render(
      <Pin items={[]} lastCheck="12:29" trailer={EMPTY_TRAILER} viewer="lars" />,
    );
    expect(container.querySelector('[data-pin-glyph]')?.textContent).toBe('');
    expect(glyphIn(container, '[data-pin-glyph]')).toBeNull();
    expect(hardestGlyph([])).toBeNull();
  });

  /* THE ONE SCREEN, WITH THE SHIPPED FIXTURES. The repro Lars measured: on `/`
     the rail chip read `◆4` forty pixels from a pin head reading `■` over the
     same four items. Driven rather than reasoned about — a model that agrees and
     a route that does not is exactly what r9 shipped for D5. */
  it('on `/`, the rail chip and the pin head answer with one glyph', () => {
    cleanup();
    reactRender(<RoomSession />);
    const chip = document
      .querySelector('[data-owed-chip="users-migration"] [data-glyph]')
      ?.getAttribute('data-glyph');
    const head = document
      .querySelector('[data-pin-glyph] [data-glyph]')
      ?.getAttribute('data-glyph');
    expect(chip, 'the rail renders no owed chip for the room on screen').not.toBeUndefined();
    expect(chip).toBe(head);
    expect(chip).toBe(hardestGlyph(f.ATTENTION));
    /* …and so does the banner the composer is bound to. */
    const banner = document
      .querySelector('[data-binding="bound"] [data-glyph]')
      ?.getAttribute('data-glyph');
    expect(banner).toBe(glyphFor(f.item('X1').state));
    expect(banner).toBe(head);
  });
});
