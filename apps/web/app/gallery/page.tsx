import type { Metadata } from 'next';
import * as f from './fixtures';
import styles from './gallery.module.css';
import type { RoomFrameProps } from './RoomFrame';
import { RoomFrame } from './RoomFrame';
import { RECORDS, railFor, roomsQuiet, sessionView } from './rooms';
import { ThemeSwitch } from './theme-switch';

export const metadata: Metadata = {
  title: 'Atrium · component gallery',
  description: 'Every state of the app frame, one full frame each, in both themes.',
};

interface GalleryFrame {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly props: RoomFrameProps;
}

/* EVERY FRAME'S REGISTER IS THE WHOLE PAGE'S. Round 10, D2: frame 05 cites a
   record that lives in another room, and a ledger holding only users-migration's
   records could not resolve it — the four rooms share one register precisely so
   "is this message's source somewhere else" has an answer. */
const base = {
  messages: RECORDS,
  room: f.ROOM,
  /* THE RAIL STATES WHAT THE FRAME IS SHOWING. Round 8, D2: a still whose rail
     chip and whose footer answer "how many things here need you" differently is
     not a state of this product. `railFor` derives the current chip from the
     frame's own pin — the ITEMS, since round 10, because the chip's glyph is
     derived from the hardest of them. */
  rooms: railFor(f.ROOM.name, f.ATTENTION),
  humans: f.HUMANS,
  viewer: f.VIEWER,
  focused: 'conversation' as const,
  attention: f.ATTENTION,
  trailer: f.TRAILER,
  lastCheck: '12:29',
  filter: null,
  objectives: f.OBJECTIVES,
  objects: f.OBJECTS,
  updatedAt: '13:41',
  binding: f.FREE,
  composerNote: 'nothing is inferred from a message unless you bind it',
};

/* ---------------------------------------------------------------------------
 * FRAME 05'S ROOM, WHOLE — ROUND 10, D2.
 *
 * The frame used to be `{...base, room: {…name: 'identity-service'}, rooms:
 * railFor('identity-service', 4), entries: f.timeline(…)}`: the head, the lens,
 * the composer and the rail chip were overridden to #identity-service and the
 * FEED was left as #users-migration's. Eight `room: 'users-migration'` records
 * rendered as this room's conversation, so a reader came away believing priya
 * said "Staging backfill ran clean — 4.2M rows in 38 minutes" in
 * #identity-service. The rail also showed `#users-migration ◆4` and
 * `#identity-service ◆4` for the same four items, reading as eight.
 *
 * A frame is a room. `sessionView` is the one shape a room comes in — head,
 * lens, pin, rail, trailer and feed derived together from one id — so there is no
 * longer a prop table where the head and the feed can be set independently. Every
 * frame below spreads one of these, and `TimelineRow` refuses any row whose
 * record is not from the room the ledger says is on screen, so the class is
 * unreachable rather than merely absent from this file.
 * ------------------------------------------------------------------------- */
const IDENTITY = sessionView('r2', []);

const FRAMES: readonly GalleryFrame[] = [
  {
    id: 'fresh-room',
    title: 'Fresh room',
    note: 'You have not been away. No divider, no fold — the pin still carries what is owed, because owed attention never hides just because the feed is short.',
    props: {
      ...base,
      entries: f.FRESH_TIMELINE,
      label: 'fresh-room',
    },
  },
  {
    id: 'since-you-left',
    title: 'Since you left, with owed items',
    note: 'Three hours away. The divider counts the rows below it by attention class — counted, not asserted — the routine group collapses legibly, and the pin sorts hardest first, so the destructive decision opens and the rest compress but stay actionable.',
    props: {
      ...base,
      entries: f.timeline({ seen: false, filter: null, routineOpen: false }),
      openAttentionId: 'X1',
      binding: f.BOUND,
      label: 'since-you-left',
    },
  },
  {
    id: 'filtered',
    title: 'Filtered to what needs you',
    note: 'Clicking a count chip filters the feed. Matching rows are LIFTED; nothing is hidden and nothing is faded — a row you cannot read is a row you cannot check, and measured against these tokens the weakest thing a row can carry (an amber needs-you tag) is already at the shell’s 4.53:1 floor, so any fade at all would put it under AA. The group is marked seen, so the divider is muted but still present — no fake mark-all-read.',
    props: {
      ...base,
      entries: f.timeline({ seen: true, filter: 'need', routineOpen: true }),
      /* ONE REGISTER FOR WHICH CLASS IS LIFTED. Round 10, D3: this frame passed
         `filter: 'need'` to the entry builder and `filtered: true` to the frame,
         and nothing obliged the two to name the same class. */
      filter: 'need' as const,
      openAttentionId: 'K2',
      label: 'filtered',
    },
  },
  {
    id: 'receipt-open',
    title: 'Receipt open',
    note: 'The lens becomes the record. Every what-happened line carries its own glyph, every excerpt is a quotation with a message behind it, and the correction chain keeps the system’s voice and the human’s visibly apart — the system half is mono and unquoted, the human half is a real typed sentence in quotation marks.',
    props: {
      ...base,
      entries: f.timeline({ seen: true, filter: null, routineOpen: false }),
      openAttentionId: 'P1',
      receipt: f.RECEIPT,
      label: 'receipt-open',
    },
  },
  {
    id: 'cross-room-jump',
    title: 'Cross-room jump',
    note: 'You followed Q1’s source out of #users-migration; its message lives here, so here is where you are standing. The whole frame is #identity-service — head, feed, pin, lens and rail — because a room is one value and this frame is a room. The trace bar persists rather than fading, and the row it landed on is marked in the feed.',
    props: {
      ...base,
      room: IDENTITY.room,
      rooms: IDENTITY.rooms,
      attention: IDENTITY.attention,
      objectives: IDENTITY.objectives,
      objects: IDENTITY.objects,
      trailer: IDENTITY.trailer,
      entries: IDENTITY.timeline({
        seen: true,
        filter: null,
        routineOpen: false,
        targetId: 'm-legal',
      }),
      jump: f.JUMP,
      openAttentionId: 'IQ1',
      binding: IDENTITY.binding,
      label: 'cross-room-jump',
    },
  },
  {
    id: 'zero-owed',
    title: 'Zero owed — silence as a result',
    note: 'Nothing needs this person. The pin says so as an answer rather than showing an empty box, and the trailer is only allowed to say everything is verified because it derived that from the objects, not from an author’s optimism.',
    props: {
      ...base,
      rooms: roomsQuiet(f.ROOM.name),
      attention: [],
      trailer: f.TRAILER_QUIET,
      lastCheck: '13:41',
      entries: f.QUIET_TIMELINE,
      objects: f.OBJECTS_QUIET,
      objectives: f.OBJECTIVES.map((objective) => ({ ...objective, status: 'active' as const })),
      label: 'zero-owed',
    },
  },
  {
    id: 'rail-open',
    title: 'Rooms and people, unfolded',
    note: 'v8 folds the room rail, so every other still on this page shows the canvas without it. This is the same frame one click later. It is here because a state a person can reach and no still ever shows is a state nobody reviews — and because three of the six registered non-text graphics live in this column: the here presence fill, the idle/away presence ring, and the disabled count chip’s dashed border. With the rail folded they render nowhere, and a sweep that measured none of them still reported a pass.',
    props: {
      ...base,
      entries: f.FRESH_TIMELINE,
      railOpen: true,
      label: 'rail-open',
    },
  },
];

export default function GalleryPage() {
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1>Atrium · component gallery</h1>
          <p className={styles.headNote}>
            Seven states of the app frame, one <strong>full frame</strong> each — never a component
            on its own, because density and hairlines only mean anything against a whole screen.
            Both themes are the same markup under one class on <code>&lt;html&gt;</code>; use the
            switch to see the other one.
          </p>
        </div>
        <span className={styles.headSpacer} />
        <ThemeSwitch />
      </header>

      {FRAMES.map((frame, index) => (
        <section aria-labelledby={`frame-${frame.id}`} key={frame.id}>
          <div className={styles.caption}>
            <span className={`${styles.captionIndex} atr-lbl`}>
              {String(index + 1).padStart(2, '0')}
            </span>
            <h2 className={styles.captionTitle} id={`frame-${frame.id}`}>
              {frame.title}
            </h2>
            <p className={styles.captionNote}>{frame.note}</p>
          </div>
          <div className={styles.frame} data-gallery-frame={frame.id}>
            <RoomFrame {...frame.props} />
          </div>
        </section>
      ))}
    </div>
  );
}
