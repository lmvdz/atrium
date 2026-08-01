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
import type { MessageId, Quotation, SystemStatement } from './quotation';
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

export interface ReplyContext {
  readonly actor: string;
  readonly at: string;
  /** an excerpt of what is being replied to — a quotation, so it must be proven */
  readonly excerpt: Quotation;
}

export interface MessageEntry {
  readonly type: 'message';
  readonly id: MessageId;
  readonly at: string;
  readonly actor: string;
  readonly body: readonly BodySegment[];
  /** the epistemic state of the object this message carries, when it carries one */
  readonly state: EpistemicState;
  readonly fromViewer: boolean;
  readonly replyTo: Maybe<ReplyContext>;
  /**
   * A system-voice note under the row — "chosen from the options on the card",
   * "superseded". Typed as a SystemStatement so it cannot be a person's words.
   */
  readonly note: Maybe<SystemStatement>;
  readonly tag: Maybe<RowTag>;
  /** highlighted as the target of a cross-room jump */
  readonly targeted: boolean;
  /** matches the active feed filter (rows that do not are dimmed, never hidden) */
  readonly matchesFilter: boolean;
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

export interface HappenedLine {
  readonly id: string;
  readonly kind: HappenedKind;
  readonly who: string;
  readonly at: string;
  readonly text: string;
}

export interface ProvenanceEntry {
  readonly id: string;
  readonly who: string;
  readonly at: string;
  /** the excerpt IS a quotation — there is no way to show one that is not proven */
  readonly excerpt: Quotation;
  readonly note: Maybe<string>;
  readonly jump: Maybe<SourceRef>;
}

/**
 * A correction has two voices and they never mix.
 *
 * SYSTEM: `was` → `now`, plus an optional `fact`. Mono, muted, no quotation
 *   marks, no first person, no "X said". Visibly not speech.
 * HUMAN: `reason`, present only when a person actually typed one. Rendered in
 *   <q>, attributed, and provably theirs because it is a Quotation.
 */
export interface CorrectionEntry {
  readonly id: string;
  readonly heading: string;
  readonly who: string;
  readonly at: string;
  readonly was: SystemStatement;
  readonly now: SystemStatement;
  readonly fact: Maybe<SystemStatement>;
  readonly reason: Maybe<{ readonly quotation: Quotation; readonly by: string }>;
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
  | { readonly mode: 'replying'; readonly to: ReplyContext };

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

export function trailerFor(input: {
  readonly objects: readonly StateObject[];
  readonly objectives: readonly ObjectiveRecord[];
  readonly overdue: number;
  readonly lastCheck: string;
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
