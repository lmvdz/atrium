import type { RenderResult } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaimText, Glyph, ObjectRow, TimelineRow } from '../src/components';
import type { EpistemicState, MessageEntry, MessageRecord } from '../src/components/model';
import { messageEntry as buildEntry, slot } from '../src/components/model';
import { renderWith } from './harness';

afterEach(cleanup);

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
