'use client';

/* ---------------------------------------------------------------------------
 * The session REVIEW PANE — diff + tests + receipt + artifact, and a
 * certification gated on a formal human hold (scout §9.5; #121; the Delta
 * review-changes layout with the tests and the receipt Delta never showed).
 *
 * Borrows Delta's "everything about the change in one place" but NOT its implicit
 * "land when you're happy": certifying is a HoldToAct — a real press-and-hold
 * whose duration is stamped and measured by the SERVER (lib/certify-session.ts's
 * arm→confirm), not reported by this page. It is offered only to a HUMAN viewer;
 * an agent or an unreadable-kind viewer sees the refusal in the covenant's own
 * words. The server and the DB triggers (drizzle/0032, 0033) enforce all of it
 * under the affordance — the UI gate is the first of three, not the only one.
 *
 * ## WHAT THIS PANE SAYS THE ACTION DOES, AND WHY IT CHANGED
 *
 * It used to read: "Certifying lands this work onto <branch>. It is not undoable."
 * The first sentence was false. Nothing in this product merges, pushes, deploys
 * or applies anything — `certifySession` writes four columns on the session row.
 * The branch named in the artifact is where the agent's work ALREADY is; the
 * action puts a person's signature on the record that it was reviewed. Copy that
 * promises a merge on a control that writes a receipt is the most expensive kind
 * of lie this interface can tell, because the person acts on it and then believes
 * the branch moved.
 *
 * The second sentence is true and stays: drizzle/0033 makes a certification
 * write-once, so it genuinely cannot be taken back.
 * ------------------------------------------------------------------------- */

import { useEffect, useState } from 'react';
import { CERTIFY_HOLD_MS } from '@/lib/certify-hold';
import type { ControlSessionRow } from '@/lib/control-plane-data';
import type { ParticipantKind } from '../model/kind';
import { systemText } from '../model/quotation';
import { Glyph } from '../primitives/Glyph';
import { HoldToAct } from '../primitives/HoldToAct';
import styles from './control.module.css';
import { formatMicros, sessionAwaitsLanding, sessionCertified, sessionState } from './state';

/** The "certified by … · when · held Ns" line, composed once. */
function certifiedLine(session: ControlSessionRow): string {
  const when =
    session.certifiedAt === null ? '' : ` · ${session.certifiedAt.slice(0, 16).replace('T', ' ')}`;
  /* The held duration the SERVER measured between its arm and its confirm. It is
     evidence now rather than a number the browser reported, which is the only
     reason it is worth printing on a receipt at all. */
  const held =
    session.certifiedHeldMs === null
      ? ''
      : ` · held ${(session.certifiedHeldMs / 1000).toFixed(1)}s`;
  return `certified by ${session.certifiedByName}${when}${held}`;
}

export interface ReviewPaneProps {
  readonly session: ControlSessionRow | null;
  readonly planTitle: string | null;
  readonly agentName: string | null;
  /** the person reading — the actor an arming records */
  readonly viewerId: string;
  /** server-resolved; the certification is offered only when this is `human` */
  readonly viewerKind: ParticipantKind | 'unknown';
  /** fired when the hold BEGINS, so the server can stamp the start of it */
  readonly onArm: (sessionId: string) => void;
  readonly onCertify: (sessionId: string) => void;
  readonly certifyError: string | null;
}

export function ReviewPane({
  session,
  planTitle,
  agentName,
  viewerId,
  viewerKind,
  onArm,
  onCertify,
  certifyError,
}: ReviewPaneProps) {
  const [applying, setApplying] = useState(false);
  // A new session, or a certified one, clears the optimistic "recording" note.
  const sessionId = session?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keys off the identity/certified-ness, not the whole row.
  useEffect(() => setApplying(false), [sessionId, session?.certifiedByName]);

  if (session === null) {
    return (
      <div className={styles.review} data-region="review-pane">
        <div className={styles.reviewEmpty}>
          <span className="atr-lbl">REVIEW</span>
          <span>Select a session in the tree to review its diff, tests, receipt and artifact.</span>
        </div>
      </div>
    );
  }

  /* The review header's glyph reads the same "owed to a human" gate the tree and
     the pin do: an agent-principal viewer sees the process glyph, not a "needs
     you" they cannot act on. `viewerKind` is server-resolved; allowlist `'human'`. */
  const state = sessionState(session, viewerKind === 'human');
  const artifact = session.artifact;
  const awaitsLanding = sessionAwaitsLanding(session);
  /* The SAME predicate the glyph derives from — not `certifiedByName !== null`,
     which is a second source that would agree with the tick only by luck. */
  const certified = sessionCertified(session);

  return (
    <div className={styles.review} data-region="review-pane" data-review-session={session.id}>
      <div className={styles.reviewHead}>
        <Glyph state={state} />
        <span className={styles.reviewTitle}>{systemText(session.model, 'ReviewPane model')}</span>
        <span className="atr-meta">{systemText(session.status, 'ReviewPane status')}</span>
      </div>
      <span className="atr-meta">
        {systemText(
          `${agentName ?? 'agent'}${planTitle === null ? '' : ` · ${planTitle}`} · ${session.harness}`,
          'ReviewPane provenance',
        )}
      </span>

      {/* ── DIFF ─────────────────────────────────────────────────────────── */}
      <section className={styles.section} data-review-diff="true">
        <div className={`${styles.sectionHead} atr-lbl`}>DIFF</div>
        <div className={styles.sectionBody}>
          {artifact?.diffStat ? (
            <span className={`${styles.v} ${styles.vMono}`} data-diff-stat="true">
              {systemText(artifact.diffStat, 'ReviewPane diff')}
            </span>
          ) : (
            <span className={styles.muted}>
              no diff recorded — the ExecutionProvider (#120) records one at settle
            </span>
          )}
        </div>
      </section>

      {/* ── TESTS ────────────────────────────────────────────────────────── */}
      <section className={styles.section} data-review-tests="true">
        <div className={`${styles.sectionHead} atr-lbl`}>TESTS</div>
        <div className={styles.sectionBody}>
          {artifact?.testsPassed === undefined && artifact?.testsFailed === undefined ? (
            <span className={styles.muted}>no test run recorded</span>
          ) : (
            <span className={styles.v} data-tests="true">
              <span className={styles.pass} data-tests-passed={artifact?.testsPassed ?? 0}>
                {artifact?.testsPassed ?? 0} passed
              </span>
              {' · '}
              <span
                className={(artifact?.testsFailed ?? 0) > 0 ? styles.fail : styles.muted}
                data-tests-failed={artifact?.testsFailed ?? 0}
              >
                {artifact?.testsFailed ?? 0} failed
              </span>
            </span>
          )}
        </div>
      </section>

      {/* ── RECEIPT ──────────────────────────────────────────────────────── */}
      <section className={styles.section} data-review-receipt="true">
        <div className={`${styles.sectionHead} atr-lbl`}>RECEIPT</div>
        <div className={styles.sectionBody}>
          <div className={styles.kv}>
            <span className={styles.k}>status</span>
            <span className={styles.v}>
              {systemText(session.status, 'ReviewPane receipt status')}
            </span>
          </div>
          <div className={styles.kv}>
            <span className={styles.k}>spend</span>
            <span className={styles.v}>
              {systemText(formatMicros(session.spendMicros), 'ReviewPane receipt spend')}
            </span>
          </div>
          {session.contextPct === null ? null : (
            <div className={styles.kv}>
              <span className={styles.k}>context</span>
              <span className={styles.v}>
                {systemText(`${Math.round(session.contextPct * 100)}%`, 'ReviewPane context')}
              </span>
            </div>
          )}
          <div className={styles.kv}>
            <span className={styles.k}>summary</span>
            <span className={`${styles.v} ${styles.receiptProse}`} data-exit-summary="true">
              {session.exitSummary === null ? (
                <span className={styles.muted}>no exit prose recorded</span>
              ) : (
                systemText(session.exitSummary, 'ReviewPane exit summary')
              )}
            </span>
          </div>
        </div>
      </section>

      {/* ── ARTIFACT ─────────────────────────────────────────────────────── */}
      <section className={styles.section} data-review-artifact="true">
        <div className={`${styles.sectionHead} atr-lbl`}>ARTIFACT</div>
        <div className={styles.sectionBody}>
          {artifact === null ? (
            <span className={styles.muted}>
              no execution artifact — an audit or a dry-run produces none
            </span>
          ) : (
            <>
              {artifact.branch === undefined ? null : (
                <div className={styles.kv}>
                  <span className={styles.k}>branch</span>
                  <span className={`${styles.v} ${styles.vMono}`} data-artifact-branch="true">
                    {systemText(artifact.branch, 'ReviewPane branch')}
                  </span>
                </div>
              )}
              {artifact.commit === undefined ? null : (
                <div className={styles.kv}>
                  <span className={styles.k}>commit</span>
                  <span className={`${styles.v} ${styles.vMono}`} data-artifact-commit="true">
                    {systemText(artifact.commit, 'ReviewPane commit')}
                  </span>
                </div>
              )}
              {artifact.summary === undefined ? null : (
                <div className={styles.kv}>
                  <span className={styles.k}>note</span>
                  <span className={styles.v}>
                    {systemText(artifact.summary, 'ReviewPane note')}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── CERTIFY ──────────────────────────────────────────────────────── */}
      {certified ? (
        <div className={styles.certified} data-certified="true">
          <Glyph className={styles.certifiedGlyph} state={state} />
          <span>{systemText(certifiedLine(session), 'ReviewPane certified')}</span>
        </div>
      ) : !awaitsLanding ? (
        <div className={styles.refused} data-certify="unavailable">
          {session.status === 'settled'
            ? 'this session produced no artifact to review — it settled on its own account, and no human signature is owed'
            : 'a session is certified once it settles with an artifact; this one has not yet'}
        </div>
      ) : viewerKind === 'human' ? (
        <div className={`${styles.certify} ${styles.certifyDestructive}`} data-certify="ready">
          <span className={`${styles.certifyHead} atr-lbl`}>CERTIFY THIS SESSION</span>
          <span className={styles.certifyNote}>
            {systemText(
              `Certifying records a human signature on this session — who certified it, when, and how long the control was held, all measured by the server. It moves no code: the work already sits on ${artifact?.branch ?? 'its branch'}, and nothing here merges, pushes or deploys it. A certification is written once and cannot be taken back.`,
              'ReviewPane certify note',
            )}
          </span>
          <HoldToAct
            actionId={`certify-${session.id}`}
            actor={viewerId}
            describe="put a human signature on this session's receipt"
            holdMs={CERTIFY_HOLD_MS}
            label="Certify this session"
            onAct={() => onCertify(session.id)}
            /* The arm goes out on hold-BEGIN so the server's clock starts when
               the person's press does; `onArm` fires on completion and is the
               local note that a confirm is in flight. */
            onArm={() => setApplying(true)}
            onBegin={() => onArm(session.id)}
          />
          {applying && certifyError === null ? (
            <span className={styles.certifyNote} data-certify-applying="true">
              hold complete — recording the signature…
            </span>
          ) : null}
          {certifyError === null ? null : (
            <span className={styles.error} data-certify-error="true">
              {systemText(certifyError, 'ReviewPane certify error')}
            </span>
          )}
        </div>
      ) : (
        <div className={styles.refused} data-certify="refused" data-certify-refused="true">
          A session is certified only by a human — the covenant's second pair of eyes. A machine or
          a voice path cannot certify this, and neither the server nor the table will let it.
        </div>
      )}
    </div>
  );
}
