'use client';

/* ---------------------------------------------------------------------------
 * The process TREE — agent → plan → session, pstree not a graph (scout §9).
 *
 * Three fixed levels, forever (§8): an agent owns plans, a plan groups sessions,
 * a session never spawns. Each row wears a status glyph, and every one of them
 * is DERIVED (state.ts → glyphFor) from real lifecycle state — a running session
 * is `·`, a failed one `✗`, a clean exit `✓`, a settled-awaiting-landing `■`;
 * a plan and an agent roll up the hardest thing beneath them. No glyph on this
 * tree is hand-set — and none of them is `✓` unless a HUMAN certified that
 * session. A clean exit is the process's own account of itself and reads `~`;
 * see state.ts for why that is the whole of the covenant rule.
 *
 * The cost chip beside a plan is the same burn-vs-budget the cost surface reads,
 * off the plan's own columns: draws against the enforced ceiling, dollars against
 * the `~` budget. An over-ceiling or unfunded plan wears the chip in red.
 * ------------------------------------------------------------------------- */

import type { ControlAgentRow, ControlSessionRow } from '@/lib/control-plane-data';
import { systemText } from '../model/quotation';
import { Glyph } from '../primitives/Glyph';
import styles from './control.module.css';
import {
  agentState,
  formatMicros,
  planCost,
  planState,
  sessionCertified,
  sessionState,
} from './state';

export interface ProcessTreeProps {
  readonly agents: readonly ControlAgentRow[];
  readonly openSessionId?: string;
  readonly onOpenSession: (sessionId: string) => void;
  /**
   * Whether the person reading is a HUMAN. It gates the room-wide "owed" a failed
   * session and an unlanded artifact carry: those are owed to any human (any human
   * may certify) but to no agent, so a non-human viewer sees the process glyph
   * without the second-person debt. Derived once in `ControlPlane` from `viewerKind`.
   */
  readonly viewerIsHuman: boolean;
}

function sessionSummary(session: ControlSessionRow): string {
  const parts: string[] = [session.harness];
  if (session.status !== 'open') parts.push(session.status);
  else parts.push('running');
  if (session.contextPct !== null) parts.push(`ctx ${Math.round(session.contextPct * 100)}%`);
  if (session.spendMicros > 0) parts.push(`${formatMicros(session.spendMicros)}`);
  return parts.join(' · ');
}

export function ProcessTree({
  agents,
  openSessionId,
  onOpenSession,
  viewerIsHuman,
}: ProcessTreeProps) {
  return (
    <section className={styles.tree} aria-label="Process tree" data-region="process-tree">
      <div className={styles.treeHead}>
        <span className="atr-lbl">PROCESS TREE</span>
        <span className="atr-meta">agent · plan · session</span>
      </div>

      {agents.length === 0 ? (
        <p className={styles.treeEmpty}>
          No agent has opened work in this room yet — the tree draws itself as work lands.
        </p>
      ) : (
        agents.map((agent) => (
          <div className={styles.agent} data-agent={agent.userId} key={agent.userId}>
            <div className={`${styles.row} ${styles.rowAgent}`} data-tree-agent={agent.userId}>
              <Glyph className={styles.rowGlyph} state={agentState(agent, viewerIsHuman)} />
              <span className={styles.rowMain}>
                <span className={`${styles.name} ${styles.nameAgent}`}>
                  {systemText(agent.name, 'ProcessTree agent')}
                </span>
                {agent.model === null ? null : (
                  <span className={styles.sub}>
                    {systemText(agent.model, 'ProcessTree agent model')}
                  </span>
                )}
              </span>
              <span className={styles.rowMeta}>
                <span className={styles.sub}>
                  {systemText(
                    agent.plans.length === 1 ? '1 plan' : `${agent.plans.length} plans`,
                    'ProcessTree plan count',
                  )}
                </span>
              </span>
            </div>

            {agent.plans.map((plan) => {
              const cost = planCost(plan);
              const drawsLabel =
                cost.draws.ceiling === null
                  ? `${cost.draws.used} draws · unfunded`
                  : `${cost.draws.used}/${cost.draws.ceiling} draws`;
              const chipClass = [
                styles.chip,
                cost.draws.overCeiling || (cost.draws.unfunded && cost.draws.used > 0)
                  ? styles.chipOver
                  : cost.dollars.over
                    ? styles.chipWarn
                    : null,
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div data-tree-plan={plan.id} key={plan.id}>
                  <div className={`${styles.row} ${styles.rowPlan}`}>
                    <Glyph className={styles.rowGlyph} state={planState(plan, viewerIsHuman)} />
                    <span className={styles.rowMain}>
                      <span className={styles.name}>
                        {systemText(plan.title, 'ProcessTree plan')}
                      </span>
                      {plan.status === 'settled' ? (
                        <span className={styles.sub}>settled</span>
                      ) : null}
                    </span>
                    <span className={styles.rowMeta}>
                      <span className={chipClass} data-plan-cost={plan.id}>
                        {systemText(drawsLabel, 'ProcessTree draws')}
                      </span>
                      <span className={styles.sub}>
                        {systemText(formatMicros(plan.spentMicros), 'ProcessTree spend')}
                      </span>
                    </span>
                  </div>

                  {plan.sessions.map((session) => (
                    <button
                      className={[
                        styles.row,
                        styles.rowSession,
                        session.id === openSessionId ? styles.rowSessionOpen : null,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-tree-session={session.id}
                      data-session-status={session.status}
                      key={session.id}
                      onClick={() => onOpenSession(session.id)}
                      type="button"
                    >
                      <Glyph
                        className={styles.rowGlyph}
                        state={sessionState(session, viewerIsHuman)}
                      />
                      <span className={styles.rowMain}>
                        <span className={styles.name}>
                          {systemText(session.model, 'ProcessTree session')}
                        </span>
                        <span className={styles.sub}>
                          {systemText(sessionSummary(session), 'ProcessTree session summary')}
                        </span>
                      </span>
                      <span className={styles.rowMeta}>
                        {/* The SAME predicate the row's glyph derives from. A
                            second test here — `certifiedByName !== null` — would
                            be a badge free to say "certified" beside a `~`. */}
                        {sessionCertified(session) ? (
                          <span className={styles.sub} data-session-certified={session.id}>
                            certified
                          </span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}
