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
import { CERTIFY_HOLD_MS, isReviewableArtifact } from '@/lib/certify-hold';
import type { ControlSessionRow, SessionArtifact } from '@/lib/control-plane-data';
import type { ParticipantKind } from '../model/kind';
import { fileText, systemText } from '../model/quotation';
import { Glyph } from '../primitives/Glyph';
import { HoldToAct } from '../primitives/HoldToAct';
import styles from './control.module.css';
/* The diff renderer is shared now, not module-private: the prototype's artifact
   pane (#155) renders the SAME structured-diff view rather than hand-rolling a
   client `parseDiff`. Extraction is behaviour-preserving — see DiffView.tsx. */
import { DiffView } from './DiffView';
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
  /** fired when the hold BEGINS, so the server can stamp the start of it and mint a token */
  readonly onArm: (sessionId: string) => void;
  readonly onCertify: (sessionId: string) => void;
  /** fired when a hold is RELEASED before completing, so the server clears the arm */
  readonly onDisarm: (sessionId: string) => void;
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
  onDisarm,
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
          <DiffView artifact={artifact} />
        </div>
      </section>

      {/* ── TESTS ────────────────────────────────────────────────────────── */}
      <section className={styles.section} data-review-tests="true">
        <div className={`${styles.sectionHead} atr-lbl`}>TESTS</div>
        <div className={styles.sectionBody}>
          <TestsView artifact={artifact} />
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
          {/* Three distinct reasons a settled-or-not session offers no certify, and
              the copy must name the RIGHT one (round-8). The branch used to say
              "produced no artifact to review" for every settled row — a lie when the
              artifact is visibly present above and the row simply carries an
              incomplete/defective receipt (`certifiedById` set, but the hold does not
              cohere, so `sessionCertified` renders `~`). Distinguish: genuinely no
              artifact vs. an artifact present under a receipt that does not stand. */}
          {session.status !== 'settled'
            ? 'a session is certified once it settles with an artifact; this one has not yet'
            : !isReviewableArtifact(artifact)
              ? 'this session produced no artifact to review — it settled on its own account, and no human signature is owed'
              : "this session's certification receipt is incomplete — the artifact above is present, but the recorded hold does not cohere, so it does not stand as a human signature and reads as the machine's own account (~)"}
        </div>
      ) : viewerKind === 'human' ? (
        <div className={`${styles.certify} ${styles.certifyDestructive}`} data-certify="ready">
          <span className={`${styles.certifyHead} atr-lbl`}>CERTIFY THIS SESSION</span>
          <span className={styles.certifyNote}>
            {systemText(
              `Certifying records a human signature on this session — who certified it, when, and the minimum delay the server measured before it would confirm. Press and hold is the affordance for meeting that delay; the server times its own arm→confirm interval, so nothing here trusts the browser's clock. It moves no code: the work already sits on ${artifact?.branch ?? 'its branch'}, and nothing here merges, pushes or deploys it. A certification is written once and cannot be taken back.`,
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
               the person's press does; `onArm` (HoldToAct's, below) fires on
               completion and is the local note that a confirm is in flight. The
               server-issued token the arm returns is what correlates the confirm
               and the disarm to this press (round-7 finding 2); the ControlPlane
               holds it, so nothing needs to travel through these callbacks. */
            onArm={() => setApplying(true)}
            onBegin={() => onArm(session.id)}
            /* Released before the meter filled: tell the server to clear the arm
               it stamped on begin, so a cancelled hold leaves nothing a later
               confirm could spend (CS-3). Also drops the local "recording" note. */
            onCancel={() => {
              setApplying(false);
              onDisarm(session.id);
            }}
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

/* ---------------------------------------------------------------------------
 * THE TEST RESULTS, RENDERED AS A REPORTED ~ FACT — NOT A GATE (#145; r2 FIX 2).
 *
 * The covenant: a machine's reading of the world is `~` until a human certifies it
 * a `✓`. A green "N passed · 0 failed" with no qualifier reads as that ✓ — a gate
 * the machine passed — which is exactly the claim-dressed-as-fact this ticket
 * exists to kill. So the block ALWAYS leads with an explicit reported-not-verified
 * marker (`~ reported by the session · not verified`), carries the test COMMAND as
 * provenance (what produced the numbers), and the pass count is never a bare green
 * pass standing on its own. The only ✓ in this pane is still the human's certify,
 * below; the test block may inform that judgement, never substitute for it.
 *
 * PRESENT (structured) → the marker, the pass/fail summary, and any failing names.
 * A present 0/0 block is an honest "ran, nothing to report". ABSENT → the legacy
 * scalar counts (also under the marker) if a producer carried them, else "no test
 * run recorded" — a different fact from a present-but-zero block.
 * ------------------------------------------------------------------------- */

/**
 * THE REPORTED-NOT-VERIFIED MARKER (#145 r2, FIX 2). The `~` glyph is the pane's
 * own chrome (system voice); the command, when present, is the harness's verbatim
 * provenance (file content). Rendering the two through their right doors is the
 * whole point — the label is what the page STATES, the command is what the machine
 * REPORTED, and neither is a certification.
 */
function ReportedMarker({ command }: { command?: string }) {
  return (
    <div className={styles.reported} data-tests-reported="true">
      <span className={styles.reportedTilde} aria-hidden="true">
        ~
      </span>
      <span className={styles.reportedLabel}>
        {systemText('reported by the session · not verified', 'ReviewPane tests provenance')}
      </span>
      {command === undefined ? null : (
        <span className={styles.reportedCommand} data-tests-command="true">
          {fileText(command, 'ReviewPane tests command')}
        </span>
      )}
    </div>
  );
}

function TestsView({ artifact }: { artifact: SessionArtifact | null }) {
  const tests = artifact?.tests;

  if (tests !== undefined) {
    return (
      <div data-tests="true" data-tests-structured="true">
        <ReportedMarker command={tests.command} />
        <span className={styles.v}>
          <span className={styles.pass} data-tests-passed={tests.passed}>
            {systemText(String(tests.passed), 'ReviewPane tests passed')} passed
          </span>
          {' · '}
          <span
            className={tests.failed > 0 ? styles.fail : styles.muted}
            data-tests-failed={tests.failed}
          >
            {systemText(String(tests.failed), 'ReviewPane tests failed')} failed
          </span>
        </span>
        {tests.failures.length > 0 ? (
          <ul className={styles.testFailures} data-tests-failures="true">
            {tests.failures.map((name, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; order is stable.
              <li key={i} className={styles.testFailure} data-test-failure="true">
                {fileText(name, 'ReviewPane failing test')}
              </li>
            ))}
            {tests.failuresTruncated ? (
              <li className={styles.muted} data-tests-failures-truncated="true">
                … and more, truncated
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    );
  }

  // No structured block. Fall back to the legacy scalars, else absent. The legacy
  // scalar pass count is held to the SAME covenant (#145 r2, FIX 2): it leads with
  // the reported marker too, so no green pass in this pane ever reads as a gate.
  if (artifact?.testsPassed !== undefined || artifact?.testsFailed !== undefined) {
    return (
      <div data-tests="true">
        <ReportedMarker />
        <span className={styles.v}>
          <span className={styles.pass} data-tests-passed={artifact?.testsPassed ?? 0}>
            {systemText(String(artifact?.testsPassed ?? 0), 'ReviewPane tests passed')} passed
          </span>
          {' · '}
          <span
            className={(artifact?.testsFailed ?? 0) > 0 ? styles.fail : styles.muted}
            data-tests-failed={artifact?.testsFailed ?? 0}
          >
            {systemText(String(artifact?.testsFailed ?? 0), 'ReviewPane tests failed')} failed
          </span>
        </span>
      </div>
    );
  }
  return (
    <span className={`${styles.diffState} ${styles.diffAbsent}`} data-tests-absent="true">
      no test run recorded
    </span>
  );
}
