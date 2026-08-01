import type { Metadata } from 'next';
import * as f from './fixtures';
import styles from './gallery.module.css';
import type { RoomFrameProps } from './RoomFrame';
import { RoomFrame } from './RoomFrame';
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

const base = {
  messages: f.RECORDS,
  room: f.ROOM,
  rooms: f.ROOMS,
  humans: f.HUMANS,
  viewer: f.VIEWER,
  viewerNote: 'here · 4 owed to you',
  focused: 'conversation' as const,
  attention: f.ATTENTION,
  trailer: f.TRAILER,
  lastCheck: '12:29',
  filtered: false,
  objectives: f.OBJECTIVES,
  objects: f.OBJECTS,
  updatedAt: '13:41',
  binding: f.FREE,
  composerNote: 'nothing is inferred from a message unless you bind it',
};

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
    note: 'Three hours away. The divider counts by attention class, the routine group collapses legibly, and the pin sorts hardest first — the ■ destructive decision opens, the rest compress but stay actionable.',
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
      filtered: true,
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
    note: 'An owed item whose source lives in another room says so and goes there. The trace bar persists rather than fading — the reason you are standing in this room should still be on screen when you look up — and the target row is marked in the feed.',
    props: {
      ...base,
      room: {
        ...f.ROOM,
        name: 'identity-service',
        topic: 'tokens, sessions, and who is allowed to mint them',
      },
      rooms: f.ROOMS.map((room) => ({ ...room, current: room.name === 'identity-service' })),
      entries: f.timeline({ seen: true, filter: null, routineOpen: false, targetId: 'm10' }),
      jump: f.JUMP,
      openAttentionId: 'P1',
      binding: f.REPLYING,
      label: 'cross-room-jump',
    },
  },
  {
    id: 'zero-owed',
    title: 'Zero owed — silence as a result',
    note: 'Nothing needs this person. The pin says so as an answer rather than showing an empty box, and the trailer is only allowed to say everything is verified because it derived that from the objects, not from an author’s optimism.',
    props: {
      ...base,
      rooms: f.ROOMS_QUIET,
      viewerNote: 'here · nothing owed',
      attention: [],
      trailer: f.TRAILER_QUIET,
      lastCheck: '13:41',
      entries: f.QUIET_TIMELINE,
      objects: f.OBJECTS_QUIET,
      objectives: f.OBJECTIVES.map((objective) => ({ ...objective, status: 'active' as const })),
      label: 'zero-owed',
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
            Six states of the app frame, one <strong>full frame</strong> each — never a component on
            its own, because density and hairlines only mean anything against a whole screen. Both
            themes are the same markup under one class on <code>&lt;html&gt;</code>; use the switch
            to see the other one.
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
