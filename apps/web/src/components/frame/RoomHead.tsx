'use client';

import { systemText } from '../model/quotation';
import type { RoomHeadRecord } from '../model/records';
import type { Slot } from '../model/slot';
import { initials } from '../model/text';
import styles from './frame.module.css';

export interface RoomHeadProps {
  readonly room: RoomHeadRecord;
  readonly working?: number;
  readonly settled?: number;
  /**
   * The surface indicators sit under the title line. A `Slot`, not a
   * `ReactNode`: this was the last composition hole in the frame taking the
   * widest type React has, which is the hole model/slot.ts exists to close —
   * raw `<q>invented words</q>` could have gone straight through it with no
   * cast, in the header of every room.
   */
  readonly surfaces: Slot;
}

export function RoomHead({ room, surfaces, working, settled }: RoomHeadProps) {
  /* THE ROOM, THE TOPIC AND EVERY MEMBER'S NAME ARE STRINGS THIS PAGE PRINTS.
     Round 7's denominator: the page-authored sink set is not the set of elements
     carrying `data-voice="system"`, it is every caller string that reaches a
     reader — and a header that prints a room's topic prints whatever the record
     holds. */
  const name = systemText(room.name, 'RoomHead name');
  const topic = systemText(room.topic, 'RoomHead topic');
  return (
    <header className={styles.roomhead}>
      <div className={styles.roomheadTop}>
        {/* Tree/by-goal is the only implemented projection. These used to be
            bordered spans reading like tabs for mux/by-agent/by-project even
            though no interaction existed. State the active view; do not paint
            unavailable navigation. */}
        <span className={styles.modeStatus}>view: tree · by goal</span>
        <div className={styles.faces}>
          {room.members.map((member) => {
            const memberName = systemText(member.name, 'RoomHead member');
            const isAgent = member.kind === 'agent';
            return (
              <span
                className={`${styles.face}${isAgent ? ` ${styles.faceAgent}` : ''}`}
                data-participant-kind={member.kind}
                key={`${member.kind}:${member.name}`}
                /* The chip's own accessible route to who it is. An agent's says
                   so — the monogram alone is a shape distinction, and a shape is
                   not a name. */
                title={isAgent ? `${memberName} — agent` : memberName}
              >
                {initials(memberName)}
              </span>
            );
          })}
        </div>
        <span className={styles.hereCount}>{room.members.length} here</span>
        <span className={styles.roomheadSpacer} />
        {working === undefined || settled === undefined ? (
          <h2 title={topic}>
            <span aria-hidden="true" className={styles.roomheadHash}>
              #
            </span>
            <span>{name}</span>
          </h2>
        ) : (
          <div className={styles.workCounts} title={topic}>
            {/* NO DECORATIVE MARK INSIDE A VISUALLY HIDDEN HEADING. This
                carried an `aria-hidden` `#` span, which no screen reader
                announces (it is aria-hidden) and no reader sees (the heading is
                sr-only geometry) — a mark with no consumer. It was also a real
                child box inside a 1px clipping parent, which is precisely the
                shape `e2e/audit.ts` reports as a broken track set with the
                evidence swallowed, at every width and in both themes. Deleting
                the mark is the fix; exempting the element would have taught the
                sweep to ignore the shape it exists to find. */}
            <h2 className={styles.roomContext}>{name}</h2>
            <span>{working} working</span>
            <span>· {settled} settled</span>
          </div>
        )}
      </div>
      {surfaces.node}
    </header>
  );
}
