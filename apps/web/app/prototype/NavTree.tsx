'use client';

/* NAV TREE — the process tree (agent → plan → session). State reads from
   indentation + connector colour (green selected / amber drift), not rails.
   Selecting a node is what molds the center — no mode is typed.

   #151 marriage table: NavTree is **keep design CSS, bind shipped data** (#154).
   The shell is the design's; the data is the REAL control plane. This component
   reads `ControlPlaneData` (`lib/control-plane-data.ts`) and derives every cost
   and glyph through the shipped `control/state.ts` selectors — `planCost`,
   `formatMicros`, and, for the covenant `✓`, `sessionCertified` — exactly as the
   plain `ProcessTree.tsx` does. Nothing on this tree is hand-set:

     * the `✓` badge is `sessionCertified(session)` and NOTHING else — a human
       signature through the one predicate, never a client boolean. Flip a part
       of the receipt and the tick drops to nothing, which is what makes it
       derived rather than merely true today.
     * a session's branch is `session.artifact?.branch` — the branch the work
       LANDED on. A session with no settled artifact shows NO branch rather than
       a fabricated one.
     * `ageMin` is `now − createdAt` (the read model carries no age column).
     * every string the tree prints is the page's own voice, through
       `systemText` — the same door `ProcessTree.tsx` routes its rows through, so
       the printed-strings covenant guard traces the tree's cells to a checked
       source instead of an untraced mock. */

import { useState } from 'react';
import type { ControlPlaneData, ControlSessionRow } from '@/lib/control-plane-data';
import { formatMicros, planCost, sessionCertified } from '@/src/components/control/state';
import { systemText } from '@/src/components/model/quotation';
import { IconCheck, IconChevron, IconDot, IconWarn } from './icons';
import { ProviderMark } from './ProviderMark';
import styles from './prototype.module.css';
import type { Selection } from './types';

/* The live session — the one whose diff the (still-mock, #159) stream animates.
   Keyed by id, the same id the conversation/peripheral seams select against, so
   binding the tree did not move the live thread. */
const LIVE_SESSION_ID = 's-live';

/* The branch the work landed on, or null — NEVER fabricated. The read model
   surfaces a branch only through the settled artifact (`SessionArtifact.branch`,
   #145), so an open session with no artifact has no branch to show. */
function branchOf(session: ControlSessionRow): string | null {
  const branch = session.artifact?.branch;
  return typeof branch === 'string' && branch.trim().length > 0 ? branch : null;
}

/* Minutes since the session was opened, against the projection instant — the
   read model carries no age column, so age is derived, and from a single stable
   reference (never `Date.now()`, which tears between SSR and hydration). */
function ageMinOf(session: ControlSessionRow, nowIso: string): number {
  const created = Date.parse(session.createdAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round((now - created) / 60_000));
}

export function NavTree({
  data,
  selected,
  onSelect,
  concern,
}: {
  data: ControlPlaneData;
  selected: Selection;
  onSelect: (s: Selection) => void;
  /* The live session wears a "needs you" alert when the (still-mock, #159)
     stream surfaces a concern — derived in the composer and handed down. */
  concern: boolean;
}) {
  const agents = data.agents;
  const roomName = data.room.name;
  const now = data.updatedAt;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (k: string) =>
    setCollapsed((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const inCall = ['EB', 'OP'];
  const on = (kind: Selection['kind'], id: string) => selected.kind === kind && selected.id === id;

  /* The flat list of VISIBLE nodes, in render order, for single-tab-stop arrow
     nav. ↑↓ move selection (which also molds the chat/graph), ←→ collapse/expand
     or step to parent/child, enter focuses. */
  interface FlatNode {
    sel: Selection;
    key: string;
    hasChildren: boolean;
    expanded: boolean;
    parentKey: string | null;
  }
  const flat: FlatNode[] = [];
  for (const agent of agents) {
    const aKey = `agent:${agent.userId}`;
    const aOpen = !collapsed.has(agent.userId);
    flat.push({
      sel: { kind: 'agent', id: agent.userId },
      key: aKey,
      hasChildren: agent.plans.length > 0,
      expanded: aOpen,
      parentKey: null,
    });
    if (!aOpen) continue;
    for (const plan of agent.plans) {
      const pKey = `plan:${plan.id}`;
      const pOpen = !collapsed.has(plan.id);
      flat.push({
        sel: { kind: 'plan', id: plan.id },
        key: pKey,
        hasChildren: plan.sessions.length > 0,
        expanded: pOpen,
        parentKey: aKey,
      });
      if (!pOpen) continue;
      for (const s of plan.sessions) {
        flat.push({
          sel: { kind: 'session', id: s.id },
          key: `session:${s.id}`,
          hasChildren: false,
          expanded: false,
          parentKey: pKey,
        });
      }
    }
  }
  const curIdx = flat.findIndex((n) => n.key === `${selected.kind}:${selected.id}`);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (flat.length === 0) return;
    const i = curIdx < 0 ? 0 : curIdx;
    const node = flat[i];
    if (!node) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        onSelect(flat[Math.min(i + 1, flat.length - 1)]?.sel ?? node.sel);
        break;
      case 'ArrowUp':
        e.preventDefault();
        onSelect(flat[Math.max(i - 1, 0)]?.sel ?? node.sel);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (node.hasChildren && !node.expanded) toggle(node.sel.id);
        else if (node.hasChildren && node.expanded && i + 1 < flat.length)
          onSelect(flat[i + 1]!.sel);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (node.hasChildren && node.expanded) toggle(node.sel.id);
        else if (node.parentKey) {
          const p = flat.find((n) => n.key === node.parentKey);
          if (p) onSelect(p.sel);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(node.sel);
        break;
      default:
        break;
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: single-tab-stop tree pattern
    <nav
      className={styles.nav}
      aria-label="agents, plans and sessions"
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {agents.map((agent) => {
        const aOpen = !collapsed.has(agent.userId);
        const spend = agent.plans.reduce((s, p) => s + p.spentMicros, 0);
        return (
          <div key={agent.userId}>
            <div
              className={`${styles.navRow} ${styles.tAgent} ${on('agent', agent.userId) ? styles.navOn : ''}`}
            >
              <button
                className={styles.twisty}
                type="button"
                onClick={() => toggle(agent.userId)}
                aria-label={aOpen ? 'collapse' : 'expand'}
              >
                <IconChevron open={aOpen} />
              </button>
              <button
                className={styles.navMain}
                type="button"
                onClick={() => onSelect({ kind: 'agent', id: agent.userId })}
              >
                <span className={styles.tGlyphAgent}>
                  {agent.model !== null ? (
                    <ProviderMark model={agent.model} />
                  ) : (
                    <IconDot size={9} />
                  )}
                </span>
                <span className={styles.tName}>{systemText(agent.name, 'NavTree agent name')}</span>
                <span className={styles.tHandle}>
                  {systemText(`@${agent.name}`, 'NavTree agent handle')}
                </span>
                <span className={styles.grow} />
                <span className={styles.tDim}>
                  {systemText(formatMicros(spend), 'NavTree agent spend')}
                </span>
                <span className={styles.tRoom}>#{systemText(roomName, 'NavTree agent room')}</span>
              </button>
            </div>

            {aOpen
              ? agent.plans.map((plan) => {
                  const pOpen = !collapsed.has(plan.id);
                  const cost = planCost(plan);
                  const unfunded = cost.draws.unfunded;
                  const over = cost.draws.overCeiling;
                  const drawsLabel = unfunded
                    ? `${cost.draws.used} draws · unfunded`
                    : `${cost.draws.used}/${cost.draws.ceiling} draws`;
                  const costLabel =
                    cost.dollars.budgetMicros !== null
                      ? `${formatMicros(cost.dollars.spentMicros)} / ${formatMicros(cost.dollars.budgetMicros)}`
                      : formatMicros(cost.dollars.spentMicros);
                  return (
                    <div key={plan.id}>
                      <div
                        className={`${styles.navRow} ${styles.tPlan} ${on('plan', plan.id) ? styles.navOn : ''}`}
                      >
                        <button
                          className={styles.twisty}
                          type="button"
                          onClick={() => toggle(plan.id)}
                          aria-label={pOpen ? 'collapse' : 'expand'}
                        >
                          <IconChevron open={pOpen} />
                        </button>
                        <button
                          className={styles.navMain}
                          type="button"
                          onClick={() => onSelect({ kind: 'plan', id: plan.id })}
                        >
                          <span className={styles.mark}>~</span>
                          <span className={styles.tName}>
                            {systemText(plan.title, 'NavTree plan title')}
                          </span>
                          <span
                            className={`${styles.chip} ${over || unfunded ? styles.chipWarn : ''}`}
                          >
                            {systemText(drawsLabel, 'NavTree plan draws')}
                          </span>
                          <span className={styles.grow} />
                          <span className={styles.tDim}>
                            {systemText(costLabel, 'NavTree plan cost')}
                          </span>
                        </button>
                      </div>

                      {pOpen ? (
                        <div className={styles.tSessionGroup}>
                          {plan.sessions.map((session) => {
                            const liveHexi = session.id === LIVE_SESSION_ID;
                            const running = session.status === 'open';
                            const certified = sessionCertified(session);
                            const needsYou = liveHexi && concern;
                            const branch = branchOf(session);
                            /* The REAL lifecycle status, in the shipped tree's
                               vocabulary (`ProcessTree.sessionSummary`): an open
                               session reads "running". The live-activity PHASE
                               overlay ("writing"/"reading") is the mock stream's
                               narration and belongs to #159 (out of scope); the
                               live session's activeness stays legible through the
                               pulsing run-dot and in-call faces below. */
                            const statusLabel = running ? 'running' : session.status;
                            const sub = [
                              statusLabel,
                              session.contextPct !== null
                                ? `ctx ${Math.round(session.contextPct * 100)}%`
                                : null,
                              formatMicros(session.spendMicros),
                              `${ageMinOf(session, now)}m`,
                              certified ? 'certified' : null,
                            ]
                              .filter((part): part is string => part !== null)
                              .join(' · ');
                            return (
                              <button
                                key={session.id}
                                type="button"
                                className={[
                                  styles.navRow,
                                  styles.tSession,
                                  on('session', session.id) ? styles.navOn : '',
                                  needsYou ? styles.navAlert : '',
                                ].join(' ')}
                                onClick={() => onSelect({ kind: 'session', id: session.id })}
                              >
                                <span className={styles.tSessionMain}>
                                  {needsYou ? (
                                    <span className={styles.warnGlyph} aria-hidden>
                                      <IconWarn />
                                    </span>
                                  ) : certified ? (
                                    <span className={styles.markOk} title="human-certified">
                                      <IconCheck />
                                    </span>
                                  ) : running ? (
                                    <span
                                      className={`${styles.tRunDot} atr-pulse`}
                                      aria-hidden
                                      title="running"
                                    />
                                  ) : (
                                    <span className={styles.tGlyphIdle} aria-hidden>
                                      <IconDot size={6} />
                                    </span>
                                  )}
                                  {branch !== null ? (
                                    <span className={styles.branch}>
                                      {systemText(branch, 'NavTree session branch')}
                                    </span>
                                  ) : null}
                                  {liveHexi ? (
                                    <span className={styles.tCall} title="in the call">
                                      {inCall.map((p) => (
                                        <span key={p} className={styles.tCallFace}>
                                          {p}
                                        </span>
                                      ))}
                                    </span>
                                  ) : null}
                                </span>
                                <span className={styles.tSub}>
                                  {systemText(sub, 'NavTree session summary')}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </nav>
  );
}
