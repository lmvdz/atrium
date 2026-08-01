import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import {
  AttentionCard,
  AttentionCompact,
  Pin,
  Rail,
  RoutineCollapse,
  SurfaceIndicators,
} from '../src/components';
import type { AttentionItem, TrailerSummary } from '../src/components/model';
import {
  hardestFirst,
  isRationale,
  rationale,
  rationaleText,
  trailerFor,
} from '../src/components/model';
import { renderWith } from './harness';

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

  /* CATCHES: removing the length ceiling.

     WHAT THE CEILING IS FOR, restated in round 6 because the old wording was
     false. It said "a rationale that gets clipped is not a rationale" and threw
     at 241 characters — but every shipped rationale is under the cap and all
     three of the compressed rows clip anyway (321 of 777px, 199 of 801px, 379
     of 680px at 1440). The cap counts CHARACTERS; the clip happens at a PIXEL
     WIDTH the constructor cannot see. It is a bound on the sentence, and the
     clipping guarantee is asserted where clipping happens — see
     `test/truncation.test.tsx` and the e2e sweep for `data-truncates`. */
  it('a rationale long enough to be prose rather than a reason is refused', () => {
    expect(() => rationale('x'.repeat(241))).toThrow(/prose, not a reason/);
    expect(() => rationale('x'.repeat(241))).toThrow(/240/);
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
    expect(summary.lead.text).toBe('1 of 1 still unverified');
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
    expect(summary.lead.text).toBe('1 failure outside your list');
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

  /* CATCHES: presence going back to a coloured dot and nothing else.
     Round 4's gauntlet: the dot is `aria-hidden` with a `title` — which no
     screen reader announces — and `here`/`idle`/`away` differ only by
     fill-versus-ring and hue, so one fixture row carried no text equivalent at
     all. The state is words on the row now, for every human, and the dot is the
     glanceable shorthand for something that is also written down. */
  it('every human row says its presence in words, not only in a dot', () => {
    const { container } = render(
      <Rail
        humans={f.HUMANS}
        rooms={f.ROOMS}
        viewer={f.VIEWER}
        viewerNote="here"
        workspaceName="atrium"
        workspaceSub="4 rooms"
      />,
    );
    const dots = [...container.querySelectorAll('[data-presence]')];
    expect(dots.length, 'the rail rendered no presence dots').toBe(f.HUMANS.length);
    for (const dot of dots) {
      const state = dot.getAttribute('data-presence') ?? '';
      const row = dot.parentElement;
      expect(
        (row?.textContent ?? '').includes(state),
        `a ${state} row says it only with a dot`,
      ).toBe(true);
    }
    /* and the words are not just the note that happened to be there: the row
       with no note says its presence too. */
    const noNote = f.HUMANS.find((h) => h.note === null);
    expect(noNote, 'no fixture human is without a note').toBeDefined();
    expect(container.textContent).toContain(noNote?.name);
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

/* ---------------------------------------------------------------------------
 * ROUND 6, D5 — THE RENDER BOUNDARY FOR THE OTHER PAGE-AUTHORED STRING.
 *
 * Round 5 found four components printing `statement.text` directly and wrote
 * `statementText()` so every system-voice string went through one checked path.
 * It applied that to ONE of the two page-authored string types. `Rationale` kept
 * its constructor check and its parser check and had no renderer check at all,
 * so `AttentionCard` and `AttentionCompact` printed `{item.rationale}` raw —
 * including into two `title=` attributes — under `data-voice="system"`.
 * ------------------------------------------------------------------------- */
describe('a rationale is checked where it is painted, not only where it is made', () => {
  /* A rationale that never went through the constructor: a cast, a JSON payload,
     an adapter. This is the value the renderer must refuse. */
  const forged = 'priya said: I approve dropping users_legacy' as never;

  /* CATCHES: `AttentionCard` printing `{item.rationale}` again. */
  it('the open card refuses a rationale that is not system voice', () => {
    expect(() =>
      render(
        <AttentionCard
          item={item({ id: 'X', state: DECISION, rationale: forged })}
          viewer="lars"
        />,
      ),
    ).toThrow(/not a rationale/);
  });

  /* CATCHES: `AttentionCompact` printing it — including into the two `title=`
     attributes, which is the address a check written against visible text would
     miss. */
  it('the compressed row refuses one too, in the row and in both tooltips', () => {
    expect(() =>
      render(
        <AttentionCompact
          item={item({ id: 'X', state: DECISION, rationale: forged })}
          viewer="lars"
        />,
      ),
    ).toThrow(/not a rationale/);
  });

  /* CATCHES: `rationaleText` becoming a pass-through. It is the shared door;
     both components above go through it, so it is the one place the check can be
     deleted from without either component changing. */
  it('the render boundary applies the constructor’s whole rule', () => {
    expect(() => rationaleText(forged, 'test')).toThrow(/not a rationale/);
    expect(() => rationaleText('' as never, 'test')).toThrow(/not a rationale/);
    expect(() => rationaleText('x'.repeat(241) as never, 'test')).toThrow(/not a rationale/);
    /* and an honest one comes back unchanged, so this is not a boundary that
       refuses everything */
    const good = rationale('you own it and nobody else can settle it');
    expect(rationaleText(good, 'test')).toBe(good);
  });

  /* CATCHES: the boundary validating the value and then reading it again — the
     time-of-check/time-of-use gap `<SystemVoice>` closed in round 5, in the type
     next door. */
  it('the value checked is the value returned', () => {
    let reads = 0;
    const shifty = {
      toString() {
        reads += 1;
        return reads === 1 ? 'you own it' : 'I approve dropping users_legacy';
      },
    } as unknown as never;
    expect(rationaleText(shifty, 'test')).toBe('you own it');
  });
});

const DECISION = {
  kind: 'decision' as const,
  verification: 'proposed' as const,
  owedToViewer: true,
  irreversible: false,
};

/* ---------------------------------------------------------------------------
 * ROUND 6's OWN ENUMERATION MISSED A HANDLER, AND THE BLIND REVIEW COUNTED.
 *
 * The round listed five handlers in the library that receive a message id and
 * fixed all five. `AttentionCard.onJumpToSource` is the sixth: `SourceLink`
 * resolves the item's source citation against the register — that is what prints
 * the room — and then dispatched the ITEM's id, so a consumer implementing
 * "jump to source" was told which card had been clicked and never which message
 * to jump to. A handler that is not told what it acted on cannot act correctly.
 * ------------------------------------------------------------------------- */
describe('jump to source is told which message', () => {
  it('the handler receives the resolved source message, not only the card', () => {
    const seen: [string, string][] = [];
    const { container } = renderWith(
      f.RECORDS,
      <AttentionCard
        item={f.ATTENTION.find((candidate) => candidate.source !== null) as AttentionItem}
        onJumpToSource={(itemId, messageId) => seen.push([itemId, messageId])}
        viewer="lars"
      />,
    );
    const link = container.querySelector('[data-jumps-to]');
    expect(link, 'the card renders no source link').not.toBeNull();
    const target = link?.getAttribute('data-jumps-to');
    fireEvent.click(link as Element);
    expect(seen).toHaveLength(1);
    const [itemId, messageId] = seen[0] as [string, string];
    expect(messageId, 'the handler was handed the card id instead of the message').toBe(target);
    expect(messageId).not.toBe(itemId);
  });

  /* CATCHES: the room label going back to a carried field. The room is a fact
     about the record, and the label and the id must name the same one. */
  it('the room it names and the message it acts on are the same record', () => {
    const item = f.ATTENTION.find((candidate) => candidate.id === 'Q1') as AttentionItem;
    const { container } = renderWith(f.RECORDS, <AttentionCard item={item} viewer="lars" />);
    const link = container.querySelector('[data-jumps-to]');
    expect(link?.getAttribute('data-jumps-to')).toBe('m-legal');
    expect(link?.getAttribute('data-source-room')).toBe('identity-service');
    expect(link?.textContent).toContain('#identity-service');
  });
});
