'use client';

/* ---------------------------------------------------------------------------
 * The PLAN pane — FUND (set_plan_rlimit) and SETTLE (settle_plan), the two
 * plan-level acts #140's run-book needs and #121 never built.
 *
 * ## Funding is a human-only SPEND act, and it goes through the command path
 *
 * Raising a plan's slice authorizes draws — spawns and continues — against it. It
 * is a human-only class (#115/#118): the server refuses a non-human
 * `set_plan_rlimit` BEFORE the append, exactly as a machine trying to certify is
 * refused. This pane does NOT re-implement that check and does NOT write
 * `rlimit_slice` directly; it issues the `set_plan_rlimit` COMMAND over the
 * authenticated socket (`issueRoomCommand`), so the server's single enforcement
 * path is what makes a machine reaching this act impossible — by construction,
 * not by a second copy of the gate. The control is offered only to a human viewer
 * and the affordance carries the weight the covenant gives spend: a deliberate
 * press-and-hold over a chosen number of draws, not a stray click. It is NOT the
 * certify pane's server-timed arm→confirm — funding is not certifying — but it is
 * a real elapsed-time hold, so a slip cannot spend.
 *
 * ## Settling is an act, legal only when every child has exited (#119)
 *
 * `settle_plan` closes a plan to a receipt that indexes its sessions' receipts, so
 * it may not run while a child session is still open — the projection refuses it,
 * and the DB trigger backstops it (drizzle/0031). It is an OPEN-class command, not
 * human-only: the daemon issues it in steady state (#139, unbuilt), and a human
 * issues it here for the run-book's first, daemon-less runs. The control is shown
 * only when the plan is open and settle-legal, so a human is never handed a settle
 * the server would only nack; a plan with an open child shows WHY it cannot settle
 * yet rather than an armed control.
 * ------------------------------------------------------------------------- */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlanRow } from '@/lib/control-plane-data';
import { issueRoomCommand } from '@/lib/room-command';
import type { ParticipantKind } from '../model/kind';
import { systemText } from '../model/quotation';
import { Glyph } from '../primitives/Glyph';
import { HoldToAct } from '../primitives/HoldToAct';
import styles from './control.module.css';
import { formatMicros, planCost, planSettleable, planState } from './state';

/** The client-side friction on a spend/settle act. Deliberate, not server-timed. */
const PLAN_ACT_HOLD_MS = 1500;

export interface PlanPaneProps {
  readonly plan: ControlPlanRow | null;
  readonly agentName: string | null;
  /** The room the plan lives in — the `set_plan_rlimit`/`settle_plan` command target. */
  readonly roomId: string;
  /** The person reading — the actor a hold records. */
  readonly viewerId: string;
  /** server-resolved; funding is offered only when this is `human`. */
  readonly viewerKind: ParticipantKind | 'unknown';
}

type ActState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'working' }
  | { readonly phase: 'error'; readonly message: string };

function friendlyOutcomeMessage(code: string, message: string): string {
  /* The server's refusal sentences are already system voice — show them verbatim.
     A transport failure gets a plain, honest retry line instead of a raw socket
     error the operator cannot act on. */
  if (code === 'unreachable') {
    return 'the server could not be reached — check the connection and try again';
  }
  return message;
}

export function PlanPane({ plan, agentName, roomId, viewerId, viewerKind }: PlanPaneProps) {
  const router = useRouter();
  const [fund, setFund] = useState<ActState>({ phase: 'idle' });
  const [settle, setSettle] = useState<ActState>({ phase: 'idle' });

  /* The slice to authorize, as a controlled input. Held in a ref too so the hold's
     `onAct` — captured when the hold began — reads the number as it stands at the
     moment of the act, not a stale closure. */
  const [sliceInput, setSliceInput] = useState<string>('');
  const sliceRef = useRef<number>(0);

  const planId = plan?.id ?? null;
  const currentSlice = plan?.rlimitSlice ?? null;
  const usedDraws = plan?.authorizedDraws ?? 0;

  // A new plan resets the pane: a suggested slice, cleared act states.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keys off the plan identity, not every column.
  useEffect(() => {
    setFund({ phase: 'idle' });
    setSettle({ phase: 'idle' });
    /* Suggest a slice that funds at least one draw beyond what has already been
       drawn — the common act is "give this plan room to work", not "set it to
       exactly what it has spent". Falls back to the current ceiling when one is
       set and already ample. */
    const suggested = Math.max(currentSlice ?? 0, usedDraws + 1, 1);
    setSliceInput(String(suggested));
    sliceRef.current = suggested;
  }, [planId]);

  if (plan === null) {
    return (
      <div className={styles.review} data-region="plan-pane">
        <div className={styles.reviewEmpty}>
          <span className="atr-lbl">PLAN</span>
          <span>
            Select a plan in the tree — or an owed-funding item on the pin — to fund or settle it.
          </span>
        </div>
      </div>
    );
  }

  const cost = planCost(plan);
  const state = planState(plan, viewerKind === 'human');
  const viewerIsHuman = viewerKind === 'human';
  const settleable = planSettleable(plan);
  const openChildCount = plan.sessions.filter((session) => session.status === 'open').length;

  const drawsLabel =
    cost.draws.ceiling === null
      ? `${cost.draws.used} draws · unfunded`
      : `${cost.draws.used}/${cost.draws.ceiling} draws`;

  const runFund = async () => {
    const slice = sliceRef.current;
    if (!Number.isInteger(slice) || slice < 0) {
      setFund({ phase: 'error', message: 'a slice is a whole, non-negative number of draws' });
      return;
    }
    setFund({ phase: 'working' });
    const outcome = await issueRoomCommand({
      name: 'set_plan_rlimit',
      roomId,
      planId: plan.id,
      slice,
    });
    if (outcome.ok) {
      setFund({ phase: 'idle' });
      router.refresh();
    } else {
      setFund({ phase: 'error', message: friendlyOutcomeMessage(outcome.code, outcome.message) });
    }
  };

  const runSettle = async () => {
    setSettle({ phase: 'working' });
    const outcome = await issueRoomCommand({ name: 'settle_plan', roomId, planId: plan.id });
    if (outcome.ok) {
      setSettle({ phase: 'idle' });
      router.refresh();
    } else {
      setSettle({ phase: 'error', message: friendlyOutcomeMessage(outcome.code, outcome.message) });
    }
  };

  return (
    <div className={styles.review} data-region="plan-pane" data-plan-pane={plan.id}>
      <div className={styles.reviewHead}>
        <Glyph state={state} />
        <span className={styles.reviewTitle}>{systemText(plan.title, 'PlanPane title')}</span>
        <span className="atr-meta">{systemText(plan.status, 'PlanPane status')}</span>
      </div>
      <span className="atr-meta">
        {systemText(`${agentName ?? 'agent'} · plan`, 'PlanPane provenance')}
      </span>

      {/* ── COST ─────────────────────────────────────────────────────────── */}
      <section className={styles.section} data-plan-cost-section="true">
        <div className={`${styles.sectionHead} atr-lbl`}>COST · BURN VS BUDGET</div>
        <div className={styles.sectionBody}>
          <div className={styles.kv}>
            <span className={styles.k}>draws</span>
            <span className={styles.v} data-plan-pane-draws={drawsLabel}>
              {systemText(drawsLabel, 'PlanPane draws')}
            </span>
          </div>
          {cost.draws.refused > 0 ? (
            <div className={styles.kv}>
              <span className={styles.k}>refused</span>
              <span
                className={`${styles.v} ${styles.fail}`}
                data-plan-pane-refused={cost.draws.refused}
              >
                {systemText(
                  `${cost.draws.refused} ${cost.draws.refused === 1 ? 'draw' : 'draws'} refused — the slice as it stands is spent`,
                  'PlanPane refused',
                )}
              </span>
            </div>
          ) : null}
          <div className={styles.kv}>
            <span className={styles.k}>spend</span>
            <span className={styles.v}>
              {systemText(
                plan.budgetLimitMicros === null
                  ? `${formatMicros(plan.spentMicros)} spent`
                  : `${formatMicros(plan.spentMicros)} / ${formatMicros(plan.budgetLimitMicros)}`,
                'PlanPane spend',
              )}
            </span>
          </div>
        </div>
      </section>

      {/* ── FUND ─────────────────────────────────────────────────────────── */}
      {plan.status === 'settled' ? (
        <div className={styles.refused} data-fund="settled">
          {systemText(
            'this plan has settled — its budget is frozen and its slice can no longer be set',
            'PlanPane fund settled',
          )}
        </div>
      ) : !viewerIsHuman ? (
        <div className={styles.refused} data-fund="refused" data-fund-refused="true">
          {systemText(
            "funding a plan sets its spend ceiling, and only a person may — the server refuses a non-human identity (human = init). A machine cannot raise its own or any plan's slice, and neither the command path nor the table will let it.",
            'PlanPane fund refused',
          )}
        </div>
      ) : (
        <div className={`${styles.fund}`} data-fund="ready">
          <span className={`${styles.certifyHead} atr-lbl`}>FUND THIS PLAN</span>
          <span className={styles.certifyNote}>
            {systemText(
              `Funding sets the plan's slice — the ceiling on the draws (spawns and continues) Atrium will authorize against it. ${
                currentSlice === null
                  ? 'It is unfunded, so nothing can spawn until you set a slice.'
                  : `Its slice is ${currentSlice}; ${cost.draws.used} ${cost.draws.used === 1 ? 'draw has' : 'draws have'} been granted.`
              } The count Atrium enforces is granted draws, never the reported spend. Press and hold to authorize.`,
              'PlanPane fund note',
            )}
          </span>
          <label className={styles.sliceRow}>
            <span className={`${styles.k} atr-lbl`}>SLICE · DRAWS</span>
            <input
              className={styles.sliceInput}
              data-fund-slice-input="true"
              inputMode="numeric"
              min={0}
              onChange={(event) => {
                setSliceInput(event.target.value);
                const parsed = Number.parseInt(event.target.value, 10);
                sliceRef.current = Number.isNaN(parsed) ? Number.NaN : parsed;
                if (fund.phase === 'error') setFund({ phase: 'idle' });
              }}
              step={1}
              type="number"
              value={sliceInput}
            />
          </label>
          <HoldToAct
            actionId={`fund-${plan.id}`}
            actor={viewerId}
            className={styles.fundHold}
            describe={`authorize the plan's slice — ${sliceInput || '0'} draws of spend`}
            holdMs={PLAN_ACT_HOLD_MS}
            label="Authorize funding"
            onAct={() => {
              void runFund();
            }}
          />
          {fund.phase === 'working' ? (
            <span className={styles.certifyNote} data-fund-working="true">
              recording the funding…
            </span>
          ) : null}
          {fund.phase === 'error' ? (
            <span className={styles.error} data-fund-error="true">
              {systemText(fund.message, 'PlanPane fund error')}
            </span>
          ) : null}
        </div>
      )}

      {/* ── SETTLE ───────────────────────────────────────────────────────── */}
      {plan.status === 'settled' ? (
        <div className={styles.certified} data-settle="settled">
          <span>
            {systemText(
              'settled — the plan is closed to a receipt indexing its sessions',
              'PlanPane settle settled',
            )}
          </span>
        </div>
      ) : settleable ? (
        <div className={styles.settle} data-settle="ready">
          <span className={`${styles.certifyHead} atr-lbl`}>SETTLE THIS PLAN</span>
          <span className={styles.certifyNote}>
            {systemText(
              'Every session has exited, so this plan may settle: it closes to a receipt that indexes its sessions, and a settled plan cannot be reopened or refunded. Press and hold to settle.',
              'PlanPane settle note',
            )}
          </span>
          <HoldToAct
            actionId={`settle-${plan.id}`}
            actor={viewerId}
            className={styles.settleHold}
            describe="settle this plan to a receipt indexing its sessions"
            holdMs={PLAN_ACT_HOLD_MS}
            label="Settle this plan"
            onAct={() => {
              void runSettle();
            }}
          />
          {settle.phase === 'working' ? (
            <span className={styles.certifyNote} data-settle-working="true">
              settling the plan…
            </span>
          ) : null}
          {settle.phase === 'error' ? (
            <span className={styles.error} data-settle-error="true">
              {systemText(settle.message, 'PlanPane settle error')}
            </span>
          ) : null}
        </div>
      ) : (
        <div className={styles.refused} data-settle="blocked" data-settle-blocked="true">
          {systemText(
            `this plan has ${openChildCount} open ${openChildCount === 1 ? 'session' : 'sessions'} and cannot settle yet — every session must settle or fail first, so the plan's receipt can index its children's receipts (#119).`,
            'PlanPane settle blocked',
          )}
        </div>
      )}
    </div>
  );
}
