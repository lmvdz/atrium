import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { AttentionCard, Pin, Rail, RoutineCollapse, SurfaceIndicators } from '../src/components';
import type { AttentionItem, TrailerSummary } from '../src/components/model';
import { hardestFirst, isRationale, rationale, trailerFor } from '../src/components/model';

afterEach(cleanup);

function item(input: Partial<AttentionItem> & Pick<AttentionItem, 'id' | 'state'>): AttentionItem {
  return {
    title: 'A thing that needs you',
    rationale: rationale('you own it and nobody else can settle it'),
    facts: ['due yesterday'],
    source: null,
    actions: [{ id: 'go', label: 'Answer it', emphasis: 'primary', statement: null }],
    ...input,
  };
}

const EMPTY_TRAILER: TrailerSummary = trailerFor({ objects: [], objectives: [], overdue: 0 });

describe('the rationale requirement', () => {
  /* CATCHES: relaxing rationale() to accept an empty or whitespace string. The
     prop is required by the type, so the only remaining way to render an
     unexplained demand on a person is an empty one — this closes it. */
  it('an empty rationale is refused at construction', () => {
    expect(() => rationale('')).toThrow(/without a reason/);
    expect(() => rationale('   \n  ')).toThrow(/without a reason/);
  });

  /* CATCHES: removing the length ceiling. The pin clips the WHY YOU line at two
     lines; a rationale that gets clipped is not a rationale, so an over-long
     one has to fail loudly at the source rather than quietly on screen. */
  it('a rationale too long for the pin is refused', () => {
    expect(() => rationale('x'.repeat(241))).toThrow(/clipped/);
  });

  /* CATCHES: an adapter (#25/#27) that widens the guard when it turns core
     attention items into view records. `isRationale` is the runtime half of the
     brand, and it has to agree with the constructor on every edge. */
  it('the runtime guard agrees with the constructor', () => {
    expect(isRationale('you own it')).toBe(true);
    expect(isRationale('')).toBe(false);
    expect(isRationale('   ')).toBe(false);
    expect(isRationale('x'.repeat(241))).toBe(false);
    expect(isRationale(undefined)).toBe(false);
    expect(isRationale(42)).toBe(false);
  });

  /* CATCHES: making the prop optional, or adding a `why ?? 'needs you'`
     fallback. Both compile if the prop is `string | undefined`; neither
     compiles while it is a required branded type. */
  it('the type refuses an attention item with no reason', () => {
    // @ts-expect-error — `rationale` is required; there is no card without one.
    const noReason: AttentionItem = {
      id: 'X',
      state: {
        kind: 'decision',
        verification: 'proposed',
        owedToViewer: true,
        irreversible: false,
      },
      title: 'unexplained',
      facts: [],
      source: null,
      actions: [],
    };
    const bareString: AttentionItem = {
      ...item({ id: 'Y', state: noReason.state }),
      // @ts-expect-error — and a bare string is not a Rationale, so `''` and
      // any other unvalidated text is rejected too.
      rationale: '',
    };
    expect(bareString.id).toBe('Y');
  });

  /* CATCHES: dropping the WHY YOU label, or rendering the rationale as a
     tooltip only. It has to be on screen: an item that can only justify itself
     on hover cannot justify itself to someone scanning the pin. */
  it('the card always shows the reason, labelled, in system voice', () => {
    const why = 'no automated path may drop a table that still takes live reads';
    render(
      <AttentionCard
        item={item({
          id: 'X1',
          state: {
            kind: 'decision',
            verification: 'proposed',
            owedToViewer: true,
            irreversible: true,
          },
          rationale: rationale(why),
        })}
        viewer="lars"
      />,
    );
    expect(screen.getByText('WHY YOU')).toBeDefined();
    const reason = screen.getByText(why);
    expect(reason.getAttribute('data-voice')).toBe('system');
  });
});

describe('the pin', () => {
  /* CATCHES: any change to the hardest-first sort — including "improving" it to
     sort by recency or by owner. The corpus settled this under load: failures
     before destructive decisions before reversible gates before questions. */
  it('sorts hardest first, derived from the glyph', () => {
    const items: readonly AttentionItem[] = [
      item({
        id: 'question',
        state: { kind: 'question', verification: 'open', owedToViewer: true, irreversible: false },
      }),
      item({
        id: 'gate',
        state: {
          kind: 'decision',
          verification: 'proposed',
          owedToViewer: true,
          irreversible: false,
        },
      }),
      item({
        id: 'failure',
        state: { kind: 'event', verification: 'failed', owedToViewer: true, irreversible: false },
      }),
      item({
        id: 'destructive',
        state: {
          kind: 'decision',
          verification: 'proposed',
          owedToViewer: true,
          irreversible: true,
        },
      }),
    ];
    expect(hardestFirst(items).map((i) => i.id)).toEqual([
      'failure',
      'destructive',
      'gate',
      'question',
    ]);
  });

  /* CATCHES: turning the empty pin into a hidden element or an empty box.
     Silence is a result the reader wanted, not an absence to hide. */
  it('an empty pin says so as an answer', () => {
    render(<Pin items={[]} lastCheck="13:41" trailer={EMPTY_TRAILER} viewer="lars" />);
    expect(screen.getByText(/THAT IS A RESULT, NOT AN ABSENCE/)).toBeDefined();
  });

  /* CATCHES: letting a fold hide owed items rather than compress them, and
     dropping the press-and-hold on an irreversible action. Asymmetric friction
     is the most consistent decision in the corpus: one click for reversible,
     two seconds of hold for destructive, and never a modal for either. */
  it('an irreversible item holds; a reversible one is one click', () => {
    render(
      <Pin
        items={[
          item({
            id: 'destructive',
            state: {
              kind: 'decision',
              verification: 'proposed',
              owedToViewer: true,
              irreversible: true,
            },
            actions: [{ id: 'go', label: 'Authorise', emphasis: 'primary', statement: null }],
          }),
          item({
            id: 'gate',
            state: {
              kind: 'decision',
              verification: 'proposed',
              owedToViewer: true,
              irreversible: false,
            },
          }),
        ]}
        lastCheck="12:29"
        trailer={EMPTY_TRAILER}
        viewer="lars"
      />,
    );
    const hold = screen.getByRole('button', { name: /Authorise — hold/ });
    expect(hold.getAttribute('data-hold')).toBe('2000');
    const oneClick = screen.getByRole('button', { name: 'Answer it' });
    expect(oneClick.getAttribute('data-hold')).toBeNull();
  });
});

describe('the trailer', () => {
  /* CATCHES: hardcoding "everything else is green" over derived numbers — the
     round-3 defect. Green means checked by something other than the claimant,
     so a room with unverified objects outside the pin may not claim it. */
  it('will not say everything is verified when it is not', () => {
    const summary = trailerFor({
      objects: [
        {
          id: 'C1',
          kind: 'claim',
          state: {
            kind: 'claim',
            verification: 'unverified',
            owedToViewer: false,
            irreversible: false,
          },
          text: 'costs about $900/mo',
          facts: [],
          objectives: ['o1'],
        },
      ],
      objectives: [{ id: 'o1', title: 'o', status: 'active', open: true }],
      overdue: 0,
    });
    expect(summary.lead).toBe('1 of 1 still unverified');
    expect(summary.state.verification).toBe('self_reported');
  });

  /* CATCHES: letting a failure outside the pin be described as lateness or as
     green. A failure is the loudest thing the trailer can report and it has to
     win the lead. */
  it('a failure outside the pin wins the lead', () => {
    const summary = trailerFor({
      objects: [
        {
          id: 'F1',
          kind: 'claim',
          state: {
            kind: 'claim',
            verification: 'failed',
            owedToViewer: false,
            irreversible: false,
          },
          text: 'parity #418 failed',
          facts: [],
          objectives: [],
        },
      ],
      objectives: [],
      overdue: 3,
    });
    expect(summary.lead).toBe('1 failure outside your list');
  });
});

/* ---------------------------------------------------------------------------
 * THE NAME A SCREEN READER HEARS IS A RENDERED STRING TOO.
 *
 * Round 3's gauntlet: the surface chip's label and its count are two adjacent
 * elements with no text node between them, so the computed accessible name was
 * "NEEDS YOU0" — worst on the disabled chip, where the number is the reason it
 * is disabled and therefore the part the person most needs to hear.
 * ------------------------------------------------------------------------- */
describe('a surface indicator says its count as a count', () => {
  const SURFACES = [
    { id: 'conversation' as const, label: 'CONVERSATION', count: null, warn: false },
    { id: 'needs-you' as const, label: 'NEEDS YOU', count: 0, warn: false },
    { id: 'current-state' as const, label: 'CURRENT STATE', count: 12, warn: false },
  ];

  /* CATCHES: the label and the count welding back together. Asserted through
     the accessible NAME rather than through the markup, so it stays true
     however the two spans are arranged — the defect was never about which
     elements exist. */
  it('the disabled chip’s label is not welded to its number', () => {
    render(<SurfaceIndicators focused="conversation" surfaces={SURFACES} />);
    const chip = screen.getByRole('button', { name: 'NEEDS YOU — 0' });
    expect(chip.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /NEEDS YOU0/ })).toBeNull();
    // the visible text is unchanged — this is a naming fix, not a copy change
    expect(chip.textContent).toBe('NEEDS YOU0');
  });

  /* CATCHES: over-applying it, so a countless surface announces a dangling
     separator ("CONVERSATION — "). */
  it('a surface with no count says only its label', () => {
    render(<SurfaceIndicators focused="conversation" surfaces={SURFACES} />);
    expect(screen.getByRole('button', { name: 'CONVERSATION' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CURRENT STATE — 12' })).toBeTruthy();
  });

  /* CATCHES: the same weld on the rail's room rows, which a sweep of every
     button's computed name found after the gauntlet named only the surface
     chip. "#identity-service12" is a room and the number of things it owes you,
     said as one word — and the number is the half that matters. */
  it('a rail room chip says its badge as a badge', () => {
    render(
      <Rail
        humans={f.HUMANS}
        rooms={f.ROOMS}
        viewer={f.VIEWER}
        viewerNote="here"
        workspaceName="atrium"
        workspaceSub="4 rooms"
      />,
    );
    const names = screen
      .getAllByRole('button')
      .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
    expect(names.length).toBeGreaterThan(3);
    expect(
      names.filter((n) => /[A-Za-z]\d|\d[A-Za-z]/.test(n)),
      'a rail chip welds its room name to its badge',
    ).toEqual([]);
    expect(names.some((n) => / — \d+ (owed to you|unseen)$/.test(n))).toBe(true);
  });

  /* CATCHES: the routine strip's parts running together. Its visible separators
     are `aria-hidden` `·` spans, so removing the explicit name leaves the ONLY
     whitespace inside a hidden element and the computed name reads
     "8 routine11:50 – 11:57backfill, tests, deploys". A separator that is
     decoration to the eye is not decoration to the name computation once it is
     the only thing between two runs of text. */
  it('the routine strip says its count, its window and its actors apart', () => {
    render(
      <RoutineCollapse
        entry={
          f
            .timeline({ seen: false, filter: null, routineOpen: false })
            .find((e) => e.type === 'routine') as never
        }
      />,
    );
    const name = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(name).toMatch(/^\d+ routine rows between \d\d:\d\d and \d\d:\d\d, from /);
    expect(/[A-Za-z]\d/.test(name.replace(/\b\d+:\d+\b/g, '')), `welded: ${name}`).toBe(false);
  });
});
