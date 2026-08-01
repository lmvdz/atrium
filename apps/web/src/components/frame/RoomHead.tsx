'use client';

import type { RoomHeadRecord } from '../model/records';
import type { Slot } from '../model/slot';
import { initials } from '../model/text';
import styles from './frame.module.css';

export interface RoomHeadProps {
  readonly room: RoomHeadRecord;
  /**
   * The surface indicators sit under the title line. A `Slot`, not a
   * `ReactNode`: this was the last composition hole in the frame taking the
   * widest type React has, which is the hole model/slot.ts exists to close —
   * raw `<q>invented words</q>` could have gone straight through it with no
   * cast, in the header of every room.
   */
  readonly surfaces: Slot;
}

export function RoomHead({ room, surfaces }: RoomHeadProps) {
  return (
    <header className={styles.roomhead}>
      <div className={styles.roomheadTop}>
        <h2>
          <span aria-hidden="true" className={styles.roomheadHash}>
            #
          </span>{' '}
          <span>{room.name}</span>
        </h2>
        <div className={styles.topic} data-truncates="the room head's title" title={room.topic}>
          {room.topic}
        </div>
        <div className={styles.faces}>
          {room.members.map((member) => (
            <span className={styles.face} key={member} title={member}>
              {initials(member)}
            </span>
          ))}
        </div>
      </div>
      {surfaces.node}
    </header>
  );
}
