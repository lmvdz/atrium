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
import { citationFrom, messageEntry, rationale, trailerFor } from '../../src/components/model';
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
const GATE = {
  kind: 'decision',
  verification: 'proposed',
  owedToViewer: true,
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

export interface RoomView {
  readonly id: string;
  readonly room: RoomHeadRecord;
  readonly objectives: readonly ObjectiveRecord[];
  readonly objects: readonly StateObject[];
  readonly attention: readonly AttentionItem[];
  readonly binding: ComposerBinding;
  readonly overdue: number;
  readonly timeline: (options: {
    readonly seen: boolean;
    readonly filter: SinceYouLeftEntry['activeFilter'];
    readonly routineOpen: boolean;
  }) => readonly TimelineEntry[];
}

const IDENTITY_OBJECTS: readonly StateObject[] = [
  {
    id: 'IQ1',
    kind: 'question',
    state: OPEN_QUESTION,
    text: 'Does legal approve 90-day retention of users_legacy?',
    facts: ['raised by priya 09:11', 'open 3h', 'answers to you'],
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

const VIEWS: Readonly<Record<string, RoomView>> = {
  r1: {
    id: 'r1',
    room: f.ROOM,
    objectives: f.OBJECTIVES,
    objects: f.OBJECTS,
    attention: f.ATTENTION,
    binding: f.BOUND,
    overdue: 1,
    timeline: (options) => f.timeline(options),
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
    attention: [
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
    ],
    binding: { mode: 'free' },
    overdue: 0,
    timeline: () => [
      row('i1', { state: ACCEPTED }),
      row('i2', { state: CLAIM, tag: { label: 'claim · unverified', tone: 'neutral' } }),
      f.messageIn('m-legal', { state: GATE, tag: { label: '◆ needs lars', tone: 'needs' } }),
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
    overdue: 0,
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
    overdue: 0,
    timeline: () => [row('d1', { state: ACCEPTED })],
  },
};

/** The room a rail chip switches to. Throws rather than falling back to room one. */
export function roomView(roomId: string): RoomView {
  const view = VIEWS[roomId];
  if (view === undefined) throw new Error(`no room ${roomId}`);
  return view;
}

export const ROOM_IDS: readonly string[] = Object.keys(VIEWS);

/**
 * The rail, with the current room derived from the one being shown.
 *
 * Round 6 left `current: true` hard-coded on `r1` in the fixture while the head
 * changed, so the rail marked one room and the head named another — the two
 * sources of truth the whole product is about, disagreeing on screen. The unseen
 * count drops to zero for the room you are standing in, because you are reading
 * it.
 */
export function railRooms(roomId: string): readonly RoomSummary[] {
  return f.ROOMS.map((room) => ({
    ...room,
    current: room.id === roomId,
    unseen: room.id === roomId ? 0 : room.unseen,
    owed: roomView(room.id).attention.length,
  }));
}

export function trailerForRoom(view: RoomView): TrailerSummary {
  return trailerFor({ objects: view.objects, objectives: view.objectives, overdue: view.overdue });
}

/** The receipt for an object in a given room. */
export function receiptForIn(view: RoomView, objectId: string): ReceiptRecord {
  if (view.id === 'r1') return f.receiptFor(objectId);
  return f.receiptFromObject(view.objects, objectId);
}
