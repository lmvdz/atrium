import 'server-only';
import { loadRoomMembershipRow, type PrincipalKind, parsePrincipalKind } from '@atrium/auth';
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
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';

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
 * the human certification of a session: those are the nullable `sessions` columns
 * #121 added (`artifact`, `certified_*`, drizzle/0032). The certification is
 * non-epistemic in the LEDGER's sense (#114 T3) — it never writes an
 * `accepted_objects` row — but it is exactly what the session's own glyph is
 * derived from, because a settled process is a machine's report and only a human
 * signature makes it more than that. Hence `certifiedByKind`: the certifier's
 * principal kind travels WITH the name, so the glyph derivation can run the one
 * predicate (`epistemicStateOf`) rather than trust that a name implies a person.
 *
 * ## THIS VIEW BELONGS TO ONE VIEWER
 *
 * It used to belong to the room, which is the same defect twice:
 *
 *   * every pending attention item in the room was handed to every viewer and
 *     rendered as owed to them, so a person who was owed nothing saw somebody
 *     else's four decisions counted under NEEDS YOU;
 *   * "unseen activity" was the last twelve lifecycle events, full stop —
 *     `memberships.seen_seq`, the per-person read cursor this product already
 *     maintains, was not consulted, so a person who had read everything was told
 *     twelve things were new.
 *
 * Both now read the viewer: `owedToViewer` is derived from the item's addressee
 * against `viewerId`, and "unseen" means `room_seq > seen_seq` for THIS viewer's
 * membership. Flip the viewer and both surfaces move.
 *
 * The membership (and its cursor) is read through `@atrium/auth`, which owns
 * every query that touches `memberships` — this file names the table nowhere,
 * which is the boundary `packages/auth/test/room-access.test.ts` enforces.
 *
 * Every field here is otherwise RAW state. No glyph, no tone, no ordering
 * decision is made in this file: the component layer derives all of those from
 * the state, so the one rule the whole product turns on — a glyph is derived,
 * never hand-set — holds across the seam. See src/components/control/state.ts.
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
  /** The human who certified it, resolved to a display name; null until certified. */
  readonly certifiedByName: string | null;
  /**
   * The certifier's PRINCIPAL KIND, carried beside the name so the glyph
   * derivation can ask the one predicate instead of assuming.
   *
   * Failed closed: an unreadable `principal_kind` resolves to `null` here, which
   * `sessionState` reads as "no human signature" and renders `~`. Two triggers
   * (0032, 0033) already make a non-human name unwritable, so this should be
   * unreachable — and it is exactly the sort of should-be-unreachable that the
   * fail-open version of this file spelled `verification: 'verified'`.
   */
  readonly certifiedByKind: PrincipalKind | null;
  readonly certifiedAt: string | null;
  readonly certifiedHeldMs: number | null;
  /**
   * When the hold that produced the certification was ARMED. Carried beside the
   * rest of the receipt so the render can fail CLOSED on an incomplete one: a
   * `certified_by` with no arm, no held duration, or no `certified_at` is not a
   * hold, and `sessionCertified` refuses to mint `✓` from a partial row (CS-2).
   * A DB backstop (drizzle/0035) refuses to WRITE such a row; this is what the
   * render does if one is ever read.
   */
  readonly certifyArmedAt: string | null;
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
  /** Its ADDRESSEE. `attention_items` is per-person; this is the person. */
  readonly userId: string;
  /**
   * Whether this item is owed to the person reading the page — `userId` against
   * the viewer, and nothing else.
   *
   * It was hard-coded `true` for every item and every viewer, which made NEEDS
   * YOU a room-wide queue wearing a second-person label. Derived here rather than
   * in the component so there is one answer for the pin, the surface and the
   * count.
   */
  readonly owedToViewer: boolean;
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
  /** Whose reading of the room this is. Every per-viewer field below derives from it. */
  readonly viewerId: string;
  readonly agents: readonly ControlAgentRow[];
  readonly decisions: readonly ControlDecisionRow[];
  /** Lifecycle events past THIS viewer's `memberships.seen_seq`, newest first. */
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
  viewerId: string,
): Promise<ControlPlaneData> {
  /* THE VIEWER'S READ CURSOR, through the package that owns `memberships`.
     A viewer with no membership row has read nothing (`0`) rather than
     everything: an unreadable cursor must over-report what is new, never
     under-report it, because the failure a person can see is the one they can
     correct. The page's own authorization has already refused a non-member long
     before this runs. */
  const membership = await loadRoomMembershipRow(database, roomId, viewerId);
  const seenSeq = membership?.seenSeq ?? 0;

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
        and(
          eq(coreEvents.roomId, roomId),
          inArray(coreEvents.type, [...LIFECYCLE_EVENT_TYPES]),
          /* UNSEEN MEANS UNSEEN BY THIS PERSON. Without this predicate the
             surface was "the last twelve lifecycle events", which is a room
             fact wearing a per-person label — a viewer who had read all of them
             was still told twelve things happened while they were away. */
          gt(coreEvents.roomSeq, seenSeq),
        ),
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
            /* The KIND travels with the name. A display name says nothing about
               whether a person signed this; `principal_kind` is what the one
               predicate reads, and reading it here is what lets the glyph
               derivation stop assuming. */
            .select({ id: users.id, name: users.displayName, kind: users.principalKind })
            .from(users)
            .where(inArray(users.id, certifierIds));
    })(),
  ]);

  const nameById = new Map(nameRows.map((row) => [row.id, row.name]));
  const certifierNameById = new Map(certifierNameRows.map((row) => [row.id, row.name]));
  const certifierKindById = new Map(
    certifierNameRows.map((row) => [row.id, parsePrincipalKind(row.kind)]),
  );
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
      certifiedByKind:
        session.certifiedBy === null ? null : (certifierKindById.get(session.certifiedBy) ?? null),
      certifiedAt: session.certifiedAt === null ? null : session.certifiedAt.toISOString(),
      certifiedHeldMs: session.certifiedHeldMs,
      certifyArmedAt: session.certifyArmedAt === null ? null : session.certifyArmedAt.toISOString(),
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
    /* THE WHOLE OF "owed to you": the item's addressee is this reader, or it is
       not. It used to be the constant `true`. */
    owedToViewer: item.userId === viewerId,
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
    viewerId,
    agents: agentRows,
    decisions,
    unseen,
    updatedAt: new Date().toISOString(),
  };
}
