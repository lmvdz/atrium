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
 * nothing owed), and a settled session whose artifact still needs a human is `■`
 * (needs you, and certifying is not undoable). Those readings are mapped here.
 *
 * ## THE TICK IS THE COVENANT'S, AND IT IS NOT ON LOAN TO A PROCESS
 *
 * This file shipped `status === 'settled' → verification: 'verified'`, so a
 * process that exited cleanly and that NO PERSON had ever looked at rendered `✓`
 * — in the tree, in the pin's rollup, in the review pane's header, and in every
 * plan and agent that rolled it up. The glyph whose tooltip reads "certified — a
 * person has accepted this reading" was being minted by a subprocess reporting
 * its own exit code. That is the exact claim-dressed-as-fact the whole product
 * exists to refuse, and it was one string literal, invisible to typecheck.
 *
 * The rule, stated once: **`✓` derives from a human certification and from
 * nothing else.** A settled session nobody has signed is the machine's own
 * account of its own exit — `self_reported`, which renders `~`, whose tooltip
 * already says "the claimant's own account, nothing has checked it". That is
 * precisely what a green exit code is.
 *
 * And the signature is not taken on trust either: the certifier's principal kind
 * travels with it from the read model, and the tick is minted by
 * `epistemicStateFromAcceptance` — @atrium/core's ONE predicate, the same
 * function the reducer's gate and every other rendered `✓` go through. A mutation
 * of `epistemicStateOf` moves this glyph too, which is what makes it derived
 * rather than merely correct today.
 * ------------------------------------------------------------------------- */

import { epistemicStateFromAcceptance } from '@atrium/core';
import type {
  ControlAgentRow,
  ControlDecisionRow,
  ControlPlanRow,
  ControlSessionRow,
} from '@/lib/control-plane-data';
import type { EpistemicState } from '../model/glyph';
import { hardestState } from '../model/records';

/**
 * Has a HUMAN certified this session — through the one predicate.
 *
 * `epistemicStateFromAcceptance` is the same function `locallyAcceptedState`
 * (replay) and the reducer's gate call go through, so there is one definition of
 * "a person took this" in the product rather than a second one spelled
 * `certifiedByName !== null` here.
 *
 * The second argument is `null` DELIBERATELY. `humanTouchedAt` is the predicate's
 * corrected-by-a-person clause, and a session has no correction path — it has one
 * signature or none — so passing `certifiedAt` would be handing the predicate a
 * timestamp that is written for a certifier of ANY kind, which is the OR branch
 * that would let a machine's name confirm. The only question here is whether the
 * principal who signed is a person, and that is the argument the answer comes
 * from.
 *
 * A name with an unreadable or non-human kind is therefore NOT a certification.
 * Two DB triggers make such a row unwritable (0032, 0033) — this is what the
 * render does if one ever is.
 *
 * ## A `✓` REQUIRES A COMPLETE RECEIPT, NOT A NAME (CS-2)
 *
 * The human triggers (0032/0033) refuse a non-human name, but nothing stopped
 * `UPDATE sessions SET certified_by = <a human uuid>` on its own — arm, held-ms
 * and `certified_at` all left null. The humanity trigger accepts that row, and a
 * render that read name + kind alone minted `✓` from it: a certification with no
 * hold. So the render fails CLOSED on an incomplete receipt — every part of the
 * hold must be present (armed, held, stamped, signed) or this is `~`, the same
 * way an unreadable kind is. A DB backstop (drizzle/0035) refuses to WRITE the
 * partial row; this is the render's own refusal to trust one if it ever appears.
 */
export function sessionCertified(session: ControlSessionRow): boolean {
  if (session.certifiedByName === null || session.certifiedByKind === null) return false;
  /* The whole receipt or nothing. A `certified_by` without the arm that produced
     it, the duration it measured, or the moment it was stamped is not a hold — and
     `✓` is the glyph for a held human signature, not for a name in a column. */
  if (
    session.certifyArmedAt === null ||
    session.certifiedHeldMs === null ||
    session.certifiedAt === null
  ) {
    return false;
  }
  return epistemicStateFromAcceptance(session.certifiedByKind, null) === 'confirmed';
}

/** A settled session carries an artifact no human has certified yet. */
export function sessionAwaitsLanding(session: ControlSessionRow): boolean {
  return session.status === 'settled' && session.artifact !== null && !sessionCertified(session);
}

/**
 * A session's state. Order matters, and it is the same shape `glyphFor` uses:
 *
 *   failed    → ✗, and OWED to a human — a dead process is unpaid attention
 *               (scout §18), so `owedToViewer` is true FOR A HUMAN VIEWER and it
 *               pins and sorts above everything.
 *   settled + artifact + UNCERTIFIED → ■, OWED to a human and irreversible: a
 *               human must sign it, and a certification is written once
 *               (drizzle/0033).
 *   CERTIFIED → ✓, and only here. A person put their name on it.
 *   settled, uncertified, nothing to certify → `~`: the process says it exited
 *               cleanly, and the process is the claimant.
 *   open      → ·, routine: a running session owes nobody anything.
 *
 * ## "OWED TO YOU" IS OWED TO A HUMAN, NOT TO WHOEVER IS LOOKING
 *
 * A failed session and an unlanded artifact are owed to *any human* in the room
 * — that room-wide visibility is the design, because any human may certify — but
 * they are owed to NO agent. Certifying is a human-only act (the server refuses a
 * non-human identity; drizzle/0032, 0033 refuse the column outright), so telling
 * an AGENT-principal viewer "needs you" would be pointing them at a control they
 * can never operate. `viewerIsHuman` gates the room-wide `owedToViewer`: a human
 * sees these owed exactly as before, a non-human (agent, or an unreadable
 * `'unknown'` kind that fails closed to not-human) sees the underlying process
 * glyph — a failed `✗`, an unlanded `~` — without the second-person debt. The
 * flag is an allowlist of the compliant form (`=== 'human'`), never a denylist of
 * `'agent'`, so a kind that is neither is not owed either.
 */
export function sessionState(session: ControlSessionRow, viewerIsHuman: boolean): EpistemicState {
  if (session.status === 'failed') {
    return {
      kind: 'event',
      verification: 'failed',
      owedToViewer: viewerIsHuman,
      irreversible: false,
    };
  }
  if (sessionAwaitsLanding(session)) {
    return {
      kind: 'decision',
      verification: 'proposed',
      owedToViewer: viewerIsHuman,
      irreversible: true,
    };
  }
  if (sessionCertified(session)) {
    return {
      kind: 'commitment',
      verification: 'accepted',
      owedToViewer: false,
      irreversible: false,
    };
  }
  if (session.status === 'settled') {
    return {
      kind: 'commitment',
      verification: 'self_reported',
      owedToViewer: false,
      irreversible: false,
    };
  }
  return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
}

/**
 * A plan's state: the hardest of its sessions' states — a plan rolls its
 * children up (scout §9.4, "a needs-you propagates to every ancestor").
 *
 * A plan with no sessions yet reads from its own lifecycle status, and it reads
 * it the same way a session does: `plans` carries no certification column at all,
 * so a settled plan is a machine's report of its own completion and renders `~`.
 * It used to render `✓` — the same defect as the session's, one level up, and it
 * would have kept the tick alive on every plan and agent even after the session
 * derivation was fixed.
 */
export function planState(plan: ControlPlanRow, viewerIsHuman: boolean): EpistemicState {
  const childStates = plan.sessions.map((session) => sessionState(session, viewerIsHuman));
  const hardest = hardestState(childStates.map((state) => ({ state })));
  if (hardest !== null) return hardest;
  if (plan.status === 'settled') {
    return {
      kind: 'commitment',
      verification: 'self_reported',
      owedToViewer: false,
      irreversible: false,
    };
  }
  return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
}

/** An agent's state: the hardest of every session across all its plans. */
export function agentState(agent: ControlAgentRow, viewerIsHuman: boolean): EpistemicState {
  const sessionStates = agent.plans.flatMap((plan) =>
    plan.sessions.map((session) => ({ state: sessionState(session, viewerIsHuman) })),
  );
  const hardest = hardestState(sessionStates);
  if (hardest !== null) return hardest;
  return { kind: 'event', verification: 'routine', owedToViewer: false, irreversible: false };
}

/* ── owed decisions: whose attention item is this? ───────────────────────── */

/**
 * A pending attention item's state — its glyph is the class AND the ADDRESSEE.
 *
 * `owedToViewer` was hard-coded `true` in `ControlPlane`, for every item and
 * every viewer, so the room's whole pending queue rendered as owed to whoever
 * happened to be looking: a person owed nothing saw somebody else's four
 * decisions counted under NEEDS YOU, in `◆` amber. The viewer's own reading of
 * the item is now what decides, and it arrives on the row (`ControlDecisionRow`,
 * derived in the read model from the item's `user_id`).
 *
 * `needsViewer` in glyph.ts is what turns that into `◆`/`?`, so an item NOT owed
 * to this reader falls through to its verification and reads `~`/`?` — present,
 * uncoloured, not claiming a debt that is not theirs. This lives here rather than
 * in the component for the same reason every other derivation does: the pin, the
 * surface and the count all have to be reading one answer.
 */
export function decisionState(decision: ControlDecisionRow): EpistemicState {
  if (decision.class === 'blocking_question') {
    return {
      kind: 'question',
      verification: 'open',
      owedToViewer: decision.owedToViewer,
      irreversible: false,
    };
  }
  return {
    kind: 'decision',
    verification: 'proposed',
    owedToViewer: decision.owedToViewer,
    irreversible: false,
  };
}

/** A system-voice label for an owed decision, by its class. */
export function decisionLabel(cls: string): string {
  switch (cls) {
    case 'needs_decision':
      return 'a decision awaits a human';
    case 'blocking_question':
      return 'an open question is blocking';
    case 'owned_commitment':
      return 'a commitment awaits confirmation';
    case 'mention':
      return 'a mention awaits a reply';
    default:
      return cls.replace(/_/g, ' ');
  }
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
