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
import { chosenAct, quotationFrom, recordFingerprint } from './quotation';
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
}

/** A row whose words are the actor's own — typed here or already on the record. */
export interface AuthoredMessageEntry extends MessageEntryCommon {
  readonly origin: QuotableOrigin;
  /** the citation: the message id this row's words and name come from */
  readonly attribution: Quotation;
  /**
   * A checksum of the record this row was minted from — NEVER rendered, only
   * compared against the record the row is resolved against.
   *
   * The blind cross-lineage review of round 5 found the frame taking the rows
   * and the record register as independent props, so a row minted from lars's
   * record could be rendered inside a ledger whose `m14` says priya, with no
   * cast and no forged field. This is what makes "the row and the ledger are the
   * same register" checkable rather than assumed. See `recordFingerprint`.
   */
  readonly mintedFrom: string;
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
    mintedFrom: recordFingerprint(record),
    body: input.body ?? [{ kind: 'text', text: record.text }],
    fromViewer: input.viewer !== undefined && record.actor === input.viewer,
    note: input.note ?? null,
  } as AuthoredMessageEntry;
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
 * than it can show. So the COUNT bound moves with the pixel bound. The numbers
 * below are the rendered geometry, measured in Chromium at 1124px, and the
 * arithmetic is the same arithmetic the stylesheet does:
 *
 *   available = min(340, 0.34 × viewport)      ← attention.module.css, .pinList
 *   needed(b) = card + gap + overflow + b × (row + gap)
 *
 * They are two numbers that must agree, and what makes them agree is not this
 * comment: e2e/pin-bound.spec.ts asserts `scrollHeight <= clientHeight` at five
 * viewport heights, so a card that grows a line fails the suite rather than
 * silently clipping a row off the bottom of the pin.
 * ------------------------------------------------------------------------- */
export const PIN_GEOMETRY = {
  /** the open card */
  card: 74,
  /** one compressed row */
  row: 39,
  /** flex gap between them */
  gap: 4,
  /** the gap the belt leaves so a card that grew a line is visibly clipped rather
      than exactly filling the box — the "N more owed" control is a SIBLING of the
      clipped list now (attention.module.css, .pinMore), so it is not in this sum */
  overflow: 46,
  /** `.pinList`'s max-height, both halves of it */
  beltMax: 340,
  beltShare: 0.34,
} as const;

/** How many compressed rows fit beside the open card in a viewport this tall. */
export function pinBudgetFor(viewportHeight: number): number {
  const g = PIN_GEOMETRY;
  const available = Math.min(g.beltMax, viewportHeight * g.beltShare);
  const fixed = g.card + g.gap + g.overflow;
  const rows = Math.floor((available - fixed) / (g.row + g.gap));
  return Math.max(0, Math.min(PIN_COMPACT_BUDGET, rows));
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
