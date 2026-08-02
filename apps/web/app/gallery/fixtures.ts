/* ---------------------------------------------------------------------------
 * Gallery fixtures — one room, told six ways.
 *
 * Everything here is a plain record handed to props. There is no store, no
 * reducer and no fetch: the gallery exists to prove the component layer renders
 * every state it claims to, and a fixture that needed a runtime to exist would
 * not prove that.
 *
 * The content is the users-migration story the prototype uses, so a reviewer
 * can put the two side by side. Every quotation below is minted from a message
 * in `MESSAGES` through `quotationFrom` — including the ones the receipt shows.
 * ------------------------------------------------------------------------- */

import type {
  AttentionItem,
  BodySegment,
  ComposerBinding,
  CorrectionEntry,
  CrossRoomJumpRecord,
  HappenedKind,
  HumanSummary,
  Maybe,
  MessageEntry,
  MessageRecord,
  ObjectiveRecord,
  ProvenanceEntry,
  Quotation,
  ReceiptRecord,
  RoomHeadRecord,
  RoomSummary,
  RoutineEntry,
  SinceYouLeftEntry,
  StateObject,
  SurfaceIndicator,
  SystemEntry,
  SystemStatement,
  TimelineEntry,
  TrailerSummary,
} from '../../src/components/model';
import {
  checkedFeed,
  citationFrom,
  glyphFor,
  happenedKindFor,
  messageEntry,
  needsTag,
  quotationFrom,
  rationale,
  settledForViewer,
  systemStatement,
  trailerFor,
} from '../../src/components/model';

/* --- the register of real messages --------------------------------------- */
/* A quotation can only be minted from one of these, and only when its origin is
   `typed` or `seeded`. m-chosen is here on purpose: it is the one-click answer,
   and it is what the round-4 gauntlet caught being quoted as somebody's words. */

/**
 * THE ROOM THESE RECORDS LIVE IN, WRITTEN DOWN.
 *
 * Round 8, D3: every record here but `m-legal` carried NO room, and three render
 * boundaries read that absence as "the room you are looking at". A room is a
 * fact about a message; absence is a fact about the register. They are the same
 * value only from one viewport, and this register is deliberately shared across
 * all four.
 */
const HERE = 'users-migration';

export const MESSAGES: Readonly<Record<string, MessageRecord>> = {
  m2: {
    id: 'm2',
    at: '09:04',
    actor: 'priya',
    text: 'Staging backfill ran clean — 4.2M rows in 38 minutes.',
    origin: 'seeded',
    room: HERE,
  },
  m5: {
    id: 'm5',
    at: '09:41',
    actor: 'dana',
    text: '4.7% of sessions still present legacy opaque tokens.',
    origin: 'seeded',
    room: HERE,
  },
  /* The inline-runs fixture. Round 2 shipped this record with a body that added
     a mention and a whole clause the record did not contain — the words under
     mateo's name were not mateo's. The record now carries the full sentence,
     and the body below marks THAT text up rather than extending it. */
  m7: {
    id: 'm7',
    at: '10:12',
    actor: 'mateo',
    text: '@lars dual-write costs about $900/mo in extra write throughput — that is users.dualwrite on both tables, not the backfill.',
    origin: 'seeded',
    room: HERE,
  },
  m10: {
    id: 'm10',
    at: '11:02',
    actor: 'priya',
    text: 'Cut over Friday 1 Aug and drop the legacy tokens with it.',
    origin: 'seeded',
    room: HERE,
  },
  m14: {
    id: 'm14',
    at: '11:48',
    actor: 'lars',
    text: 'This was an actual call, not priya thinking out loud.',
    origin: 'typed',
    room: HERE,
  },
  /* A message that genuinely lives in another room. It has no row in this feed —
     the register is not the feed — and it is what a cross-room source, a
     cross-room provenance row and a `msg:…@identity-service` token are rendered
     from. Before round 6 the cross-room label came from a `room` carried beside
     the id on `SourceRef`/`ProvenanceEntry.jump`, and for `m10` it was simply
     false: the receipt printed "in #identity-service" over a message this room
     holds and whose record says so. */
  'm-legal': {
    id: 'm-legal',
    at: '09:11',
    actor: 'priya',
    text: 'Does legal approve 90-day retention of users_legacy?',
    origin: 'seeded',
    room: 'identity-service',
  },
  m17: {
    id: 'm17',
    at: '12:31',
    actor: 'justin',
    text: 'Parity check 418 came back with 12 checksum diffs on users_legacy.',
    origin: 'seeded',
    room: HERE,
  },
  m19: {
    id: 'm19',
    at: '12:44',
    actor: 'justin',
    text: 'Simplest is to drop users_legacy in the same window. Nothing reads it after cutover.',
    origin: 'seeded',
    room: HERE,
  },
  m21: {
    id: 'm21',
    at: '13:07',
    actor: 'lars',
    text: 'Hold the cutover until 418 is explained. I would rather be a week late than lose a session.',
    origin: 'typed',
    room: HERE,
  },
  q1: {
    id: 'q1',
    at: '13:40',
    actor: 'priya',
    text: 'Seven clean days. The dual-write condition is met.',
    origin: 'seeded',
    room: HERE,
  },
  q2: {
    id: 'q2',
    at: '13:41',
    actor: 'lars',
    text: 'Good. Nothing else from me today.',
    origin: 'typed',
    room: HERE,
  },
  'm-chosen': {
    id: 'm-chosen',
    at: '13:09',
    actor: 'lars',
    text: 'Keep dual-write on until parity holds for 7 consecutive days',
    // PAGE-AUTHORED. `quotationFrom` returns null for this; the only way it can
    // be rendered is in system voice, as "chose: …".
    origin: 'chosen',
    room: HERE,
  },
  /* ORDINARY ENGLISH IN A ONE-CLICK ANSWER. Round 4 applied the system-voice
     first-person ban to the OPTION PAYLOAD, so all four of these threw at
     render — "our", "us", "I" and "we" are four of the five commonest pronouns
     in the language, and a product whose buttons cannot contain them is not a
     product. They are fixtures rather than test-only strings on purpose: the
     round-4 ban had no live subject, which is why nothing caught it. */
  'm-retention': {
    id: 'm-retention',
    at: '13:11',
    actor: 'lars',
    text: 'Keep it behind our retention window',
    origin: 'chosen',
    room: HERE,
  },
  'm-day': {
    id: 'm-day',
    at: '13:12',
    actor: 'priya',
    text: 'Give us another day',
    origin: 'chosen',
    room: HERE,
  },
  'm-approve': {
    id: 'm-approve',
    at: '13:13',
    actor: 'justin',
    text: 'Yes — I approve',
    origin: 'chosen',
    room: HERE,
  },
  'm-agreed': {
    id: 'm-agreed',
    at: '13:15',
    actor: 'dana',
    text: 'Ship it, we agreed',
    origin: 'chosen',
    room: HERE,
  },
};

/**
 * The register as a list, for `<AttributionLedger>`. Every citation any frame
 * renders resolves against exactly this — a quotation for a message that is not
 * here does not degrade, it throws.
 */
export const RECORDS: readonly MessageRecord[] = Object.values(MESSAGES);

/* A reference to a message of any origin, checked against this register. `cite`
   and `quote` are the two doors: `quote` additionally proves the words are the
   person's own, and refuses a page-authored record. */
function cite(id: string) {
  const message = MESSAGES[id];
  if (message === undefined) throw new Error(`fixture: no message ${id}`);
  return citationFrom(message);
}

function quote(id: string) {
  const message = MESSAGES[id];
  if (message === undefined) throw new Error(`fixture: no message ${id}`);
  const quotation = quotationFrom(message);
  if (quotation === null) {
    throw new Error(
      `fixture: ${id} is page-authored and cannot be quoted — that is the invariant working`,
    );
  }
  return quotation;
}

/* --- rail ---------------------------------------------------------------- */

export const ROOMS: readonly RoomSummary[] = [
  { id: 'r1', name: 'users-migration', unseen: 0, owed: 4, current: true },
  { id: 'r2', name: 'identity-service', unseen: 12, owed: 1, current: false },
  { id: 'r3', name: 'platform', unseen: 3, owed: 0, current: false },
  { id: 'r4', name: 'design', unseen: 0, owed: 0, current: false },
];

export const ROOMS_QUIET: readonly RoomSummary[] = ROOMS.map((room) => ({ ...room, owed: 0 }));

/**
 * THE RAIL AS IT MUST READ BESIDE A FRAME SHOWING `owed` ITEMS IN `roomName`.
 *
 * ROUND 8, D2, ZERO CLICKS: `/gallery/pin/60` rendered `# users-migration ◆ 4`
 * in the same rail as `here · 60 owed to you`, because the rail was the static
 * `ROOMS` fixture and the pin was `manyOwed(60)`. A still is a STATE, and a
 * state whose rail contradicts its pin is not one of this product's states.
 *
 * The chip for the room being shown states what the frame is showing; the other
 * chips are claims about rooms this frame does not render, so they keep their
 * own numbers. The room you are standing in has no unseen count, because you are
 * reading it.
 */
export function railFor(roomName: string, owed: number): readonly RoomSummary[] {
  return ROOMS.map((room) =>
    room.name === roomName
      ? { ...room, current: true, unseen: 0, owed }
      : { ...room, current: false },
  );
}

export const VIEWER: HumanSummary = {
  id: 'lars',
  name: 'lars',
  presence: 'here',
  note: null,
  isViewer: true,
};

export const HUMANS: readonly HumanSummary[] = [
  VIEWER,
  { id: 'priya', name: 'priya', presence: 'here', note: 'in #identity-service', isViewer: false },
  { id: 'dana', name: 'dana', presence: 'idle', note: '20m', isViewer: false },
  { id: 'justin', name: 'justin', presence: 'here', note: null, isViewer: false },
  { id: 'mateo', name: 'mateo', presence: 'away', note: 'back tomorrow', isViewer: false },
];

export const ROOM: RoomHeadRecord = {
  name: 'users-migration',
  topic: 'cut auth over to the new users table without dropping a live session',
  members: ['lars', 'priya', 'dana', 'justin', 'mateo'],
};

/** All three surfaces are on screen at once; only two of them carry a count. */
export function surfaces(owed: number, objects: number): readonly SurfaceIndicator[] {
  return [
    { id: 'conversation', label: 'CONVERSATION', count: null, warn: false },
    { id: 'needs-you', label: 'NEEDS YOU', count: owed, warn: true },
    { id: 'current-state', label: 'CURRENT STATE', count: objects, warn: false },
  ];
}

/* --- state lens ---------------------------------------------------------- */

export const OBJECTIVES: readonly ObjectiveRecord[] = [
  { id: 'o1', title: 'Dual-write parity before cutover', status: 'active', open: true },
  { id: 'o2', title: 'Retire the legacy opaque tokens', status: 'blocked', open: false },
];

export const OBJECTS: readonly StateObject[] = [
  {
    id: 'D1',
    kind: 'decision',
    state: { kind: 'decision', verification: 'accepted', owedToViewer: false, irreversible: false },
    text: 'Dual-write stays on until parity holds for 7 consecutive days',
    facts: ['accepted by lars', '29 Jul 11:20', 'answer-bound'],
    objectives: ['o1'],
  },
  {
    id: 'X1',
    kind: 'decision',
    state: { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: true },
    text: 'Drop users_legacy at cutover rather than after the retention window',
    facts: ['proposed by justin', 'not accepted', 'destructive'],
    objectives: ['o1', 'o2'],
  },
  {
    id: 'P1',
    kind: 'decision',
    state: { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: false },
    text: 'Cut over Friday 1 Aug and drop the legacy tokens with it',
    facts: ['proposed by priya', 'confidence .71', 'not accepted'],
    objectives: ['o1'],
  },
  {
    id: 'Q1',
    kind: 'question',
    state: { kind: 'question', verification: 'open', owedToViewer: true, irreversible: false },
    text: 'Does legal approve 90-day retention of users_legacy?',
    /* "asked by priya" is a SPEECH REPORT, and round 7 routed every printed
       fact through the system-voice door — which refused it, correctly: a fact
       line reports an ACT ("raised"), and "X said/asked/wrote" is the framing
       the ban exists for. The fixture says the act. */
    facts: ['raised by priya 09:11', 'open 3h', 'nobody assigned'],
    objectives: ['o1', 'o2'],
  },
  {
    id: 'K2',
    kind: 'commitment',
    state: {
      kind: 'commitment',
      verification: 'self_reported',
      owedToViewer: true,
      irreversible: false,
    },
    text: 'Sign off the rollback runbook',
    facts: ['lars', 'due yesterday 17:00', 'overdue 16h'],
    objectives: ['o1'],
  },
  {
    id: 'K1',
    kind: 'commitment',
    state: {
      kind: 'commitment',
      verification: 'self_reported',
      owedToViewer: false,
      irreversible: false,
    },
    text: 'Ship the token-refresh fix',
    facts: ['dana', 'due Thu 31 Jul'],
    objectives: ['o1', 'o2'],
  },
  {
    id: 'V1',
    kind: 'claim',
    state: { kind: 'claim', verification: 'verified', owedToViewer: false, irreversible: false },
    text: 'Backfill parity: 4,218,904 / 4,218,904 rows, 0 checksum diffs',
    facts: ['checked by the migration harness', '09:07'],
    objectives: ['o1'],
  },
  {
    id: 'C1',
    kind: 'claim',
    state: { kind: 'claim', verification: 'unverified', owedToViewer: false, irreversible: false },
    text: 'Dual-write costs about $900/mo in extra write throughput',
    facts: ['mateo', 'nothing has checked it'],
    objectives: ['o1'],
  },
  {
    id: 'C2',
    kind: 'claim',
    state: { kind: 'claim', verification: 'unverified', owedToViewer: false, irreversible: false },
    text: '4.7% of sessions still present legacy opaque tokens',
    facts: ['dana', 'nothing has checked it'],
    objectives: ['o2'],
  },
  {
    id: 'F1',
    kind: 'claim',
    state: { kind: 'claim', verification: 'failed', owedToViewer: false, irreversible: false },
    text: 'Parity check #418: 12 checksum diffs on users_legacy',
    facts: ['the migration harness', '12:29', 'failed'],
    objectives: ['o1'],
  },
];

/** The quiet room: everything settled, nothing owed. */
export const OBJECTS_QUIET: readonly StateObject[] = OBJECTS.filter((object) =>
  ['D1', 'V1', 'K1'].includes(object.id),
).map((object) => ({
  ...object,
  state: { ...object.state, verification: 'verified' as const, owedToViewer: false },
  facts: ['checked by the migration harness', 'today 09:07'],
}));

/* --- attention ----------------------------------------------------------- */

export const ATTENTION: readonly AttentionItem[] = [
  {
    id: 'X1',
    state: { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: true },
    title: 'Drop users_legacy at cutover rather than after the retention window',
    rationale: rationale(
      'no automated path may drop a table that still takes live reads, and legal has not answered on retention — only a maintainer can authorise it',
    ),
    facts: ['proposed by justin 12:44', 'destructive', 'blocks Q1'],
    /* m19, NOT m17. The card's own fact line says "proposed by justin 12:44",
       which is m19 — "Simplest is to drop users_legacy in the same window" —
       while the source link jumped to m17, justin's 12:31 parity-check report.
       Two facts about one source with nothing obliging them to agree, at the
       address round 6 deleted the carried room from. It matters structurally as
       well as factually now: the ■ row in the feed is built from this item, so
       the item has to cite the message that row is. */
    source: cite('m19'),
    actions: [
      { id: 'authorise', label: 'Authorise the drop', emphasis: 'primary', statement: null },
      {
        id: 'defer',
        label: 'Keep it behind our retention window',
        emphasis: 'secondary',
        /* Ordinary English with a pronoun in it, on the shipped card. Round 4's
           ban would have thrown the moment this answer was recorded. */
        statement: 'Keep it behind our retention window',
      },
      { id: 'bind', label: 'Answer in your own words →', emphasis: 'ghost', statement: null },
    ],
  },
  {
    id: 'K2',
    state: {
      kind: 'commitment',
      verification: 'self_reported',
      owedToViewer: true,
      irreversible: false,
    },
    title: 'Sign off the rollback runbook',
    rationale: rationale(
      'it is yours and it is 16h late — the runbook is what Friday’s cutover rolls back to, so nothing else can start until it is signed',
    ),
    facts: ['due yesterday 17:00', 'overdue 16h'],
    source: null,
    actions: [
      { id: 'signed', label: 'Mark signed off', emphasis: 'primary', statement: null },
      { id: 'resched', label: 'Reschedule', emphasis: 'ghost', statement: null },
    ],
  },
  {
    id: 'P1',
    state: { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: false },
    title: 'Cut over Friday 1 Aug and drop the legacy tokens with it',
    rationale: rationale(
      'it is a decision routed to you — decisions never auto-accept; the prior call was priya’s at 11:20 and it is still on the record below',
    ),
    facts: ['proposed by priya 11:02', 'confidence .71'],
    source: cite('m10'),
    actions: [
      {
        id: 'hold',
        label: 'Hold until 418 is explained',
        emphasis: 'primary',
        statement: 'Hold the cutover until parity check 418 is explained',
      },
      {
        id: 'day',
        label: 'Give us another day',
        emphasis: 'ghost',
        statement: 'Give us another day',
      },
      { id: 'bind', label: 'Answer in your own words →', emphasis: 'ghost', statement: null },
    ],
  },
  {
    id: 'Q1',
    state: { kind: 'question', verification: 'open', owedToViewer: true, irreversible: false },
    title: 'Does legal approve 90-day retention of users_legacy?',
    rationale: rationale(
      'you opened the question and legal answers to you — nobody else in this room can carry it, and it has been open 3h',
    ),
    facts: ['raised by priya 09:11', 'open 3h'],
    source: cite('m-legal'),
    actions: [
      { id: 'answer', label: 'Answer it', emphasis: 'primary', statement: null },
      { id: 'reassign', label: 'Ask priya instead', emphasis: 'ghost', statement: null },
    ],
  },
];

/** One owed item by id. Throws rather than returning the first one. */
export function item(itemId: string): AttentionItem {
  const found = ATTENTION.find((candidate) => candidate.id === itemId);
  if (found === undefined) throw new Error(`fixture: no attention item ${itemId}`);
  return found;
}

/**
 * WHICH OBJECTS ARE LATE, BY ID — not how many.
 *
 * `overdue: 1` was a hand-written number handed to `trailerFor` beside the
 * objects it is about, so signing off the one overdue commitment left the
 * trailer still saying one thing was late. A count that cannot be filtered is a
 * count that cannot follow an act.
 */
export const OVERDUE: readonly string[] = ['K2'];

export const TRAILER = trailerFor({ objects: OBJECTS, objectives: OBJECTIVES, overdue: 1 });

export const TRAILER_QUIET = trailerFor({
  objects: OBJECTS_QUIET,
  objectives: OBJECTIVES.map((objective) => ({ ...objective, status: 'active' as const })),
  overdue: 0,
});

/* --- timeline ------------------------------------------------------------ */

/**
 * Every feed row is built FROM the message register, never beside it: the time,
 * the actor and the words all come from the same record a quotation would have
 * to cite. A row whose text drifted from its message is the class of defect the
 * whole provenance apparatus exists to prevent, so the fixtures cannot express
 * one either.
 */
function message(
  id: string,
  input: {
    state: MessageEntry['state'];
    body?: readonly BodySegment[];
    note?: Maybe<SystemStatement>;
    tag?: MessageEntry['tag'];
    replyTo?: Maybe<Quotation>;
  },
): MessageEntry {
  const record = MESSAGES[id];
  if (record === undefined) throw new Error(`fixture: no message ${id}`);
  /* `messageEntry` is the only constructor, and it reads the record's ORIGIN.
     There is no way to spell a fixture that renders m-chosen under lars's name:
     the chosen arm of the union has no actor field and no body field. */
  return messageEntry(record, { ...input, viewer: VIEWER.name });
}

const CLAIM = {
  kind: 'claim',
  verification: 'unverified',
  owedToViewer: false,
  irreversible: false,
} as const;
const TALK = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
} as const;
const VERIFIED = {
  kind: 'claim',
  verification: 'verified',
  owedToViewer: false,
  irreversible: false,
} as const;
const GATE = {
  kind: 'decision',
  verification: 'proposed',
  owedToViewer: true,
  irreversible: false,
} as const;
const DESTRUCTIVE = {
  kind: 'decision',
  verification: 'proposed',
  owedToViewer: true,
  irreversible: true,
} as const;
const FAILED = {
  kind: 'event',
  verification: 'failed',
  owedToViewer: false,
  irreversible: false,
} as const;
const ACCEPTED = {
  kind: 'decision',
  verification: 'accepted',
  owedToViewer: false,
  irreversible: false,
} as const;

const ROUTINE_ROWS: readonly SystemEntry[] = [
  ['11:50', 'deploy 2f81c3 → staging · 41s'],
  ['11:51', 'staging health green · 12/12 pods ready'],
  ['11:52', 'shadow-write lag 41ms p50 · 118ms p99'],
  ['11:53', 'auth suite green · 1,204 tests · 2m11s'],
  ['11:54', 'parity #414 passed · 0 diffs'],
  ['11:55', 'coverage 87.4% · unchanged'],
  ['11:56', 'pool users-api scaled 4 → 6'],
  ['11:57', 'parity #415 passed · 0 diffs'],
].map(([at, body], index) => ({
  type: 'system',
  id: `routine-${index}`,
  at: at ?? '',
  statement: systemStatement(body ?? ''),
  state: TALK,
}));

const routine = (open: boolean): RoutineEntry => ({
  type: 'routine',
  id: 'routine-group',
  from: '11:50',
  to: '11:57',
  actors: ['backfill', 'tests', 'deploys'],
  open,
  rows: ROUTINE_ROWS,
});

const sinceYouLeft = (input: {
  seen: boolean;
  activeFilter: SinceYouLeftEntry['activeFilter'];
}): SinceYouLeftEntry => ({
  type: 'since-you-left',
  id: 'syl',
  label: 'SINCE YOU LEFT',
  window: '09:04 → 12:31 · 3h 27m away',
  counts: { need: 4, change: 3, discussion: 6, routine: 8 },
  total: 21,
  ownRows: 1,
  seen: input.seen,
  seenAt: input.seen ? '13:12' : null,
  activeFilter: input.activeFilter,
});

const BEFORE: readonly TimelineEntry[] = [
  message('m2', { state: CLAIM, tag: { label: 'claim · unverified', tone: 'neutral' } }),
  message('m5', { state: CLAIM, tag: { label: 'claim · unverified', tone: 'neutral' } }),
  {
    type: 'system',
    id: 's1',
    at: '09:07',
    statement: systemStatement(
      'parity harness reported 4,218,904 / 4,218,904 rows, 0 checksum diffs',
    ),
    state: VERIFIED,
  },
  message('m7', {
    state: CLAIM,
    /* The only two inline runs a message body has: code and a mention. Every
       character below comes from MESSAGES.m7.text — `messageEntry` throws if
       the concatenation drifts by so much as a space, so this fixture is
       checked on every render rather than trusted. */
    body: [
      { kind: 'mention', text: 'lars' },
      {
        kind: 'text',
        text: ' dual-write costs about $900/mo in extra write throughput — that is ',
      },
      { kind: 'code', text: 'users.dualwrite' },
      { kind: 'text', text: ' on both tables, not the backfill.' },
    ],
    tag: { label: 'claim · unverified', tone: 'neutral' },
  }),
];

/**
 * A ROW WHOSE "NEEDS YOU" IS THE PIN'S, NOT THE FIXTURE'S.
 *
 * ROUND 8, D1, FIFTH SURFACE. `message('m10', { state: GATE, tag: '◆ needs lars' })`
 * is a hand-written claim that this row is owed to lars, written beside — and
 * independent of — the attention item that is the reason it is. Acting on the
 * item removed it from one array; the row went on saying "◆ needs lars" under a
 * pin reading "nothing owed".
 *
 * The row is built FROM the item now: its state is the item's state, its tag is
 * derived from that state, and when the item is no longer owed the row is no
 * longer owed either, because there is nothing left to write it from.
 * `checkedFeed` refuses any row that claims otherwise.
 */
export function owedRow(item: AttentionItem, stillOwed: boolean): MessageEntry {
  const source = item.source;
  if (source === null) {
    throw new Error(`fixture: ${item.id} has no source message, so it has no feed row`);
  }
  const state = stillOwed ? item.state : settledForViewer(item.state);
  return message(source.messageId, {
    state,
    tag: stillOwed ? needsTag(state, VIEWER.name) : null,
  });
}

/** Which owed items are still owed — the whole set, by default. */
export type OwedSet = ReadonlySet<string>;

const allOwed: OwedSet = new Set(ATTENTION.map((item) => item.id));

const after = (owed: OwedSet): readonly TimelineEntry[] => [
  message('m17', {
    state: FAILED,
    /* Not a claim on the viewer: a failure needs AN explanation, from whoever
       can give one. `checkedFeed` only refuses rows whose STATE says they are
       owed to the person reading, which this one's does not. */
    tag: { label: '✗ failed · needs an explanation', tone: 'needs' },
  }),
  owedRow(item('P1'), owed.has('P1')),
  owedRow(item('X1'), owed.has('X1')),
  message('m21', {
    state: TALK,
    // the reply banner's actor and time come off the quotation, not beside it
    replyTo: quote('m17'),
  }),
  /* The one-click answer. `messageEntry` reads origin `chosen` and returns the
     arm of the union that has NO actor and NO body — the row renders as
     "lars chose: …" in system voice, mono and unquoted, with an empty actor
     column. Round 1 found this exact record rendering as lars's own sentence
     under his name; that shape no longer type-checks. */
  message('m-chosen', {
    state: ACCEPTED,
    tag: { label: 'resolves ◆ · answer-bound · nothing inferred', tone: 'verified' },
  }),
];

/** A feed row for a message in THIS register, for a room module to reuse. */
export function messageIn(id: string, input: Parameters<typeof message>[1]): MessageEntry {
  return message(id, input);
}

export function timeline(options: {
  readonly seen: boolean;
  readonly filter: SinceYouLeftEntry['activeFilter'];
  readonly routineOpen: boolean;
  readonly targetId?: string;
  /** which of this room's owed items are still owed; all of them by default */
  readonly owed?: OwedSet;
}): readonly TimelineEntry[] {
  const owed = options.owed ?? allOwed;
  const entries: TimelineEntry[] = checkedFeed(
    [
      ...BEFORE,
      routine(options.routineOpen),
      sinceYouLeft({ seen: options.seen, activeFilter: options.filter }),
      ...after(owed),
    ],
    ATTENTION,
    'fixtures.timeline',
  ) as TimelineEntry[];
  if (options.filter === null && options.targetId === undefined) return entries;
  return entries.map((entry) => {
    if (entry.type !== 'message') return entry;
    const matchesFilter =
      options.filter === null ? true : entry.tag !== null && entry.tag.tone === 'needs';
    return {
      ...entry,
      matchesFilter,
      targeted: options.targetId !== undefined && entry.id === options.targetId,
    };
  });
}

export const QUIET_TIMELINE: readonly TimelineEntry[] = [
  {
    type: 'system',
    id: 'q0',
    at: '13:38',
    statement: systemStatement('parity #421 passed · 0 diffs · 7 consecutive days'),
    state: VERIFIED,
  },
  message('q1', {
    state: VERIFIED,
    tag: { label: 'verified · the migration harness', tone: 'verified' },
  }),
  message('q2', { state: TALK }),
  /* THE FOUR ANSWERS ROUND 4 THREW ON, RENDERED. Each is a `chosen` record, so
     each becomes "<who> chose: <the option, verbatim>" in system voice with an
     empty actor column — the framing is the system's and is held to the whole
     rule; the option is a recorded payload and keeps its pronouns. A ban with no
     live subject is a ban nobody has run, which is exactly how the round-4
     version shipped believing its fixtures proved something. */
  message('m-retention', { state: ACCEPTED }),
  message('m-day', { state: ACCEPTED }),
  message('m-approve', { state: ACCEPTED }),
  message('m-agreed', { state: ACCEPTED }),
];

export const FRESH_TIMELINE: readonly TimelineEntry[] = [...BEFORE, ...after(allOwed).slice(0, 2)];

/* --- receipt ------------------------------------------------------------- */

/* No `who` and no `at`: both are read off the excerpt. A fixture cannot put
   priya's name over lars's sentence here, because there is no field for it. */
const PROVENANCE: readonly ProvenanceEntry[] = [
  {
    id: 'p1',
    excerpt: quote('m10'),
    /* The note no longer names a room. The room is a fact about the record and
       the row reads it from there — this note used to say #identity-service
       while `m10`'s record says it is in this room, which is what "three facts
       about one row from three sources" buys you. */
    /* THE NOTE IS A SYSTEM STATEMENT NOW, not a string. Round 7: this printed
       inside the same `<button>` as the quotation, one line under the quoted
       words. "as she wrote it" is also a speech report, which the system-voice
       bans refuse — the copy says what the row is FOR without reporting an
       utterance. */
    note: systemStatement('the proposal this decision answers'),
  },
  {
    id: 'p2',
    excerpt: quote('m21'),
    note: systemStatement(
      'typed into the bound composer — recorded as the answer, not interpreted from it',
    ),
  },
  {
    id: 'p3',
    excerpt: quote('m-legal'),
    note: systemStatement('the open question this decision waits on'),
  },
];

const CORRECTIONS: readonly CorrectionEntry[] = [
  {
    id: 'c1',
    heading: systemStatement('ANSWERED · PROPOSAL → DECISION'),
    at: '13:09',
    was: systemStatement('Proposal: cut over Friday 1 Aug and drop the legacy tokens with it'),
    now: systemStatement(
      'Keep dual-write on until parity holds for 7 consecutive days — not what was proposed; the answer is the decision',
    ),
    fact: systemStatement('answered by lars at 13:09 · chosen from the options on the card'),
    reason: null,
    link: {
      label: 'the proposal it replaced is still in the room →',
      ref: cite('m10'),
    },
  },
  {
    id: 'c2',
    heading: systemStatement('REOPENED · PRIOR ANSWER KEPT'),
    at: '13:14',
    was: systemStatement('Answer of 13:09'),
    now: systemStatement('pending again — the previous answer stays on the record'),
    fact: systemStatement('reopened by lars at 13:14 · parity #418 arrived after the answer'),
    // The human's reason is a real typed message, so it is quoted and it is
    // provable. A synthesized sentence could not get here: `reason` IS a
    // Quotation, Quotations only come from typed or seeded messages, and the
    // name rendered beside it is the quotation's own actor.
    reason: quote('m14'),
    link: {
      label: 'the superseded answer is still in the room →',
      ref: cite('m-chosen'),
    },
  },
];

export const RECEIPT: ReceiptRecord = {
  id: 'P1',
  state: { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: false },
  title: 'Cut over Friday 1 Aug and drop the legacy tokens with it',
  status: [
    'PROPOSED',
    'not accepted',
    'confidence .71',
    'renders as a claim until a human answers',
  ],
  /* Every line's words are a SystemStatement: third person, page-authored,
     visibly not speech. Nothing on a history line is quoted, so `who` names the
     actor of the event rather than attributing a sentence to anybody. */
  happened: [
    {
      id: 'h1',
      kind: 'claim',
      at: '11:02',
      /* The actor is INSIDE the sentence. There is no `who` field to render in an
         attribution column beside it — see `HappenedLine`. */
      statement: systemStatement('priya proposed the cutover date'),
    },
    {
      id: 'h2',
      kind: 'verified',
      at: '11:57',
      statement: systemStatement('the migration harness ran parity #415 — 0 diffs'),
    },
    {
      id: 'h3',
      kind: 'accepted',
      at: '13:09',
      statement: systemStatement(
        'lars answered it directly — the resolution was recorded from the answer, not interpreted from it',
      ),
    },
    {
      id: 'h4',
      kind: 'failed',
      at: '12:29',
      statement: systemStatement('the migration harness ran parity #418 — 12 checksum diffs'),
    },
    {
      id: 'h5',
      kind: 'gate',
      at: '13:14',
      statement: systemStatement('lars reopened it — pending again'),
    },
  ],
  provenance: PROVENANCE,
  corrections: CORRECTIONS,
  reopenable: false,
  reopenNote:
    'already reopened at 13:14 · the answer of 13:09 is still on the record and still linked below · corrections are events, not erasures',
};

/**
 * THE RECEIPT FOR ANY OBJECT ON THIS PAGE.
 *
 * BRIEF concept 5: every rendered derived object gets an inspect affordance from
 * day one. `ObjectRow` has had the affordance since round 1 and `/` had nothing
 * to open, so all ten rows were buttons that did nothing — which is round 2's
 * "a screen of controls that did nothing", surviving in the one place the fix
 * was not applied.
 *
 * P1 has the hand-written receipt with real provenance and a real correction
 * chain. Every other object gets one DERIVED FROM THE OBJECT: its own state, its
 * own facts, restated in system voice. A derived receipt says less than a
 * curated one and says nothing that is not on the object — which is the honest
 * version of "every object is inspectable", as against a button that opens
 * somebody else's record.
 */
export function receiptFor(objectId: string): ReceiptRecord {
  if (objectId === RECEIPT.id) return RECEIPT;
  return receiptFromObject(OBJECTS, objectId);
}

/** The same derivation, over any room's objects. */
export function receiptFromObject(
  objects: readonly StateObject[],
  objectId: string,
): ReceiptRecord {
  const object = objects.find((candidate) => candidate.id === objectId);
  if (object === undefined) throw new Error(`fixture: no state object ${objectId}`);
  /* ROUND 8, D4: this was a nested ternary here, and it collapsed every owed
     object to `gate` — so X1, whose `irreversible` is true, whose card is a
     press-and-hold and whose receipt title says "destructive, and not undoable",
     had all three history lines painted ◆ "a reversible gate waiting on a
     human", including the line whose entire text is the word `destructive`.
     The derivation lives beside `stateForHappened` now, and the two are checked
     as a round trip rather than read side by side. */
  const kind: HappenedKind = happenedKindFor(object.state);
  return {
    id: object.id,
    state: object.state,
    title: object.text,
    status: [object.kind.toUpperCase(), object.state.verification.replace('_', ' ')],
    /* One line per fact the row already shows, each tagged with the object's own
       epistemic kind. Nothing here is invented: the words are the words on the
       object, in system voice, and there is no actor field to fill.
       AND NO CLOCK, because there is no clock. This used to pass `at: '—'`, and
       since nine of the gallery's ten receipts are built here, every derived
       history line read "proposed by justin —" — an em dash standing in the
       column where a time goes. `HappenedLine.at` is optional now; a field with
       nothing to put in it is a field the row does not have. */
    happened: object.facts.map((fact, index) => ({
      id: `${object.id}-h${index}`,
      kind,
      statement: systemStatement(fact),
    })),
    provenance: [],
    corrections: [],
    reopenable: glyphFor(object.state) !== '✓',
    reopenNote:
      'this receipt is derived from the object itself — it carries no excerpts, because nothing on this object cites a message',
  };
}

/* --- cross-room jump ----------------------------------------------------- */

export const JUMP: CrossRoomJumpRecord = {
  fromRoom: 'users-migration',
  why: systemStatement(
    'you followed the source of ◆ P1 — #users-migration owes it to you, this room holds the message',
  ),
  targetMessage: cite('m10'),
};

/* --- composer ------------------------------------------------------------ */

export const BOUND: ComposerBinding = {
  mode: 'bound',
  itemId: 'X1',
  itemLabel: 'drop users_legacy at cutover',
  objective: 'dual-write parity before cutover',
};

export const FREE: ComposerBinding = { mode: 'free' };

export const REPLYING: ComposerBinding = { mode: 'replying', to: quote('m17') };

/* --- the pin under load -------------------------------------------------- */

/**
 * Owed items on demand, for the load the pin exists for. Round 1 measured the
 * unbounded pin pushing the composer out of a 900px viewport at 19 items with
 * no way to scroll it back; `/gallery/pin/[n]` renders these at 4, 13, 19 and
 * 34 so the bound is measured rather than asserted.
 */
export interface LoadRoom {
  readonly attention: readonly AttentionItem[];
  readonly objects: readonly StateObject[];
  readonly objectives: readonly ObjectiveRecord[];
  readonly trailer: TrailerSummary;
  readonly rooms: readonly RoomSummary[];
  readonly viewerNote: string;
}

/**
 * THE WHOLE FRAME AT A GIVEN LOAD, DERIVED FROM ONE NUMBER.
 *
 * ROUND 8, D2's zero-click repro. `/gallery/pin/60` handed `manyOwed(60)` to the
 * pin and left every other surface on the users-migration fixtures: the rail
 * said `# users-migration ◆ 4`, the lens said "4 items awaiting you", the
 * trailer counted two objectives, and the footer said "here · 60 owed to you" —
 * four answers to one question, on one screen, with nothing clicked.
 *
 * A route that exists to measure the pin under load is still a room. Every
 * surface on it now counts the same items.
 */
export function loadRoom(n: number): LoadRoom {
  const attention = manyOwed(n);
  const objects: readonly StateObject[] = attention.map((owedItem) => ({
    id: owedItem.id,
    kind: owedItem.state.kind === 'event' ? 'claim' : owedItem.state.kind,
    state: owedItem.state,
    text: owedItem.title,
    facts: owedItem.facts,
    objectives: ['load'],
  }));
  const objectives: readonly ObjectiveRecord[] = [
    {
      id: 'load',
      title: `Carry ${n} owed items without losing the composer`,
      status: 'active',
      open: true,
    },
  ];
  return {
    attention,
    objects,
    objectives,
    trailer: trailerFor({ objects, objectives, overdue: 0 }),
    rooms: railFor(ROOM.name, n),
    viewerNote: `here · ${n} owed to you`,
  };
}

export function manyOwed(n: number): readonly AttentionItem[] {
  const shapes = [
    { state: DESTRUCTIVE, kind: 'drop', why: 'destructive and nothing else can authorise it' },
    { state: GATE, kind: 'gate', why: 'a decision routed to you — decisions never auto-accept' },
    {
      state: {
        kind: 'event',
        verification: 'failed',
        owedToViewer: true,
        irreversible: false,
      } as const,
      kind: 'failure',
      why: 'it failed and the explanation is owed to you',
    },
    {
      state: {
        kind: 'question',
        verification: 'open',
        owedToViewer: true,
        irreversible: false,
      } as const,
      kind: 'question',
      why: 'you opened it and nobody else can carry it',
    },
  ] as const;
  return Array.from({ length: n }, (_, index) => {
    const shape = shapes[index % shapes.length];
    if (shape === undefined) throw new Error('fixture: no shape');
    return {
      id: `load-${index}`,
      state: shape.state,
      title: `${shape.kind} #${index + 1} — an owed item in a room carrying ${n} of them`,
      rationale: rationale(`${shape.why} · item ${index + 1} of ${n}`),
      facts: [`raised ${9 + (index % 5)}:0${index % 6}`, shape.kind],
      source: null,
      actions: [
        { id: 'act', label: 'Answer it', emphasis: 'primary' as const, statement: null },
        { id: 'defer', label: 'Defer', emphasis: 'ghost' as const, statement: null },
      ],
    };
  });
}
