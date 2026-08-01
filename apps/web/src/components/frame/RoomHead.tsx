'use client';

import type { ReactNode } from 'react';
import type { RoomHeadRecord } from '../model/records';
import { initials } from '../model/text';
import styles from './frame.module.css';

export interface RoomHeadProps {
  readonly room: RoomHeadRecord;
  /** the surface indicators sit under the title line */
  readonly surfaces: ReactNode;
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
        <div className={styles.topic} title={room.topic}>
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
      {surfaces}
    </header>
  );
}
