'use client';

import { systemText } from '../model/quotation';
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
        <h2>
          <span aria-hidden="true" className={styles.roomheadHash}>
            #
          </span>{' '}
          <span>{name}</span>
        </h2>
        <div className={styles.topic}>{topic}</div>
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
      </div>
      {surfaces.node}
    </header>
  );
}
