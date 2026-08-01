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
  HumanSummary,
  MessageEntry,
  MessageRecord,
  ObjectiveRecord,
  ProvenanceEntry,
  ReceiptRecord,
  RoomHeadRecord,
  RoomSummary,
  RoutineEntry,
  SinceYouLeftEntry,
  StateObject,
  SurfaceIndicator,
  SystemEntry,
  TimelineEntry,
} from '../../src/components/model';
import {
  chosenAnswer,
  quotationFrom,
  rationale,
  systemStatement,
  trailerFor,
} from '../../src/components/model';

/* --- the register of real messages --------------------------------------- */
/* A quotation can only be minted from one of these, and only when its origin is
   `typed` or `seeded`. m-chosen is here on purpose: it is the one-click answer,
   and it is what the round-4 gauntlet caught being quoted as somebody's words. */

export const MESSAGES: Readonly<Record<string, MessageRecord>> = {
  m2: {
    id: 'm2',
    at: '09:04',
    actor: 'priya',
    text: 'Staging backfill ran clean — 4.2M rows in 38 minutes.',
    origin: 'seeded',
  },
  m5: {
    id: 'm5',
    at: '09:41',
    actor: 'dana',
    text: '4.7% of sessions still present legacy opaque tokens.',
    origin: 'seeded',
  },
  m7: {
    id: 'm7',
    at: '10:12',
    actor: 'mateo',
    text: 'Dual-write costs about $900/mo in extra write throughput.',
    origin: 'seeded',
  },
  m10: {
    id: 'm10',
    at: '11:02',
    actor: 'priya',
    text: 'Cut over Friday 1 Aug and drop the legacy tokens with it.',
    origin: 'seeded',
  },
  m14: {
    id: 'm14',
    at: '11:48',
    actor: 'lars',
    text: 'This was an actual call, not priya thinking out loud.',
    origin: 'typed',
  },
  m17: {
    id: 'm17',
    at: '12:31',
    actor: 'justin',
    text: 'Parity check 418 came back with 12 checksum diffs on users_legacy.',
    origin: 'seeded',
  },
  m19: {
    id: 'm19',
    at: '12:44',
    actor: 'justin',
    text: 'Simplest is to drop users_legacy in the same window. Nothing reads it after cutover.',
    origin: 'seeded',
  },
  m21: {
    id: 'm21',
    at: '13:07',
    actor: 'lars',
    text: 'Hold the cutover until 418 is explained. I would rather be a week late than lose a session.',
    origin: 'typed',
  },
  q1: {
    id: 'q1',
    at: '13:40',
    actor: 'priya',
    text: 'Seven clean days. The dual-write condition is met.',
    origin: 'seeded',
  },
  q2: {
    id: 'q2',
    at: '13:41',
    actor: 'lars',
    text: 'Good. Nothing else from me today.',
    origin: 'typed',
  },
  'm-chosen': {
    id: 'm-chosen',
    at: '13:09',
    actor: 'lars',
    text: 'Keep dual-write on until parity holds for 7 consecutive days',
    // PAGE-AUTHORED. `quotationFrom` returns null for this; the only way it can
    // be rendered is in system voice, as "chose: …".
    origin: 'chosen',
  },
};

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
    facts: ['asked by priya 09:11', 'open 3h', 'nobody assigned'],
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
    source: { messageId: 'm17', room: null },
    actions: [
      { id: 'authorise', label: 'Authorise the drop', emphasis: 'primary', statement: null },
      {
        id: 'defer',
        label: 'Keep it behind the retention window',
        emphasis: 'secondary',
        statement: 'Keep users_legacy until the retention window closes',
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
    source: { messageId: 'm10', room: 'identity-service' },
    actions: [
      {
        id: 'hold',
        label: 'Hold until 418 is explained',
        emphasis: 'primary',
        statement: 'Hold the cutover until parity check 418 is explained',
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
    facts: ['asked by priya 09:11', 'open 3h'],
    source: { messageId: 'm2', room: null },
    actions: [
      { id: 'answer', label: 'Answer it', emphasis: 'primary', statement: null },
      { id: 'reassign', label: 'Ask priya instead', emphasis: 'ghost', statement: null },
    ],
  },
];

export const TRAILER = trailerFor({
  objects: OBJECTS,
  objectives: OBJECTIVES,
  overdue: 1,
  lastCheck: '12:29',
});

export const TRAILER_QUIET = trailerFor({
  objects: OBJECTS_QUIET,
  objectives: OBJECTIVES.map((objective) => ({ ...objective, status: 'active' as const })),
  overdue: 0,
  lastCheck: '13:41',
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
    note?: MessageEntry['note'];
    tag?: MessageEntry['tag'];
    replyTo?: MessageEntry['replyTo'];
  },
): MessageEntry {
  const record = MESSAGES[id];
  if (record === undefined) throw new Error(`fixture: no message ${id}`);
  return {
    type: 'message',
    id: record.id,
    at: record.at,
    actor: record.actor,
    body: input.body ?? [{ kind: 'text', text: record.text }],
    state: input.state,
    fromViewer: record.actor === VIEWER.name,
    replyTo: input.replyTo ?? null,
    note: input.note ?? null,
    tag: input.tag ?? null,
    targeted: false,
    matchesFilter: true,
  };
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
    // the only two inline runs a message body has: code and a mention
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

const AFTER: readonly TimelineEntry[] = [
  message('m17', {
    state: FAILED,
    tag: { label: '✗ failed · needs an explanation', tone: 'needs' },
  }),
  message('m10', { state: GATE, tag: { label: '◆ needs lars', tone: 'needs' } }),
  message('m19', {
    state: DESTRUCTIVE,
    tag: { label: '■ destructive · needs lars', tone: 'needs' },
  }),
  message('m21', {
    state: TALK,
    replyTo: { actor: 'justin', at: '12:31', excerpt: quote('m17') },
  }),
  message('m-chosen', {
    state: ACCEPTED,
    // The row's own note is SYSTEM VOICE and says the answer was chosen, not
    // typed. `chosenAnswer` is the only constructor that produces it, and it
    // renders "chose: …" with no quotation marks anywhere near it.
    note: chosenAnswer(MESSAGES['m-chosen']?.text ?? '', 'm-chosen'),
    tag: { label: 'resolves ◆ · answer-bound · nothing inferred', tone: 'verified' },
  }),
];

export function timeline(options: {
  readonly seen: boolean;
  readonly filter: SinceYouLeftEntry['activeFilter'];
  readonly routineOpen: boolean;
  readonly targetId?: string;
}): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...BEFORE,
    routine(options.routineOpen),
    sinceYouLeft({ seen: options.seen, activeFilter: options.filter }),
    ...AFTER,
  ];
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
];

export const FRESH_TIMELINE: readonly TimelineEntry[] = [...BEFORE, ...AFTER.slice(0, 2)];

/* --- receipt ------------------------------------------------------------- */

const PROVENANCE: readonly ProvenanceEntry[] = [
  {
    id: 'p1',
    who: 'priya',
    at: '11:02',
    excerpt: quote('m10'),
    note: 'the proposal, as she wrote it in #identity-service',
    jump: { messageId: 'm10', room: 'identity-service' },
  },
  {
    id: 'p2',
    who: 'lars',
    at: '13:07',
    excerpt: quote('m21'),
    note: 'typed into the bound composer — recorded as the answer, not interpreted from it',
    jump: { messageId: 'm21', room: null },
  },
];

const CORRECTIONS: readonly CorrectionEntry[] = [
  {
    id: 'c1',
    heading: 'ANSWERED · PROPOSAL → DECISION',
    who: 'lars',
    at: '13:09',
    was: systemStatement('Proposal: cut over Friday 1 Aug and drop the legacy tokens with it'),
    now: systemStatement(
      'Keep dual-write on until parity holds for 7 consecutive days — not what was proposed; the answer is the decision',
    ),
    fact: systemStatement('answered by lars at 13:09 · chosen from the options on the card'),
    reason: null,
    link: {
      label: 'the proposal it replaced is still in the room →',
      ref: { messageId: 'm10', room: 'identity-service' },
    },
  },
  {
    id: 'c2',
    heading: 'REOPENED · PRIOR ANSWER KEPT',
    who: 'lars',
    at: '13:14',
    was: systemStatement('Answer of 13:09'),
    now: systemStatement('pending again — the previous answer stays on the record'),
    fact: systemStatement('reopened by lars at 13:14 · parity #418 arrived after the answer'),
    // The human's reason is a real typed message, so it is quoted and it is
    // provable. A synthesized sentence could not get here: `reason` takes a
    // Quotation, and Quotations only come from typed or seeded messages.
    reason: { quotation: quote('m14'), by: 'lars' },
    link: {
      label: 'the superseded answer is still in the room →',
      ref: { messageId: 'm-chosen', room: null },
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
  happened: [
    { id: 'h1', kind: 'claim', who: 'priya', at: '11:02', text: 'proposed the cutover date' },
    {
      id: 'h2',
      kind: 'verified',
      who: 'the migration harness',
      at: '11:57',
      text: 'parity #415 passed with 0 diffs',
    },
    {
      id: 'h3',
      kind: 'accepted',
      who: 'lars',
      at: '13:09',
      text: 'answered it directly — the resolution was recorded from the answer, not interpreted from it',
    },
    {
      id: 'h4',
      kind: 'failed',
      who: 'the migration harness',
      at: '12:29',
      text: 'parity #418 returned 12 checksum diffs',
    },
    { id: 'h5', kind: 'gate', who: 'lars', at: '13:14', text: 'reopened it — pending again' },
  ],
  provenance: PROVENANCE,
  corrections: CORRECTIONS,
  reopenable: false,
  reopenNote:
    'already reopened at 13:14 · the answer of 13:09 is still on the record and still linked below · corrections are events, not erasures',
};

/* --- cross-room jump ----------------------------------------------------- */

export const JUMP: CrossRoomJumpRecord = {
  fromRoom: 'users-migration',
  why: systemStatement(
    'you followed the source of ◆ P1 — #users-migration owes it to you, this room holds the message',
  ),
  targetMessage: 'm10',
};

/* --- composer ------------------------------------------------------------ */

export const BOUND: ComposerBinding = {
  mode: 'bound',
  itemId: 'X1',
  itemLabel: 'drop users_legacy at cutover',
  objective: 'dual-write parity before cutover',
};

export const FREE: ComposerBinding = { mode: 'free' };

export const REPLYING: ComposerBinding = {
  mode: 'replying',
  to: { actor: 'justin', at: '12:31', excerpt: quote('m17') },
};
