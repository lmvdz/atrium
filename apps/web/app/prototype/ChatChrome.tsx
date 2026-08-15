'use client';

/* CHAT CHROME — the thread's header (`ChatTopBar`) and its footer status strip
   (`ThreadStatus`), both contained to the chat column so they share its L/R
   gutters and stop at the split rather than running under the artifact.

   #151 marriage table: ChatTopBar / ThreadStatus are **port CSS, bind head +
   client projection** (#156) — `frame/RoomHead` + a small client projection for
   the branch/model status strip. The design shell stays; the derived data is
   the seam. The status strip's **run ▶** is a covenant/dispatch affordance
   wired by #157. */

import { useState } from 'react';
import { systemText } from '@/src/components/model/quotation';
import type { ParticipantSummary } from '@/src/components/model/records';
import { initials } from '@/src/components/model/text';
import { IconBase, IconPlay } from './icons';
import { ProviderMark } from './ProviderMark';
import styles from './prototype.module.css';
import { SharePopover } from './SharePopover';
import { participantsFor, type StreamState, statusStripFor, threadHeadFor } from './seams';
import type { Selection } from './types';

/* THE FACES ROW — a `ParticipantSummary` per member, kind-aware and presence-
   carrying, following the shipped `frame/RoomHead`/`Rail` grammar: the monogram
   is `initials()`, an agent's chip says so (`faceAgent`), and each face states
   its kind and presence as data so a fixture change moves the rendered state.
   Extracted so it can be rendered against a projected roster in a test. */
export function Faces({ people }: { people: readonly ParticipantSummary[] }) {
  return (
    <div className={styles.chatFaces}>
      {people.map((participant) => {
        const name = systemText(participant.name, 'ChatTopBar face');
        const isAgent = participant.kind === 'agent';
        const isUnknown = participant.kind === 'unknown';
        const kindClass = isAgent
          ? styles.faceAgent
          : isUnknown
            ? styles.facePending
            : styles.faceHuman;
        const label = isAgent ? `${name} — agent` : isUnknown ? `${name} — unknown` : name;
        return (
          <span
            key={participant.id}
            className={`${styles.face} ${kindClass}`}
            data-participant-kind={participant.kind}
            data-presence={participant.presence}
            title={label}
            aria-label={label}
          >
            {initials(name)}
          </span>
        );
      })}
    </div>
  );
}

/* CHAT TOP BAR — the thread's header: its title, the faces of everyone on it, and
   share. Contained to the chat column, sharing the chat's L/R gutters. */
export function ChatTopBar({ selected }: { selected: Selection }) {
  // #156: head is a real `RoomHeadRecord`; participants are real `ParticipantSummary` rows.
  const head = threadHeadFor(selected);
  const people = participantsFor(selected);
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <div className={styles.chatTop}>
      <div className={styles.chatTopId}>
        <span className={styles.chatTopName}>{systemText(head.topic, 'ChatTopBar topic')}</span>
        <span className={styles.chatTopSub}>#{systemText(head.name, 'ChatTopBar room')}</span>
      </div>
      <span className={styles.grow} />
      <Faces people={people} />
      <div className={styles.shareWrap}>
        <button
          type="button"
          className={`${styles.shareBtn} ${shareOpen ? styles.shareBtnOn : ''}`}
          onClick={() => setShareOpen((o) => !o)}
          aria-expanded={shareOpen}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="18" cy="5" r="2.6" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="6" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="18" cy="19" r="2.6" stroke="currentColor" strokeWidth="1.7" />
            <path d="M8.3 10.8l7.4-4.3M8.3 13.2l7.4 4.3" stroke="currentColor" strokeWidth="1.7" />
          </svg>
          share
        </button>
        {shareOpen ? <SharePopover people={people} onClose={() => setShareOpen(false)} /> : null}
      </div>
    </div>
  );
}

/* THREAD STATUS BAR — the bottom strip: branch · base · diff · model · host · run.
   Sits inside the thread, so it shares the chat's L/R gutters. */
export function ThreadStatus({ selected, stream }: { selected: Selection; stream: StreamState }) {
  // #156: the branch/base/diff/model/host strip, assembled by a client projection.
  const strip = statusStripFor(selected, stream);
  return (
    <footer className={styles.status}>
      <span className={styles.statItem}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="18" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.8" />
          <path d="M6 8.4v7.2M18 8.4c0 4-4 4-8.6 4.2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        <span className={styles.statBranch}>{systemText(strip.branch, 'ThreadStatus branch')}</span>
      </span>
      <span className={styles.statSep} aria-label="based on">
        <IconBase size={13} />
      </span>
      <span className={styles.statDim}>{systemText(strip.base, 'ThreadStatus base')}</span>
      <span className={styles.statDiff}>
        <span className={styles.statAdd}>+{strip.added}</span>
        <span className={styles.statDel}>−{strip.removed}</span>
      </span>
      {strip.running ? <span className={`${styles.statDot} atr-pulse`} aria-hidden /> : null}
      <span className={styles.grow} />
      <span className={styles.statItem}>
        <ProviderMark model={strip.model} />
        {systemText(strip.model, 'ThreadStatus model')}
      </span>
      <span className={styles.statSep}>·</span>
      <span className={styles.statItem}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect
            x="3"
            y="4"
            width="18"
            height="12"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path d="M8 20h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {systemText(strip.host, 'ThreadStatus host')}
      </span>
      {/* SEAM(#157): run ▶ dispatches a session through the gated door
          (open_session / resume_session — a resume is a DRAW, gated by the plan's
          slice). Honestly INERT until app-integration: this route holds no live
          session to dispatch, so the control is DISABLED rather than a no-op that
          looks live. It carries no onClick — clicking it cannot mutate anything or
          fake a run. Wired via `covenant.run(sessionId)` when a live client lands. */}
      <button
        className={styles.statRun}
        type="button"
        title="run — not reachable from this surface yet (#157: open_session / resume_session)"
        aria-label="run (awaiting the live session)"
        disabled
      >
        <IconPlay size={12} />
      </button>
    </footer>
  );
}
