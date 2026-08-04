/* ---------------------------------------------------------------------------
 * EVERY HANDLER A CHILD ACCEPTS IS REACHABLE FROM <Timeline>.
 *
 * Round 1: `ROW_ACTIONS` was a module constant whose entries had no `onSelect`,
 * so 24 row buttons per frame were decorative; `onOpenTag`, `onMarkSeen` and
 * `onUnmarkSeen` existed on the children and were never forwarded. That is the
 * literal "forces #25 to fork a component" case — a consumer who wanted a
 * working reply button had no prop to pass.
 * ------------------------------------------------------------------------- */

import type { RenderResult } from '@testing-library/react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { CrossRoomJump, ObjectiveGroup, ReceiptView, Timeline } from '../src/components';
import { renderWith } from './harness';

afterEach(cleanup);

/* The feed resolves every row's actor against the record register it was built
   from; a row rendered outside one throws rather than degrading. */
const render = (ui: ReactElement): RenderResult => renderWith(f.RECORDS, ui);

const ENTRIES = f.timeline({ seen: false, filter: null, routineOpen: false });
const SEEN_ENTRIES = f.timeline({ seen: true, filter: null, routineOpen: false });

describe('the feed forwards what its children accept', () => {
  /* CATCHES: row actions rendered from a constant with no handler. A button
     that does nothing is worse than no button: it says the affordance exists. */
  it('a row action reaches the caller with the row and the action', () => {
    const calls: [string, string][] = [];
    render(<Timeline entries={ENTRIES} filter={null} onRowAction={(a, b) => calls.push([a, b])} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'reply' })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('button', { name: 'quote' })[0] as HTMLElement);
    expect(calls.length).toBe(2);
    expect(calls[0]?.[1]).toBe('reply');
    expect(calls[1]?.[1]).toBe('quote');
    expect(calls[0]?.[0]).toBe(calls[1]?.[0]);
    // and the row it names is a real row in the feed
    expect(ENTRIES.some((e) => e.id === calls[0]?.[0])).toBe(true);
  });

  /* CATCHES: dropping `onOpenTag` on the way through. Every row tag is a
     button; before this it was a button with no handler on every single row. */
  it('a row tag reaches onOpenTag', () => {
    const opened: string[] = [];
    render(<Timeline entries={ENTRIES} filter={null} onOpenTag={(id) => opened.push(id)} />);
    const tag = document.querySelector('[data-row-tag]') as HTMLElement | null;
    expect(tag).not.toBeNull();
    fireEvent.click(tag as HTMLElement);
    expect(opened).toEqual([tag?.getAttribute('data-row-tag')]);
  });

  /* CATCHES: mark/unmark being unreachable. The divider's whole promise is that
     marking a group seen mutes it rather than deleting it — which a consumer
     cannot demonstrate if the handler never arrives. */
  it('mark seen and unmark seen both reach the caller', () => {
    const marked: string[] = [];
    const { unmount } = render(
      <Timeline entries={ENTRIES} filter={null} onMarkSeen={(id) => marked.push(`mark:${id}`)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'mark this group seen' }));
    unmount();

    render(
      <Timeline
        entries={SEEN_ENTRIES}
        filter={null}
        onUnmarkSeen={(id) => marked.push(`unmark:${id}`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'unmark' }));
    expect(marked).toEqual(['mark:syl', 'unmark:syl']);
  });

  /* CATCHES: a regression in the two handlers that DID work, while the four
     that did not were being wired. */
  it('filter and peek still reach the caller', () => {
    const calls: string[] = [];
    render(
      <Timeline
        entries={ENTRIES}
        filter={null}
        onFilter={(c) => calls.push(`filter:${c}`)}
        onTogglePeek={(id) => calls.push(`peek:${id}`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 NEED YOU' }));
    fireEvent.click(screen.getByRole('button', { name: /8 routine/ }));
    expect(calls).toEqual(['filter:need', 'peek:routine-group']);
  });

  /* CATCHES: hard-coding the row action set, which is the other half of the
     fork pressure — #25 wanting a different set had no way to say so. */
  it('the row action set can be replaced without forking the component', () => {
    render(
      <Timeline entries={ENTRIES} filter={null} rowActions={[{ id: 'pin', label: 'pin it' }]} />,
    );
    expect(screen.getAllByRole('button', { name: 'pin it' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'reply' })).toBeNull();
  });
});

describe('objective header actions', () => {
  /** CATCHES: proposed objectives remaining expandable but having no path to their receipt. */
  it('opens a proposed objective receipt instead of toggling an empty group', () => {
    const calls: string[] = [];
    render(
      <ObjectiveGroup
        objective={{ id: 'proposal-goal', title: 'Ship it', status: 'proposed', open: true }}
        objects={[]}
        onOpenReceipt={(id) => calls.push(`receipt:${id}`)}
        onToggle={(id) => calls.push(`toggle:${id}`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ship it/ }));
    expect(calls).toEqual(['receipt:proposal-goal']);
  });

  /** CATCHES: routing accepted objective navigation into the retired proposal receipt path. */
  it('keeps accepted objectives expandable', () => {
    const calls: string[] = [];
    render(
      <ObjectiveGroup
        objective={{ id: 'accepted-goal', title: 'Ship it', status: 'active', open: true }}
        objects={[]}
        onOpenReceipt={(id) => calls.push(`receipt:${id}`)}
        onToggle={(id) => calls.push(`toggle:${id}`)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ship it/ }));
    expect(calls).toEqual(['toggle:accepted-goal']);
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 6, D3 — EVERY HANDLER TAKES THE RESOLVED ID.
 *
 * Round 5 fixed this at `TimelineRow` — the row action bus and the row tag — and
 * nowhere else. The receipt's provenance row printed `entry.excerpt`, took its
 * room from `entry.jump.room` and acted on `entry.jump.messageId`: three facts
 * about one row from three sources, shipped rendering lars's words under
 * `data-quoted=msg:mA@identity-service` and clicking through to priya's message.
 * `CorrectionRow` was the same shape with an `?? ''` fallback that dispatched the
 * empty string, and `CrossRoomJump` revealed a bare caller-supplied id.
 *
 * The enumeration behind this block: every handler in the library that receives
 * a MESSAGE ID. There are five — the row action bus, the row tag, the receipt's
 * provenance jump, the receipt's correction link, and the trace's reveal. The
 * first two are asserted above; the other three are here.
 * ------------------------------------------------------------------------- */
describe('a handler is told what it acted on, by the register', () => {
  /* CATCHES: the provenance row acting on a second source. There is no `jump`
     field any more — what it prints, what it labels itself with and what it acts
     on all come from the record the excerpt cites. */
  it('the receipt’s provenance row jumps to the message it printed', () => {
    const jumped: string[] = [];
    const { container } = render(
      <ReceiptView onJump={(id) => jumped.push(id)} receipt={f.RECEIPT} />,
    );
    const rows = [...container.querySelectorAll('[data-jumps-to]')];
    expect(rows.length, 'the receipt renders no outbound links').toBeGreaterThan(0);
    for (const row of rows) {
      const target = row.getAttribute('data-jumps-to');
      /* The row's own provenance token cites the same message it will act on. */
      const quoted = row.querySelector('[data-quoted]')?.getAttribute('data-quoted');
      if (quoted !== null && quoted !== undefined) {
        expect(quoted.startsWith(`msg:${target}`), `${quoted} does not name ${target}`).toBe(true);
      }
      fireEvent.click(row);
    }
    expect(jumped).toEqual(rows.map((row) => row.getAttribute('data-jumps-to')));
    expect(jumped.filter((id) => id === '')).toEqual([]);
  });

  /* CATCHES: the `?? ''` fallback coming back. A handler dispatching the empty
     string is a handler that was never told what it acted on. */
  it('the receipt’s correction link never dispatches an empty id', () => {
    const jumped: string[] = [];
    const { container } = render(
      <ReceiptView onJump={(id) => jumped.push(id)} receipt={f.RECEIPT} />,
    );
    const links = [...container.querySelectorAll('[data-jumps-to]')].filter((el) =>
      (el.textContent ?? '').includes('→'),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) fireEvent.click(link);
    expect(
      jumped.every((id) => id.length > 0),
      `an empty id was dispatched: ${jumped}`,
    ).toBe(true);
  });

  /* CATCHES: the trace bar revealing a caller-supplied id. */
  it('the cross-room trace reveals the message the register resolved', () => {
    const revealed: string[] = [];
    const { container } = render(
      <CrossRoomJump jump={f.JUMP} onReveal={(id) => revealed.push(id)} />,
    );
    const button = container.querySelector('[data-jumps-to]');
    expect(button?.getAttribute('data-jumps-to')).toBe('m-legal');
    fireEvent.click(button as Element);
    expect(revealed).toEqual(['m-legal']);
  });

  /* CATCHES: any of the three resolving against a register that does not hold
     the message. A reference nothing vouched for does not become a click. */
  it('a trace whose target this page has never seen does not render', () => {
    expect(() => renderWith([f.MESSAGES.m2 as never], <CrossRoomJump jump={f.JUMP} />)).toThrow(
      /is not a message on this page|minted from a different record/,
    );
  });
});

describe('receipt supersession', () => {
  /**
   * Mutation: invoke supersession from a single ambiguous click or reverse the
   * selected replacement and the open receipt. The destructive relation then
   * retires the object the person meant to keep.
   */
  it('requires candidate selection and confirmation and preserves endpoint direction', () => {
    const candidate = f.OBJECTS.find((object) => object.id !== f.RECEIPT.id);
    if (!candidate) throw new Error('the receipt fixture has no replacement candidate');
    const calls: Array<[string, string]> = [];
    render(
      <ReceiptView
        onSupersede={(retired, replacement) => calls.push([retired, replacement])}
        receipt={f.RECEIPT}
        supersessionCandidates={[candidate]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Confirm supersession' })).toBeNull();
    fireEvent.click(
      document.querySelector(`[data-supersession-replacement="${candidate.id}"]`) as Element,
    );
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm supersession' }));
    expect(calls).toEqual([[f.RECEIPT.id, candidate.id]]);
  });
});

/* ---------------------------------------------------------------------------
 * WHAT THE RECEIPT SAYS WHEN IT HAS NOTHING TO SAY — r8 D7/D8.
 *
 * Nine of the gallery's ten receipts are derived from the object rather than
 * from a curated record, and both defects live in exactly those nine: an empty
 * PROVENANCE section rendered as a bare heading, and a naked em dash standing in
 * the column where a time goes. Both are about a component filling a slot it has
 * nothing for — the `HappenedLine.who` shape, one field over.
 * ------------------------------------------------------------------------- */
describe('a derived receipt says what it has and does not decorate what it lacks', () => {
  /* The exact receipts the app builds: every object except the one with a
     curated record. Enumerated from the fixture set rather than named, so an
     object added to the gallery is covered on the day it is added. */
  const DERIVED = f.OBJECTS.filter((object) => object.id !== f.RECEIPT.id).map((object) =>
    f.receiptFromObject(f.OBJECTS, object.id),
  );

  it('there are derived receipts to check', () => {
    expect(
      DERIVED.length,
      'the gallery has no derived receipts, which cannot be true',
    ).toBeGreaterThan(5);
    expect(DERIVED.every((receipt) => receipt.provenance.length === 0)).toBe(true);
  });

  /* CATCHES D7: a section heading with nothing under it. The CORRECTION CHAIN
     right below already had an empty state, so the reader got a bare word here
     and found the explanation three sections down in `reopenNote`. */
  it.each(DERIVED.map((receipt) => [receipt.id, receipt] as const))(
    'the empty provenance section of %s explains itself where the question is asked',
    (_id, receipt) => {
      const { container } = renderWith(f.RECORDS, <ReceiptView receipt={receipt} />);
      const text = container.textContent ?? '';
      const heading = text.indexOf('PROVENANCE');
      const next = text.indexOf('CORRECTION CHAIN');
      expect(heading, 'the receipt renders no provenance section').toBeGreaterThan(-1);
      expect(
        text.slice(heading + 'PROVENANCE'.length, next).trim(),
        'the provenance section is a heading over nothing',
      ).not.toBe('');
      expect(text).toContain('nothing on this object cites a message');
    },
  );

  /* CATCHES D8: a placeholder painted as a value. `receiptFromObject` used to
     pass `at: '—'`, so every derived history line read "proposed by justin —". */
  it.each(DERIVED.map((receipt) => [receipt.id, receipt] as const))(
    'no history line of %s prints a dash where a time goes',
    (_id, receipt) => {
      expect(
        receipt.happened.filter((line) => line.at !== undefined),
        'a derived history line carries a clock it cannot have',
      ).toEqual([]);
      const { container } = renderWith(f.RECORDS, <ReceiptView receipt={receipt} />);
      expect(
        container.textContent ?? '',
        'a naked em dash is rendered as the time of an event',
      ).not.toMatch(/\s—\s*(·|$|[A-Z])/);
      /* BOTH DIRECTIONS: a receipt that DOES have clocks still prints them. */
    },
  );

  it('a receipt that has clocks still prints them', () => {
    const { container } = renderWith(f.RECORDS, <ReceiptView receipt={f.RECEIPT} />);
    const clocks = f.RECEIPT.happened.map((line) => line.at).filter((at) => at !== undefined);
    expect(clocks.length, 'the curated receipt has no clocks to print').toBeGreaterThan(0);
    for (const at of clocks) expect(container.textContent).toContain(at);
  });
});
