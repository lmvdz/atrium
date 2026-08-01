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

import { systemText } from '../model/quotation';
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

/* PRESENCE IN WORDS, NOT ONLY IN A DOT.
   Round 4's gauntlet: the dot was `aria-hidden` with a `title`, which no screen
   reader announces, and `here`/`idle`/`away` differed only by fill-versus-ring
   and hue — one fixture row carried no text equivalent at all. The state is now
   the first thing on the row's meta line, visibly, for every human; the dot is
   the glanceable shorthand for a fact that is also written down. */
const PRESENCE_LABEL = {
  here: 'here',
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
        <h1>{systemText(workspaceName, 'Rail workspaceName')}</h1>
        <div className={`${styles.railHeadSub} atr-meta`}>
          {systemText(workspaceSub, 'Rail workspaceSub')}
        </div>
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
          {initials(systemText(viewer.name, 'Rail viewer'))}
        </div>
        <div>
          <div className={styles.railFootName}>{systemText(viewer.name, 'Rail viewer')}</div>
          <div className="atr-meta">{systemText(viewerNote, 'Rail viewerNote')}</div>
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
  /* ONE CHECKED READ OF THE ROOM'S NAME, used by the label, the accessible name
     and the chip. The name is a caller string this component prints in three
     places; checking it once and painting the checked value is the same shape
     `AttentionCompact` uses for its rationale. */
  const roomName = systemText(room.name, 'Rail room');
  const owedLabel =
    room.owed > 0
      ? `${room.owed} item${room.owed === 1 ? '' : 's'} in #${roomName} need you`
      : null;
  /* THE SAME WELDED NAME AS THE SURFACE CHIP, two more times. The name and the
     count are adjacent elements with no text node between them, so the room
     announced as "identity-service12" — and the badge that says twelve things
     are owed to you is the half that gets eaten. Round 3's gauntlet named the
     surface chip; a sweep of every button's accessible name found these, which
     is why the sweep is worth more than the instance. Stated rather than left
     to how the platform joins two spans. */
  const name = `#${roomName}${
    room.owed > 0
      ? ` — ${room.owed} owed to you`
      : room.unseen > 0
        ? ` — ${room.unseen} unseen`
        : ''
  }`;
  return (
    <button
      aria-current={room.current ? 'true' : undefined}
      aria-label={name}
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
      {/* The button's own accessible name carries the room and its badge in
          full — see `name` above — so a clipped chip has a route that does not
          depend on hovering. */}
      <span className={styles.rrowName} data-truncates="name">
        {roomName}
      </span>
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
  /* THE NOTE IS A FREE STRING THE PAGE PRINTS BESIDE A PERSON'S NAME, which is
     the shape round 7 found four more of. `text()` normalises absence; it is not
     a check, and it never was — the check is the door. */
  const note = text(human.note) === null ? null : systemText(human.note ?? '', 'Rail human note');
  const name = systemText(human.name, 'Rail human');
  /* The presence word leads the meta line, and the free-text note follows it.
     Composed here rather than left to two adjacent elements, for the same reason
     every other name on this rail is: adjacent spans announce welded. */
  const meta =
    note === null ? PRESENCE_LABEL[human.presence] : `${PRESENCE_LABEL[human.presence]} · ${note}`;
  return (
    <div className={[styles.hrow, human.isViewer ? styles.hrowMe : null].filter(Boolean).join(' ')}>
      {/* Decorative NOW: the row says the same thing in words one element over.
          `data-presence` is what the rendered non-text-graphic audit measures it
          by — a graphic that carries information has to be in the registry, and
          the registry needs a selector that is not a CSS-module hash. */}
      <span
        aria-hidden="true"
        className={`${styles.pres} ${PRESENCE_CLASS[human.presence]}`}
        data-presence={human.presence}
      />
      {/* THE ROSTER STATES EVERY NAME IN FULL, which is what makes it the route
          the feed's actor column names. It stopped clipping in round 7 — its own
          route had been the `title` attribute, which CONVENTIONS refuses. */}
      <span className={styles.hrowName} data-roster-name={name}>
        {name}
      </span>
      <span className="atr-meta">{meta}</span>
    </div>
  );
}
