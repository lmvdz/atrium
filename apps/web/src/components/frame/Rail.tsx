'use client';

/* ---------------------------------------------------------------------------
 * Rail — rooms and participants.
 *
 * Rules from the corpus that show up here as structure, not styling:
 *   - owed attention never hides. The amber owed badge is not a hover
 *     affordance and it outranks the unseen count on the same row: a room you
 *     owe something to says so before it says how noisy it is.
 *   - presence is BLUE. Green means "verified" in this system and nothing else;
 *     a green dot beside a person's name would be a lie in the shared grammar.
 *   - an agent is not a person, and the roster says so in shape and in words,
 *     never in a new hue. Every colour is spoken for (green verified, blue
 *     presence, amber owed, red destructive), so the kind is carried by a
 *     squared marker and the word `agent` on the row — a distinction a reader
 *     who cannot separate two colours still reads, which is the same reason the
 *     presence state is written down and not left to the dot.
 * ------------------------------------------------------------------------- */

import { systemText } from '../model/quotation';
import type { ParticipantSummary, RoomSummary } from '../model/records';
import { text } from '../model/text';
import { Glyph } from '../primitives/Glyph';
import styles from './frame.module.css';

export interface RailProps {
  readonly workspaceName: string;
  readonly workspaceSub: string;
  readonly rooms: readonly RoomSummary[];
  readonly participants: readonly ParticipantSummary[];
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
  participants,
  onSelectRoom,
}: RailProps) {
  return (
    <nav className={styles.rail} aria-label="Rooms and participants">
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

        {/* PARTICIPANTS, not HUMANS. The section held only people because the
            record it read could not describe anything else; now a member can be
            an agent, and a header that says HUMANS would be a hardcoded person
            assumption on the one surface that lists who is in the room. */}
        <div className={styles.railSec}>
          <span className={`${styles.railSecLabel} atr-lbl`}>PARTICIPANTS</span>
        </div>
        {participants.map((participant) => (
          <ParticipantRow key={participant.id} participant={participant} />
        ))}
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
  /* THE COUNT AND THE GLYPH ARE ONE VALUE — ROUND 10, D1. `room.owed` was a
     number and the chip drew `<span aria-hidden="true">◆</span>` beside it: the
     only aggregate glyph in the app that was not derived, on the one surface
     that reports what a room you are NOT standing in owes you, where nothing
     else on screen can correct it. It promised amber-reversible over a set whose
     hardest member is an irreversible table drop.
     `OwedSummary` carries the count and the hardest owed item's STATE together,
     from one pass over one array, and `<Glyph>` derives the character, the tone
     and the tooltip from that state. */
  const owedLabel =
    room.owed.kind === 'some'
      ? `${room.owed.count} item${room.owed.count === 1 ? '' : 's'} in #${roomName} need you`
      : null;
  /* THE SAME WELDED NAME AS THE SURFACE CHIP, two more times. The name and the
     count are adjacent elements with no text node between them, so the room
     announced as "identity-service12" — and the badge that says twelve things
     are owed to you is the half that gets eaten. Round 3's gauntlet named the
     surface chip; a sweep of every button's accessible name found these, which
     is why the sweep is worth more than the instance. Stated rather than left
     to how the platform joins two spans. */
  const name = `#${roomName}${
    room.owed.kind === 'some'
      ? ` — ${room.owed.count} owed to you`
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
        room.unseen > 0 || room.owed.kind === 'some' ? styles.rrowUnread : null,
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
      {room.owed.kind === 'some' ? (
        <span className={styles.owedPill} data-owed-chip={roomName} title={owedLabel ?? undefined}>
          <Glyph state={room.owed.state} />
          {room.owed.count}
        </span>
      ) : room.unseen > 0 ? (
        <span className={styles.count} title={`${room.unseen} unseen`}>
          {room.unseen}
        </span>
      ) : null}
    </button>
  );
}

function ParticipantRow({ participant }: { readonly participant: ParticipantSummary }) {
  /* THE NOTE IS A FREE STRING THE PAGE PRINTS BESIDE A NAME, which is the shape
     round 7 found four more of. `text()` normalises absence; it is not a check,
     and it never was — the check is the door. */
  const note =
    text(participant.note) === null
      ? null
      : systemText(participant.note ?? '', 'Rail participant note');
  const name = systemText(participant.name, 'Rail participant');
  const isAgent = participant.kind === 'agent';
  const isUnknown = participant.kind === 'unknown';
  /* The presence word leads the meta line, and the free-text note follows it.
     Composed here rather than left to two adjacent elements, for the same reason
     every other name on this rail is: adjacent spans announce welded.

     An agent's line names the kind first — `agent · here` — so the register is
     read, not inferred from a shape. An unknown-kind member leads with `unknown`
     for the same reason and the opposite one: the row must not read as a person,
     and the word says so where the shape alone would not. The presence WORD
     (`here`/`idle`/`away`) is still present, because a member that holds a
     session is here or not the same way a person is, and the audit that checks
     every row writes its state down reads that word on this row too. */
  const presenceLabel = PRESENCE_LABEL[participant.presence];
  const kindWord = isAgent ? 'agent' : isUnknown ? 'unknown' : null;
  const kindPrefixed = kindWord === null ? presenceLabel : `${kindWord} · ${presenceLabel}`;
  const meta = note === null ? kindPrefixed : `${kindPrefixed} · ${note}`;
  return (
    <div
      className={[styles.hrow, participant.isViewer ? styles.hrowMe : null]
        .filter(Boolean)
        .join(' ')}
      data-participant-kind={participant.kind}
    >
      {/* Decorative NOW: the row says the same thing in words one element over.
          `data-presence` is what the rendered non-text-graphic audit measures it
          by — a graphic that carries information has to be in the registry, and
          the registry needs a selector that is not a CSS-module hash.
          `presAgent` squares the marker: an agent is a machine holding a session,
          not a person present, and the shape says which without borrowing a hue
          that already means something else in this grammar. `presUnknown` is the
          fail-closed marker — a dashed hollow square, neither the person's dot
          nor the agent's filled square — for a kind we could not read. */}
      <span
        aria-hidden="true"
        className={`${styles.pres} ${PRESENCE_CLASS[participant.presence]}${
          isAgent ? ` ${styles.presAgent}` : isUnknown ? ` ${styles.presUnknown}` : ''
        }`}
        data-presence={participant.presence}
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
