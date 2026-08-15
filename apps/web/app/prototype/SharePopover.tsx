'use client';

/* SHARE — invite by email or hand out a link. A popover off the top bar.

   #151 marriage table: the share **roster** is bind-shipped (#156, from
   `ParticipantSummary`); the invite/copy-link **action** is deferred (Tier-2,
   no backend) to the Phase-6 fog. The invite list and copy state are local — a
   prototype of the real share flow. */

import { useState } from 'react';
import { IconClose } from './icons';
import styles from './prototype.module.css';
import { NO_AUTOFILL, type Participant } from './types';

export function SharePopover({
  people,
  onClose,
}: {
  people: readonly Participant[];
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
        {people.map((p, i) => (
          <div key={p.who} className={styles.shareRow}>
            <span
              className={`${styles.face} ${p.kind === 'human' ? styles.faceHuman : styles.faceAgent}`}
              aria-hidden
            >
              {p.who.slice(0, 2)}
            </span>
            <span className={styles.shareName}>{p.who === 'you' ? 'you' : p.who}</span>
            <span className={styles.grow} />
            <span className={styles.shareRole}>
              {i === 0 ? 'owner' : p.kind === 'agent' ? 'agent' : 'editor'}
            </span>
          </div>
        ))}
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
