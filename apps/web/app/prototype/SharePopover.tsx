'use client';

/* SHARE — invite by email or hand out a link. A popover off the top bar.

   #151 marriage table: the share **roster** is bind-shipped (#156, from
   `ParticipantSummary`); the invite/copy-link **action** is deferred (Tier-2,
   no backend) to the Phase-6 fog. The invite list and copy state are local — a
   prototype of the real share flow. */

import { useState } from 'react';
import { systemText } from '@/src/components/model/quotation';
import type { ParticipantSummary } from '@/src/components/model/records';
import { initials } from '@/src/components/model/text';
import { IconClose } from './icons';
import styles from './prototype.module.css';
import { NO_AUTOFILL } from './types';

export function SharePopover({
  people,
  onClose,
}: {
  people: readonly ParticipantSummary[];
  onClose: () => void;
}) {
  const [email, setEmail] = useState('');
  const [invited, setInvited] = useState<readonly string[]>([]);
  const [copied, setCopied] = useState(false);
  const link = 'https://atrium.dev/t/streaming-invoice-totals#k=9f3ac1';
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const copy = () => {
    navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };
  return (
    <div className={styles.sharePop} role="dialog" aria-label="share this thread">
      <div className={styles.shareHead}>
        <span className={styles.shareTitle}>Share this thread</span>
        <button type="button" className={styles.shareClose} onClick={onClose} aria-label="close">
          <IconClose />
        </button>
      </div>
      {/* SEAM(#156)/Phase-6 fog: the invite action has no backend yet — local only. */}
      <form
        className={styles.shareInvite}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setInvited((v) => [...v, email]);
          setEmail('');
        }}
      >
        <input
          className={styles.shareInput}
          type="email"
          placeholder="invite by email…"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          {...NO_AUTOFILL}
        />
        <button type="submit" className={styles.shareInviteBtn} disabled={!valid}>
          Invite
        </button>
      </form>
      <div className={styles.shareList}>
        {/* #156: the roster is real `ParticipantSummary` rows. The row's role is
            read from the record — the viewer owns the thread, an agent is named
            an agent, everyone else is an editor — never from list position. */}
        {people.map((participant) => {
          const name = systemText(participant.name, 'SharePopover name');
          const role = participant.isViewer
            ? 'owner'
            : participant.kind === 'agent'
              ? 'agent'
              : participant.kind === 'unknown'
                ? 'unknown'
                : 'editor';
          return (
            <div key={participant.id} className={styles.shareRow}>
              <span
                className={`${styles.face} ${
                  participant.kind === 'agent'
                    ? styles.faceAgent
                    : participant.kind === 'unknown'
                      ? styles.facePending
                      : styles.faceHuman
                }`}
                data-participant-kind={participant.kind}
                data-presence={participant.presence}
                aria-hidden
              >
                {initials(name)}
              </span>
              <span className={styles.shareName}>{name}</span>
              <span className={styles.grow} />
              <span className={styles.shareRole}>{role}</span>
            </div>
          );
        })}
        {invited.map((e) => (
          <div key={e} className={styles.shareRow}>
            <span className={`${styles.face} ${styles.facePending}`} aria-hidden>
              @
            </span>
            <span className={styles.shareName}>{e}</span>
            <span className={styles.grow} />
            <span className={styles.shareRolePending}>invited</span>
          </div>
        ))}
      </div>
      <div className={styles.shareLink}>
        <input
          className={styles.shareLinkInput}
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className={styles.shareCopy} onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
