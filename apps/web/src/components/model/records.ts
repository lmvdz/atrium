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
import { glyphFor, needsViewer } from './glyph';
import type {
  MessageId,
  MessageRecord,
  QuotableOrigin,
  Quotation,
  SystemStatement,
} from './quotation';
import { chosenAct, quotationFrom } from './quotation';
import type { Rationale } from './rationale';
import type { Maybe } from './text';

/* --- rail ---------------------------------------------------------------- */

export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly unseen: number;
  /** how many items in that room are owed to the viewer */
  readonly owed: number;
  readonly current: boolean;
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

/* --- timeline ------------------------------------------------------------ */

/** An inline run inside a message body. Code and mentions are the only two. */
export type BodySegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'mention'; readonly text: string };

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
 * ------------------------------------------------------------------------- */

interface MessageEntryCommon {
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
}

/** A row whose words are the actor's own — typed here or already on the record. */
export interface AuthoredMessageEntry extends MessageEntryCommon {
  readonly origin: QuotableOrigin;
  /** the proof: the words, the actor and the message id, from one record */
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
      /* Third person, on purpose: "lars chose: …" is a fact about an act. It is
         not "lars said", and it is not in his voice. */
      statement: chosenAct(record.actor, record.text, record.id),
    };
  }

  /* THE BODY DERIVES FROM THE RECORD. Segments add markup; they do not add,
     remove or reword anything. A body that reads differently from the message
     it is attributed to is synthesized speech under a real name — the round-1
     defect, relocated from the actor slot to the body slot. */
  if (input.body !== undefined) {
    const rendered = bodyText(input.body);
    if (rendered !== record.text) {
      throw new Error(
        `messageEntry: ${record.id}'s body does not read as the message it is attributed to (${attribution.actor}). ` +
          'A body marks the record up; it may not change the words.\n' +
          `  record: ${JSON.stringify(record.text)}\n` +
          `  body:   ${JSON.stringify(rendered)}`,
      );
    }
  }

  return {
    ...common,
    origin: attribution.origin,
    attribution,
    body: input.body ?? [{ kind: 'text', text: record.text }],
    fromViewer: input.viewer !== undefined && record.actor === input.viewer,
    note: input.note ?? null,
  };
}

export interface RowTag {
  readonly label: string;
  readonly tone: 'neutral' | 'needs' | 'verified';
}

export interface SystemEntry {
  readonly type: 'system';
  readonly id: string;
  readonly at: string;
  /** system rows are always system voice — the type says so */
  readonly statement: SystemStatement;
  readonly state: EpistemicState;
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
}

export type TimelineEntry = MessageEntry | SystemEntry | SinceYouLeftEntry | RoutineEntry;

/* --- attention ----------------------------------------------------------- */

export interface SourceRef {
  readonly messageId: MessageId;
  /** the room the source lives in, when it is not the one on screen */
  readonly room: Maybe<string>;
}

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
  readonly source: Maybe<SourceRef>;
  readonly actions: readonly AttentionAction[];
}

/* --- state lens ---------------------------------------------------------- */

export type ObjectiveStatus = 'active' | 'blocked' | 'idle';

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

export type HappenedKind =
  | 'claim'
  | 'verified'
  | 'accepted'
  | 'gate'
  | 'question'
  | 'routine'
  | 'failed';

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
    case 'question':
      return { kind: 'question', verification: 'open', owedToViewer: false, irreversible: false };
    case 'failed':
      return { kind: 'event', verification: 'failed', owedToViewer: false, irreversible: false };
    case 'routine':
      return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
  }
}

/**
 * A history line. `who` names the actor of an EVENT, and the line's words are a
 * `SystemStatement` — third person, page-authored, visibly not speech. Nothing
 * on this record is quoted, which is why the name may be a plain string here
 * and may not be one on `ProvenanceEntry` below.
 */
export interface HappenedLine {
  readonly id: string;
  readonly kind: HappenedKind;
  readonly who: string;
  readonly at: string;
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
  /** the excerpt IS a quotation — it carries the words, the actor and the time */
  readonly excerpt: Quotation;
  readonly note: Maybe<string>;
  readonly jump: Maybe<SourceRef>;
}

/**
 * A correction has two voices and they never mix.
 *
 * SYSTEM: `was` → `now`, plus an optional `fact`. Mono, muted, no quotation
 *   marks, no first person, no "X said". Visibly not speech. `who`/`at` label
 *   the correction EVENT and sit inside that system-voice header.
 * HUMAN: `reason`, present only when a person actually typed one. It is a bare
 *   `Quotation` — the attribution beside it is `reason.actor`, not a `by`
 *   string the caller supplies. Round 1: a `by` beside a quotation is a name
 *   nothing checks.
 */
export interface CorrectionEntry {
  readonly id: string;
  readonly heading: string;
  readonly who: string;
  readonly at: string;
  readonly was: SystemStatement;
  readonly now: SystemStatement;
  readonly fact: Maybe<SystemStatement>;
  readonly reason: Maybe<Quotation>;
  readonly link: Maybe<{ readonly label: string; readonly ref: SourceRef }>;
}

export interface ReceiptRecord {
  readonly id: string;
  readonly state: EpistemicState;
  readonly title: string;
  readonly status: readonly string[];
  readonly happened: readonly HappenedLine[];
  readonly provenance: readonly ProvenanceEntry[];
  readonly corrections: readonly CorrectionEntry[];
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
  readonly targetMessage: MessageId;
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
    }
  /** the banner names whoever the quotation says wrote it, and nobody else */
  | { readonly mode: 'replying'; readonly to: Quotation };

/* --- derivations --------------------------------------------------------- */

/**
 * Hardest first — the corpus's turn-17 sort. Failures outrank destructive
 * decisions, which outrank reversible gates, which outrank open questions.
 */
const GLYPH_HARDNESS: Readonly<Record<Glyph, number>> = {
  '✗': 0,
  '■': 1,
  '◆': 2,
  '?': 3,
  '~': 4,
  '·': 5,
  '✓': 6,
};

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
 * The glyph that stands for a whole group: the hardest one in it. `null` when
 * the group is empty — an empty group has no state, and a component that has to
 * render something for nothing should say so in words, not in a borrowed glyph.
 */
export function hardestGlyph(items: readonly { readonly state: EpistemicState }[]): Maybe<Glyph> {
  const counts = glyphCounts(items);
  return counts[0]?.glyph ?? null;
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

/** The window advances by exactly what it shows: one page is one budget. */
export const PIN_PAGE = PIN_COMPACT_BUDGET;

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
}

export function foldPin(items: readonly AttentionItem[], options: FoldOptions = {}): PinFold {
  const owed = hardestFirst(items.filter((item) => needsViewer(item.state)));
  const clean = hardestFirst(items.filter((item) => !needsViewer(item.state)));

  /* The open card is the hardest owed item and does not move with the page:
     paging past the worst thing in the room is not something this surface
     should be able to do. */
  const open = owed.find((item) => item.id === options.openId) ?? owed[0] ?? null;
  const rest = owed.filter((item) => item.id !== open?.id);

  const pageCount = Math.max(1, Math.ceil(rest.length / PIN_PAGE));
  const requested = Math.trunc(options.page ?? 0);
  const page = ((requested % pageCount) + pageCount) % pageCount;
  const start = page * PIN_PAGE;
  const compact = rest.slice(start, start + PIN_PAGE);
  const overflow = rest.filter((_, index) => index < start || index >= start + PIN_PAGE);

  const nextIndex = (page + 1) % pageCount;
  const nextStart = nextIndex * PIN_PAGE;

  return {
    open,
    compact,
    overflow,
    nextPage: rest.slice(nextStart, nextStart + PIN_PAGE),
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
  readonly lead: string;
  readonly objectivesClear: number;
  readonly objectivesTotal: number;
  readonly commitments: number;
  readonly overdue: number;
  readonly failures: number;
}

/* No `lastCheck`: round 1 caught it being accepted and never read. A parameter
   nothing consumes is a claim that the derivation depends on something it does
   not, which is the same defect as a hard-coded glyph one level down. The
   trailer renders the last-check time as its own prop. */
export function trailerFor(input: {
  readonly objects: readonly StateObject[];
  readonly objectives: readonly ObjectiveRecord[];
  readonly overdue: number;
}): TrailerSummary {
  const owed = input.objects.filter((o) => needsViewer(o.state));
  const owedIds = new Set(owed.map((o) => o.id));
  const rest = input.objects.filter((o) => !owedIds.has(o.id));

  const objectivesClear = input.objectives.filter(
    (ob) => !owed.some((o) => o.objectives.includes(ob.id)),
  ).length;
  const commitments = rest.filter((o) => o.kind === 'commitment').length;
  const failures = rest.filter((o) => o.state.verification === 'failed').length;
  const unverified = rest.filter((o) =>
    ['proposed', 'unverified', 'self_reported'].includes(o.state.verification),
  ).length;
  const openQuestions = rest.filter((o) => o.state.verification === 'open').length;

  const summary = (
    verification: EpistemicState['verification'],
    kind: ObjectKind,
    lead: string,
  ): TrailerSummary => ({
    state: { kind, verification, owedToViewer: false, irreversible: false },
    lead,
    objectivesClear,
    objectivesTotal: input.objectives.length,
    commitments,
    overdue: input.overdue,
    failures,
  });

  if (failures > 0) {
    return summary(
      'failed',
      'event',
      `${failures} failure${failures === 1 ? '' : 's'} outside your list`,
    );
  }
  if (input.overdue > 0) {
    return summary(
      'proposed',
      'commitment',
      `${input.overdue} thing${input.overdue === 1 ? ' is' : 's are'} late, none failed`,
    );
  }
  if (unverified > 0) {
    return summary('self_reported', 'claim', `${unverified} of ${rest.length} still unverified`);
  }
  if (openQuestions > 0) {
    return summary(
      'open',
      'question',
      `${openQuestions} question${openQuestions === 1 ? '' : 's'} still open`,
    );
  }
  if (owed.length > 0) {
    return summary('proposed', 'decision', 'the list above is all of it');
  }
  return summary('verified', 'claim', 'everything else is verified');
}
