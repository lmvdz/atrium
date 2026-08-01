'use client';

/* ---------------------------------------------------------------------------
 * Rail — rooms and humans.
 *
 * Two rules from the corpus show up here as structure, not styling:
 *   - owed attention never hides. The amber owed badge is not a hover
 *     affordance and it outranks the unseen count on the same row: a room you
 *     owe something to says so before it says how noisy it is.
 *   - presence is BLUE. Green means "verified" in this system and nothing else;
 *     a green dot beside a person's name would be a lie in the shared grammar.
 * ------------------------------------------------------------------------- */

import type { HumanSummary, RoomSummary } from '../model/records';
import { initials, text } from '../model/text';
import styles from './frame.module.css';

export interface RailProps {
  readonly workspaceName: string;
  readonly workspaceSub: string;
  readonly rooms: readonly RoomSummary[];
  readonly humans: readonly HumanSummary[];
  readonly viewer: HumanSummary;
  readonly viewerNote: string;
  readonly onSelectRoom?: (roomId: string) => void;
}

const PRESENCE_CLASS = {
  here: styles.presHere,
  idle: styles.presIdle,
  away: styles.presAway,
} as const;

const PRESENCE_LABEL = {
  here: 'here now',
  idle: 'idle',
  away: 'away',
} as const;

export function Rail({
  workspaceName,
  workspaceSub,
  rooms,
  humans,
  viewer,
  viewerNote,
  onSelectRoom,
}: RailProps) {
  return (
    <nav className={styles.rail} aria-label="Rooms and people">
      <div className={styles.railHead}>
        <h1>{workspaceName}</h1>
        <div className={`${styles.railHeadSub} atr-meta`}>{workspaceSub}</div>
      </div>

      <div className={`${styles.railBody} atr-scroll`}>
        <div className={styles.railSec}>
          <span className={`${styles.railSecLabel} atr-lbl`}>ROOMS</span>
        </div>
        {rooms.map((room) => (
          <RoomRow key={room.id} room={room} onSelect={onSelectRoom} />
        ))}

        <div className={styles.railSec}>
          <span className={`${styles.railSecLabel} atr-lbl`}>HUMANS</span>
        </div>
        {humans.map((human) => (
          <HumanRow human={human} key={human.id} />
        ))}
      </div>

      <div className={styles.railFoot}>
        <div className={styles.railFootAvatar} aria-hidden="true">
          {initials(viewer.name)}
        </div>
        <div>
          <div className={styles.railFootName}>{viewer.name}</div>
          <div className="atr-meta">{viewerNote}</div>
        </div>
      </div>
    </nav>
  );
}

function RoomRow({
  room,
  onSelect,
}: {
  readonly room: RoomSummary;
  readonly onSelect?: (roomId: string) => void;
}) {
  const owedLabel =
    room.owed > 0
      ? `${room.owed} item${room.owed === 1 ? '' : 's'} in #${room.name} need you`
      : null;
  return (
    <button
      aria-current={room.current ? 'true' : undefined}
      className={[
        styles.rrow,
        room.current ? styles.rrowOn : null,
        room.unseen > 0 || room.owed > 0 ? styles.rrowUnread : null,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onSelect === undefined ? undefined : () => onSelect(room.id)}
      type="button"
    >
      <span aria-hidden="true" className={styles.hash}>
        #
      </span>
      <span className={styles.rrowName}>{room.name}</span>
      {room.owed > 0 ? (
        <span className={styles.owedPill} title={owedLabel ?? undefined}>
          <span aria-hidden="true">◆</span>
          {room.owed}
        </span>
      ) : room.unseen > 0 ? (
        <span className={styles.count} title={`${room.unseen} unseen`}>
          {room.unseen}
        </span>
      ) : null}
    </button>
  );
}

function HumanRow({ human }: { readonly human: HumanSummary }) {
  const note = text(human.note);
  return (
    <div className={[styles.hrow, human.isViewer ? styles.hrowMe : null].filter(Boolean).join(' ')}>
      <span
        aria-hidden="true"
        className={`${styles.pres} ${PRESENCE_CLASS[human.presence]}`}
        title={PRESENCE_LABEL[human.presence]}
      />
      <span className={styles.hrowName}>{human.name}</span>
      {note === null ? null : <span className="atr-meta">{note}</span>}
    </div>
  );
}
