/* ---------------------------------------------------------------------------
 * The view records the component layer takes as props.
 *
 * These are deliberately NOT @atrium/core's schemas. Per the ticket's scope
 * boundary the components are props-driven with zero data fetching and zero
 * global state; #25 and #27 own the adapters that turn replayed and live core
 * objects into these shapes. Keeping the view model separate is what lets the
 * gallery render eight frames without a database.
 *
 * Every text field that can be absent is `Maybe<string>` — never optional, never
 * `undefined`. See model/text.ts for why.
 * ------------------------------------------------------------------------- */

import type { EpistemicState, Glyph, ObjectKind } from './glyph';
import { GLYPH_HARDNESS, glyphFor, needsViewer } from './glyph';
import type {
  Citation,
  MessageId,
  MessageRecord,
  QuotableOrigin,
  Quotation,
  SystemStatement,
} from './quotation';
import { chosenAct, citationFrom, quotationFrom, systemStatement } from './quotation';
import type { Rationale } from './rationale';
import type { Maybe } from './text';

/* --- rail ---------------------------------------------------------------- */

export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly unseen: number;
  /**
   * WHAT THAT ROOM STILL OWES THIS PERSON — the count and the glyph, from one
   * derivation over one set. It was a bare `number`, and the rail drew the glyph
   * beside it by hand; see `owedSummary`.
   */
  readonly owed: OwedSummary;
  readonly current: boolean;
}

declare const owedBrand: unique symbol;

/**
 * THE ONE AGGREGATE GLYPH THAT WAS NOT DERIVED — ROUND 10, D1.
 *
 * `Rail.tsx` printed `<span aria-hidden="true">◆</span>` beside `room.owed`, and
 * `room.owed` was a COUNT. So the rail could not have derived the glyph if it had
 * wanted to: the one surface that reports what is owed in a room you are not
 * standing in was handed a number and left to invent the rest. On `/` it said
 * amber-reversible over a set whose hardest member is an irreversible table drop;
 * on `/gallery/pin/34` it said `◆34` beside a pin headed `✗`.
 *
 * The type is what fixes it. A room's owed attention is the ITEMS, and the count
 * and the glyph are two readings of the same array — so both come out of
 * `owedSummary` together and neither can be written down.
 *
 * Tagged rather than nullable: `kind: 'none'` has no state at all, so a component
 * rendering the chip cannot reach for a glyph that is not there and cannot be
 * handed a `null` it has to guess a fallback for. (An empty set has no state; a
 * borrowed glyph for one is the same lie one level down.)
 */
export type OwedSummary =
  | { readonly [owedBrand]: 'owed-summary'; readonly kind: 'none'; readonly count: 0 }
  | {
      readonly [owedBrand]: 'owed-summary';
      readonly kind: 'some';
      readonly count: number;
      /** the hardest owed item's own state — the chip's glyph is `glyphFor` of it */
      readonly state: EpistemicState;
    };

/**
 * The only constructor. It filters to what actually still needs the viewer, so a
 * caller cannot hand it a settled item and get a count that includes it.
 */
export function owedSummary(items: readonly { readonly state: EpistemicState }[]): OwedSummary {
  const owed = items.filter((item) => needsViewer(item.state));
  const hardest = hardestState(owed);
  if (hardest === null) {
    return { kind: 'none', count: 0 } as OwedSummary;
  }
  return { kind: 'some', count: owed.length, state: hardest } as OwedSummary;
}

export type Presence = 'here' | 'idle' | 'away';

export interface HumanSummary {
  readonly id: string;
  readonly name: string;
  readonly presence: Presence;
  readonly note: Maybe<string>;
  readonly isViewer: boolean;
}

/* --- room head ----------------------------------------------------------- */

export interface RoomHeadRecord {
  readonly name: string;
  readonly topic: string;
  readonly members: readonly string[];
}

/** The three surfaces are all on screen at once — these focus, they do not navigate. */
export type SurfaceId = 'conversation' | 'needs-you' | 'current-state';

export interface SurfaceIndicator {
  readonly id: SurfaceId;
  readonly label: string;
  readonly count: Maybe<number>;
  readonly warn: boolean;
}

/** All three surfaces are present at once; only derived sets carry counts. */
export function surfaceIndicators(owed: number, objects: number): readonly SurfaceIndicator[] {
  return [
    { id: 'conversation', label: 'CONVERSATION', count: null, warn: false },
    { id: 'needs-you', label: 'NEEDS YOU', count: owed, warn: true },
    { id: 'current-state', label: 'CURRENT STATE', count: objects, warn: false },
  ];
}

/* --- timeline ------------------------------------------------------------ */

/** An inline run inside a message body. Code and mentions are the only two. */
export type BodySegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | {
      readonly kind: 'mention';
      readonly text: string;
      readonly referenceKind?: 'human' | 'attachment' | 'proposal' | 'object';
      readonly targetId?: string;
      readonly resolution?: string;
      readonly legacy?: boolean;
    };

/**
 * The text one segment PUTS ON SCREEN.
 *
 * A mention renders with its `@`, so the `@` is part of what the reader sees and
 * therefore part of what has to match the record. This function is the single
 * definition of that, and `MessageBody` renders through it — if the two were
 * written separately, the check below would be measuring a string the reader
 * never sees.
 */
export function segmentText(segment: BodySegment): string {
  return segment.kind === 'mention' ? `@${segment.text}` : segment.text;
}

/** What a whole body reads as, concatenated. */
export function bodyText(body: readonly BodySegment[]): string {
  return body.map(segmentText).join('');
}

/**
 * The one description of "this body does not read as the message it is
 * attributed to", so the factory and the renderer cannot drift into checking
 * subtly different things or reporting the same defect two ways. Returns null
 * when the body is an honest markup of the words.
 */
export function bodyDivergence(
  from: string,
  body: readonly BodySegment[],
  text: string,
  about: { readonly id: MessageId; readonly actor: string },
): string | null {
  const rendered = bodyText(body);
  if (rendered === text) return null;
  return (
    `${from}: ${about.id}'s body does not read as the message it is attributed to (${about.actor}). ` +
    'A body marks the record up; it may not change the words.\n' +
    `  record: ${JSON.stringify(text)}\n` +
    `  body:   ${JSON.stringify(rendered)}`
  );
}

/* ---------------------------------------------------------------------------
 * THE MESSAGE ROW, DISCRIMINATED ON ORIGIN.
 *
 * The round-1 gauntlet's central finding: the primary message path was
 * `actor + body: string[]` with the origin thrown away, so the shipped gallery
 * rendered a page-authored one-click answer (`origin: 'chosen'`) under lars's
 * name, in the same slot as his own sentences. Every quotation guarantee in
 * model/quotation.ts was defending the excerpts while the main path leaked.
 *
 * A message row is now a union with the origin as its discriminant, and the two
 * arms have DIFFERENT FIELDS rather than a shared shape with a flag:
 *
 *   AuthoredMessageEntry — has `attribution` (a Quotation, which carries the
 *     actor and the timestamp) and `body`. The name on screen is
 *     `attribution.actor`; there is no free actor string to get wrong.
 *
 *   ChosenMessageEntry — has NEITHER. No attribution, no body: only a
 *     `SystemStatement`. There is no field on this arm that a renderer could
 *     put in the human-attributed actor column, so page-authored text cannot
 *     reach a human-attributed row by construction rather than by care.
 *
 * ROUND 2's GAUNTLET FOUND THE FREE STRING HAD MOVED, NOT GONE. Closing the
 * chosen arm shut the actor slot; `body?: readonly BodySegment[]` was still a
 * caller override that nothing reconciled against the record it sat beside. A
 * caller could pass m14 — actor `lars`, `data-attribution="m14"` — with a body
 * reading "I authorise dropping users_legacy right now.", through the public
 * API, with no cast. The words under a person's name were free text again, one
 * field over.
 *
 * The body is now a DERIVATION, not an override. Segments may add markup over
 * the record's text — a mention, a link, a code run — but `bodyText(body)` must
 * equal `record.text` exactly, and `messageEntry` throws when it does not. What
 * the body can change is how the words are marked up; what it cannot change is
 * the words.
 *
 * ROUND 3's GAUNTLET FOUND THE CHECK WAS AT A CHOKEPOINT THAT IS NOT THE ONLY
 * PATH. `messageEntry` threw, and `AuthoredMessageEntry` was an exported,
 * structurally inhabitable interface while `TimelineRow` took `MessageEntry`
 * directly — so a caller got a genuine `Quotation` out of the public
 * `quotationFrom`, wrote the entry literal, skipped the factory, and rendered
 * priya's name over words she did not write, with `tsc --noEmit` at exit 0.
 * That is the same finding as round 2's, one level up: the guarantee had moved
 * and the hole had followed it. Adding a third check at a fourth chokepoint
 * would have moved it again.
 *
 * SO THE TYPE IS CLOSED AND THE RENDERER RE-DERIVES. Two changes, and they do
 * different jobs on purpose:
 *
 *   1. THE BRAND (below). `MessageEntryCommon` carries a `declare`d unique
 *      symbol, so a TypeScript module cannot write a `MessageEntry` literal at
 *      all — the only expression in the program whose type is `MessageEntry` is
 *      a call to `messageEntry`. This matches the strength the `chosen` arm
 *      already had from its shape. Same narrow claim as every other brand in
 *      this codebase (see model/quotation.ts): it stops a TypeScript author, not
 *      a cast, `Object.assign` or a JavaScript caller.
 *
 *   2. THE RENDER-BOUNDARY DERIVATION (timeline/TimelineRow.tsx). The brand is
 *      a compile-time fact and the attack it does not stop is a cast. So the
 *      renderer asserts the body against the record before it prints a name over
 *      the words. That check is on the path every row takes, so no future call
 *      site can route around it the way this one routed around the factory.
 *
 * ROUND 4's GAUNTLET FOUND THE FREE STRING INSIDE THE BRANDED VALUE. The row was
 * closed and the quotation on it was not: `{...quotationFrom(msg)!, actor:'priya'}`
 * compiled, kept the brand, and rendered priya's name over lars's sentence with
 * `data-attribution="m14"` — because the render check re-derived THE WORDS and
 * only `actor` had moved. The previous version of the comment below claimed the
 * brand stopped this ("neither does spreading one entry into another shape").
 * IT DOES NOT, and the claim is now written the other way round, because a doc
 * comment that overstates a guarantee is how the next reader stops looking:
 *
 *   TypeScript carries `unique symbol` keys through an object spread. `{...entry}`
 *   is still branded; `{...quotation, actor: 'priya'}` was still a `Quotation`.
 *   What the brand actually stops is a BARE LITERAL — a shape written from
 *   nothing — because there the phantom key is missing. Excess-property checking
 *   stops explicitly-written keys the target type does not declare. Neither of
 *   those is a spread that only overwrites fields the type already has.
 *
 * SO THE FIELDS ARE GONE. A `Quotation` is now a message id and nothing else,
 * and `TimelineRow` looks the actor, the words and the time up from that id in
 * the page's record ledger. There is no field to overwrite; if there were,
 * nothing downstream would read it. That is the difference between guarding the
 * field that moved last time and removing the place it moves to.
 * ------------------------------------------------------------------------- */

declare const entryBrand: unique symbol;

interface MessageEntryCommon {
  /**
   * Phantom. Present so `messageEntry` is the only way to write a `MessageEntry`
   * LITERAL: the key is not one a caller can name. It does not survive as a
   * guarantee against a cast, `Object.assign`, JSON, or a spread of an existing
   * entry — see the round-4 note above, where exactly that was mistaken for one.
   */
  readonly [entryBrand]: 'message-entry';
  readonly type: 'message';
  readonly id: MessageId;
  readonly at: string;
  /** the epistemic state of the object this message carries, when it carries one */
  readonly state: EpistemicState;
  readonly replyTo: Maybe<Quotation>;
  readonly tag: Maybe<RowTag>;
  /** highlighted as the target of a cross-room jump */
  readonly targeted: boolean;
  /** matches the active feed filter (rows that do not are quieted, never hidden) */
  readonly matchesFilter: boolean;
  /** belongs to the rows named by the filter's divider; absent means global */
  readonly filterScoped?: boolean;
}

/** A row whose words are the actor's own — typed here or already on the record. */
export interface AuthoredMessageEntry extends MessageEntryCommon {
  readonly origin: QuotableOrigin;
  /**
   * The citation: the message this row's words, name, id and time come from.
   *
   * It carries the register checksum (`Citation.mintedFrom`), so "the row and
   * the ledger are the same register" is a property of the CITATION rather than
   * of this row type — round 6 moved it, because the row type was one of five
   * places a citation gets resolved and the only one that was checked.
   */
  readonly attribution: Quotation;
  readonly body: readonly BodySegment[];
  readonly fromViewer: boolean;
  /**
   * A system-voice note under the row — "superseded", "answer-bound". Typed as
   * a SystemStatement so it cannot be a person's words.
   */
  readonly note: Maybe<SystemStatement>;
}

/**
 * A row the interface authored on somebody's behalf: the statement behind a
 * one-click answer. It has no actor field and no body field — the person's name
 * exists only inside the third-person system-voice sentence.
 */
export interface ChosenMessageEntry extends MessageEntryCommon {
  readonly origin: 'chosen';
  /**
   * The page-authored message this row is about.
   *
   * Round 6: the chosen arm still rendered caller-supplied `entry.id` and
   * `entry.at` while the authored arm had been rebuilt to derive them, so the
   * one arm that could not forge a NAME could still forge WHICH MESSAGE the row
   * cites and WHEN it happened. A citation is not a quotation — a chosen record
   * may never be quoted — but it is a reference the register can check, and the
   * row resolves it before printing either fact.
   */
  readonly citation: Citation;
  readonly statement: SystemStatement;
}

export type MessageEntry = AuthoredMessageEntry | ChosenMessageEntry;

export function isAuthored(entry: MessageEntry): entry is AuthoredMessageEntry {
  return entry.origin !== 'chosen';
}

export interface MessageEntryInput {
  readonly state: EpistemicState;
  /**
   * Marks the record's text up as inline runs; authored rows only.
   *
   * NOT an override. `bodyText(body)` must equal `record.text` character for
   * character — segments choose the markup, the record owns the words — and
   * `messageEntry` throws otherwise.
   */
  readonly body?: readonly BodySegment[];
  readonly note?: Maybe<SystemStatement>;
  readonly tag?: Maybe<RowTag>;
  readonly replyTo?: Maybe<Quotation>;
  readonly targeted?: boolean;
  readonly matchesFilter?: boolean;
  readonly filterScoped?: boolean;
  /** the person reading the page, so `fromViewer` is derived and not asserted */
  readonly viewer?: string;
}

/**
 * The ONLY constructor for a feed row. It takes the message record itself, so
 * the row's id, time, actor and words all come from one place and cannot drift
 * apart — and it reads the origin rather than dropping it.
 */
export function messageEntry(record: MessageRecord, input: MessageEntryInput): MessageEntry {
  const common = {
    type: 'message' as const,
    id: record.id,
    at: record.at,
    state: input.state,
    replyTo: input.replyTo ?? null,
    tag: input.tag ?? null,
    targeted: input.targeted ?? false,
    matchesFilter: input.matchesFilter ?? true,
    filterScoped: input.filterScoped,
  };

  const attribution = quotationFrom(record);
  if (attribution === null) {
    if (input.body !== undefined) {
      throw new Error(
        `messageEntry: ${record.id} is page-authored (origin ${record.origin}); it has no body of its own, only a system-voice statement of what was chosen`,
      );
    }
    return {
      ...common,
      origin: 'chosen',
      citation: citationFrom(record),
      /* Third person, on purpose: "lars chose: …" is a fact about an act. It is
         not "lars said", and it is not in his voice. */
      statement: chosenAct(record.actor, record.text, record.id),
    } as ChosenMessageEntry;
  }

  /* THE BODY DERIVES FROM THE RECORD. Segments add markup; they do not add,
     remove or reword anything. A body that reads differently from the message
     it is attributed to is synthesized speech under a real name — the round-1
     defect, relocated from the actor slot to the body slot.

     Both operands come off `record`, not off the quotation: the quotation is a
     citation now and has nothing to compare against. */
  if (input.body !== undefined) {
    const diverged = bodyDivergence('messageEntry', input.body, record.text, {
      id: record.id,
      actor: record.actor,
    });
    if (diverged !== null) throw new Error(diverged);
  }

  return {
    ...common,
    origin: record.origin,
    attribution,
    body: input.body ?? [{ kind: 'text', text: record.text }],
    fromViewer: input.viewer !== undefined && record.actor === input.viewer,
    note: input.note ?? null,
  } as AuthoredMessageEntry;
}

export interface RowTag {
  readonly label: string;
  readonly tone: 'neutral' | 'needs' | 'verified';
}

/**
 * The same state, no longer owed to the person reading — what acting on
 * something does to it.
 *
 * ROUND 8, D1: acting REMOVED an item from one array. Removal is not what
 * happened: the object is still on the record, it is still proposed, it is still
 * in the lens; what changed is that it no longer needs this person. Modelling
 * the act as a filter on one array is precisely why four other surfaces went on
 * saying it did.
 */
export function settledForViewer(state: EpistemicState): EpistemicState {
  return { ...state, owedToViewer: false };
}

/**
 * THE "NEEDS YOU" TAG ON A FEED ROW, DERIVED FROM THE ROW'S STATE.
 *
 * `'◆ needs lars'` and `'■ destructive · needs lars'` were hand-written strings
 * on fixture rows, restating the row's own `state` — a second register for the
 * one fact this whole product is about, and one that no act could move. The
 * glyph comes from `glyphFor` like every other glyph, the name comes from the
 * viewer, and the destructive clause comes from `irreversible`.
 */
export function needsTag(state: EpistemicState, viewer: string): RowTag {
  return glyphTag(state, `${state.irreversible ? 'destructive · ' : ''}needs ${viewer}`, 'needs');
}

/**
 * A ROW TAG THAT LEADS WITH A GLYPH, AND THE GLYPH IS THE ROW'S OWN.
 *
 * ROUND 10, D1's class in a fixture: `tag: { label: '✗ failed · needs an
 * explanation' }` writes the character beside a state that also produces one.
 * They agree today; nothing makes them. This is the only way to get a glyph into
 * a tag, so the state the row renders and the character in its tag are one
 * derivation.
 */
export function glyphTag(state: EpistemicState, clause: string, tone: RowTag['tone']): RowTag {
  return { label: `${glyphFor(state)} ${clause}`, tone };
}

/**
 * A FEED MAY NOT SAY A ROW NEEDS YOU UNLESS SOMETHING OWED CITES IT.
 *
 * The refusal that makes round 8's D1 unrepresentable rather than merely fixed.
 * The pin, the rail, the tab and the lens all count the same register; a feed
 * row is the fifth surface, and it is the one that carries its claim in prose
 * rather than in a number, so no count check can see it. A row whose state says
 * "owed to the viewer" must be the source of an attention item — then removing
 * that item from the register necessarily unmakes the row, because the row is
 * built from it.
 *
 * `items` is the room's WHOLE attention list, owed and acted-on alike: a row for
 * something that has just been settled is legal, it simply may not still claim
 * to need anybody, and that is `needsViewer` on its own state.
 */
export function checkedFeed(
  entries: readonly TimelineEntry[],
  items: readonly AttentionItem[],
  from: string,
): readonly TimelineEntry[] {
  const cited = new Set(
    items.map((item) => item.source?.messageId).filter((id) => id !== undefined),
  );
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (!needsViewer(entry.state)) continue;
    if (cited.has(entry.id)) continue;
    throw new Error(
      `${from}: the feed row for ${entry.id} says it needs the viewer, and no owed item in this room cites that message.\n` +
        '  A row that claims your attention on its own authority is a second register for the one fact the pin, the rail, the tab and the lens all count — and the only one an act cannot move.',
    );
  }
  return entries;
}

export interface SystemEntry {
  readonly type: 'system';
  readonly id: string;
  readonly at: string;
  /** system rows are always system voice — the type says so */
  readonly statement: SystemStatement;
  readonly state: EpistemicState;
  /**
   * Matches the active class filter. Optional because a system row nested inside
   * a routine strip is never filtered on its own — the strip is the row the
   * filter lifts. Absent reads as "matches", the same default a message row has.
   */
  readonly matchesFilter?: boolean;
  /** belongs to the rows named by the filter's divider; absent means global */
  readonly filterScoped?: boolean;
}

export type AttentionClass = 'need' | 'change' | 'discussion' | 'routine';

export interface SinceYouLeftEntry {
  readonly type: 'since-you-left';
  readonly id: string;
  readonly label: string;
  readonly window: Maybe<string>;
  readonly counts: Readonly<Record<AttentionClass, number>>;
  readonly total: number;
  /** rows in this group the viewer wrote — never counted back to them as unseen */
  readonly ownRows: number;
  /** marked seen fades the divider to muted; it never removes it */
  readonly seen: boolean;
  readonly seenAt: Maybe<string>;
  readonly activeFilter: Maybe<AttentionClass>;
  /** exact feed rows counted by this divider and eligible for its filter */
  readonly entryIds: readonly string[];
}

export interface RoutineEntry {
  readonly type: 'routine';
  readonly id: string;
  /* There is no `count`: the strip derives it from `rows`, so "8 routine" and
     what the peek shows can never disagree. A count carried alongside the rows
     is a second source of truth waiting to drift. */
  readonly from: string;
  readonly to: string;
  readonly actors: readonly string[];
  readonly open: boolean;
  /** the rows behind the fold — the count is counted, never asserted */
  readonly rows: readonly SystemEntry[];
  /** matches the active class filter; a ROUTINE chip has to be able to lift this */
  readonly matchesFilter?: boolean;
  /** belongs to the rows named by the filter's divider; absent means global */
  readonly filterScoped?: boolean;
}

export type TimelineEntry = MessageEntry | SystemEntry | SinceYouLeftEntry | RoutineEntry;

/* ---------------------------------------------------------------------------
 * WHICH CLASS A FEED ROW IS — ROUND 10, D3.
 *
 * `fixtures.ts` decided a row matched the active filter with
 *
 *   options.filter === null ? true : entry.tag !== null && entry.tag.tone === 'needs'
 *
 * — `options.filter` decided WHETHER to filter and never WHAT to match, so all
 * four chips lifted the same three rows. Someone asking what was routine while
 * they were away was shown a destructive table drop as the answer, and the
 * answer was carried by a background colour and an inset stripe, so nothing
 * reading `textContent`, `aria-label` or `title` could see it.
 *
 * The class is derived from the row, here, once. The divider's chips count the
 * rows this function classifies, and the filter matches on the same value — so a
 * chip that says 8 lifts 8, by construction rather than by two lists agreeing.
 *
 * WHAT DECIDES IT:
 *   need        the row is owed to the person reading. `needsViewer`, the same
 *               predicate the pin, the rail and the lens count.
 *   change      something moved: it failed, or it was verified, or a human
 *               accepted it. "Meaningful changes to what the group understands."
 *   routine     a SYSTEM row with no epistemic weight — a deploy line, a green
 *               harness. A person saying something routine is not routine, it is
 *               discussion; the distinction is who is talking, not the state,
 *               because `TALK` is the state of both.
 *   discussion  everything else: people talking, nothing settled.
 *
 * The divider itself has no class — it is the thing doing the counting.
 * ------------------------------------------------------------------------- */
export function attentionClassOf(entry: TimelineEntry): Maybe<AttentionClass> {
  if (entry.type === 'since-you-left') return null;
  /* A routine strip is not one row: it stands for the rows behind the fold, and
     the chip counts those. Callers that need the number use `classCounts`. */
  if (entry.type === 'routine') return 'routine';
  const { state } = entry;
  if (needsViewer(state)) return 'need';
  if (['failed', 'verified', 'accepted'].includes(state.verification)) return 'change';
  if (entry.type === 'system' && state.verification === 'routine') return 'routine';
  return 'discussion';
}

/** How many rows of each class, counted from the rows themselves. */
export function classCounts(
  entries: readonly TimelineEntry[],
): Readonly<Record<AttentionClass, number>> {
  const counts: Record<AttentionClass, number> = {
    need: 0,
    change: 0,
    discussion: 0,
    routine: 0,
  };
  for (const entry of entries) {
    const attentionClass = attentionClassOf(entry);
    if (attentionClass === null) continue;
    /* The strip counts as the rows it swallowed — "8 ROUTINE" and what the peek
       shows are the same eight, which is the rule `RoutineEntry` already had for
       its own summary and did not have for the divider's chip. */
    counts[attentionClass] += entry.type === 'routine' ? entry.rows.length : 1;
  }
  return counts;
}

/** Rows the viewer wrote — never counted back to them as unseen. */
export function ownRowsIn(entries: readonly TimelineEntry[]): number {
  return entries.filter(
    (entry) => entry.type === 'message' && isAuthored(entry) && entry.fromViewer,
  ).length;
}

/**
 * THE DIVIDER, DERIVED FROM THE ROWS IT SITS ABOVE.
 *
 * Round 10: `counts: { need: 4, change: 3, discussion: 6, routine: 8 }` and
 * `total: 21` were written down beside a feed that holds neither those rows nor
 * that many. `SinceYouLeftDivider`'s own docblock says "the counts are counted,
 * never asserted"; they were asserted, one file over.
 */
export function sinceYouLeft(input: {
  readonly id: string;
  readonly label: string;
  readonly window: Maybe<string>;
  readonly entries: readonly TimelineEntry[];
  readonly seen: boolean;
  readonly seenAt: Maybe<string>;
  readonly activeFilter: Maybe<AttentionClass>;
}): SinceYouLeftEntry {
  const counts = classCounts(input.entries);
  return {
    type: 'since-you-left',
    id: input.id,
    label: input.label,
    window: input.window,
    counts,
    total: counts.need + counts.change + counts.discussion + counts.routine,
    ownRows: ownRowsIn(input.entries),
    seen: input.seen,
    seenAt: input.seenAt,
    activeFilter: input.activeFilter,
    entryIds: input.entries
      .filter((entry) => entry.type !== 'since-you-left')
      .map((entry) => entry.id),
  };
}

/**
 * THE FILTER, APPLIED. A chip lifts the rows of ITS class and nothing else; the
 * rest are quieted, never hidden (`Timeline`'s own rule).
 */
export function withFilter(
  entries: readonly TimelineEntry[],
  filter: Maybe<AttentionClass>,
  scopeIds?: readonly string[],
): readonly TimelineEntry[] {
  if (filter === null) return entries;
  const scope = scopeIds === undefined ? null : new Set(scopeIds);
  return entries.map((entry) => {
    if (entry.type === 'since-you-left') return { ...entry, activeFilter: filter };
    const filterScoped = scope === null || scope.has(entry.id);
    return {
      ...entry,
      filterScoped,
      matchesFilter: filterScoped && attentionClassOf(entry) === filter,
    };
  });
}

/* --- attention ----------------------------------------------------------- */

/* `SourceRef` is gone. It was `{messageId, room}` — a message id beside a copy
   of a fact about that message's record — and every one of its four uses printed
   the carried room while acting on the carried id, which is the "three facts
   about one row from three sources" defect the receipt shipped with. A reference
   to a message is a `Citation`; the room comes off the record at the render
   boundary, the same way the name and the words do. */

export interface AttentionAction {
  readonly id: string;
  readonly label: string;
  readonly emphasis: 'primary' | 'secondary' | 'ghost';
  /**
   * The statement this button puts on the record, verbatim. Present only for
   * one-click answers, and it is page-authored — so it becomes a
   * SystemStatement at the call site, never a quotation.
   */
  readonly statement: Maybe<string>;
}

export interface AttentionItem {
  readonly id: string;
  readonly state: EpistemicState;
  readonly title: string;
  /** required, non-empty, system voice — see model/rationale.ts */
  readonly rationale: Rationale;
  readonly facts: readonly string[];
  /** the message this item came from; the ROOM is derived from its record */
  readonly source: Maybe<Citation>;
  readonly actions: readonly AttentionAction[];
}

export type ReferenceAttentionLocation =
  | { readonly kind: 'conversation'; readonly id: null }
  | { readonly kind: 'objective' | 'object'; readonly id: string };

/** A durable direct reference projected beside, never into, semantic state. */
export interface ContextualReferenceAttention {
  readonly attentionId: string;
  readonly messageId: string;
  readonly location: ReferenceAttentionLocation;
}

/* --- state lens ---------------------------------------------------------- */

export type ObjectiveStatus = 'active' | 'blocked' | 'idle' | 'proposed';

export interface ObjectiveRecord {
  readonly id: string;
  readonly title: string;
  readonly status: ObjectiveStatus;
  readonly open: boolean;
}

export interface StateObject {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly state: EpistemicState;
  readonly text: string;
  /**
   * The metadata line under the object — claimant, dates, verification notes.
   * A list rather than named fields because what is worth saying differs by
   * kind, and a component that renders a fixed set ends up printing "due:
   * undefined" on the ones that have no due date.
   */
  readonly facts: readonly string[];
  readonly objectives: readonly string[];
}

/* --- receipt ------------------------------------------------------------- */

/**
 * The vocabulary a history line can be in.
 *
 * ROUND 8, D4: THERE WAS NO `destructive`, SO THE ONE DISTINCTION IN THIS
 * VOCABULARY THAT CHANGES WHAT A CONTROL DOES WAS DROPPED BY THE DERIVATION AND
 * THEN ASSERTED THE OTHER WAY BY THE TOOLTIP.
 *
 * `receiptFromObject` collapsed every owed object to `gate`, and
 * `stateForHappened('gate')` hard-codes `irreversible: false`. So X1 — a
 * decision whose `state.irreversible` is true, whose card renders as a
 * two-second press-and-hold, and whose receipt title says "needs you —
 * destructive, and not undoable" — had all three of its history lines painted
 * ◆ with `title="needs you — a reversible gate waiting on a human"`, INCLUDING
 * the line whose entire text is the word `destructive`.
 *
 * An `EpistemicState` goes into `happenedKindFor` and comes back out of
 * `stateForHappened`; a round trip that loses a field is a derivation that
 * asserts a fact it was never told. The round trip is now lossless where it is
 * visible — `glyphFor(stateForHappened(happenedKindFor(s))) === glyphFor(s)` for
 * every state, asserted over the whole cross-product in
 * `test/record-integrity.test.tsx` rather than spot-checked.
 */
export type HappenedKind =
  | 'claim'
  | 'verified'
  | 'accepted'
  | 'gate'
  | 'destructive'
  | 'question'
  | 'routine'
  | 'failed';

/**
 * WHICH HISTORY-LINE KIND A STATE IS, going in.
 *
 * It lived inline in `app/gallery/fixtures.ts` as a nested ternary, which is
 * where it was written without a `destructive` arm — one derivation of a closed
 * vocabulary, in a fixture module, with nothing pairing it against the
 * derivation that reads it back. It is here beside `stateForHappened` so the
 * two halves of the round trip are one screen apart and one test away.
 */
export function happenedKindFor(state: EpistemicState): HappenedKind {
  if (state.verification === 'failed') return 'failed';
  if (needsViewer(state)) {
    if (state.irreversible) return 'destructive';
    return state.kind === 'question' ? 'question' : 'gate';
  }
  if (state.verification === 'verified') return 'verified';
  if (state.verification === 'accepted') return 'accepted';
  if (state.verification === 'open') return 'question';
  if (state.verification === 'routine') return 'routine';
  return 'claim';
}

/** History entries carry a semantic kind; the glyph derives from it, like everything else. */
export function stateForHappened(kind: HappenedKind): EpistemicState {
  switch (kind) {
    case 'claim':
      return {
        kind: 'claim',
        verification: 'self_reported',
        owedToViewer: false,
        irreversible: false,
      };
    case 'verified':
      return { kind: 'claim', verification: 'verified', owedToViewer: false, irreversible: false };
    case 'accepted':
      return {
        kind: 'decision',
        verification: 'accepted',
        owedToViewer: false,
        irreversible: false,
      };
    case 'gate':
      return {
        kind: 'decision',
        verification: 'proposed',
        owedToViewer: true,
        irreversible: false,
      };
    /* ■, and the reason the arm exists: a gate answers in one click and this
       does not. Losing it between `happenedKindFor` and here is what painted a
       destructive object's history in the reversible-gate glyph. */
    case 'destructive':
      return {
        kind: 'decision',
        verification: 'proposed',
        owedToViewer: true,
        irreversible: true,
      };
    case 'question':
      return { kind: 'question', verification: 'open', owedToViewer: false, irreversible: false };
    case 'failed':
      return { kind: 'event', verification: 'failed', owedToViewer: false, irreversible: false };
    case 'routine':
      return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
  }
}

/**
 * A history line: a page-authored fact about an event, in system voice.
 *
 * THERE IS NO `who`, AND THAT IS THE POINT. It had one until round 6 — a plain
 * string, rendered by `ReceiptView` immediately before the statement's words, in
 * exactly the attribution-column position CONVENTIONS claimed no component in
 * this codebase had. Two Cyrillic code points got a sentence past the lexical
 * bans and the free name did the rest: `~priya  priya ѕaid: І approve dropping
 * users_legacy  12:00`, inside the artifact whose entire job is being the
 * trustworthy record.
 *
 * The actor of an event goes INSIDE the sentence — "priya proposed the cutover
 * date" — which is what `chosenAct` has done for a page-authored feed row since
 * round 4. A name inside a system-voice sentence reports an act; a name in a
 * field beside the words attributes a sentence, and no amount of lexical
 * checking on the words changes which of those the layout is doing.
 */
export interface HappenedLine {
  readonly id: string;
  readonly kind: HappenedKind;
  /**
   * The event's clock — a time, never words; painted through a door.
   *
   * OPTIONAL, BECAUSE A LINE WITH NO RECORDED CLOCK HAS NO CLOCK. It was
   * required, and `receiptFromObject` — which builds nine of the ten receipts in
   * the gallery — filled it with `'—'`, so every derived history line rendered
   * "proposed by justin —": an em dash sitting in the column where a time goes,
   * saying nothing and looking like a value. Found by the r8 blind review.
   *
   * This is `HappenedLine.who` again in the field next door. Round 6 deleted
   * `who` because a field beside the words does a job the words should do; the
   * same argument applies to a field holding a placeholder, one step weaker: a
   * required field with nothing to put in it gets filled with a glyph, and a
   * glyph in a data column is a fact the reader has to know to discount.
   */
  readonly at?: string;
  readonly statement: SystemStatement;
}

/**
 * An excerpt in the receipt.
 *
 * There is no `who` and no `at`: both come off the excerpt itself. Round 1
 * found that carrying them separately let priya's name sit beside a sentence
 * minted from lars's message, and the receipt is the one artifact whose entire
 * job is being the trustworthy record.
 */
export interface ProvenanceEntry {
  readonly id: string;
  /**
   * The excerpt IS a quotation, and it is the ONLY source this row has.
   *
   * Round 6: the row printed `entry.excerpt`, took the room from
   * `entry.jump.room` and acted on `entry.jump.messageId` — three facts about
   * one row from three sources. It shipped printing lars's words under
   * `data-quoted=msg:mA@identity-service` and clicking through to mB, priya's
   * message. There is no `jump` any more: what the row prints, what it labels
   * itself with and what it acts on all come out of the one record this citation
   * names.
   */
  readonly excerpt: Quotation;
  /**
   * The page's note about why this excerpt is here — and it is a
   * `SystemStatement`, not a string.
   *
   * ROUND 7'S SHARPEST FINDING. It was `Maybe<string>`, printed by
   * `ReceiptView`'s `ProvenanceRow` INSIDE THE SAME `<button>` AS THE RESOLVED
   * QUOTATION, on the line immediately after the quoted words, under one
   * `data-attribution` and one `data-quoted`. Setting it to
   * `'priya said: I approve dropping users_legacy today.'` rendered that
   * sentence in priya's name, in the receipt, with nothing marking it as the
   * page's — while the record it cites holds "Cut over Friday 1 Aug and drop
   * the legacy tokens with it."
   *
   * `AuthoredMessageEntry.note` has been a `SystemStatement` since round 4 for
   * exactly this reason. The two fields have the same name and the same job and
   * only one of them had the type — which is CONVENTIONS' "a guarantee applies
   * to the value, not to the type it happened to be written for", one field
   * over.
   */
  readonly note: Maybe<SystemStatement>;
}

/**
 * A correction has two voices and they never mix.
 *
 * SYSTEM: `was` → `now`, plus an optional `fact`. Mono, muted, no quotation
 *   marks, no first person, no "X said". Visibly not speech. `at` labels the
 *   correction EVENT; the actor lives inside `fact`, which is a statement, for
 *   the reason `HappenedLine` above states — round 6 found `who` here too, the
 *   second instance of the same free name beside page-authored words.
 * HUMAN: `reason`, present only when a person actually typed one. It is a bare
 *   `Quotation` — the attribution beside it is `reason.actor`, not a `by`
 *   string the caller supplies. Round 1: a `by` beside a quotation is a name
 *   nothing checks.
 */
export interface CorrectionEntry {
  readonly id: string;
  /**
   * The correction's own label — and it is a `SystemStatement`, not a string.
   *
   * ROUND 7, D2. CONVENTIONS claimed "no row that carries page-authored words has
   * a field a renderer could put a name in… it is checkable by reading the
   * types", and reading the types falsified it: `heading: string` was
   * unconstrained, caller-supplied, and rendered by `ReceiptView` as
   * `{heading} · {at}` DIRECTLY ABOVE the correction's words — the exact layout
   * slot `HappenedLine.who` and `CorrectionEntry.who` occupied until round 6
   * deleted them. `heading: 'priya wrote: we should just drop it'` printed
   * there, in the receipt.
   *
   * The mutation entry that was supposed to prove the claim added a NEW REQUIRED
   * property and required `tsc` to fail — which proves that adding a required
   * property breaks the fixtures, not that no such field exists. The claim is
   * checked from the types now, by `test/record-integrity.test.tsx`.
   */
  readonly heading: SystemStatement;
  /** the correction EVENT's clock — a time, never words; painted through a door */
  readonly at: string;
  readonly was: SystemStatement;
  readonly now: SystemStatement;
  readonly fact: Maybe<SystemStatement>;
  readonly reason: Maybe<Quotation>;
  /* The link's `ref` is a Citation, so the id it dispatches is one the register
     resolved. It was a `SourceRef` whose `messageId` reached `onJump` through an
     `?? ''` fallback — a handler dispatching the empty string is a handler that
     was never told what it acted on. */
  readonly link: Maybe<{ readonly label: string; readonly ref: Citation }>;
}

export interface ReceiptRecord {
  readonly id: string;
  readonly state: EpistemicState;
  readonly title: string;
  readonly status: readonly string[];
  readonly happened: readonly HappenedLine[];
  readonly provenance: readonly ProvenanceEntry[];
  readonly corrections: readonly CorrectionEntry[];
  /** A staged machine reading becomes accepted only through this human act. */
  readonly acceptable?: boolean;
  /** An open question may bind the next words the person types as its answer. */
  readonly answerable?: boolean;
  /** Explicit capability; a decision glyph alone does not grant authority. */
  readonly retypeable: boolean;
  readonly reopenable: boolean;
  readonly reopenNote: string;
}

/* --- cross-room jump ----------------------------------------------------- */

export interface CrossRoomJumpRecord {
  /** the room you came from — the trace's way back */
  readonly fromRoom: string;
  /** system voice: why you are standing in this room */
  readonly why: SystemStatement;
  /** the row the jump landed on; it is marked in the feed */
  readonly targetMessage: Citation;
}

/* --- composer ------------------------------------------------------------ */

/**
 * The composer's banner state. `bound` is BRIEF concept 4: your next message
 * resolves the named item, and nothing is inferred from it.
 */
export type ComposerBinding =
  | { readonly mode: 'free' }
  | {
      readonly mode: 'bound';
      readonly itemId: string;
      readonly itemLabel: string;
      readonly objective: string;
      /**
       * THE BOUND ITEM'S OWN STATE — ROUND 10, D1.
       *
       * `Composer` printed a literal `◆` in the ANSWERING banner. On `/` at rest
       * the bound item is X1, which is `irreversible` and wears `■` on the pin
       * card, in the feed tag, in the lens and in its receipt: one banner saying
       * amber-reversible about the one decision on the page that is neither. The
       * banner has the item's state now and derives its glyph like every other
       * surface, and `boundTo` is the only way to build this arm — so the label
       * and the glyph are read off one item rather than typed in beside it.
       */
      readonly state: EpistemicState;
    }
  /** the banner names whoever the quotation says wrote it, and nobody else */
  | { readonly mode: 'replying'; readonly to: Quotation };

/**
 * The only constructor for a bound composer. The id, the label and the state all
 * come off ONE item, so a banner cannot name one thing and glyph another.
 */
export function boundTo(item: AttentionItem, objective: string): ComposerBinding {
  return {
    mode: 'bound',
    itemId: item.id,
    itemLabel: item.title,
    objective,
    state: item.state,
  };
}

/* --- derivations --------------------------------------------------------- */

/**
 * Hardest first — the corpus's turn-17 sort. Failures outrank destructive
 * decisions, which outrank reversible gates, which outrank open questions.
 */
/* The order lives in model/glyph.ts with the vocabulary it orders — see
   `GLYPH_HARDNESS` there. It was a second private copy here until r9, and a
   second copy of a closed vocabulary is what let the receipt's legend fall two
   glyphs behind the glyphs the receipt was emitting. */

export function hardestFirst(items: readonly AttentionItem[]): readonly AttentionItem[] {
  return [...items].sort(
    (a, b) => GLYPH_HARDNESS[glyphFor(a.state)] - GLYPH_HARDNESS[glyphFor(b.state)],
  );
}

/* --- derived aggregates -------------------------------------------------- */
/* Round 1: several aggregates hard-coded ◆ beside a count. A hard-coded glyph
   is a glyph that can disagree with the thing it labels — a pin holding one ■
   and eight ✗ headed by a hand-written ◆ is a claim dressed as a fact, one
   level up. Every aggregate glyph below is derived from the items it counts. */

export interface GlyphCount {
  readonly glyph: Glyph;
  readonly n: number;
}

/** How many of each glyph, hardest first, zero-counts dropped. */
export function glyphCounts(
  items: readonly { readonly state: EpistemicState }[],
): readonly GlyphCount[] {
  const tally = new Map<Glyph, number>();
  for (const item of items) {
    const glyph = glyphFor(item.state);
    tally.set(glyph, (tally.get(glyph) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([glyph, n]) => ({ glyph, n }))
    .sort((a, b) => GLYPH_HARDNESS[a.glyph] - GLYPH_HARDNESS[b.glyph]);
}

/**
 * THE STATE THAT STANDS FOR A WHOLE GROUP: the hardest member's own state.
 *
 * ROUND 10. `hardestGlyph` returned the glyph, which is enough to PRINT a
 * character and not enough to render one: `<Glyph>` takes a state and derives
 * the glyph, the tone and the tooltip from it together. Handing a component the
 * character is what leaves it choosing a colour and a title by hand beside a
 * glyph it did not derive — which is D1's shape one step in from the rail.
 *
 * `null` when the group is empty. An empty group has no state, and a component
 * that has to render something for nothing says so in words, not in a borrowed
 * glyph.
 */
export function hardestState(
  items: readonly { readonly state: EpistemicState }[],
): Maybe<EpistemicState> {
  let best: EpistemicState | null = null;
  for (const item of items) {
    if (best === null || GLYPH_HARDNESS[glyphFor(item.state)] < GLYPH_HARDNESS[glyphFor(best)]) {
      best = item.state;
    }
  }
  return best;
}

/** The glyph that stands for a whole group: the hardest one in it. */
export function hardestGlyph(items: readonly { readonly state: EpistemicState }[]): Maybe<Glyph> {
  const state = hardestState(items);
  return state === null ? null : glyphFor(state);
}

/* --- the pin's own bound ------------------------------------------------- */

/**
 * BRIEF concept 3: "everything clean compresses to counts; folding hides noise
 * but never signals; the pin folds rather than scrolls."
 *
 * Round 1 measured what the unbounded version did at 1440×900: 13 owed items
 * left the feed 183px tall, 17 left it 55px, and at 19 the composer's bottom
 * edge sat at 909 in a 900px viewport with `scrollHeight` still 900 — the
 * composer was unreachable by any means. A room with twenty owed items is the
 * exact load this surface exists for.
 *
 * The fold is derived HERE, from the items, not handed in by a caller. A
 * `folded` boolean the component never sets is not a bound; it is a hope.
 *
 * ROUND 2's GAUNTLET FOUND THE BOUND HELD AND THE WAY PAST IT DID NOT. The
 * unexpanded pin measured clean at every load; the affordance out of it did
 * not. `showAll` raised the budget from 4 to a `PIN_HARD_CAP` of 9 and then
 * did nothing on every subsequent click — at 60 owed items that left 50 of
 * them behind a live-looking "50 more owed" button that could not reveal
 * them, unreachable by any pointer input, while keyboard focus scrolled the
 * `overflow: hidden` list and clipped rows off the top with no way back. A
 * control whose label promises 50 and delivers 5 once is the round-1
 * `data-hold` defect wearing different clothes.
 *
 * THE FOLD NOW PAGES, AND THE LABEL IS DERIVED FROM THE PAGE IT WILL SHOW.
 * The budget never moves — the pixel bound that keeps the composer on screen
 * is the same in every state — and the affordance advances a window through
 * the owed items instead of raising a cap. Every owed item is reachable in a
 * bounded number of clicks; the button says how many the next click brings and
 * how many are still off the page; and the last page wraps back to the hardest
 * rather than becoming a control that does nothing.
 *
 * The pin still FOLDS rather than SCROLLS (BRIEF concept 3, verbatim) — a
 * scrolling pin is the unbounded pin with a scrollbar, and the round-1 measure-
 * ment is what that costs.
 */

/** One open card, then this many compressed rows, then the overflow line. */
export const PIN_COMPACT_BUDGET = 4;

/* ---------------------------------------------------------------------------
 * ROUND 4's GAUNTLET: THE BUDGET WAS A CONSTANT AND SO WAS THE BELT.
 *
 * `.pinList`'s `max-height: 340px` did not shrink against `.app`'s
 * `height: 100vh`. At 1124x500 the pin held its full height out of a 500px
 * frame: the feed collapsed to 22px and the composer's bottom edge sat at 511 in
 * a 500px viewport with `scrollHeight === clientHeight` — round 1's exact
 * signature, at a short viewport instead of a long list. Every harness viewport
 * hard-coded 900, so the one dimension the bound was written against was the one
 * dimension nothing ever varied.
 *
 * Making the belt relative (`min(340px, 34vh)`) keeps the composer on screen and
 * on its own turns the pin back into what round 2 shipped: a box holding more
 * than it can show. So the COUNT bound moves with the pixel bound.
 *
 * ROUND 9: THE BELT WAS TWO NUMBERS THAT DID NOT AGREE, AND A THIRD WRONG ONE
 * HID IT.
 *
 * This block said the belt was `min(340px, 34vh)` and `.pinList` said
 * `max-height: min(260px, 30vh)`. Three comments — here, in the stylesheet, and
 * in `Pin.tsx` — asserted the two were the same number. They were never read
 * against each other because the pixel cap that actually ships is the INLINE one
 * `Pin` writes after measuring, and an inline `max-height` outranks the class
 * rule outright: at a 900px viewport the stylesheet said 260 and the element
 * rendered 306. The stylesheet's copy was dead except before hydration, so it
 * could drift 80px and nothing would fail.
 *
 * The sums balanced anyway because `overflow: 46` charged the belt for the
 * "N more owed" control, which has been a SIBLING of the clipped list since
 * round 5 — a charge for something outside the box being measured, cancelling a
 * belt that was too small. Two wrongs, and removing either one alone moves the
 * row ladder.
 *
 * SO THE BELT IS ONE VALUE NOW, and it lives here. `beltCss` renders these same
 * two numbers as the CSS expression `.pinList` wears (`--pin-belt`, set by
 * `Pin` on the pin root, so the server can serve it with no viewport to measure)
 * and `pinBeltFor` renders them as the pixel number the measured cap and the row
 * ladder both take. There is no belt literal in the stylesheet to disagree with.
 *
 *   available = min(beltMax, beltShare × viewport)   ← and the container's room
 *   needed(b) = card + cardGrowth + b × (row + gap)
 *
 * Every term of `needed` is a box INSIDE `.pinList`. What makes the two agree is
 * not this comment: `test/pin-bound.test.tsx` asserts the rendered custom
 * property is built from these fields, and e2e/pin-bound.spec.ts asserts
 * `scrollHeight <= clientHeight` at five viewport heights, so a card that grows
 * a line fails the suite rather than silently clipping a row off the bottom.
 * ------------------------------------------------------------------------- */
export const PIN_GEOMETRY = {
  /** the open card with a single-line title. Measured in Chromium at 1280,
      1340 and 1440: 72.27px at all three, rounded up. */
  card: 74,
  /** one compressed row. Measured: 37.22px, rounded up. */
  row: 39,
  /** the flex gap between the list's children — `.pinList`'s own `gap`,
      measured as `rowGap: 2px`. It read 4 here while the stylesheet said 2. */
  gap: 2,
  /** one line of the open card's title: `font-size: 11px × line-height: 1.3`,
      measured as 14.3px. */
  titleLine: 14.3,
  /**
   * How many extra title lines the belt carries before a grown card costs a row.
   *
   * Round 6 REMOVED the two-line clamp on `.acardTitle` on purpose (see the
   * `.why` block in attention.module.css: a clip at the end of the route a
   * compressed row sends the reader to is a route to nothing), so the open card
   * is unbounded and `card` above is a measurement of the common case rather
   * than a ceiling. Measured, the card grows exactly one `titleLine` per wrapped
   * line: 72.27 → 86.56 → 100.86 → 115.16.
   *
   * This is the headroom that used to be spelled `overflow: 46` and described as
   * the "N more owed" control — a control that has been a SIBLING of the clipped
   * list since round 5 and was never in this box at all. The allowance is real;
   * only the thing it was attributed to was wrong. Three lines is what the
   * measured belt actually carries at every rung of the ladder: at a 900px
   * viewport the four-row list comes to 229.15px inside a 306px belt.
   */
  cardGrowthLines: 3,
  /** `.pinList`'s max-height, both halves of it — the ONLY place either half is
      written. `beltCss()` renders them for the stylesheet. */
  beltMax: 340,
  beltShare: 0.34,
} as const;

/**
 * The belt as the CSS expression `.pinList` wears, built from the same two
 * fields `pinBeltFor` divides by.
 *
 * It is a string rather than a number because the server has no viewport to
 * measure and guessing one would be a number nothing measured — `vh` lets the
 * browser answer before any script runs. `Pin` sets it as `--pin-belt` on the
 * pin root; `.pinList` carries no belt literal of its own, so this cannot drift
 * out of agreement with the ladder the way `min(260px, 30vh)` did.
 */
export function beltCss(): string {
  const g = PIN_GEOMETRY;
  /* 0.34 × 100 is 34.000000000000004 in binary floating point, and
     `min(340px, 34.000000000000004vh)` is a stylesheet that says the quiet part
     out loud. Six places is past any resolution a viewport has. */
  const share = Number((g.beltShare * 100).toFixed(6));
  return `min(${g.beltMax}px, ${share}vh)`;
}

/** The belt a viewport this tall allows, before the pin's own container is
    consulted. `Pin` takes the smaller of this and the room its pane leaves. */
export function pinBeltFor(viewportHeight: number): number {
  const g = PIN_GEOMETRY;
  return Math.min(g.beltMax, viewportHeight * g.beltShare);
}

/** How many compressed rows fit beside the open card in a belt this tall. */
export function pinBudgetForBelt(available: number): number {
  const g = PIN_GEOMETRY;
  /* Both terms are boxes inside `.pinList`: the open card, and the headroom for
     the card growing past its measured height. The "N more owed" control is not
     here because it is not in there. */
  const fixed = g.card + g.titleLine * g.cardGrowthLines;
  const rows = Math.floor((available - fixed) / (g.row + g.gap));
  return Math.max(0, Math.min(PIN_COMPACT_BUDGET, rows));
}

/** How many compressed rows fit beside the open card in a viewport this tall. */
export function pinBudgetFor(viewportHeight: number): number {
  return pinBudgetForBelt(pinBeltFor(viewportHeight));
}

export interface PinFold {
  /** the one item shown as a full card — always the hardest */
  readonly open: Maybe<AttentionItem>;
  /** compressed but present: glyph, title, rationale, primary action */
  readonly compact: readonly AttentionItem[];
  /** owed and not on this page — counted, named by glyph, reachable by paging */
  readonly overflow: readonly AttentionItem[];
  /**
   * Exactly what one more click puts on screen. The affordance's label is
   * rendered from this, so it cannot promise a number it will not deliver.
   */
  readonly nextPage: readonly AttentionItem[];
  /** true when the next click returns to the hardest page rather than advancing */
  readonly wraps: boolean;
  /** which page of compressed rows is showing, 0-based, already normalised */
  readonly page: number;
  readonly pageCount: number;
  /** not owed to this person: these compress to counts and never take a row */
  readonly clean: readonly AttentionItem[];
  readonly owedTotal: number;
  readonly overflowCounts: readonly GlyphCount[];
  readonly cleanCounts: readonly GlyphCount[];
}

export interface FoldOptions {
  /** which item is open. Ignored when it is not owed — the pin opens what needs you. */
  readonly openId?: string;
  /**
   * Which page of compressed rows to show. Any integer is legal: it is taken
   * modulo the page count, so a caller that only ever increments a counter
   * cannot page off the end into an empty pin.
   */
  readonly page?: number;
  /**
   * How many compressed rows there is ROOM for. Defaults to the full budget;
   * `pinBudgetFor` derives it from the viewport. It is not a caller preference —
   * `Pin` measures it — and it is clamped, so a caller cannot raise it past the
   * belt the way round 2's `showAll` did.
   */
  readonly budget?: number;
}

export function foldPin(items: readonly AttentionItem[], options: FoldOptions = {}): PinFold {
  const owed = hardestFirst(items.filter((item) => needsViewer(item.state)));
  const clean = hardestFirst(items.filter((item) => !needsViewer(item.state)));
  const budget = Math.max(
    0,
    Math.min(PIN_COMPACT_BUDGET, Math.trunc(options.budget ?? PIN_COMPACT_BUDGET)),
  );
  const normalise = (count: number) => {
    const requested = Math.trunc(options.page ?? 0);
    return ((requested % count) + count) % count;
  };

  if (budget === 0) {
    /* NO ROOM FOR A SINGLE COMPRESSED ROW — a short viewport, where the belt
       leaves space for the open card and the overflow line and nothing else.

       The page then advances THE CARD rather than a row window. Round 2's rule
       was "the open card is the hardest and does not move with the page", and
       the reason was that paging past the worst thing in the room should not be
       possible. At this height the alternative is not "the hardest stays open",
       it is "everything except the hardest is unreachable" — which is round 2's
       actual defect, a control that promises N and delivers nothing. Page 0 is
       always the hardest, so the worst thing is still what the pin opens with. */
    const base = Math.max(
      0,
      owed.findIndex((item) => item.id === options.openId),
    );
    const pageCount = Math.max(1, owed.length);
    const page = normalise(pageCount);
    const index = (base + page) % pageCount;
    const open = owed[index] ?? null;
    const nextIndex = (index + 1) % pageCount;
    const next = owed[nextIndex];
    const overflow = owed.filter((_, i) => i !== index);
    return {
      open,
      compact: [],
      overflow,
      nextPage: next === undefined || owed.length < 2 ? [] : [next],
      wraps: pageCount > 1 && (page + 1) % pageCount === 0,
      page,
      pageCount,
      clean,
      owedTotal: owed.length,
      overflowCounts: glyphCounts(overflow),
      cleanCounts: glyphCounts(clean),
    };
  }

  /* The open card is the hardest owed item and does not move with the page:
     paging past the worst thing in the room is not something this surface
     should be able to do. */
  const open = owed.find((item) => item.id === options.openId) ?? owed[0] ?? null;
  const rest = owed.filter((item) => item.id !== open?.id);

  const pageCount = Math.max(1, Math.ceil(rest.length / budget));
  const page = normalise(pageCount);
  const start = page * budget;
  const compact = rest.slice(start, start + budget);
  const overflow = rest.filter((_, index) => index < start || index >= start + budget);

  const nextIndex = (page + 1) % pageCount;
  const nextStart = nextIndex * budget;

  return {
    open,
    compact,
    overflow,
    nextPage: rest.slice(nextStart, nextStart + budget),
    wraps: pageCount > 1 && nextIndex === 0,
    page,
    pageCount,
    clean,
    owedTotal: owed.length,
    overflowCounts: glyphCounts(overflow),
    cleanCounts: glyphCounts(clean),
  };
}

/**
 * The trailer's lead, derived from verification and attention rather than
 * written. "Everything else is green" may only be said when green is true of
 * everything outside the pin — green means checked by something other than the
 * claimant, so eight unchecked claims are not green.
 */
export interface TrailerSummary {
  readonly state: EpistemicState;
  /**
   * The lead clause, as a SystemStatement rather than a string.
   *
   * Found by the round-6 blind cross-lineage review, sweeping every element that
   * carries `data-voice="system"`: this is a whole page-authored SENTENCE
   * rendered in the mono-muted treatment that tells a reader the system checked
   * it, and it was a free `string`. `trailerFor` is the only thing that builds
   * one, so the type costs nothing and closes the sink — which is the difference
   * between this field and the room name below it: a sentence gets a type, a
   * short identifier gets a render-boundary check.
   */
  readonly lead: SystemStatement;
  /**
   * WHICH COUNT THE LEAD IS ABOUT, so the tail does not say it again.
   *
   * Round 7, D7: the trailer read "1 failure outside your list — 1/2 objectives
   * clear of you · 1 commitment, 1 overdue · 1 failure · last check 12:29". The
   * lead is DERIVED from whichever count is worst, and the tail printed all of
   * them unconditionally, so the worst one appeared twice in one sentence. A
   * derived lead and a fixed tail are two descriptions of the same numbers; this
   * is what makes them one.
   */
  readonly leadsWith: 'failures' | 'overdue' | 'unverified' | 'open' | 'owed' | 'clear';
  /* ---------------------------------------------------------------------------
   * TWO SCOPES, AND EACH CLAUSE NAMES ITS OWN — ROUND 10, D4.
   *
   * The trailer read "✗ 1 failure outside your list — 2 objectives clear of you ·
   * 2 commitments, 0 overdue · last check 12:29". `commitments` and `failures`
   * counted the objects OUTSIDE the pin; `overdue` was handed in as a room-wide
   * number; `objectivesClear` is about the pin. Three scopes in one sentence,
   * one of them stated. So "0 overdue" sat 300px from a lens row reading
   * "overdue 16h", and on `/gallery/pin/60` "0 failures" sat beside a lens head
   * reading "15 failures", and both were true of what they counted and unreadable
   * as such.
   *
   * The fields below are grouped by scope and the component renders them as two
   * named clauses. `overdue` is now counted over the same objects `commitments`
   * and `failures` are, from a register of WHICH objects are late — the only way
   * for the three numbers in one clause to be about one set.
   * ------------------------------------------------------------------------- */
  /** YOUR LIST: objectives with nothing in them owed to you */
  readonly objectivesClear: number;
  readonly objectivesTotal: number;
  /** OUTSIDE YOUR LIST: the objects that do not need you, counted three ways */
  readonly commitments: number;
  readonly overdue: number;
  readonly failures: number;
  /** how many objects "outside your list" is, so the clause can be checked */
  readonly outside: number;
}

/* No `lastCheck`: round 1 caught it being accepted and never read. A parameter
   nothing consumes is a claim that the derivation depends on something it does
   not, which is the same defect as a hard-coded glyph one level down. The
   trailer renders the last-check time as its own prop. */
export function trailerFor(input: {
  readonly objects: readonly StateObject[];
  readonly objectives: readonly ObjectiveRecord[];
  /**
   * WHICH objects are late, by id — not how many.
   *
   * ROUND 10, D4: it was a `number` computed room-wide, printed inside a clause
   * whose other two numbers count the objects outside your list. A count cannot
   * be re-scoped; a register of ids can, and this one is intersected with the
   * same `rest` the clause's neighbours are counted over.
   */
  readonly overdue: readonly string[];
}): TrailerSummary {
  const owed = input.objects.filter((o) => needsViewer(o.state));
  const owedIds = new Set(owed.map((o) => o.id));
  const rest = input.objects.filter((o) => !owedIds.has(o.id));
  const late = new Set(input.overdue);

  const objectivesClear = input.objectives.filter(
    (ob) => !owed.some((o) => o.objectives.includes(ob.id)),
  ).length;
  const commitments = rest.filter((o) => o.kind === 'commitment').length;
  const overdue = rest.filter((o) => late.has(o.id)).length;
  const failures = rest.filter((o) => o.state.verification === 'failed').length;
  const unverified = rest.filter((o) =>
    ['proposed', 'unverified', 'self_reported'].includes(o.state.verification),
  ).length;
  const openQuestions = rest.filter((o) => o.state.verification === 'open').length;

  const summary = (
    verification: EpistemicState['verification'],
    kind: ObjectKind,
    lead: string,
    leadsWith: TrailerSummary['leadsWith'],
  ): TrailerSummary => ({
    state: { kind, verification, owedToViewer: false, irreversible: false },
    lead: systemStatement(lead),
    leadsWith,
    objectivesClear,
    objectivesTotal: input.objectives.length,
    commitments,
    overdue,
    failures,
    outside: rest.length,
  });

  /* EVERY LEAD IS ABOUT THE SAME SET AS THE CLAUSE UNDER IT, and says so. The
     r9 leads counted `rest` and only the failures arm mentioned it, which is how
     "N things are late" read as a claim about the room. */
  if (failures > 0) {
    return summary(
      'failed',
      'event',
      `${failures} failure${failures === 1 ? '' : 's'} outside your list`,
      'failures',
    );
  }
  if (overdue > 0) {
    return summary(
      'proposed',
      'commitment',
      `${overdue} thing${overdue === 1 ? ' is' : 's are'} late outside your list, none failed`,
      'overdue',
    );
  }
  if (unverified > 0) {
    return summary(
      'self_reported',
      'claim',
      `${unverified} of the ${rest.length} outside your list still unverified`,
      'unverified',
    );
  }
  if (openQuestions > 0) {
    return summary(
      'open',
      'question',
      `${openQuestions} question${openQuestions === 1 ? '' : 's'} outside your list still open`,
      'open',
    );
  }
  if (owed.length > 0) {
    return summary('proposed', 'decision', 'the list above is all of it', 'owed');
  }
  return summary('verified', 'claim', 'everything outside your list is verified', 'clear');
}
