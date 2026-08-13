import 'server-only';
import {
  agents,
  attentionItems,
  coreEvents,
  type Database,
  plans,
  type SessionArtifact,
  sessions,
  users,
} from '@atrium/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

/* ---------------------------------------------------------------------------
 * The control-plane read model — issue #121.
 *
 * Projection-first. This reads the EXISTING lifecycle projections
 * (`agents`/`plans`/`sessions`, #116; `rlimit_slice`/`authorized_draws`, #118;
 * `attention_items`, the covenant) and the ledger spine (`core_events`) into
 * one view the process-tree / surfaces / review pane render. It adds NO new
 * server vocabulary: burn-vs-budget is derived from columns `plans` already
 * carries (`spent_micros` vs `budget_limit_micros`, `authorized_draws` vs
 * `rlimit_slice`), so no cost projection was needed — #112's one-projection
 * allowance is unspent here.
 *
 * The ONE thing not previously projected anywhere is the execution artifact and
 * the human certification of a session's landing: those are the two nullable
 * `sessions` columns #121 added (`artifact`, `certified_*`, drizzle/0032). They
 * are non-epistemic session-receipt metadata (#114 T3), the same register as
 * `exit_summary` beside them — never a covenant `~`→`✓`.
 *
 * Every field here is RAW state. No glyph, no tone, no ordering decision is made
 * in this file: the component layer derives all of those from the state, so the
 * one rule the whole product turns on — a glyph is derived, never hand-set —
 * holds across the seam. See src/components/control/state.ts.
 * ------------------------------------------------------------------------- */

export type { SessionArtifact };

export interface ControlSessionRow {
  readonly id: string;
  readonly planId: string;
  readonly harness: string;
  readonly model: string;
  readonly status: 'open' | 'settled' | 'failed';
  readonly contextPct: number | null;
  readonly spendMicros: number;
  readonly exitSummary: string | null;
  readonly artifact: SessionArtifact | null;
  /** The human who landed it, resolved to a display name; null until certified. */
  readonly certifiedByName: string | null;
  readonly certifiedAt: string | null;
  readonly certifiedHeldMs: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ControlPlanRow {
  readonly id: string;
  readonly agentUserId: string;
  readonly title: string;
  readonly status: 'open' | 'settled';
  /** The `~` dollar intent, micro-dollars. Nullable = no cap set. */
  readonly budgetLimitMicros: number | null;
  /** The rollup of its sessions' reported spend, micro-dollars. */
  readonly spentMicros: number;
  /** THE ENFORCED CEILING, in draws. Nullable = UNFUNDED (a ceiling of zero). */
  readonly rlimitSlice: number | null;
  /** Draws granted so far — equals count(sessions) by construction (#118). */
  readonly authorizedDraws: number;
  readonly sessions: readonly ControlSessionRow[];
}

export interface ControlAgentRow {
  readonly userId: string;
  readonly name: string;
  readonly host: string | null;
  readonly harness: string | null;
  readonly model: string | null;
  readonly budgetLimitMicros: number | null;
  readonly plans: readonly ControlPlanRow[];
}

/** A pending attention item — a decision the room owes a human. */
export interface ControlDecisionRow {
  readonly id: string;
  readonly userId: string;
  readonly class: 'needs_decision' | 'owned_commitment' | 'mention' | 'blocking_question';
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly createdAt: string;
}

/** A recent lifecycle event — "what happened while you weren't looking." */
export interface ControlEventRow {
  readonly id: string;
  readonly type: string;
  readonly actorKind: 'human' | 'agent' | 'model' | 'system';
  readonly at: string;
}

export interface ControlPlaneData {
  readonly room: { readonly id: string; readonly name: string };
  readonly agents: readonly ControlAgentRow[];
  readonly decisions: readonly ControlDecisionRow[];
  readonly unseen: readonly ControlEventRow[];
  readonly updatedAt: string;
}

/**
 * The lifecycle event types that make up the "unseen" surface. The ledger-only
 * process operations (#116/#118) — what a person catches up on. `message_posted`
 * and the semantic verbs are the conversation's job, not the control plane's.
 */
const LIFECYCLE_EVENT_TYPES = [
  'plan_opened',
  'plan_settled',
  'session_opened',
  'session_settled',
  'session_failed',
  'signal_raised',
  'plan_rlimit_set',
  'draw_refused',
] as const;

/**
 * Load one room's control plane. `null` when the room has no lifecycle work at
 * all — no agent owns it as a channel and no plan lives in it — so the caller
 * can show the earned-empty state rather than an empty tree.
 */
export async function loadControlPlane(
  database: Database,
  roomId: string,
  roomName: string,
): Promise<ControlPlaneData> {
  const [planRows, sessionRows, decisionRows, eventRows] = await Promise.all([
    database
      .select()
      .from(plans)
      .where(eq(plans.roomId, roomId))
      .orderBy(asc(plans.createdAt), asc(plans.id)),
    database
      .select()
      .from(sessions)
      .where(eq(sessions.roomId, roomId))
      .orderBy(asc(sessions.createdAt), asc(sessions.id)),
    database
      .select()
      .from(attentionItems)
      .where(and(eq(attentionItems.roomId, roomId), eq(attentionItems.status, 'pending')))
      .orderBy(asc(attentionItems.createdAt), asc(attentionItems.id)),
    database
      .select({
        id: coreEvents.id,
        type: coreEvents.type,
        actorKind: coreEvents.actorKind,
        at: coreEvents.occurredAt,
      })
      .from(coreEvents)
      .where(
        and(eq(coreEvents.roomId, roomId), inArray(coreEvents.type, [...LIFECYCLE_EVENT_TYPES])),
      )
      .orderBy(desc(coreEvents.roomSeq))
      .limit(12),
  ]);

  /* The agents whose work lives in this room: every agent named by a plan here.
     A plan's `agent_user_id` is exactly its channel owner (the
     `plans_room_matches_agent_channel` trigger, #116), so this is the room's
     agent set. Read the config sidecar for each, and the display names. */
  const agentIds = [...new Set(planRows.map((plan) => plan.agentUserId))];
  const [agentConfigRows, nameRows, certifierNameRows] = await Promise.all([
    agentIds.length === 0
      ? Promise.resolve([])
      : database.select().from(agents).where(inArray(agents.userId, agentIds)),
    agentIds.length === 0
      ? Promise.resolve([])
      : database
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, agentIds)),
    (() => {
      const certifierIds = [
        ...new Set(
          sessionRows
            .map((session) => session.certifiedBy)
            .filter((id): id is string => id !== null),
        ),
      ];
      return certifierIds.length === 0
        ? Promise.resolve([])
        : database
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, certifierIds));
    })(),
  ]);

  const nameById = new Map(nameRows.map((row) => [row.id, row.name]));
  const certifierNameById = new Map(certifierNameRows.map((row) => [row.id, row.name]));
  const configByAgent = new Map(agentConfigRows.map((row) => [row.userId, row]));

  const sessionsByPlan = new Map<string, ControlSessionRow[]>();
  for (const session of sessionRows) {
    const row: ControlSessionRow = {
      id: session.id,
      planId: session.planId,
      harness: session.harness,
      model: session.model,
      status: session.status,
      contextPct: session.contextPct,
      spendMicros: session.spendMicros,
      exitSummary: session.exitSummary,
      artifact: session.artifact ?? null,
      certifiedByName:
        session.certifiedBy === null ? null : (certifierNameById.get(session.certifiedBy) ?? null),
      certifiedAt: session.certifiedAt === null ? null : session.certifiedAt.toISOString(),
      certifiedHeldMs: session.certifiedHeldMs,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
    const list = sessionsByPlan.get(session.planId);
    if (list === undefined) sessionsByPlan.set(session.planId, [row]);
    else list.push(row);
  }

  const plansByAgent = new Map<string, ControlPlanRow[]>();
  for (const plan of planRows) {
    const row: ControlPlanRow = {
      id: plan.id,
      agentUserId: plan.agentUserId,
      title: plan.title,
      status: plan.status,
      budgetLimitMicros: plan.budgetLimitMicros,
      spentMicros: plan.spentMicros,
      rlimitSlice: plan.rlimitSlice,
      authorizedDraws: plan.authorizedDraws,
      sessions: sessionsByPlan.get(plan.id) ?? [],
    };
    const list = plansByAgent.get(plan.agentUserId);
    if (list === undefined) plansByAgent.set(plan.agentUserId, [row]);
    else list.push(row);
  }

  const agentRows: ControlAgentRow[] = agentIds.map((userId) => {
    const config = configByAgent.get(userId);
    return {
      userId,
      name: nameById.get(userId) ?? 'agent',
      host: config?.host ?? null,
      harness: config?.harness ?? null,
      model: config?.model ?? null,
      budgetLimitMicros: config?.budgetLimitMicros ?? null,
      plans: plansByAgent.get(userId) ?? [],
    };
  });

  const decisions: ControlDecisionRow[] = decisionRows.map((item) => ({
    id: item.id,
    userId: item.userId,
    class: item.class,
    subjectKind: item.subjectKind,
    subjectId: item.subjectId,
    createdAt: item.createdAt.toISOString(),
  }));

  const unseen: ControlEventRow[] = eventRows.map((event) => ({
    id: event.id,
    type: event.type,
    actorKind: event.actorKind,
    at: event.at,
  }));

  return {
    room: { id: roomId, name: roomName },
    agents: agentRows,
    decisions,
    unseen,
    updatedAt: new Date().toISOString(),
  };
}
