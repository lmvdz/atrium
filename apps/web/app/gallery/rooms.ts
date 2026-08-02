/* ---------------------------------------------------------------------------
 * THE OTHER THREE ROOMS.
 *
 * ROUND 7, D6. Round 6 wired the rail's room chips — the handler fired, the
 * composer note changed, the head re-rendered — and wired them to A LABEL.
 * Clicking `#design` turned the head into `# design` and left the eight feed
 * rows, the four owed items, the ten lens objects and the composer binding
 * byte-identical to `#users-migration`'s, while the rail went on marking
 * `#users-migration` current. Two sources of truth about which room you are in,
 * disagreeing on screen, in the product whose entire doctrine is that they must
 * not be able to.
 *
 * A footer note disclosing "#25 owns the feed behind the switch" is not a state.
 * Wiring a control to a label-only change is worse than leaving it dead, because
 * a dead control is visibly dead and a lying one is not.
 *
 * So the rooms have content. It is deliberately SMALLER than users-migration's —
 * these are not three more curated stories, they are three rooms that are
 * genuinely different from each other and from the first, which is what the
 * control has to deliver to be honest:
 *
 *   #identity-service  the room `m-legal` actually lives in, so the cross-room
 *                      trace has a real destination. One owed question.
 *   #platform          unread and nothing owed — the "everything else is
 *                      verified" trailer, which `/` could not otherwise reach.
 *   #design            NOTHING NEEDS YOU IN THIS ROOM, the terminal state that
 *                      is a result rather than an absence. Until round 7 the
 *                      only way to see it was a gallery still.
 *
 * A ROOM IS ONE VALUE, not eight props. Round 6's defect was a consumer updating
 * one of them: the facts about a room move together, and handing them back
 * separately is exactly how the head ends up in one room and the feed in
 * another.
 * ------------------------------------------------------------------------- */

import type {
  AttentionItem,
  ComposerBinding,
  MessageEntry,
  MessageRecord,
  ObjectiveRecord,
  ReceiptRecord,
  RoomHeadRecord,
  RoomSummary,
  SinceYouLeftEntry,
  StateObject,
  TimelineEntry,
  TrailerSummary,
} from '../../src/components/model';
import {
  checkedFeed,
  citationFrom,
  messageEntry,
  rationale,
  settledForViewer,
  trailerFor,
} from '../../src/components/model';
import * as f from './fixtures';

const ACCEPTED = {
  kind: 'decision',
  verification: 'accepted',
  owedToViewer: false,
  irreversible: false,
} as const;
const CLAIM = {
  kind: 'claim',
  verification: 'unverified',
  owedToViewer: false,
  irreversible: false,
} as const;
const VERIFIED = {
  kind: 'claim',
  verification: 'verified',
  owedToViewer: false,
  irreversible: false,
} as const;
const TALK = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
} as const;
const OPEN_QUESTION = {
  kind: 'question',
  verification: 'open',
  owedToViewer: true,
  irreversible: false,
} as const;

const MESSAGES: Readonly<Record<string, MessageRecord>> = {
  i1: {
    id: 'i1',
    at: '08:50',
    actor: 'priya',
    text: 'Rotating the signing key on Thursday — every service reads it from the same secret.',
    origin: 'seeded',
    room: 'identity-service',
  },
  i2: {
    id: 'i2',
    at: '09:20',
    actor: 'dana',
    text: 'Two of the four consumers still cache the key for an hour.',
    origin: 'seeded',
    room: 'identity-service',
  },
  p1: {
    id: 'p1',
    at: '10:02',
    actor: 'mateo',
    text: 'Node pool upgrade finished — 6 nodes on 1.31, no drain errors.',
    origin: 'seeded',
    room: 'platform',
  },
  p2: {
    id: 'p2',
    at: '10:40',
    actor: 'justin',
    text: 'Build times down to 3m10s after the cache change.',
    origin: 'seeded',
    room: 'platform',
  },
  d1: {
    id: 'd1',
    at: '11:15',
    actor: 'lars',
    text: 'The glyph legend reads better under the divider than above it.',
    origin: 'typed',
    room: 'design',
  },
};

/**
 * EVERY RECORD ANY ROOM ON THIS PAGE CAN CITE, ON ONE REGISTER.
 *
 * Not one ledger per room: `<AttributionLedger>` refuses to nest, deliberately,
 * because two registers in one tree is the state in which a name over words is a
 * coin flip. Switching rooms changes which rows are RENDERED, never which
 * records exist — and `messageLedger` refuses two records under one id, which is
 * what makes merging four rooms' registers honest.
 */
export const RECORDS: readonly MessageRecord[] = [...f.RECORDS, ...Object.values(MESSAGES)];

function row(id: string, input: Parameters<typeof messageEntry>[1]): MessageEntry {
  const record = MESSAGES[id];
  if (record === undefined) throw new Error(`fixture: no message ${id}`);
  return messageEntry(record, { ...input, viewer: f.VIEWER.name });
}

export interface FeedOptions {
  readonly seen: boolean;
  readonly filter: SinceYouLeftEntry['activeFilter'];
  readonly routineOpen: boolean;
}

/**
 * A ROOM AS THE FIXTURES DECLARE IT — everything owed, nothing acted on yet.
 *
 * Deliberately NOT exported. See `sessionView` below: this is the array round 8
 * left reachable, and every consumer that reached it went on painting a number
 * an act had already changed.
 */
interface RoomView {
  readonly id: string;
  readonly room: RoomHeadRecord;
  readonly objectives: readonly ObjectiveRecord[];
  readonly objects: readonly StateObject[];
  readonly attention: readonly AttentionItem[];
  readonly binding: ComposerBinding;
  /** WHICH objects are late, by id — so settling one can stop counting it */
  readonly overdue: readonly string[];
  readonly timeline: (options: FeedOptions, owed: ReadonlySet<string>) => readonly TimelineEntry[];
}

const IDENTITY_OBJECTS: readonly StateObject[] = [
  {
    id: 'IQ1',
    kind: 'question',
    state: OPEN_QUESTION,
    text: 'Does legal approve 90-day retention of users_legacy?',
    /* NO "answers to you". Round 8, D1, sixth surface: that fact string is
       `state.owedToViewer` written a second time, in prose, on a register the
       act does not touch — so after answering the question the lens went on
       saying it answered to you, beside a glyph that had already stopped
       saying so. The glyph and the objective group's count carry that fact and
       both of them move. */
    facts: ['raised by priya 09:11', 'open 3h'],
    objectives: ['io1'],
  },
  {
    id: 'IC1',
    kind: 'claim',
    state: CLAIM,
    text: 'Two of four consumers cache the signing key for an hour',
    facts: ['dana', 'nothing has checked it'],
    objectives: ['io1'],
  },
  {
    id: 'ID1',
    kind: 'decision',
    state: ACCEPTED,
    text: 'Rotate the signing key on Thursday, with a 24h overlap window',
    facts: ['accepted by priya', '28 Jul 16:40'],
    objectives: ['io1'],
  },
];

const PLATFORM_OBJECTS: readonly StateObject[] = [
  {
    id: 'PV1',
    kind: 'claim',
    state: VERIFIED,
    text: 'Node pool on 1.31: 6 of 6 nodes, 0 drain errors',
    facts: ['checked by the upgrade harness', '10:02'],
    objectives: ['po1'],
  },
  {
    id: 'PK1',
    kind: 'claim',
    state: VERIFIED,
    text: 'Build times: 3m10s, down from 7m40s',
    facts: ['checked by the build harness', '10:40'],
    objectives: ['po1'],
  },
];

const DESIGN_OBJECTS: readonly StateObject[] = [
  {
    id: 'DD1',
    kind: 'decision',
    state: ACCEPTED,
    text: 'The glyph legend sits under the divider, not above it',
    facts: ['accepted by lars', 'today 11:15'],
    objectives: ['do1'],
  },
];

const IDENTITY_ATTENTION: readonly AttentionItem[] = [
  {
    id: 'IQ1',
    state: OPEN_QUESTION,
    title: 'Does legal approve 90-day retention of users_legacy?',
    rationale: rationale(
      'you opened the question and legal answers to you — nobody else in this room can carry it, and it has been open 3h',
    ),
    facts: ['raised by priya 09:11', 'open 3h'],
    source: citationFrom(f.MESSAGES['m-legal'] as MessageRecord),
    actions: [
      { id: 'answer', label: 'Answer it', emphasis: 'primary', statement: null },
      { id: 'reassign', label: 'Ask priya instead', emphasis: 'ghost', statement: null },
    ],
  },
];

/** One of this room's owed items by id. */
function identityItem(itemId: string): AttentionItem {
  const found = IDENTITY_ATTENTION.find((candidate) => candidate.id === itemId);
  if (found === undefined) throw new Error(`fixture: no attention item ${itemId}`);
  return found;
}

const VIEWS: Readonly<Record<string, RoomView>> = {
  r1: {
    id: 'r1',
    room: f.ROOM,
    objectives: f.OBJECTIVES,
    objects: f.OBJECTS,
    attention: f.ATTENTION,
    binding: f.BOUND,
    overdue: f.OVERDUE,
    timeline: (options, owed) => f.timeline({ ...options, owed }),
  },
  r2: {
    id: 'r2',
    room: {
      name: 'identity-service',
      topic: 'own the signing key and the session lifecycle for every service',
      members: ['priya', 'dana', 'lars'],
    },
    objectives: [
      { id: 'io1', title: 'Rotate the signing key safely', status: 'active', open: true },
    ],
    objects: IDENTITY_OBJECTS,
    attention: IDENTITY_ATTENTION,
    binding: { mode: 'free' },
    overdue: [],
    /* The 09:11 row is BUILT FROM IQ1. It carried `state: GATE` and a
       hand-written `'◆ needs lars'` beside the item that is the reason it needs
       lars — round 8's fifth surface, and the one that says its number in prose
       so no count check could see it. */
    timeline: (_options, owed) => [
      row('i1', { state: ACCEPTED }),
      row('i2', { state: CLAIM, tag: { label: 'claim · unverified', tone: 'neutral' } }),
      f.owedRow(identityItem('IQ1'), owed.has('IQ1')),
    ],
  },
  r3: {
    id: 'r3',
    room: {
      name: 'platform',
      topic: 'the substrate everything else runs on — clusters, images, build times',
      members: ['mateo', 'justin', 'lars'],
    },
    objectives: [
      { id: 'po1', title: 'Keep the fleet on a supported version', status: 'active', open: true },
    ],
    objects: PLATFORM_OBJECTS,
    attention: [],
    binding: { mode: 'free' },
    overdue: [],
    timeline: () => [
      row('p1', {
        state: VERIFIED,
        tag: { label: 'verified · the upgrade harness', tone: 'verified' },
      }),
      row('p2', { state: TALK }),
    ],
  },
  r4: {
    id: 'r4',
    room: {
      name: 'design',
      topic: 'the shared grammar — glyphs, density, and what a claim may look like',
      members: ['lars', 'mateo'],
    },
    objectives: [
      { id: 'do1', title: 'Settle the epistemic glyph legend', status: 'active', open: true },
    ],
    objects: DESIGN_OBJECTS,
    attention: [],
    binding: { mode: 'free' },
    overdue: [],
    timeline: () => [row('d1', { state: ACCEPTED })],
  },
};

/** The room a rail chip switches to. Throws rather than falling back to room one. */
function roomView(roomId: string): RoomView {
  const view = VIEWS[roomId];
  if (view === undefined) throw new Error(`no room ${roomId}`);
  return view;
}

export const ROOM_IDS: readonly string[] = Object.keys(VIEWS);

/* ---------------------------------------------------------------------------
 * ONE VIEW, DERIVED ONCE, CONSUMED BY EVERYTHING ON THE PAGE.
 *
 * ROUND 8, D1 AND D2 — one defect with two repros. `RoomSession` filtered the
 * acted-on items out of the array it handed to `Pin`, `SurfaceIndicators` and
 * the rail's footer note, and out of nothing else. Answering `IQ1` in
 * #identity-service left one screen saying, simultaneously:
 *
 *   NOTHING NEEDS YOU IN THIS ROOM · nothing owed · NEEDS YOU 0 (disabled) ·
 *   here · 0 owed to you
 *   ◆ 1 · "#identity-service — 1 owed to you" · 1 item awaiting you ·
 *   1 need you · ◆ needs lars · 0/1 objectives clear of you
 *
 * And `railRooms` computed `owed` from `roomView(id).attention.length` — the
 * unfiltered array — ON THE LINE IMMEDIATELY BELOW a docblock about round 6
 * leaving the rail and the head disagreeing. The comment was a monument to the
 * class and the line under it was a fresh instance.
 *
 * SO THE FIX IS NOT FIVE MORE FILTERS. That shape is what produced round 7's
 * half-fix under round 6's comment, and it leaves the sixth call site for round
 * 10. `RoomView` is private to this module; the only thing a consumer can get is
 * a `SessionView`, which is the room WITH THE ACTS APPLIED — attention, objects,
 * feed rows, trailer, rail and receipt all derived from the same two values.
 * There is no expression outside this file whose type is the unsettled room.
 *
 * And an act is not a filter. `settledForViewer` says what actually happened:
 * the object is still on the record, still proposed, still in the lens — it no
 * longer needs THIS PERSON. Modelling it as removal from one array is why four
 * other surfaces went on saying it did not happen.
 * ------------------------------------------------------------------------- */

export interface SessionView {
  readonly id: string;
  readonly room: RoomHeadRecord;
  readonly objectives: readonly ObjectiveRecord[];
  /** the lens's objects, with anything acted on no longer owed */
  readonly objects: readonly StateObject[];
  /** the pin's items: what still needs this person */
  readonly attention: readonly AttentionItem[];
  readonly binding: ComposerBinding;
  readonly trailer: TrailerSummary;
  /** the rail, every chip counting the same register this page counts */
  readonly rooms: readonly RoomSummary[];
  readonly timeline: (options: FeedOptions) => readonly TimelineEntry[];
  readonly receiptFor: (objectId: string) => ReceiptRecord;
}

/** How many items still need the viewer in a room, given what has been acted on. */
function owedIn(roomId: string, actedOn: readonly string[]): number {
  return roomView(roomId).attention.filter((item) => !actedOn.includes(item.id)).length;
}

/**
 * THE ROOM AS IT IS AFTER THE ACTS — the only room shape render can reach.
 *
 * `actedOn` is the session's whole register of "you have dealt with this",
 * across every room: an act in #users-migration has to move #users-migration's
 * rail chip while you are standing in #identity-service, which is D2's first
 * repro.
 */
export function sessionView(roomId: string, actedOn: readonly string[]): SessionView {
  const view = roomView(roomId);
  const settled = new Set(actedOn);
  const attention = view.attention.filter((item) => !settled.has(item.id));
  const owed = new Set(attention.map((item) => item.id));
  const objects = view.objects.map((object) =>
    settled.has(object.id) ? { ...object, state: settledForViewer(object.state) } : object,
  );
  return {
    id: view.id,
    room: view.room,
    objectives: view.objectives,
    objects,
    attention,
    binding: view.binding,
    trailer: trailerFor({
      objects,
      objectives: view.objectives,
      /* The late things that are STILL late. A hand-written `overdue: 1` beside
         the objects it describes is the same second register as a hand-written
         owed count beside the pin. */
      overdue: view.overdue.filter((id) => !settled.has(id)).length,
    }),
    rooms: f.ROOMS.map((room) => ({
      ...room,
      current: room.id === roomId,
      unseen: room.id === roomId ? 0 : room.unseen,
      owed: owedIn(room.id, actedOn),
    })),
    /* `checkedFeed` a second time, over the room's WHOLE item list: the feed
       this room built may not claim a row needs you unless an item cites it. */
    timeline: (options) =>
      checkedFeed(view.timeline(options, owed), view.attention, `room ${view.id}`),
    /* The receipt's title glyph is the OBJECT's state, so a receipt opened after
       an act cannot still wear ◆ over a lens that has stopped saying so. P1 is
       the one curated record on this page; everything else is derived from the
       settled objects, and P1's own state is taken from the same place. */
    receiptFor: (objectId) => {
      const base =
        view.id === 'r1' && objectId === 'P1'
          ? f.receiptFor(objectId)
          : f.receiptFromObject(objects, objectId);
      const object = objects.find((candidate) => candidate.id === objectId);
      return object === undefined ? base : { ...base, state: object.state };
    },
  };
}
