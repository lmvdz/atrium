'use client';

/* NAV TREE — the process tree (agent → plan → session). State reads from
   indentation + connector colour (green selected / amber drift), not rails.
   Selecting a node is what molds the center — no mode is typed.

   #151 marriage table: NavTree is **keep design CSS, bind shipped data** (#154).
   The shell is the design's; the `AGENTS` mock behind `treeAgents()` is the seam
   #154 replaces with `ControlPlaneData` / `ProcessTree` / `state.ts` selectors. */

import { useState } from 'react';
import { IconCheck, IconChevron, IconDot, IconWarn } from './icons';
import { ProviderMark } from './ProviderMark';
import styles from './prototype.module.css';
import { fmtMicros, type StreamState, treeAgents } from './seams';
import { PHASE_LABEL, type Selection } from './types';

export function NavTree({
  stream,
  selected,
  onSelect,
  concern,
}: {
  stream: StreamState;
  selected: Selection;
  onSelect: (s: Selection) => void;
  concern: boolean;
}) {
  // SEAM(#154): bind to real source — the ledger's agents/plans/sessions.
  const AGENTS = treeAgents();
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
  for (const agent of AGENTS) {
    const aKey = `agent:${agent.id}`;
    const aOpen = !collapsed.has(agent.id);
    flat.push({
      sel: { kind: 'agent', id: agent.id },
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
      {AGENTS.map((agent) => {
        const aOpen = !collapsed.has(agent.id);
        const spend = agent.plans.reduce((s, p) => s + p.spentMicros, 0);
        return (
          <div key={agent.id}>
            <div
              className={`${styles.navRow} ${styles.tAgent} ${on('agent', agent.id) ? styles.navOn : ''}`}
            >
              <button
                className={styles.twisty}
                type="button"
                onClick={() => toggle(agent.id)}
                aria-label={aOpen ? 'collapse' : 'expand'}
              >
                <IconChevron open={aOpen} />
              </button>
              <button
                className={styles.navMain}
                type="button"
                onClick={() => onSelect({ kind: 'agent', id: agent.id })}
              >
                <span className={styles.tGlyphAgent}>
                  <ProviderMark model={agent.model} />
                </span>
                <span className={styles.tName}>{agent.name}</span>
                <span className={styles.tHandle}>@{agent.name}</span>
                <span className={styles.grow} />
                <span className={styles.tDim}>{fmtMicros(spend)}</span>
                <span className={styles.tRoom}>#{agent.room}</span>
              </button>
            </div>

            {aOpen
              ? agent.plans.map((plan) => {
                  const pOpen = !collapsed.has(plan.id);
                  const unfunded = plan.drawsCeiling === null;
                  const over = plan.drawsCeiling !== null && plan.drawsUsed > plan.drawsCeiling;
                  const draws = unfunded
                    ? `${plan.drawsUsed} draws · unfunded`
                    : `${plan.drawsUsed}/${plan.drawsCeiling} draws`;
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
                          <span className={styles.tName}>{plan.title}</span>
                          <span
                            className={`${styles.chip} ${over || unfunded ? styles.chipWarn : ''}`}
                          >
                            {draws}
                          </span>
                          <span className={styles.grow} />
                          <span className={styles.tDim}>
                            {fmtMicros(plan.spentMicros)}
                            {plan.budgetMicros !== null ? ` / ${fmtMicros(plan.budgetMicros)}` : ''}
                          </span>
                        </button>
                      </div>

                      {pOpen ? (
                        <div className={styles.tSessionGroup}>
                          {plan.sessions.map((session) => {
                            const liveHexi = session.id === 's-live';
                            const running = session.status === 'running';
                            const needsYou = liveHexi && concern;
                            const statusLabel = liveHexi
                              ? (PHASE_LABEL[stream.phase] ?? stream.phase)
                              : session.status;
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
                                  ) : session.certified ? (
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
                                  <span className={styles.branch}>{session.branch}</span>
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
                                  {statusLabel}
                                  {session.ctxPct !== null
                                    ? ` · ctx ${Math.round(session.ctxPct * 100)}%`
                                    : ''}
                                  {` · ${fmtMicros(session.spendMicros)} · ${session.ageMin}m`}
                                  {session.certified ? ' · certified' : ''}
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
