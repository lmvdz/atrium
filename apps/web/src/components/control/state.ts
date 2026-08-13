/* ---------------------------------------------------------------------------
 * CONTROL-PLANE STATE — the process tree's glyphs, derived from real state.
 *
 * The whole product turns on one rule (design/CONVENTIONS.md, model/glyph.ts):
 * a glyph is derived from the data's provenance, never hand-set. The process
 * tree renders agent → plan → session with a status glyph on each, so this is
 * the single place a session's `status`, a plan's funding, and their rollups
 * become an `EpistemicState` — which `glyphFor` (and `<Glyph>`) then read. No
 * component in the tree picks a glyph, a tone, or a sort order; they read the
 * state this file derives.
 *
 * A session's lifecycle status is NON-EPISTEMIC (#114 T3) — it is process state,
 * not a covenant `~`/`✓`. But the seven-glyph vocabulary is exactly the alphabet
 * the operator already reads, so the tree speaks it: a failed process is `✗`
 * (unpaid attention, owed and sorted to the top), a running one is `·` (routine,
 * nothing owed), a clean exit is `✓`, and a settled session whose artifact still
 * needs a human to LAND it is `■` (needs you, and landing a merge is not
 * undoable). Those readings are mapped here, once.
 * ------------------------------------------------------------------------- */

import type { ControlAgentRow, ControlPlanRow, ControlSessionRow } from '@/lib/control-plane-data';
import type { EpistemicState } from '../model/glyph';
import { hardestState } from '../model/records';

/** A settled session carries an artifact a human has not yet certified. */
export function sessionAwaitsLanding(session: ControlSessionRow): boolean {
  return (
    session.status === 'settled' && session.artifact !== null && session.certifiedByName === null
  );
}

/**
 * A session's state, derived from its lifecycle status and whether its landing
 * is still owed. Order matters, and it is the same shape `glyphFor` uses:
 *
 *   failed   → ✗, and OWED — a dead process is unpaid attention (scout §18), so
 *              `owedToViewer` is true and it pins and sorts above everything.
 *   settled + artifact + uncertified → ■, OWED and irreversible: a human must
 *              land it, and landing is not undoable (scout §9.5's armed merge).
 *   settled (certified, or no artifact to land) → ✓, a clean exit.
 *   open     → ·, routine: a running session owes nobody anything.
 */
export function sessionState(session: ControlSessionRow): EpistemicState {
  if (session.status === 'failed') {
    return { kind: 'event', verification: 'failed', owedToViewer: true, irreversible: false };
  }
  if (sessionAwaitsLanding(session)) {
    return { kind: 'decision', verification: 'proposed', owedToViewer: true, irreversible: true };
  }
  if (session.status === 'settled') {
    return {
      kind: 'commitment',
      verification: 'verified',
      owedToViewer: false,
      irreversible: false,
    };
  }
  return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
}

/**
 * A plan's state: the hardest of its sessions' states — a plan rolls its
 * children up (scout §9.4, "a needs-you propagates to every ancestor"). A plan
 * with no sessions yet reads from its own lifecycle status: a settled plan is a
 * clean exit (`✓`), an open one is routine (`·`).
 */
export function planState(plan: ControlPlanRow): EpistemicState {
  const childStates = plan.sessions.map(sessionState);
  const hardest = hardestState(childStates.map((state) => ({ state })));
  if (hardest !== null) return hardest;
  if (plan.status === 'settled') {
    return {
      kind: 'commitment',
      verification: 'verified',
      owedToViewer: false,
      irreversible: false,
    };
  }
  return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
}

/** An agent's state: the hardest of every session across all its plans. */
export function agentState(agent: ControlAgentRow): EpistemicState {
  const sessionStates = agent.plans.flatMap((plan) =>
    plan.sessions.map((session) => ({ state: sessionState(session) })),
  );
  const hardest = hardestState(sessionStates);
  if (hardest !== null) return hardest;
  return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
}

/* ── cost: burn vs budget, derived from `plans` columns (#118) ────────────── */

/**
 * A plan's burn against its budget, in BOTH denominations `plans` carries:
 *
 *   draws   — the ENFORCED ceiling. `authorized_draws` vs `rlimit_slice`. A null
 *             slice is UNFUNDED: a ceiling of zero (#118), so any draw is over.
 *   dollars — the `~` reconciliation layer. `spent_micros` vs
 *             `budget_limit_micros`. Structurally separate from enforcement
 *             (#118): a divergence is a row that won't balance, surfaced, never
 *             a gate. Shown, not enforced.
 *
 * Neither number is invented — all four are columns on the plan row.
 */
export interface PlanCost {
  readonly draws: {
    readonly used: number;
    readonly ceiling: number | null;
    readonly unfunded: boolean;
    readonly overCeiling: boolean;
  };
  readonly dollars: {
    readonly spentMicros: number;
    readonly budgetMicros: number | null;
    readonly over: boolean;
  };
  /** True when either denomination is out of balance — the plan owes a look. */
  readonly warn: boolean;
}

export function planCost(plan: ControlPlanRow): PlanCost {
  const unfunded = plan.rlimitSlice === null;
  const overCeiling = plan.rlimitSlice !== null && plan.authorizedDraws > plan.rlimitSlice;
  const dollarsOver = plan.budgetLimitMicros !== null && plan.spentMicros > plan.budgetLimitMicros;
  return {
    draws: {
      used: plan.authorizedDraws,
      ceiling: plan.rlimitSlice,
      unfunded,
      overCeiling,
    },
    dollars: {
      spentMicros: plan.spentMicros,
      budgetMicros: plan.budgetLimitMicros,
      over: dollarsOver,
    },
    warn: overCeiling || dollarsOver || (unfunded && plan.authorizedDraws > 0),
  };
}

/** Micro-dollars as a short `$1.80` string. Whole cents; the tree is not a ledger. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
