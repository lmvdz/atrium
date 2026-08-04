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
        <span className={styles.modeGroup}>
          <span className={styles.modeOn}>tree</span>
          <span className={styles.modeOff}>mux</span>
        </span>
        <span className={styles.modeGroup}>
          <span className={styles.modeOn}>by goal</span>
          <span className={styles.modeOff}>by agent</span>
          <span className={styles.modeOff}>by project</span>
        </span>
        <div className={styles.faces}>
          {room.members.map((member) => (
            <span
              className={styles.face}
              key={member}
              title={systemText(member, 'RoomHead member')}
            >
              {initials(systemText(member, 'RoomHead member'))}
            </span>
          ))}
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
            <h2 className={styles.roomContext}>
              <span aria-hidden="true">#</span>
              {name}
            </h2>
            <span>{working} working</span>
            <span>· {settled} settled</span>
          </div>
        )}
      </div>
      {surfaces.node}
    </header>
  );
}
