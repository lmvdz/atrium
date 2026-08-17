import type {
  Actor,
  AttentionClass,
  AttentionStatus,
  AttentionSubjectKind,
  ClaimPayload,
  CommitmentPayload,
  AcceptedObjectType as CoreAcceptedObjectType,
  CoreEventType,
  CorrectionAction,
  DecisionPayload,
  EnclosedItem,
  ObjectivePayload,
  OpenQuestionPayload,
  ProposalStatus,
  ProvenanceMessage,
  RationaleReason,
  RelationKind,
} from '@atrium/core';
import { CANONICAL_TIMESTAMP } from '@atrium/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Atrium schema — issue #3's resolution, one table per settled concept.
 *
 * Shape rules that are load-bearing and must survive refactors:
 *  - `core_events` is THE spine (#12/#22). Everything else in the semantic layer
 *    is a projection of it and must be recomputable by folding it. See that
 *    table for the append invariant and the two-sequence design.
 *  - Anything that can name another room's entity does so through a composite
 *    `(room_id, id)` foreign key, never a bare `id` one. A plain FK checks that
 *    a row exists; only the composite one checks it exists *in this room*. #19's
 *    gauntlet routed this: rooms are the isolation boundary, and an isolation
 *    boundary the database does not enforce is a convention.
 *  - `messages` is append-only. There is no updated_at and no delete path;
 *    an edit is a new message, a mistake is a correction event.
 *  - The five accepted object types share ONE table with a `type` discriminator
 *    and a typed jsonb payload validated by @atrium/core before insert.
 *  - Supersession, dependency, blocking, answering and evidence are edges in
 *    `relations`, not objects.
 *  - `corrections` is an event log. Nothing in the semantic layer is ever
 *    mutated destructively (init.md §5).
 *  - `attention_items` is a stored projection, always recomputable.
 *  - `interpretations` carries the (message_id, interpretation_version) unique
 *    constraint that makes the pg-boss interpretation worker idempotent under
 *    at-least-once delivery (issue #16).
 *  - `users` and `workspaces` are ALSO Better Auth models (issue #13/#26). Their
 *    shape is therefore constrained from two directions at once; see
 *    `auth-schema.ts` for the mapping and the parity test that enforces it.
 *    Never remove a column from either table without checking that file.
 */

/* ── enums ──────────────────────────────────────────────────────────────── */

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'member']);

export const acceptedObjectType = pgEnum('accepted_object_type', [
  'decision',
  'commitment',
  'open_question',
  'claim',
  'objective',
]);

export const proposalStatus = pgEnum('proposal_status', [
  'proposed',
  'accepted',
  'rejected',
  'superseded',
]);

export const proposerKind = pgEnum('proposer_kind', ['model', 'human', 'agent']);

export const relationKind = pgEnum('relation_kind', [
  'supersedes',
  'depends_on',
  'blocks',
  'answers',
  'evidence',
]);

export const attentionClass = pgEnum('attention_class', [
  'needs_decision',
  'owned_commitment',
  'mention',
  'blocking_question',
]);

export const attentionStatus = pgEnum('attention_status', ['pending', 'resolved', 'dismissed']);

/**
 * A plan's process-group lifecycle (#116, from #114's resolution). A plan is a
 * board, not a process — it has no context window — so its states are only the
 * two a folder of work moves through: `open` while it holds sessions, `settled`
 * once its receipt is written. Projected from the ledger-only `plan_opened` /
 * `plan_settled` events; NOT a covenant state, and nothing here flips a `~`.
 */
export const planStatus = pgEnum('plan_status', ['open', 'settled']);

/**
 * A session's process lifecycle (#116). A session is a process — it settles or
 * fails, and it never spawns (the pstree invariant; see `sessions`). `settled`
 * and `failed` are the two exit receipts §9.5 names, kept apart because a
 * failure is owed attention until triaged and a settlement is not. Projected
 * from `session_opened` / `session_settled` / `session_failed`.
 *
 * **This is process state, not epistemic state (#114 T3).** A session settling
 * or failing is a receipt about the *process*; it writes `sessions.status` and
 * touches no `accepted_objects` judgement column, so it can never move a `~` to
 * a `✓`. The two receipts are deliberately separate.
 */
export const sessionStatus = pgEnum('session_status', ['open', 'settled', 'failed']);

/**
 * The three things a signal into a running session can BE (#127, from #123
 * resolution 2). Deliberately three labels and not a free string: `steer` is
 * guidance any room member may append, `interrupt` is a request to stop that
 * only the session's agent principal or that agent's owner may make, and
 * `resume` is a CONTINUATION DRAW — it passes #118's slice boundary exactly as a
 * spawn does, so there is no free wake path.
 *
 * Mastra's `debounce`/`batch` are deliberately NOT here: they are delivery
 * optimizations, and the ledger records acts (#123 resolution 2).
 */
export const signalKind = pgEnum('signal_kind', ['steer', 'interrupt', 'resume']);

/**
 * A durable wait's disposition (#127, from #123 resolution 6). A subscription is
 * never allowed to sit open forever — that is exactly the shape that blocks
 * #119's plan-settle with nothing to look at:
 *
 *  - `waiting` — live, and before its `expires_at`.
 *  - `matched` — a `session_signaled {kind:'resume'}` named it; the wait paid out
 *    as a continuation draw.
 *  - `expired` — its `expires_at` passed unmatched. The sweep escalates it to the
 *    agent's owner as `signal_raised`: the wait becomes owed ATTENTION.
 *  - `disposed` — its session took its exit first, so there is nothing left to
 *    wake. Session exit disposes its subscriptions (`projectSessionExit`).
 */
export const subscriptionStatus = pgEnum('subscription_status', [
  'waiting',
  'matched',
  'expired',
  'disposed',
]);

/**
 * Closed alphabet for durable authored references.
 *
 * `agent` (drizzle/0019) joins `human` as the second **participant** kind a
 * reference can name: an agent holds a `users` row, a membership and a session
 * (drizzle/0017), so an author can @-mention it exactly as they mention a
 * person, and the same reference lands its target in the attention register.
 * The two anonymous actor kinds — `model`, `system` — are deliberately NOT here:
 * they carry no identity to be a reference target, and `unknown` (the
 * fail-closed view kind) is never mentionable by construction. The
 * `validate_message_reference_target` trigger (drizzle/0016, replaced in 0019)
 * anchors a `human` target to a member whose `principal_kind` is `human` and an
 * `agent` target to a member whose `principal_kind` is `agent`, so neither kind
 * can mislabel the other.
 */
export const messageReferenceKind = pgEnum('message_reference_kind', [
  'human',
  'agent',
  'attachment',
  'proposal',
  'object',
]);

/**
 * What an attention item is *about* — @atrium/core's `AttentionSubjectKind`,
 * routed here from #21. A `needs_decision` item points at a **proposal**: a
 * decision never auto-accepts, so at the moment somebody has to rule on one
 * there is no accepted object to point at yet. See `attention_items`.
 */
/** Checked-text vocabulary; exported for core/schema parity without a phantom DB enum. */
export const attentionSubjectKind = {
  // `session` joins the three in #127: a subscription that expires unmatched
  // escalates to the agent's owner, and that item is about the SESSION still
  // waiting. Held in parity with @atrium/core's own enum by
  // `_AttentionSubjectKindParity` at the foot of this file, and fail-closed in
  // the store by `attention_items_subject_kind_allowlist` plus the fourth
  // generated column and its composite same-room FK.
  enumValues: ['object', 'proposal', 'message', 'session'] as const,
};

/**
 * Mirrors `@atrium/core`'s `CorrectionAction`, and the parity assert at the foot
 * of this file makes the mirror mandatory. #21 added the three verbs #5's
 * resolution named and the scaffold had not built yet: `retype` (the canonical
 * fix — a decision that was only a suggestion becomes a claim), `reattribute`
 * (owner change, kept separate from `amend` so the log is readable by verb), and
 * `reopen` (an answered question returns to open, prior answer preserved).
 */
export const correctionAction = pgEnum('correction_action', [
  'amend',
  'retract',
  'restore',
  'retype',
  'reattribute',
  'reopen',
]);

export const interpretationStatus = pgEnum('interpretation_status', [
  'pending',
  'succeeded',
  'failed',
]);

/**
 * Every kind of thing that takes a position in `core_events`.
 *
 * **Six** of the eight are @atrium/core's `CoreEvent` types verbatim — the
 * reducer folds exactly those, and `_CoreEventTypeCoverage` below stops
 * compiling if core ever grows a seventh that is not listed here. (This said
 * "the first five … a sixth" until r7; #21 added `proposal_superseded` and the
 * sentence was never updated, so a paragraph explaining an exhaustiveness assert
 * was itself out of date about the set it covered. `coreEventTypes` has six, and
 * `apps/server/test/protocol.test.ts` says so.) The other two are room history
 * the reducer has no concept of: a message is substrate, not semantics, and an
 * attention item is a per-person projection. Both still belong in the ledger,
 * because a client replaying `since(room, room_seq)` must get the room back
 * exactly as it was.
 *
 * Presence and typing are deliberately absent, and that absence is asserted by
 * a test: they are transient ws frames and never become rows (#14).
 */
export const eventType = pgEnum('event_type', [
  'proposal_recorded',
  'proposal_rejected',
  'proposal_superseded',
  'object_accepted',
  'object_corrected',
  'relation_added',
  'message_posted',
  'attention_resolved',
  // ── the agent/plan/session lifecycle (#116) ──────────────────────────────
  //
  // Six ledger-only kinds, added to the enum but KEPT OUT of `coreEventTypes`
  // below — the reducer folds none of them and `CoreState` has no concept of a
  // plan or a session, exactly the standing `message_posted` and
  // `attention_resolved` hold. They ride `core_events` for their `room_seq` and
  // their append order; the `plans`/`sessions` tables and `attention_items` are
  // their projections. `_CoreEventTypeCoverage` still holds because it is
  // one-way (every core type is storable), and `event_type` is a strict
  // superset by design. The RoomEvent zod schemas live in
  // `apps/server/src/room-events.ts`, NOT in `@atrium/core`'s `events.ts`, so
  // they never join `CoreEvent`.
  'plan_opened',
  'plan_settled',
  'session_opened',
  'session_settled',
  'session_failed',
  'signal_raised',
  // ── the budget/rlimit enforcement boundary (#118, from #115's resolution) ──
  //
  // Two more ledger-only kinds, KEPT OUT of `coreEventTypes` exactly as the six
  // above are. `plan_rlimit_set` is the human-only spend-authorization that sets
  // or raises a plan's `rlimit_slice`; `draw_refused` is the durable, receipted
  // refusal a spawn takes when the slice is spent — "a row that won't balance",
  // not a silent stop. Neither mints or moves a `✓`: the covenant reducer folds
  // neither, and `plans`/`sessions` are still their only projections.
  'plan_rlimit_set',
  'draw_refused',
  // ── the signal/interrupt boundary (#127, from #123's resolution) ──────────
  //
  // Two more ledger-only kinds, KEPT OUT of `coreEventTypes` exactly as the
  // eight above are. `session_signaled` is control DOWN into a running session
  // (`steer | interrupt | resume`); `session_subscribed` is a durable WAIT with
  // a mandatory expiry. Neither is ever folded: a steer is coordination, not the
  // room's understanding (#123 resolution 1). The third signal word,
  // `signal_raised`, is escalation UP and is unchanged — three meanings, three
  // names, no overloading (#123 resolution 7).
  'session_signaled',
  'session_subscribed',
  // ── the live progress channel (#159, from #152's resolution) ──────────────
  //
  // ONE more ledger-only kind, KEPT OUT of `coreEventTypes` exactly as the ten
  // above are. `session_phase_changed` is the DURABLE phase timeline of a running
  // session's work (`planning | writing | testing`) — low-cardinality genuine
  // history the reducer never folds (a phase is not the room's understanding).
  // Its projection writes only the `sessions.progress` snapshot column. The
  // high-frequency progress (heartbeat, diff deltas) is NOT here — those are
  // ephemeral WS frames, never a ledger row.
  'session_phase_changed',
]);

/**
 * The trusted actor's kind, lifted out of `@atrium/core`'s `Actor` union and
 * held to it by the parity assert at the foot of this file.
 *
 * It is a **column**, not a payload field, and that is #21's contract rather
 * than a storage preference: the actor decides every human-only gate in the
 * reducer, and a payload is whatever the writer says it is. See `core_events`.
 *
 * `agent` (drizzle/0017) is the identified non-human: it carries a user id in
 * `actor_id` exactly as `human` does, and it is refused by every certification
 * gate exactly as `model` is. Which of `human` and `agent` a row may claim is
 * not the writer's choice either — `atrium_core_events_invariants` reads
 * `users.principal_kind` for the id in `actor_id` and refuses a row whose
 * `actor_kind` disagrees with it, so an agent's session cannot append history
 * that reads as a person's, nor the reverse.
 *
 * **Which of these labels is an *identity* is not written down anywhere as a
 * list** (drizzle/0018). The append boundary derives the identified set from the
 * `principal_kind` enum below — a label that names a `users` row is checked for
 * membership and kind agreement, `model` and `system` are the two enumerated
 * exemptions, and a label that is neither is refused outright. So adding a value
 * here does not silently exempt it from the boundary the way it did while 0017
 * spelled the set as `IN ('human','agent')`; it fails closed at the first
 * append, which is the only direction this gate may fail in.
 */
export const actorKind = pgEnum('actor_kind', ['human', 'agent', 'model', 'system']);

/**
 * What an identity *is* — the kind of principal a `users` row stands for.
 *
 * A **column on `users`** rather than a sibling table, and the reason is the
 * failure direction rather than tidiness. Every membership, attention and
 * attribution foreign key in this schema already lands on `users.id`; a sibling
 * `principals(user_id, kind)` would answer this question with a join whose
 * *missing row* is a third state, and the only sane reading of a missing row is
 * "human" — which is a default that fails open in the one place that has to fail
 * closed (#90's interlock: `human` has always meant "authenticated account", so
 * the day accounts stop implying people, an absent answer must not read as one).
 * `NOT NULL DEFAULT 'human'` on the row itself has no missing state to read.
 *
 * Deliberately a **second** enum rather than a reuse of `actor_kind`. They are
 * different questions asked of different things — `actor_kind` describes an
 * event, `principal_kind` describes an identity — and `model`/`system` are not
 * identities and must not be spellable here.
 */
export const principalKind = pgEnum('principal_kind', ['human', 'agent']);

/** Typed payload union stored in `accepted_objects.payload` / `proposals.payload`. */
export type ObjectPayload =
  | DecisionPayload
  | CommitmentPayload
  | OpenQuestionPayload
  | ClaimPayload
  | ObjectivePayload;

/* ── identity ───────────────────────────────────────────────────────────── */

/**
 * The application's participant table AND Better Auth's `user` model — one row
 * per participant, not two. Better Auth field names that differ from ours are
 * remapped in `auth-schema.ts` (`name` → `displayName`, `image` → `avatarUrl`);
 * every other property name below is a Better Auth field name and must not be
 * renamed.
 *
 * **It said "one row per human" until drizzle/0017, and that is no longer
 * true.** A row here is an identity — something that can hold a session, a
 * workspace membership, a room membership, and its own name on what it wrote.
 * `principal_kind` says which sort of identity, and it is the only thing in the
 * schema that does; nothing else about a row distinguishes a person from an
 * agent, by design, because every relation that lands on `users.id` should treat
 * them alike right up to the point where certification is asked for.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /**
     * Person or agent. Set at provisioning and never afterwards — a BEFORE
     * UPDATE trigger (drizzle/0017) refuses any change, because changing it
     * would silently re-read every `core_events` row this identity ever
     * appended as having been written by the other sort of participant.
     *
     * "Never afterwards" is a property of the **row**, and until drizzle/0018 it
     * was only a property of the UPDATE statement: delete the row and insert the
     * same uuid under the other kind and the trigger never fired, while the
     * re-attribution it exists to prevent happened in full. A BEFORE INSERT
     * companion (`users_principal_kind_matches_history`) now refuses a row whose
     * kind disagrees with what that uuid has already appended, so the two
     * triggers together bind every route that leaves history behind.
     *
     * Exposed to Better Auth as a user `additionalField` with `input: false`
     * (`auth-schema.ts`), so it rides on the session the library already
     * resolves and there is no request body anywhere that can set it.
     */
    principalKind: principalKind('principal_kind').notNull().default('human'),
    /** Better Auth `user.name`. */
    displayName: text('display_name').notNull(),
    /** Better Auth `user.image`. */
    avatarUrl: text('avatar_url'),
    /** Better Auth `user.emailVerified` — flipped by the verification link. */
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/**
 * A workspace — the tenancy boundary that owns rooms and people. This is Better
 * Auth's `organization` model under our name; `workspace_members` and
 * `workspace_invitations` (auth-schema.ts) are its `member` and `invitation`.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Better Auth `organization.logo`. */
    logo: text('logo'),
    /** Better Auth `organization.metadata` — a JSON string, its own encoding. */
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspaces_slug_key').on(t.slug)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The agent whose **channel** this room is (#116, from #114 T1). An agent
     * has ONE channel — a room it OWNS — distinct from the many rooms it is a
     * member of: plans and sessions pin in that channel, escalations climb to a
     * group room's pin via attention. Nullable because almost every room is a
     * group channel with no owning agent, and `unique` because a room is at most
     * one agent's channel and an agent has at most one channel. `set null` on
     * the agent's deletion rather than cascading the room away: the channel's
     * history outlives the identity, the same way a person's messages do.
     *
     * `drizzle/0021` adds this as the reciprocal of `agents.channel_room_id`. It
     * began as a readable back-reference, but `drizzle/0024`'s composite FK
     * `agents_channel_owned_fk (channel_room_id, user_id) → rooms(id, agent_user_id)`
     * makes it an ENFORCED edge: an agent's channel must be a room that names it
     * here. The `rooms_agent_user_is_agent` trigger (0024) holds the other half a
     * foreign key cannot — that when set, this names an `agent`-kind user, not a
     * person or a model.
     */
    agentUserId: uuid('agent_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  // Slugs are unique *within* a workspace: two tenants may both have #general.
  (t) => [
    uniqueIndex('rooms_workspace_slug_key').on(t.workspaceId, t.slug),
    index('rooms_workspace_idx').on(t.workspaceId),
    // At most one agent per channel and at most one channel per agent.
    uniqueIndex('rooms_agent_user_id_key').on(t.agentUserId),
    /**
     * The composite-FK TARGET `agents_channel_owned_fk` lands on (#116 fix r2,
     * drizzle/0024). `id` is already unique, so this pins nothing new about rooms;
     * it exists only so a foreign key can reference (id, agent_user_id) and hold
     * an agent's channel to a room it owns.
     */
    uniqueIndex('rooms_id_agent_user_id_key').on(t.id, t.agentUserId),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The per-user, per-room read cursor (#12/#14): the `core_events.room_seq`
     * this person has seen up to. Drives the "since you left" divider, is
     * advanced only by an explicit `advance_seen` command, and is never a
     * global mark-all-read. Typed `bigint` to match `core_events.room_seq` —
     * a read cursor that overflows before the log it points into is a bug
     * waiting on a busy room.
     *
     * Bounded **above** by the room's head as well as below by zero, and both
     * ends are the database's job. The lower bound is the check constraint
     * here; the upper one is cross-table, so it is a trigger in
     * `drizzle/0003_append_enforcement.sql` — a cursor pointing past the last
     * event in the room claims to have read history that does not exist, and
     * the client that trusts it asks `since(room, n)` for a gap it will never
     * be sent (#22 gauntlet r1, major 5).
     */
    seenSeq: bigint('seen_seq', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('memberships_room_user_key').on(t.roomId, t.userId),
    index('memberships_user_idx').on(t.userId),
    check('memberships_seen_seq_nonnegative', sql`${t.seenSeq} >= 0`),
  ],
);

/* ── the durable ledger (issue #22) ─────────────────────────────────────── */

/**
 * `core_events` — the append-only spine. #12 settled that a single event log
 * with a per-room monotonic sequence is the source of truth and that every
 * accepted-object table is a projection derived from it; #19's gauntlet
 * converged on this exact shape. Nothing here is ever updated or deleted.
 *
 * ## The append invariant, quoted verbatim from #22
 *
 * > "the durable ledger must contain ONLY events accepted in canonical order —
 * > room_seq is assigned transactionally at append, so an out-of-order event is
 * > rejected at the command layer and never persisted. The reducer watermark is
 * > a defense-in-depth guard, not a data path; if refused events could reach the
 * > log, full replay (which re-sorts) would accept what live ingestion refused
 * > and the two states would diverge."
 *
 * Read that as a rule about what may reach an INSERT. The command layer calls
 * `appendEvent` inside the same transaction as the insert: a `rejected` outcome
 * aborts the transaction, so a refused event leaves no row, no sequence number
 * and no gap. There is no "quarantine" column and there must never be one — a
 * refused event stored anywhere in this table is the divergence the quote
 * describes, because `reduce` re-sorts on replay and would admit it.
 *
 * ## Two sequences, and why both — the #19 r3 global-cursor consequence
 *
 * r3 left this open: core state gates on a GLOBAL cursor (`issues`,
 * `corrections` and `consumedEventIds` are global ordered lists, so a per-room
 * gate cannot make live ≡ replay byte-equal), and #22 had to either give the
 * ledger a global total order or shard core state per room. **This resolves it
 * the first way, and both sequences are kept:**
 *
 *  - `seq` — `bigserial`, the primary key, the total order across every room.
 *    This is what the core's global cursor is a position in, and what a full
 *    replay reads in. Appends are serialized (a transaction-scoped advisory
 *    lock in apps/server), so `seq` order and the core's canonical `(at, id)`
 *    order are the same order, by construction rather than by luck.
 *  - `room_seq` — the per-room client protocol from #12. `UNIQUE(room_id,
 *    room_seq)` plus the serialized assignment makes it gap-free and
 *    duplicate-free, which is what lets `since(room, room_seq)` recover a
 *    byte-identical history after a dropped socket.
 *
 * Sharding core state per room was the alternative and is rejected: it would
 * split `corrections` and `issues` into per-room lists, changing the core's
 * public contract to buy an independence the product does not have (a
 * correction is a global audit trail) — and it would still need a global order
 * the moment anything reads across rooms.
 *
 * ## Columns
 *
 * `id` is the *event's* identity — the `CoreEvent.id` the reducer spends in
 * `consumedEventIds` — not this table's primary key, which is `seq`. It is
 * globally unique, so the reducer's duplicate gate has a durable counterpart.
 * `payload` holds the whole event, envelope included, so replay is a `parse`
 * of one column rather than a re-assembly from six; `id`, `type`, `actor` and
 * `occurred_at` are lifted out for indexing and constraints, and check
 * constraints keep the lifted copies honest — by **equality**, not by
 * existence. A row whose `occurred_at` disagrees with `payload.at` would sort
 * one way durably and another way on replay, which is the same divergence the
 * append invariant exists to exclude (#22 gauntlet r1, major 2).
 *
 * ## What is NOT in this file, and cannot be
 *
 * Drizzle describes tables. Several of this table's rules are procedural and
 * live in `drizzle/0003_append_enforcement.sql` and
 * `drizzle/0008_invariants_on_the_table.sql`, which are the authority on them:
 *
 *  - **The append rules are enforced by triggers on this table, not by the
 *    function in front of it** (#22 gauntlet r6, major 3). Membership, the room
 *    a room-less kind resolves to, the canonical `(at, id)` order, `room_seq` and
 *    the receipt window are all `core_events_invariants`, a `BEFORE INSERT` row
 *    trigger. It fires for every INSERT from every caller through every function,
 *    whatever the call stack claims. This is a change of *place*, and the reason
 *    is that the previous place turned out not to be a boundary: the r6 gauntlet
 *    defined `evil2.atrium_append_core_event`, compiled it with `evil2` on the
 *    search path so PL/pgSQL labelled its frame unqualified, and satisfied the
 *    call-stack check with a plain INSERT. Only rules attached to the table
 *    survived that, so the rules are attached to the table.
 *  - **`atrium_append_core_event(...)` is the door a `REVOKE` controls.
 *    `core_events_append_guard` is an accident check, and r8 stopped calling it
 *    anything else** (#22 gauntlet r7, defect 1, and `drizzle/0009` is the whole
 *    argument). The guard reads its own `PG_CONTEXT` call stack and substring-
 *    matches the schema-qualified signature — and `PG_CONTEXT` carries the
 *    verbatim SQL text of every caller frame, so **one SQL comment satisfies it,
 *    from a bare `DO` block, at the cost of no privilege anywhere.** The
 *    paragraph here used to say it "binds the table owner and a superuser"; it
 *    binds neither, and no rewrite of it could, because every session-scoped
 *    token it might read instead is one the caller can mint too. What binds is
 *    privilege: after `0003` only the owner and a superuser can INSERT into this
 *    table at all, anyone else is refused by the `REVOKE` before the trigger
 *    runs, and anyone inside that set can disable the trigger. What the check is
 *    worth keeping for is the accident the lock half cannot see — a stray direct
 *    INSERT in a transaction that already made a legitimate append.
 *
 *    This is a claim being narrowed, not a guarantee being lost: the rules above
 *    live on the table, and r7's critic verified all five of them **using this
 *    bypass as the vehicle**. Getting past the guard buys nothing against them.
 *  - **The advisory lock is asserted, not assumed.** The function takes it and
 *    the guard re-checks `pg_locks` before letting the row through.
 *  - **Nothing lands silently.** `core_events_doorbell` is an `AFTER INSERT`
 *    trigger emitting `pg_notify('atrium_ledger', …)`, so a row written by
 *    something that is not this application still announces itself — as `null`,
 *    which matches no instance and is therefore folded by all of them.
 *  - **`UPDATE` raises. `DELETE` and `TRUNCATE` do not, deliberately.**
 *    `core_events_no_update` is a `BEFORE UPDATE` trigger and nothing else:
 *    `room_id` cascades from `rooms`, so deleting a room has to be able to take
 *    its history with it, and the integration suite truncates between files. Both
 *    are `REVOKE`d from every role a `REVOKE` binds — asserted since r7 against
 *    a real role in `leaves an ordinary reader with SELECT and nothing else`,
 *    rather than asserted here — which is a weaker guarantee
 *    than a trigger and is the right one here. Rewriting a row in place has no
 *    legitimate caller at all, and it is the one that would let history be edited
 *    after the fact without leaving a trace — so that is the one with a trigger.
 *    (This bullet said all three raised until r6; 0003, which it names as the
 *    authority, says the opposite in as many words. Two independent reviewers
 *    found it in the same pass.)
 *
 * ## `seq` may gap; `room_seq` may not
 *
 * `seq` is a `bigserial`, and a sequence does not roll back. A transaction that
 * takes `seq = n` and then aborts — a rejected event, a failed projection, a
 * constraint violation — leaves `n` unused forever. That is fine and expected:
 * `seq` is a total *order*, not a census, and nothing counts it. `room_seq` is
 * different: it is minted by `max(room_seq) + 1` under the append lock inside
 * the same transaction as the insert, so an aborted append gives its number
 * back and the per-room sequence stays contiguous. Only the per-room one is
 * ever advertised as gap-free, and only it is what `since(room, room_seq)`
 * walks.
 */
export const coreEvents = pgTable(
  'core_events',
  {
    /** Global total order across all rooms. The core's cursor is a position here. */
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** Per-room order, 1-based, contiguous. The `since(room, seq)` cursor. */
    roomSeq: bigint('room_seq', { mode: 'number' }).notNull(),
    /** The event id from @atrium/core — NOT the primary key. Globally unique. */
    id: text('id').notNull(),
    type: eventType('type').notNull(),
    /**
     * The trusted actor, as **two columns** (#21 r3).
     *
     * `actor_id` is the user id for a human **or an agent**, the model id for a
     * model, and NULL for the system actor — the shape #21's contract names,
     * checked by `core_events_actor_id_matches_kind` so the last case cannot be
     * spelled as an empty string.
     *
     * Two kinds now share the "user id" spelling, so the column alone no longer
     * answers "was this a person?" — `actor_kind` does, and it is the column
     * every gate reads. See `actorKind`.
     */
    actorKind: actorKind('actor_kind').notNull(),
    actorId: text('actor_id'),
    /**
     * The receipt window this row folded under, **snapshotted at append**
     * (#22 gauntlet r3 delta, blocking 2).
     *
     * `NULL` means no window was supplied — a human actor, or an event with no
     * provenance to check. An array means one was, and `[]` is a window that was
     * looked for and came back empty, which the reducer refuses. Absent and empty
     * are different facts and are stored differently, because #21's contract
     * treats them as the same *refusal* for different *reasons* and a replay that
     * could not tell them apart would report the wrong one.
     *
     * ## Why it is a column and not a join
     *
     * Round 3 derived this window on both paths — live append and replay — from
     * `provenance.messageIds` against the `messages` table, and called the
     * sameness of the derivation the guarantee. The delta gauntlet found the
     * guarantee is not in the function:
     *
     * > the bodies come from `messages` whose `authorId` is `onDelete: 'set
     * > null'` […] Delete a human author and a model `object_accepted` that
     * > folded cleanly under a real `authorId` replays with `''`, fails the
     * > receipt, and is absent from replayed state. Same derivation code,
     * > different substrate.
     *
     * A deterministic function of mutable inputs is not deterministic. What the
     * receipt validates — the author identity and the text a quote is matched
     * against — has to be as immutable as the event, so it lives on the event's
     * own row, written by the transaction that assigned `room_seq` and never
     * updated (the append-only trigger from 0003 sees to that).
     *
     * The weaker alternative was a tombstone instead of `ON DELETE SET NULL`,
     * which fixes this one mutation and leaves the class open: an author renamed,
     * a message edited, a row moved between rooms all reopen it. Denormalising at
     * append holds for any future mutation of `messages`, because after the
     * append the fold does not read `messages` at all.
     *
     * ## Why nobody can write one (#22 gauntlet r4 delta, blocking)
     *
     * Round 4 made this an immutable column and let the append function take it as
     * a *parameter*, checked only for shape. That is the same defect one move
     * further along: a trusted location holding a value the caller computed.
     *
     * > A direct caller of the granted append function supplies a fabricated but
     * > well-formed receipt window and every fold trusts it.
     *
     * There is no parameter now. `atrium_receipt_window(room_id, actor_kind,
     * payload)` derives this from the row itself — room-scoped, ordered by the
     * room's own `messages.seq` — and `atrium_append_core_event` calls it and
     * inserts the result. The shape check below survives for the one writer that
     * can still get around all of it (a superuser with the triggers disabled), and
     * for nobody else. **Trust follows derivation, not location.**
     */
    trustedMessages: jsonb('trusted_messages').$type<ProvenanceMessage[]>(),
    /** The complete event. `reduce` folds `payload`, not a reassembly of it. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** The event's own `at` — the first half of the canonical `(at, id)` key. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** When the row landed. Wall clock for operators; never an ordering input. */
    appendedAt: timestamp('appended_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * The gap/duplicate-free guarantee, at the only level that survives a
     * racing writer. Two concurrent posts to one room cannot both take
     * `room_seq = n`: one transaction rolls back and its event is never
     * persisted — which is the invariant above, enforced by Postgres.
     */
    uniqueIndex('core_events_room_seq_key').on(t.roomId, t.roomSeq),
    /** The reducer's duplicate gate, made durable. */
    uniqueIndex('core_events_id_key').on(t.id),
    index('core_events_room_order_idx').on(t.roomId, t.roomSeq),
    index('core_events_order_idx').on(t.occurredAt, t.id),
    /**
     * The two lookups `atrium_append_core_event` runs for a room-less kind
     * (#22 gauntlet r5 delta, major 2).
     *
     * `proposal_rejected`, `proposal_superseded` and `object_corrected` name a
     * subject rather than a room, so the boundary resolves the subject back to
     * the room its own ledger row landed in. Without these that resolution is a
     * sequential scan of the whole ledger on every such append; with them it is
     * an index probe. Partial, because the answer only ever comes from the one
     * kind that minted the subject.
     */
    index('core_events_proposal_subject_idx')
      .on(sql`(${t.payload}->'proposal'->>'id')`)
      .where(sql`${t.type} = 'proposal_recorded'`),
    index('core_events_object_subject_idx')
      .on(sql`(${t.payload}->'object'->>'id')`)
      .where(sql`${t.type} = 'object_accepted'`),
    check('core_events_room_seq_positive', sql`${t.roomSeq} >= 1`),
    /**
     * The lifted columns are a denormalisation of `payload`, so they are
     * checked against it rather than trusted. A row whose `type` column says
     * one thing and whose payload says another would replay as something the
     * ledger's own indexes never described.
     */
    check('core_events_payload_id_matches', sql`${t.payload}->>'id' = ${t.id}`),
    check('core_events_payload_type_matches', sql`${t.payload}->>'type' = ${t.type}::text`),
    // `jsonb_exists(x, k)` rather than the `?` operator: identical meaning, and
    // a literal `?` in DDL is a placeholder to half the drivers that will ever
    // read this file back.
    check('core_events_payload_has_at', sql`jsonb_exists(${t.payload}, 'at')`),
    /**
     * The two ordering fields, checked for **equality** with the payload the
     * reducer actually folds — r1's major 2. "The key exists" was never the
     * claim worth making: what matters is that the durable order (`occurred_at`,
     * `seq`) and the canonical order (`payload.at`, `payload.id`) are the same
     * order, so a writer cannot mint a row that replays into a different
     * position than it occupies.
     *
     * The `::timestamptz` cast is only session-independent because the next
     * check forces a timezone designator onto every `at` — with one, the cast
     * cannot mean two things in two sessions, which is what makes it safe to
     * put in a CHECK at all.
     */
    check(
      'core_events_payload_at_matches',
      sql`(${t.payload}->>'at')::timestamptz = ${t.occurredAt}`,
    ),
    /**
     * **One spelling of one instant** (#22 gauntlet r3 delta, major 1).
     *
     * r2 required a timezone designator, which makes the `::timestamptz` cast
     * above session-independent. That is necessary and it is not sufficient,
     * because the canonical `(at, id)` order is evaluated in two places by two
     * different rules:
     *
     *  - the SQL append gate compares `p_occurred_at` as a **`timestamptz`**, so
     *    `…05.000Z` and `…05Z` and `…05+00:00` are one value and tie;
     *  - `orderEvents` in @atrium/core compares `event.at` as a **string**, so the
     *    same three are three different values in an arbitrary order.
     *
     * Two events one millisecond apart in the reducer's eyes and simultaneous in
     * the database's is the ordering gate and the reducer disagreeing about what
     * the log says — the r1 lock-key lesson again: two components that must agree
     * on a shared rule, agreeing only because production happens to mint one
     * spelling. This makes the subset a constraint instead of a habit: exactly
     * `YYYY-MM-DDTHH:MM:SS.mmmZ`, which is what `Date#toISOString` produces and
     * what `nextTimestamp` in `ledger.ts` mints. Inside it, string order and
     * `timestamptz` order are the same order for every value.
     *
     * ## The pattern is @atrium/core's, not a copy of it (r4 delta, major 1)
     *
     * Round 4 wrote this shape here and left `Timestamp` in @atrium/core as
     * `z.iso.datetime({ offset: true })`, then called the two one rule. They were
     * two rules that agreed about the common case: the type admitted `+00:00`,
     * second precision and every other legal ISO spelling, all of which this CHECK
     * refuses — so a value could pass every type in the system and be refused by
     * the database at the INSERT.
     *
     * The fix is not a second transcription. `CANONICAL_TIMESTAMP` is imported and
     * its `source` is interpolated, so there is exactly one pattern and the two
     * engines evaluate the same characters. It is calendar-aware — `2026-13-45`
     * and `T25:00` are refused here as well as there — because a shape-only check
     * would let an impossible instant reach the `::timestamptz` cast in
     * `core_events_payload_at_matches` and fail as a cast error rather than as a
     * named constraint. Postgres ARE reads `\d`, `{n}` and `(?:…)` exactly as
     * JavaScript does, which is what makes sharing the source honest rather than
     * lucky; the integration suite fuzzes both engines against each other and
     * asserts no value is accepted by one and refused by the other.
     */
    check(
      'core_events_payload_at_is_canonical_utc',
      sql`${t.payload}->>'at' ~ ${sql.raw(`'${CANONICAL_TIMESTAMP.source}'`)}`,
    ),
    /**
     * The other half of the same rule: the id's charset.
     *
     * The SQL gate compares ids under `COLLATE "C"` (UTF-8 byte order); the
     * reducer compares them with JavaScript's `<` (UTF-16 code-unit order). Those
     * two agree for every code point in the Basic Multilingual Plane and disagree
     * above it — an astral-plane character is a surrogate pair starting at
     * U+D800, so UTF-16 sorts it before U+E000–U+FFFF while byte order sorts it
     * after. `Id` in @atrium/core carries the same rule for anything that goes
     * through the application; this carries it for anything that does not.
     *
     * See `ID_CHARSET` there for the derivation, and
     * `integration/db/ledger-constraints.test.ts` for the fuzz that compares the
     * two orders directly across both dimensions.
     */
    // Two clauses rather than `{1,256}`: Postgres caps a regex repetition count
    // at 255, and a bound expressed as a regex quantifier would have silently
    // been 255 or a syntax error depending on the number chosen. `ID_MAX_LENGTH`
    // in @atrium/core is the same 256.
    //
    // `COLLATE "C"` on the subject is not decoration (#22 gauntlet r4 delta): a
    // regex bracket *range* is resolved in the collation of its input, so `[!-~]`
    // means "printable ASCII" only where the collation is byte order. Under ICU or
    // a generated glibc locale it means "everything that sorts between `!` and
    // `~`", which admits accented letters and a great deal else — and this
    // constraint's entire job is to keep the ledger inside the subset where the
    // reducer's UTF-16 order and the gate's `COLLATE "C"` order are one order. The
    // compose image's `en_US.utf8` happens to behave as byte order, so **no
    // behavioural test in this suite can see the difference**; the deployed
    // `pg_get_constraintdef` is asserted directly in
    // `integration/db/ledger-constraints.test.ts`, beside the function's `prosrc`
    // and the index's `indexdef`, for that reason.
    check(
      'core_events_id_is_safe_to_order',
      sql`(${t.id} COLLATE "C") ~ '^[!-~]+$' AND length(${t.id}) <= 256`,
    ),
    /**
     * The room the row lands in is the room **this kind's own shape** declares
     * (#22 gauntlet r5 delta, blocking).
     *
     * `room_id` was a lifted column nothing compared to the payload. A direct
     * caller of the append function could write an `object_accepted` whose
     * `object.roomId` names room B into `room_id = A`: the fan-out reads the
     * column and delivers it to A's subscribers, the fold reads the payload and
     * files the object under B, and `since(A, n)` then serves a row that folded
     * into another room. Same class as `payload_id_matches` and
     * `payload_type_matches`, and the last of the lifted columns to get one.
     *
     * ## Round 5 wrote that fix kind-blind, and the finding is the shape of it
     *
     * > `coalesce(payload->'proposal'->>'roomId', payload->'object'->>'roomId',
     * > …)` takes whichever key appears **first in its list**, JSONB accepts extra
     * > keys, and Zod strips them only after the row exists.
     *
     * The exploit is one smuggled key. An `object_accepted` filed into room B,
     * whose `object.roomId` really is room A, carrying an extra `proposal:
     * {roomId: B}` that no reducer will ever read: the coalesce reaches
     * `proposal.roomId` first, sees B, and the row installs. Fan-out uses the
     * column (B), the fold uses `object.roomId` (A), and `since(B, n)` serves a
     * row that folded into another room — the exact defect the previous round
     * claimed to have closed, reopened by discriminating on **key order** instead
     * of on **kind**.
     *
     * The general form, and it is now a RETRO entry: *validate a union by its
     * tag, not by key presence.* `coalesce` over every member's shape is a check
     * that some member is satisfied; it is not a check that **this** member is.
     *
     * ## What it says now
     *
     * Two clauses, and the first is the one that closes the class:
     *
     *  1. **The set of room-bearing keys present is exactly the set this kind's
     *     shape declares** — one for the eleven kinds that carry a room (the five
     *     originals plus the six agent/plan/session lifecycle kinds #116 added to
     *     the enum and to migration 0023, mirrored here), and *empty* for the
     *     three that name a subject instead. A key belonging to another
     *     kind's shape is not ignored, it is a refusal, so there is nothing to
     *     smuggle. This also closes the room-less kinds, which under the coalesce
     *     were satisfied by *anything* because the fall-through reached the column.
     *  2. **That key's value is the row's room.** `IS NOT DISTINCT FROM`, not `=`
     *     — and the reason is *not* the one this comment gave until r7. It said
     *     "`=` against a missing key would admit exactly the rows this exists to
     *     refuse", and the r6 gauntlet took that apart: clause 1 already requires
     *     the declared key to be present and non-NULL for the five room-bearing
     *     kinds, and the `ELSE room_id::text` covers the other three, so the CASE
     *     here is never NULL when clause 1 holds — and when clause 1 fails, `false
     *     AND anything` is `false` either way. **The two spellings are
     *     behaviourally identical under the shipped shape, and no test can
     *     separate them.** It is kept because clause 2 should not need clause 1 to
     *     be safe against a NULL, which is a property of *this* clause rather than
     *     of the pair — and, being unobservable, it is pinned structurally by
     *     `fails closed on a kind it does not enumerate, and says so structurally`
     *     rather than left as an argument.
     *
     * Wrapped in `coalesce(…, false)` so an event type this `CASE` does not
     * enumerate fails closed. The type column is an enum and `payload_type_matches`
     * pins the payload to it, so that is unreachable through the table today; a
     * ninth kind added without a room policy is refused rather than waved through.
     * That one *is* observable, and it went untested for two rounds: the test
     * above reads this constraint's expression back out of `pg_constraint` and
     * evaluates it against a ninth-kind payload, where dropping the `coalesce`
     * yields NULL — which a CHECK accepts — instead of `false`.
     *
     * A smuggled key whose value is JSON `null` (`proposal: {roomId: null}`) is
     * accepted, and that is not a gap: `->>'roomId'` is SQL NULL either way, the
     * key carries no room, and no fan-out or fold can read one out of it.
     *
     * The three room-less kinds (`proposal_rejected`, `proposal_superseded`,
     * `object_corrected`) still take their room from state, which is a question
     * only a fold can answer and a CHECK never can. That half is enforced one
     * layer up, inside `atrium_append_core_event`, which resolves the named
     * proposal or object back to the room its own ledger row landed in — the same
     * answer `resolveRoomId` gives on the command path, asked of the log instead
     * of the in-memory state. See `0007_kind_discriminated_room.sql`.
     */
    check(
      'core_events_payload_room_matches',
      sql`coalesce(array_remove(ARRAY[
        CASE WHEN ${t.payload}->'proposal'->>'roomId' IS NOT NULL THEN 'proposal.roomId' END,
        CASE WHEN ${t.payload}->'object'->>'roomId' IS NOT NULL THEN 'object.roomId' END,
        CASE WHEN ${t.payload}->'relation'->>'roomId' IS NOT NULL THEN 'relation.roomId' END,
        CASE WHEN ${t.payload}->>'roomId' IS NOT NULL THEN 'roomId' END
      ], NULL) = CASE ${t.payload}->>'type'
        WHEN 'proposal_recorded' THEN ARRAY['proposal.roomId']
        WHEN 'object_accepted' THEN ARRAY['object.roomId']
        WHEN 'relation_added' THEN ARRAY['relation.roomId']
        WHEN 'message_posted' THEN ARRAY['roomId']
        WHEN 'attention_resolved' THEN ARRAY['roomId']
        WHEN 'plan_opened' THEN ARRAY['roomId']
        WHEN 'plan_settled' THEN ARRAY['roomId']
        WHEN 'session_opened' THEN ARRAY['roomId']
        WHEN 'session_settled' THEN ARRAY['roomId']
        WHEN 'session_failed' THEN ARRAY['roomId']
        WHEN 'signal_raised' THEN ARRAY['roomId']
        WHEN 'plan_rlimit_set' THEN ARRAY['roomId']
        WHEN 'draw_refused' THEN ARRAY['roomId']
        WHEN 'session_signaled' THEN ARRAY['roomId']
        WHEN 'session_subscribed' THEN ARRAY['roomId']
        WHEN 'session_phase_changed' THEN ARRAY['roomId']
        WHEN 'proposal_rejected' THEN ARRAY[]::text[]
        WHEN 'proposal_superseded' THEN ARRAY[]::text[]
        WHEN 'object_corrected' THEN ARRAY[]::text[]
      END AND ${t.roomId}::text IS NOT DISTINCT FROM CASE ${t.payload}->>'type'
        WHEN 'proposal_recorded' THEN ${t.payload}->'proposal'->>'roomId'
        WHEN 'object_accepted' THEN ${t.payload}->'object'->>'roomId'
        WHEN 'relation_added' THEN ${t.payload}->'relation'->>'roomId'
        WHEN 'message_posted' THEN ${t.payload}->>'roomId'
        WHEN 'attention_resolved' THEN ${t.payload}->>'roomId'
        WHEN 'plan_opened' THEN ${t.payload}->>'roomId'
        WHEN 'plan_settled' THEN ${t.payload}->>'roomId'
        WHEN 'session_opened' THEN ${t.payload}->>'roomId'
        WHEN 'session_settled' THEN ${t.payload}->>'roomId'
        WHEN 'session_failed' THEN ${t.payload}->>'roomId'
        WHEN 'signal_raised' THEN ${t.payload}->>'roomId'
        WHEN 'plan_rlimit_set' THEN ${t.payload}->>'roomId'
        WHEN 'draw_refused' THEN ${t.payload}->>'roomId'
        WHEN 'session_signaled' THEN ${t.payload}->>'roomId'
        WHEN 'session_subscribed' THEN ${t.payload}->>'roomId'
        WHEN 'session_phase_changed' THEN ${t.payload}->>'roomId'
        ELSE ${t.roomId}::text
      END, false)`,
    ),
    /**
     * The snapshot is a list of `{id, authorId, body}`, all strings.
     *
     * Checked rather than trusted, for the same reason every other lifted column
     * here is: this row is what a replay folds, and a writer that never went
     * through the server must not be able to leave a window a replay cannot read.
     * Expressed as "count the good elements and require them all", rather than as
     * "find a bad one". The natural-looking negative form —
     * `NOT jsonb_path_exists(…, '$[*] ? (@.id.type() != "string" || …)')` — was
     * the first draft and it is wrong in a way worth recording: a jsonpath filter
     * over a *missing* member yields unknown rather than true, so an element with
     * no `body` at all matches nothing and passes. It rejects wrong types and
     * admits absent keys, which is the more likely mistake of the two.
     *
     * `jsonb_path_query_array` is immutable, which is what makes it usable in a
     * CHECK; a subquery over `jsonb_array_elements` would not be.
     */
    check(
      'core_events_trusted_messages_shape',
      sql`${t.trustedMessages} IS NULL OR (
        jsonb_typeof(${t.trustedMessages}) = 'array'
        AND jsonb_array_length(${t.trustedMessages}) = jsonb_array_length(jsonb_path_query_array(${t.trustedMessages}, '$[*] ? (@.id.type() == "string" && @.authorId.type() == "string" && @.body.type() == "string")'))
      )`,
    ),
    /**
     * The actor rule, **inverted** by #21's contract — and it is the same rule.
     *
     * r1's major 2 said: a lifted column that can disagree with the payload lets
     * a writer mint a row that replays as something other than what it is. r2
     * answered it with `payload->'actor' = actor`, which was right for a world
     * where the payload had an actor.
     *
     * #21 r2/r3 removed the actor from `CoreEvent` entirely: the payload has no
     * place to put one and `CoreEvent.parse` throws on an input that carries one.
     * Equality is therefore unsatisfiable, and deleting the constraint would
     * delete the finding — a payload could carry a stray `actor` key that the
     * reducer refuses at parse time on the live path but that nothing stops from
     * sitting in the ledger looking authoritative to the next reader.
     *
     * So the equality becomes the only equality left that says the same thing:
     * the payload holds **no** actor, and the columns hold the only one. There is
     * exactly one actor per row, in exactly one place, by constraint.
     */
    check('core_events_payload_has_no_actor', sql`NOT jsonb_exists(${t.payload}, 'actor')`),
    /**
     * `actor_id` is the user id for a human or an agent and the model id for a
     * model, and is NULL for the system actor and only for it. Without this,
     * `{kind:'system', actor_id:'alice'}` is a row that reads as a person having
     * done something the process did.
     */
    check(
      'core_events_actor_id_matches_kind',
      sql`(${t.actorKind} = 'system') = (${t.actorId} IS NULL)`,
    ),
    check('core_events_actor_id_not_blank', sql`${t.actorId} IS NULL OR length(${t.actorId}) > 0`),
    index('core_events_actor_idx').on(t.actorKind, t.actorId),
    /**
     * "Anything at all under this uuid, of any kind" — which the composite index
     * above cannot answer without a scan, because `actor_kind` leads it.
     *
     * Its one caller is `atrium_users_principal_kind_matches_history`
     * (drizzle/0018), which runs on every `users` INSERT and asks exactly that
     * question: has this uuid already appended history as the other sort of
     * participant? Without this index that guard turns each signup into a
     * sequential scan of the ledger.
     */
    index('core_events_actor_id_idx').on(t.actorId),
  ],
);

/* ── conversation substrate (append-only) ───────────────────────────────── */

/**
 * The durable answer to “did this command already commit?”.
 *
 * A receipt names a contiguous room-sequence interval rather than copying the
 * events into a second json document. `core_events` remains the one history;
 * retries read the exact rows the first attempt committed. The ledger's global
 * append lock makes a batch contiguous, and the two composite foreign keys
 * prove both ends belong to this room. The endpoint equation then proves the
 * claimed count without trusting a caller-supplied list of event ids.
 *
 * `actor_id` is deliberately non-null. Idempotent participant commands may be
 * issued by humans, by agents and by named models; the system actor has no
 * stable id and may not claim a retry key. This keeps the same `(actor_kind, actor_id)` spelling
 * as `core_events` while making the unique key an ordinary PostgreSQL key with
 * no NULL corner case.
 */
export const commandReceipts = pgTable(
  'command_receipts',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    actorKind: actorKind('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    commandName: text('command_name').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Lowercase SHA-256 over a server-canonical, versioned command payload. */
    payloadFingerprint: text('payload_fingerprint').notNull(),
    firstRoomSeq: bigint('first_room_seq', { mode: 'number' }).notNull(),
    lastRoomSeq: bigint('last_room_seq', { mode: 'number' }).notNull(),
    eventCount: integer('event_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'command_receipts_key',
      columns: [t.roomId, t.actorKind, t.actorId, t.commandName, t.idempotencyKey],
    }),
    foreignKey({
      name: 'command_receipts_first_event_same_room_fk',
      columns: [t.roomId, t.firstRoomSeq],
      foreignColumns: [coreEvents.roomId, coreEvents.roomSeq],
    }),
    foreignKey({
      name: 'command_receipts_last_event_same_room_fk',
      columns: [t.roomId, t.lastRoomSeq],
      foreignColumns: [coreEvents.roomId, coreEvents.roomSeq],
    }),
    check('command_receipts_actor_has_identity', sql`${t.actorKind} <> 'system'`),
    check('command_receipts_actor_id_not_blank', sql`length(${t.actorId}) > 0`),
    check('command_receipts_command_name_not_blank', sql`length(${t.commandName}) > 0`),
    check(
      'command_receipts_idempotency_key_bounded',
      sql`length(${t.idempotencyKey}) BETWEEN 1 AND 128`,
    ),
    check(
      'command_receipts_fingerprint_is_sha256',
      sql`${t.payloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check('command_receipts_event_count_positive', sql`${t.eventCount} > 0`),
    check('command_receipts_first_seq_positive', sql`${t.firstRoomSeq} > 0`),
    check(
      'command_receipts_interval_matches_count',
      sql`${t.lastRoomSeq} = ${t.firstRoomSeq} + ${t.eventCount} - 1`,
    ),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    claimedByMessageId: uuid('claimed_by_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('attachments_room_id_key').on(t.roomId, t.id),
    uniqueIndex('attachments_room_key_key').on(t.roomId, t.key),
    foreignKey({
      name: 'attachments_claim_message_same_room_fk',
      columns: [t.roomId, t.claimedByMessageId],
      foreignColumns: [messages.roomId, messages.id],
    }),
    check('attachments_name_not_blank', sql`length(${t.name}) > 0`),
    check('attachments_content_type_not_blank', sql`length(${t.contentType}) > 0`),
    check('attachments_size_positive', sql`${t.size} > 0`),
    check('attachments_size_bounded', sql`${t.size} <= 26214400`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Global monotonic order. Realtime clients page and resume on this. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    replyToId: uuid('reply_to_id'),
    /** Client-supplied idempotency key so a retried send never duplicates. */
    clientMessageId: text('client_message_id'),
    /**
     * THE ROUTING RECEIPT ON THE ANSWER ARM (#128, #124 resolution 3).
     *
     * The room message this one was posted in reply to as a ROUTED answer — the
     * third arm of Glance §9.3's trichotomy, where the first two are a steer
     * (`session_signals.cause_message_id`) and new work (`plans` / `sessions`
     * below). Nullable, and null for almost every message ever written: a person
     * typing in a channel routes nothing, and neither does an agent speaking on
     * its own initiative.
     *
     * NOT `reply_to_id`, and the distinction is the reason this column exists.
     * `reply_to_id` is a THREADING edge a client renders; this is a claim that a
     * daemon consumed that message and this append is what it did about it. The
     * two are independently nullable and an answer may carry either, both, or
     * neither.
     */
    causeMessageId: uuid('cause_message_id'),
    /** `[{ key, name, contentType, size }]` — objects live in S3/MinIO. */
    attachments: jsonb('attachments').$type<MessageAttachment[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_seq_key').on(t.seq),
    index('messages_room_seq_idx').on(t.roomId, t.seq),
    /** Retry keys are owned by their authenticated author, matching command receipts. */
    uniqueIndex('messages_room_author_client_id_key').on(t.roomId, t.authorId, t.clientMessageId),
    /** The composite-FK target: lets other tables demand "in *this* room". */
    uniqueIndex('messages_room_id_key').on(t.roomId, t.id),
    /**
     * A reply must be to a message in the same room, not merely to a message.
     *
     * No `ON DELETE SET NULL` here or on any other composite FK in this file:
     * Postgres would null *every* referencing column, `room_id` included, and
     * `room_id` is NOT NULL — so the action can only ever fail. NO ACTION is
     * the honest choice and costs nothing, because none of these rows are ever
     * deleted individually (messages and objects are append-only; a mistake is
     * a correction). Dropping a whole room still works: the cascade from
     * `rooms` removes every referencing row in the same statement, and NO
     * ACTION is checked at end of statement.
     */
    foreignKey({
      name: 'messages_reply_to_same_room_fk',
      columns: [t.roomId, t.replyToId],
      foreignColumns: [t.roomId, t.id],
    }),
    /**
     * A routed answer's cause is a message in the SAME room (#128, #124
     * resolution 3). The same composite shape `session_signals` uses for its
     * steer receipt, for the same reason: routing appends land in the agent's
     * channel room only, and a cause from another room is not a cause this room
     * can show. NO ACTION for the reason the reply edge above gives.
     */
    foreignKey({
      name: 'messages_cause_same_room_fk',
      columns: [t.roomId, t.causeMessageId],
      foreignColumns: [t.roomId, t.id],
    }),
  ],
);

export interface MessageAttachment {
  /** Absent only on pre-0015 legacy JSON rows. New events require it. */
  id?: string;
  key: string;
  name: string;
  contentType: string;
  size: number;
}

/* ── interpretation bookkeeping (issue #16) ─────────────────────────────── */

/**
 * One row per (message, interpretation_version). The unique constraint is the
 * belt-and-braces half of the idempotency pattern: pg-boss guarantees the job
 * runs at least once, this guarantees running it again is a no-op on the end
 * state. Bumping `interpretation_version` re-interprets without overwriting the
 * previous run's provenance.
 */
export const interpretations = pgTable(
  'interpretations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    interpretationVersion: integer('interpretation_version').notNull().default(1),
    model: text('model'),
    status: interpretationStatus('status').notNull().default('pending'),
    /** Raw structured output from the model, kept for audit and replay. */
    raw: jsonb('raw'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('interpretations_message_version_key').on(t.messageId, t.interpretationVersion),
    index('interpretations_status_idx').on(t.status),
  ],
);

/* ── the agent / plan / session trunk (#116, from #114's resolution) ─────── */

/**
 * An agent's config sidecar. **An agent IS a `users` row** with
 * `principal_kind = 'agent'` (#96, drizzle/0017); this 1:1 table (PK = the
 * agent's `user_id`) carries the config that has no place on `users`, which
 * Better Auth shares. Kept off `users` for that reason, and keyed by it so the
 * two are one identity.
 *
 * ## The chain terminates at a human, BY SCHEMA (#114's init anchor)
 *
 * `owner_user_id` is NOT NULL and, by the `agents_owner_is_human` trigger
 * (drizzle/0021, modelled on 0017's immutable-`principal_kind` reads), points
 * at a `users` row whose `principal_kind` is `human`. `user_id` points, by the
 * `agents_user_is_agent` trigger, at one whose kind is `agent`. So "the
 * ownership chain ends at a person" is not a convention the app maintains — it
 * is a pair of triggers, on the same axis 0017 uses, that refuse the row
 * otherwise. Neither read takes a lock: `principal_kind` is immutable, so there
 * is no update to race.
 *
 * The budget/host/harness/model columns are the §9.2 "who owns what number"
 * placeholders — the budget ROOT lives here, a plan takes an rlimit slice, a
 * session spends. Enforcement is #115; this only carries the numbers.
 */
export const agents = pgTable(
  'agents',
  {
    /** The agent principal this configures — 1:1 with the `users` row. */
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The human who owns this agent. NOT NULL — an agent always has an owner —
     * and held to a `human` principal by `agents_owner_is_human`. `restrict`, so
     * an owner cannot be deleted out from under the agent it is accountable for.
     */
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * The room that is this agent's channel — the one it OWNS (#114 T1),
     * reciprocal to `rooms.agent_user_id`. NOT NULL: an agent has exactly one
     * channel. This is the column the pstree room trigger keys on — a plan's
     * room must equal its agent's `channel_room_id`.
     */
    channelRoomId: uuid('channel_room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** Where the agent's harness runs. Config placeholder (#115 owns semantics). */
    host: text('host').notNull(),
    /** The default harness a session under this agent runs (a session may override). */
    harness: text('harness').notNull(),
    /** The default model. */
    model: text('model').notNull(),
    /** The agent's budget root, in micro-dollars. Nullable = no cap set yet. */
    budgetLimitMicros: bigint('budget_limit_micros', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agents_owner_idx').on(t.ownerUserId),
    uniqueIndex('agents_channel_room_key').on(t.channelRoomId),
    /**
     * Reciprocity: an agent's channel is a room IT owns (#116 fix r2,
     * drizzle/0024). `(channel_room_id, user_id) → rooms(id, agent_user_id)` holds
     * `rooms.agent_user_id = agents.user_id` for the channel — refused at INSERT
     * and under UPDATE of either side, closing the round-1 leak where a channel
     * could point at a room owned by NULL / a human / a different agent. With the
     * unique `rooms_agent_user_id_key` (one channel per agent) this also makes
     * `channel_room_id` immutable as a theorem: there is no other room the agent
     * owns to move the channel to, so the plan-orphaning UPDATE has no legal
     * spelling. `plans_room_matches_agent_channel` (0022) then needs no lock, as
     * its comment already assumed.
     */
    foreignKey({
      name: 'agents_channel_owned_fk',
      columns: [t.channelRoomId, t.userId],
      foreignColumns: [rooms.id, rooms.agentUserId],
    }).onDelete('cascade'),
  ],
);

/**
 * A plan — a process group projected from the ledger-only `plan_opened` /
 * `plan_settled` events. A board, not a process: progress, a spend rollup, a
 * receipt index; no context window and no terminal (§4). Truth stays on the
 * spine; this table is a projection of it.
 *
 * The `(room_id, id)` unique index is the **composite-FK target** a session's
 * parent edge lands on: a session's `(room_id, plan_id)` points here, so a
 * session and its plan are always in one room. `agent_user_id` ties the plan to
 * its agent, and the `plans_room_matches_agent_channel` trigger (drizzle/0022)
 * refuses any plan whose `room_id` is not that agent's `channel_room_id` — the
 * third of the four ways the pstree invariant is a DB fact.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** The agent whose work this plan groups. */
    agentUserId: uuid('agent_user_id')
      .notNull()
      .references(() => agents.userId, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: planStatus('status').notNull().default('open'),
    /** The rlimit slice this plan may spend, in micro-dollars. Nullable placeholder. */
    budgetLimitMicros: bigint('budget_limit_micros', { mode: 'number' }),
    /** Rollup of its sessions' spend, in micro-dollars. */
    spentMicros: bigint('spent_micros', { mode: 'number' }).notNull().default(0),
    /**
     * THE ENFORCED CEILING (#118, #115's resolution decision 1). A human-set
     * ceiling on the number of *authorized draws* — spawns/continues — this plan
     * may be granted. `NULL` means UNFUNDED: fail CLOSED, a ceiling of ZERO —
     * every draw is refused until a human sets a finite slice (#118 fix r2, CS-1;
     * `commands.ts`'s `open_session` reads a null slice as 0, not as "no limit").
     * A finite value is a hard ceiling, and the ONLY writer of it is
     * `projectPlanRlimitSet`, from the human-only `set_plan_rlimit` verb — no
     * machine-authored path raises a slice (that path is refused before the
     * append, like a machine trying to certify; `commands.ts`).
     *
     * Denominated in DRAWS, not micro-dollars, and that is the whole point: the
     * enforced quantity is the count of draws Atrium itself GRANTED, which it
     * records and cannot be lied to about — so a session under-reporting its spend
     * (`spent_micros`, `sessions.spend_micros`) cannot get one more draw than the
     * slice funds. The `~` dollar layer (`budget_limit_micros` intent,
     * `spent_micros` reported spend) is STRUCTURALLY SEPARATE and never the
     * enforcement variable; a divergence between the two is a row that won't
     * balance, surfaced to the human, not a gate.
     */
    rlimitSlice: bigint('rlimit_slice', { mode: 'number' }),
    /**
     * The committed authorized-draw accounting: how many draws Atrium has granted
     * under this plan. Incremented by exactly one inside the same append
     * transaction as each draw it grants, under the global ledger lock, so it
     * cannot be forged. This is the number the draw gate reads and compares to
     * `rlimit_slice` — never the adapter-reported `spent_micros`.
     *
     * ## A draw is a SPAWN **or** a CONTINUE (#127, from #115 decision 2)
     *
     * #115 defined the slice as authorized "spawns/continues", and #118 built only
     * the spawn half — so this column's original sentence said it "equals
     * `count(sessions)` for the plan by construction". That identity was an
     * artifact of the missing half, not the invariant: #123's resolution point 2
     * makes RESUME a draw, and `projectSessionSignaled` increments this column by
     * one for a granted `session_signaled {kind:'resume'}` exactly as
     * `projectSessionOpened` does for a `session_opened`. So the identity is now
     * `count(sessions) + count(granted resumes)`, and a resume that would exceed
     * the slice takes the same durable `draw_refused` receipt a spawn does. The
     * enforced quantity is unchanged: draws Atrium itself granted. `steer` and
     * `interrupt` are NOT draws and never touch this column.
     */
    authorizedDraws: bigint('authorized_draws', { mode: 'number' }).notNull().default(0),
    /**
     * THE ROUTING RECEIPT ON THE NEW-WORK ARM'S BOARD (#128, #124 resolution 3).
     *
     * The room message this plan was opened in response to. Nullable — a human
     * opening a board by hand cites nothing, and the resolution names that case
     * outright.
     *
     * A PLAN NEVER DRAWS (#124 resolution 2, grok r3): only session spawns and
     * continues pass #118's slice boundary, so this column takes NO `funded_arms`
     * claim — a plan is not a draw and must not consume a draw claim. That
     * SPEND exemption stands.
     *
     * It does, however, carry a distinct BOARD-level idempotency of its own
     * (#148 FIX 1, `plans_room_cause_routed_key` below): at most one plan per
     * `(room, cause)` when the cause is non-null. The daemon opens a plan by
     * sending `open_plan` and only THEN journaling the request; a crash in that
     * window replays the goal and re-sends `open_plan`, and without a server claim
     * that second send opens a permanently-orphaned empty board (it never draws —
     * the cause has already advanced — and never settles). The funded-arm claim
     * covers the SESSION double-fund but says nothing about the free board, so a
     * durable daemon needs this. The earlier "two free boards cost nothing"
     * reasoning was spend-scoped and true for spend; the orphan board is a
     * durability wart the routing daemon surfaced. A HAND-opened plan cites no
     * cause (null) and stays free — the partial index only binds routed plans.
     */
    causeMessageId: uuid('cause_message_id'),
    /** The `core_events.id` of the `plan_opened` that projected this. */
    openedByEventId: text('opened_by_event_id'),
    /** The `core_events.id` of the `plan_settled`, once it has settled. */
    settledByEventId: text('settled_by_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('plans_room_status_idx').on(t.roomId, t.status),
    index('plans_agent_idx').on(t.agentUserId),
    /** The composite-FK target a session's parent edge lands on. */
    uniqueIndex('plans_room_id_key').on(t.roomId, t.id),
    /** A plan's cause is a message in the SAME room (#128, #124 resolution 3). */
    foreignKey({
      name: 'plans_cause_same_room_fk',
      columns: [t.roomId, t.causeMessageId],
      foreignColumns: [messages.roomId, messages.id],
    }),
    /**
     * AT MOST ONE PLAN PER ROUTED CAUSE (#148 FIX 1) — the board-level analogue of
     * `funded_arms`. PARTIAL, on `cause_message_id IS NOT NULL`: a hand-opened
     * plan cites nothing and stays free, so this binds only the daemon's routed
     * `open_plan`s, where `cause_message_id` is set. It is the durable authority
     * behind `requirePlanCauseUnclaimed` in `commands.ts`: a crash-replay re-send
     * of `open_plan` for a cause that already opened a board is refused, so the
     * daemon opens exactly one board per goal across any crash seam. Distinct from
     * `funded_arms`: a plan takes no draw claim; this is a plan claim.
     */
    uniqueIndex('plans_room_cause_routed_key')
      .on(t.roomId, t.causeMessageId)
      .where(sql`${t.causeMessageId} IS NOT NULL`),
    /** A slice is a count of draws — never negative. NULL (unfunded) is allowed. */
    check('plans_rlimit_slice_nonnegative', sql`${t.rlimitSlice} IS NULL OR ${t.rlimitSlice} >= 0`),
    /** Draws granted only ever counts up from zero. */
    check('plans_authorized_draws_nonnegative', sql`${t.authorizedDraws} >= 0`),
  ],
);

/**
 * A session — a process projected from `session_opened` / `session_settled` /
 * `session_failed`. Own context and spend, any harness; it settles or fails to
 * a receipt and it **never spawns** (§4, §9).
 *
 * ## The pstree invariant, by construction (#114, four ways)
 *
 *  1. `plan_id` is NOT NULL and its `(room_id, plan_id)` composite FK lands on
 *     `plans(room_id, id)` — so a session has **exactly one** parent, in the
 *     **same room**. One parent, one room, enforced.
 *  2. **There is no `parent_session_id` column here, or anywhere.** A session
 *     cannot be another session's parent because there is no FK by which it
 *     could be — you cannot violate a constraint that does not exist (#111's
 *     strongest form). Depth is fixed at agent → plan → session because those
 *     are the only parent FKs that exist.
 *
 * `sessions.status` / `exit_summary` / `spend_micros` are the session-EXIT
 * receipt — process state, **non-epistemic (#114 T3)**. A `session_settled` or
 * `session_failed` writes only these; it touches no `accepted_objects`
 * judgement column and so can never flip a `~` to a `✓`.
 */

/**
 * One contiguous hunk of a unified diff — its `@@` header and its body lines,
 * exactly as git emits them (#145). Each body line keeps git's leading marker:
 * `' '` context, `'+'` added, `'-'` removed, `'\'` the no-newline marker. The
 * render reads the marker to colour the line; nothing here is interpreted.
 */
export interface SessionDiffHunk {
  /** The `@@ -a,b +c,d @@` header line git wrote for this hunk. */
  readonly header: string;
  /** The hunk body, each line prefixed by git's ` `/`+`/`-`/`\` marker. */
  readonly lines: readonly string[];
}

/** One file's change in a structured diff (#145). */
export interface SessionDiffFile {
  /** The file's path (the post-image path for an add/modify/rename). */
  readonly path: string;
  /** The pre-rename path, present only when `status === 'renamed'`. */
  readonly oldPath?: string;
  /** What happened to the file. */
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Lines added in this file (from git numstat — the whole file, not the cap). */
  readonly additions: number;
  /** Lines removed in this file (from git numstat — the whole file, not the cap). */
  readonly deletions: number;
  /** A binary file carries no textual hunks; git reports only that it changed. */
  readonly binary: boolean;
  /** The retained hunks. Empty for a binary file, or when the line cap trimmed them. */
  readonly hunks: readonly SessionDiffHunk[];
}

/**
 * THE REAL STRUCTURED DIFF THE PRODUCER COMPUTED (#145) — per-file hunks the
 * ExecutionProvider derived from the git diff of its scratch worktree against the
 * seeded upstream ref, so the review pane renders the ACTUAL change, not a
 * one-line summary.
 *
 * ## PRESENT-BUT-EMPTY IS A DIFFERENT FACT FROM ABSENT
 *
 * The field being PRESENT means the producer computed a diff. An EMPTY `files`
 * array is then an HONEST EMPTY — the producer ran and the worktree matched the
 * seeded upstream, a real "no changes" it can vouch for. That is a different fact
 * from the whole `diff` field being ABSENT (`undefined`): a merge/branch-only
 * artifact, a session that predates #145, or any producer that reported no diff
 * at all. The render distinguishes the two — present+empty says "no changes",
 * absent says "no diff recorded" — so the pane never lets one stand in for the
 * other. Non-epistemic: a `~` fact the adapter reports, never an `accepted_objects`
 * `✓`.
 *
 * ## THE CAP IS HONEST
 *
 * `files` and each file's `hunks` are CAPPED so a huge diff can never blow the
 * jsonb row or the DB (see `MAX_DIFF_*` in `execution/git.ts`). The whole-diff
 * totals (`fileCount`/`additions`/`deletions`) come from git numstat over the
 * ENTIRE diff, so they describe the real change even when the carried hunks are a
 * truncated prefix; `truncated` says so and the render prints "N files, truncated".
 */
export interface SessionDiff {
  /** The retained (possibly capped) per-file changes. Empty array = honest empty. */
  readonly files: readonly SessionDiffFile[];
  /** Total changed files across the WHOLE diff, before any cap. */
  readonly fileCount: number;
  /** Total additions across the WHOLE diff, before any cap. */
  readonly additions: number;
  /** Total deletions across the WHOLE diff, before any cap. */
  readonly deletions: number;
  /** True when `files`/`hunks` are a truncated prefix of the whole diff. */
  readonly truncated: boolean;
}

/**
 * THE HARNESS'S OWN TEST REPORT (#145). PRESENT means the producer reported a
 * test run — `passed: 0, failed: 0` is an honest "ran, nothing to report", which
 * is a different fact from the whole `tests` field being ABSENT (no run reported).
 * The render distinguishes the two. Non-epistemic, like the diff beside it.
 */
export interface SessionTestResults {
  /** Tests that passed. */
  readonly passed: number;
  /** Tests that failed. */
  readonly failed: number;
  /** The names of failing tests, capped (see `MAX_TEST_FAILURES`). */
  readonly failures: readonly string[];
  /** True when `failures` is a truncated prefix of the whole failing set. */
  readonly failuresTruncated: boolean;
  /**
   * WHAT PRODUCED THESE NUMBERS (#145 r2, FIX 2) — the test command or harness
   * suite that ran, carried as provenance so the review pane can render the block
   * as an explicit reported-not-verified `~` fact instead of a bare green pass that
   * reads as a covenant `✓`. Optional: a producer that reported no command still
   * renders as `~` reported, it just cannot name the runner. A `~` fact the adapter
   * reports, never a certification.
   */
  readonly command?: string;
}

/**
 * The execution artifact a settled session produced — #120's ExecutionProvider
 * output, surfaced in #121's review pane and enriched in #145. All fields
 * optional: the shape a merge carries (branch + commit) differs from what a real
 * shim session carries (branch + commit + structured diff + tests), and an audit
 * session carries neither.
 *
 * `diff`/`tests` (#145) are the STRUCTURED enrichment — real per-file hunks and a
 * pass/fail block. `diffStat`/`testsPassed`/`testsFailed` are the older one-line
 * scalars; both remain for a producer that only carries a summary, and the render
 * prefers the structured field when present, falling back to the scalar. All are
 * non-epistemic `~` facts the adapter reports (#114 T3), never a covenant `✓`.
 */
export interface SessionArtifact {
  /** The branch the work landed on, when it produced one. */
  readonly branch?: string;
  /** The commit sha, when it produced one. */
  readonly commit?: string;
  /** The real structured diff the producer computed (#145). Present-but-empty ≠ absent. */
  readonly diff?: SessionDiff;
  /** The harness's structured test report (#145). Present-but-zero ≠ absent. */
  readonly tests?: SessionTestResults;
  /** A one-line diff summary — additions, deletions, files touched (legacy scalar). */
  readonly diffStat?: string;
  /** Tests that passed, when the session ran a suite (legacy scalar). */
  readonly testsPassed?: number;
  /** Tests that failed, when the session ran a suite (legacy scalar). */
  readonly testsFailed?: number;
  /** A free one-line note about the artifact — kept short, system voice. */
  readonly summary?: string;
}

/** The three phases a running session's work moves through (#159, decided in #152). */
export type SessionPhase = 'planning' | 'writing' | 'testing';

/**
 * THE LIVE PROGRESS SNAPSHOT (#159, decided in #152) — a projection ROW, never a
 * ledger payload.
 *
 * A running session streams its work as ephemeral frames (`session_heartbeat`,
 * `session_diff_delta`) that are lost on reconnect and a durable phase timeline
 * (`session_phase_changed`). This column is the LATE-JOIN/LOSS-RECOVERY snapshot:
 * a cross-instance client that just subscribed reads it (an authenticated row
 * read) and then applies live frames whose `progressSeq` is greater. It is
 * cleared (set null) by the settle projection — at terminal the durable receipt
 * (`sessions.artifact`) REPLACES the stream wholesale, so a stale preview never
 * outlives the real object.
 *
 * COVENANT (#152 boundary point 2): nothing here is epistemic. There is no
 * `certified`/`verified` field and there can never be one — every value is a `~`
 * draft the running process reported, and the `diff` reuses the receipt's own
 * `SessionDiff` schema (one diff dialect, ceilinged and coherence-checked), NOT a
 * second lossier copy free to disagree.
 */
export interface SessionProgress {
  /** The server-assigned per-session progress counter this snapshot was written at. */
  readonly progressSeq: number;
  /** The last durable phase, or null before any phase was reported. */
  readonly phase: SessionPhase | null;
  /** Last reported spend, micro-dollars — a `~` fact, never enforced on (§9.2). */
  readonly spendMicros: number | null;
  /** Last reported context-window fill, 0..1 — the session's own, never aggregated. */
  readonly contextPct: number | null;
  /** The latest coalesced diff, in the receipt's own `SessionDiff` dialect. */
  readonly diff?: SessionDiff;
  /** ISO wall-clock of the last snapshot write. */
  readonly updatedAt: string;
  /**
   * ISO wall-clock of the last HEARTBEAT specifically — the gate the server nacks
   * a heartbeat <1s apart against (#152 cadence). Distinct from `updatedAt`, which
   * also moves on a phase or a diff, so a diff 100ms before a heartbeat does not
   * spuriously block it.
   */
  readonly heartbeatAt?: string;
}

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** The plan that is this session's one parent. NOT NULL — see the table doc. */
    planId: uuid('plan_id').notNull(),
    /** This session's harness process. */
    harness: text('harness').notNull(),
    /** The model it runs. */
    model: text('model').notNull(),
    status: sessionStatus('status').notNull().default('open'),
    /** Its own context-window fill, 0..1. Never aggregated (§9.2). Nullable. */
    contextPct: real('context_pct'),
    /** Its own spend, in micro-dollars. */
    spendMicros: bigint('spend_micros', { mode: 'number' }).notNull().default(0),
    /** The session's exit receipt prose, once it settles or fails. */
    exitSummary: text('exit_summary'),
    /**
     * THE EXECUTION ARTIFACT (#120's forward slot, #121's review pane).
     *
     * What a settled session PRODUCED — the branch/commit it landed on, a diff
     * stat, and a test summary — so the control-plane review pane can show diff +
     * tests + receipt + artifact rather than only the exit prose. Nullable: a
     * session with no code output (an audit, a dry-run) leaves it null, and a
     * settled session that predates its ExecutionProvider leaves it null too. The
     * #120 ExecutionProvider is the eventual writer at settle time; until it
     * lands, this is the slot it fills, populated directly for a seeded session.
     * It is non-epistemic (#114 T3), the same as `exit_summary` beside it: a
     * process receipt, never an `accepted_objects` `~`→`✓`.
     */
    artifact: jsonb('artifact').$type<SessionArtifact>(),
    /**
     * THE LIVE PROGRESS SNAPSHOT (#159, decided in #152). A `~` preview of a
     * running session's work — phase, spend/context heartbeat, coalesced diff —
     * written by the `report_session_progress` command's projection and CLEARED
     * (set null) by the settle projection, where the durable receipt replaces the
     * stream wholesale. Non-epistemic and covenant-safe: no `certified`/`verified`
     * field exists here, and this column is `sessions`-local, so a progress write
     * can never reach an `accepted_objects` `✓` (pinned by `progress-writeset.test.ts`).
     */
    progress: jsonb('progress').$type<SessionProgress>(),
    /**
     * WHO LANDED THIS SESSION — the human who certified it, and only ever a
     * human. NULL until a person formally certifies (#121's hold-to-arm land),
     * and held to a `human` principal by the `sessions_certified_by_is_human`
     * trigger (drizzle/0032): certification is the covenant's human-only act made
     * a table fact, so no non-human path — no machine, no voice — can write a
     * name here even with triggers left on. `SET NULL` on the human's deletion:
     * the session's receipt outlives the identity, the same as its channel does.
     */
    certifiedBy: uuid('certified_by').references(() => users.id, { onDelete: 'set null' }),
    /** When the certification was armed and committed. NULL until certified. */
    certifiedAt: timestamp('certified_at', { withTimezone: true }),
    /**
     * How long the human held the arm control, measured — the asymmetric-friction
     * receipt (#102/#110). Recorded so a certification carries evidence it was a
     * deliberate hold, not a click. NULL until certified.
     */
    certifiedHeldMs: integer('certified_held_ms'),
    /**
     * WHO ARMED THE PENDING CERTIFICATION, and WHEN — stamped by the SERVER.
     *
     * #121 fix round. The first cut of the certify path took the hold's timing
     * from the CLIENT: the Server Action accepted `armedAt` and `heldMs` off the
     * request, so `{ heldMs: 999999 }` from `curl` certified a session without
     * anybody having held anything, and `{ heldMs: 0 }` did too. The asymmetric
     * friction the covenant asks for was measured entirely on the attacker's
     * side of the wire.
     *
     * These two columns are the fix. Arming is its own server round-trip and
     * `certify_armed_at` is written as `now()` INSIDE the database, never from a
     * value a request carried. Certification then computes the held duration as
     * `now() - certify_armed_at` in SQL and refuses anything under the required
     * hold. There is no client-supplied timing left to forge, and the recorded
     * `certified_held_ms` is a measurement rather than a claim.
     *
     * `certify_armed_by` is held to a `human` principal by the
     * `sessions_certify_armed_by_is_human` trigger (drizzle/0033), the same way
     * `certified_by` is by 0032: the arm is half of the human-only act, so a
     * machine may not perform it either.
     */
    certifyArmedBy: uuid('certify_armed_by').references(() => users.id, { onDelete: 'set null' }),
    /** The SERVER's clock at the arm — `now()`, never a value a request sent. */
    certifyArmedAt: timestamp('certify_armed_at', { withTimezone: true }),
    /**
     * THE ARM'S SINGLE-USE ATTEMPT ID — a `now()`-armed hold is a specific
     * attempt, not a 120s standing permission.
     *
     * #121 fix round, CS-3 finished. The gauntlet found that a server arm survived
     * its whole TTL and "a later direct confirm spends it": the arm was a window,
     * not a token. `certify_arm_nonce` is stamped with a fresh `gen_random_uuid()`
     * at arm and CONSUMED (set null) by the confirm that spends it, so the confirm
     * honours only an arm minted by `armCertification` (the one path that stamps a
     * nonce) and only once. A hand-forged or leaked arm without a live nonce is not
     * a confirmable attempt. NULL whenever no hold is pending. Cleared on disarm.
     */
    certifyArmNonce: uuid('certify_arm_nonce'),
    /**
     * A DIGEST OF THE ARTIFACT THE HOLD WAS ARMED OVER — so the signature binds to
     * the artifact the person REVIEWED, not merely to "an" artifact.
     *
     * #121 fix round, CS-1 finished. 0034 freezes the artifact once certified, but
     * between arm and confirm the artifact is still mutable: render A, change it to
     * B, confirm → 0034 froze B under a `✓` for work nobody reviewed. The arm now
     * records `md5(artifact::text)` of what was on screen; the confirm recomputes
     * it and REFUSES if the artifact changed underneath the hold. `md5` of jsonb's
     * canonical text is stable for equal jsonb. NULL when no hold is pending;
     * consumed (set null) by the confirm and cleared on disarm.
     */
    certifyArmedArtifactDigest: text('certify_armed_artifact_digest'),
    /*
     * ROUND 7 removed `certify_arm_seq` and `certify_cancel_seq` (drizzle/0040).
     * Round 6 threaded a CLIENT-minted, strictly-monotonic `attemptSeq` through the
     * arm/disarm/confirm and raised it into a session-global cancel watermark. That
     * was the round-7 finding-2 hole: any member could `disarm(MAX_SAFE_INTEGER)`
     * and jam every honest arm forever, and cross-client clock skew did it by
     * accident. The attempt is SERVER-ISSUED now — `certify_arm_nonce` is the whole
     * of it, minted by `armCertification` and returned to the client, which hands it
     * back on the confirm and disarm. No client number reaches the row, so none can
     * jam a future arm. The correlation the two dropped columns provided is the
     * nonce's job now, and it is a capability, not a counter.
     */
    /**
     * THE ROUTING RECEIPT ON THE NEW-WORK ARM'S PROCESS (#128, #124 resolution 3).
     *
     * The room message whose routing spawned this session. Nullable — a person
     * opening a session by hand cites nothing.
     *
     * A SPAWN IS A DRAW, so unlike `plans.cause_message_id` this one is ALSO
     * claimed in `funded_arms` when it is non-null: at most one funded arm per
     * cause message, across spawns and continues both, so a daemon that retries
     * the same message cannot fund two sessions from it (#124 resolution 4). The
     * column here is the provenance; the claim row is the enforcement.
     */
    causeMessageId: uuid('cause_message_id'),
    /** The `core_events.id` of the `session_opened` that projected this. */
    openedByEventId: text('opened_by_event_id'),
    /** The `core_events.id` of the settling/failing event, once it exits. */
    settledByEventId: text('settled_by_event_id'),
    /**
     * EXECUTION-OWNERSHIP LEASE (#120 round-5 F4) — process-liveness bookkeeping,
     * NOT covenant state and NOT written by the ledger projection. The instance id
     * of the process whose ExecutionProvider is running this session, set when the
     * coordinator claims the session and NULL for a session no local execution
     * owns (the documented external-settle mode). Startup/periodic reconciliation
     * reads it to tell a wedge THIS lineage must recover (leased, owner gone) from
     * a live external-settle session (never leased) it must leave alone — replacing
     * the round-4 boot-flag proxy that force-failed live external sessions on a
     * disabled→enabled reboot and killed a peer instance's running sessions.
     */
    executionOwner: text('execution_owner'),
    /**
     * Last heartbeat from the owning process (#120 round-5 F4). Bumped on a timer
     * while the owner runs; a lease whose heartbeat has gone stale is a dead
     * owner's, and only THOSE are reconciled — a fresh heartbeat is a live owner,
     * whether this process or a concurrent peer, and its session is left running.
     */
    executionHeartbeatAt: timestamp('execution_heartbeat_at', { withTimezone: true }),
    /**
     * EXECUTION-AUTHORITY RECORD (#120 round-6) — the mode this session's
     * execution runs under, decided AT GRANT and written in the `session_opened`
     * transaction. `provider` = a wired ExecutionProvider owns its execution and
     * its terminal; `external` = no provider this boot, an outside member settles
     * it (the documented external-settle mode). NULL for pre-migration rows, read
     * as `external`. This is what a settle reads to know whether the capability
     * token is required — bound to the SESSION, never to the boot's verifier.
     */
    executionMode: text('execution_mode'),
    /**
     * The unforgeable settlement CAPABILITY for a provider session (#120 round-6),
     * minted at grant. Authorizes writing this session's terminal — settled OR
     * failed. ROW-ONLY: never in the ledger event, never broadcast, so a room
     * member (opener included) cannot forge either outcome. Held by the coordinator
     * (via `claim`) and the reconciler (via a row read). NULL for external.
     */
    executionAuthority: text('execution_authority'),
    /**
     * NULL while a granted provider session is unclaimed; set exactly once when the
     * coordinator claims it (#120 round-6, unclaimed → running). The claim's guarded
     * UPDATE keys on this being NULL, so a re-entrant claim matches zero rows.
     */
    executionClaimedAt: timestamp('execution_claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_plan_idx').on(t.planId),
    index('sessions_room_status_idx').on(t.roomId, t.status),
    /** Reconciliation scans open, leased sessions by heartbeat (#120 round-5 F4). */
    index('sessions_execution_owner_idx').on(t.status, t.executionOwner, t.executionHeartbeatAt),
    /** The claim keys on an unclaimed provider session (#120 round-6). */
    index('sessions_execution_claim_idx')
      .on(t.executionMode, t.executionClaimedAt)
      .where(sql`${t.status} = 'open'`),
    /** The composite-FK target for provenance edges (`accepted_objects`/`proposals`). */
    uniqueIndex('sessions_room_id_key').on(t.roomId, t.id),
    /**
     * The one parent, in the same room. `plan_id` NOT NULL above makes it exactly
     * one; this composite FK makes it the same room's plan. There is no second
     * parent FK and no `parent_session_id`, so this is the whole of a session's
     * upward edge — agent → plan → session, and nothing deeper.
     */
    foreignKey({
      name: 'sessions_plan_same_room_fk',
      columns: [t.roomId, t.planId],
      foreignColumns: [plans.roomId, plans.id],
    }).onDelete('cascade'),
    /** A session's cause is a message in the SAME room (#128, #124 resolution 3). */
    foreignKey({
      name: 'sessions_cause_same_room_fk',
      columns: [t.roomId, t.causeMessageId],
      foreignColumns: [messages.roomId, messages.id],
    }),
    /**
     * TERMINAL-NULL PROGRESS IS A TABLE FACT (#159, decided in #152). The settle
     * projection clears `progress` to NULL in the same UPDATE as the exit receipt —
     * the durable receipt replaces the live stream wholesale — and this CHECK makes
     * that a construction-time invariant rather than one writer's discipline: a
     * settled/failed session may not carry a live `~` preview. Enforced here (schema
     * + drizzle/0049) and, for a LATER mutation of an already-terminal row, by the
     * `sessions_terminal_immutable` trigger's `progress` clause (0049).
     */
    check('sessions_progress_open_or_null', sql`${t.status} = 'open' OR ${t.progress} IS NULL`),
  ],
);

/* ── the signal/interrupt boundary (#127, from #123's resolution) ────────────
 *
 * Two projections of two ledger-only events, and they are the ONLY tables those
 * events write. The pinned write-set: `session_signals` and
 * `session_subscriptions` and nothing else — no `accepted_objects` column, no
 * `plans.rlimit_slice`, and (for `steer`/`interrupt`) no `plans.authorized_draws`.
 * A steer is coordination, not the room's understanding, and coordination has no
 * route to a `✓`. The single deliberate exception is a granted `resume`, which IS
 * a draw and moves `authorized_draws` by exactly one under #118's boundary —
 * #115 decision 2's "spawns/continues", finally built.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A durable WAIT registered by a running session (#127; #123 resolution 6).
 *
 * `expires_at` is NOT NULL and that is the whole design. An unmatched subscribe
 * used to be a way to hold a session open forever with nothing owed to anybody:
 * the plan could never settle (#119), and no human ever learned why. So a
 * subscription has exactly three ways to end — matched into a resume draw,
 * expired into the owner's attention, or disposed by its session's own exit —
 * and `status` records which. `matcher` and `source` are opaque here on purpose:
 * what a wait means is the daemon's business (#124), and the ledger's business is
 * that the wait exists, targets an OPEN session, and ends.
 */
export const sessionSubscriptions = pgTable(
  'session_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** The session that is waiting. Same room, by the composite FK below. */
    sessionId: uuid('session_id').notNull(),
    /** Where the awaited thing comes from — opaque to Atrium, the daemon's word. */
    source: text('source').notNull(),
    /** What would satisfy the wait — opaque; #124 interprets it, this table stores it. */
    matcher: text('matcher').notNull(),
    /** MANDATORY. A wait with no horizon is a wedge; this is the horizon. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: subscriptionStatus('status').notNull().default('waiting'),
    /** The `core_events.id` of the `session_signaled {resume}` that matched it. */
    matchedByEventId: text('matched_by_event_id'),
    /** When the expiry sweep escalated it to the agent's owner. NULL until then. */
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    /**
     * WHO registered the wait — the trusted actor off the ledger row, never the
     * payload (#21's contract), exactly as `session_signals.raised_by_user_id` is
     * written. Registering a wait is CONTROL over a process: it decides how long
     * the session stays open and therefore how long its plan cannot settle
     * (#119), so it is the agent principal's or its owner's act. The
     * `session_subscriptions_control_authorized` trigger in drizzle/0046 reads
     * THIS column, which is why it must exist: without it the table had no way to
     * ask who was asking, and a bystander's hand-written wait landed (#127 round-1
     * gauntlet finding B — the command clause could be deleted and every test
     * stayed green).
     */
    raisedByUserId: uuid('raised_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The `core_events.id` of the `session_subscribed` that projected this. */
    subscribedByEventId: text('subscribed_by_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('session_subscriptions_session_idx').on(t.roomId, t.sessionId, t.status),
    /** The expiry sweep's index: waiting subscriptions, oldest horizon first. */
    index('session_subscriptions_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'waiting'`),
    /** The composite-FK target a resume's `subscription_id` lands on. */
    uniqueIndex('session_subscriptions_room_id_key').on(t.roomId, t.id),
    /** One row per ledger event — a re-projection cannot mint a second wait. */
    uniqueIndex('session_subscriptions_event_key').on(t.subscribedByEventId),
    /** One room, one session — a wait can never name a session it cannot see. */
    foreignKey({
      name: 'session_subscriptions_session_same_room_fk',
      columns: [t.roomId, t.sessionId],
      foreignColumns: [sessions.roomId, sessions.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A signal appended into a running session (#127; #123 resolution 2/4).
 *
 * Ledger-only and non-epistemic: this table is the whole projection. It writes no
 * judgement column, so `steer`ing a session can no more flip a `~` to a `✓` than
 * settling one can (#114 T3).
 *
 * ## The provenance fields are explicit, and are NOT `MessageReference`
 *
 * #123's draft reached for `MessageReference` and the gauntlet found it
 * unrepresentable — that vocabulary has no `message` kind (`room-events.ts`), and
 * `routedFrom` existed nowhere at all. So the edges are named outright:
 *
 *  - `cause_message_id` — the room message a mediated steer came from. Nullable
 *    (a steer typed straight at the session cites nothing), and composite-FK'd on
 *    `(room_id, message_id)` so a cause from ANOTHER room is impossible in every
 *    write path, not merely refused by the command.
 *  - `supersedes_event_id` — forward-only revision of an earlier steer. The
 *    ledger is append-only, so a revision is a new row that NAMES the one it
 *    replaces; discarding the superseded tail is the harness's act, reported in
 *    the session receipt, never a rewrite of history here.
 *  - `subscription_id` — `resume` only, held to that by
 *    `session_signals_subscription_is_a_resume`. A steer does not pay out a wait.
 */
export const sessionSignals = pgTable(
  'session_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** The session being signaled. Open at append time — see the 0045 trigger. */
    sessionId: uuid('session_id').notNull(),
    kind: signalKind('kind').notNull(),
    /** The steer's words, or the interrupt's reason. Nullable. */
    body: text('body'),
    /** The room message this signal was mediated from. Same room, by FK. */
    causeMessageId: uuid('cause_message_id'),
    /** The `core_events.id` of an earlier signal this one revises. */
    supersedesEventId: text('supersedes_event_id'),
    /** `resume` only: the wait this continuation pays out. */
    subscriptionId: uuid('subscription_id'),
    /**
     * WHO signaled — the trusted actor off the ledger row, never the payload.
     * The interrupt-authorization trigger reads this column, so it is the same
     * value the command checked, and a direct writer cannot dodge the check by
     * writing a different one.
     */
    raisedByUserId: uuid('raised_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The `core_events.id` of the `session_signaled` that projected this. */
    signaledByEventId: text('signaled_by_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('session_signals_session_idx').on(t.roomId, t.sessionId, t.createdAt),
    /** One row per ledger event — a re-projection cannot mint a second signal. */
    uniqueIndex('session_signals_event_key').on(t.signaledByEventId),
    /** A signal can never name a session from another room. */
    foreignKey({
      name: 'session_signals_session_same_room_fk',
      columns: [t.roomId, t.sessionId],
      foreignColumns: [sessions.roomId, sessions.id],
    }).onDelete('cascade'),
    /**
     * THE SAME-ROOM PROVENANCE EDGE (#123 resolution 4). A cross-room
     * `causeMessageId` is refused by the DDL, so the command's own check is the
     * clean error message and this is the authority.
     */
    foreignKey({
      name: 'session_signals_cause_same_room_fk',
      columns: [t.roomId, t.causeMessageId],
      foreignColumns: [messages.roomId, messages.id],
    }).onDelete('cascade'),
    /** A resume names a wait in its own room, or none. */
    foreignKey({
      name: 'session_signals_subscription_same_room_fk',
      columns: [t.roomId, t.subscriptionId],
      foreignColumns: [sessionSubscriptions.roomId, sessionSubscriptions.id],
    }).onDelete('cascade'),
    /** Only a resume pays out a wait — a steer carrying one is a category error. */
    check(
      'session_signals_subscription_is_a_resume',
      sql`${t.subscriptionId} IS NULL OR ${t.kind} = 'resume'`,
    ),
  ],
);

/**
 * AT MOST ONE FUNDED ARM PER CAUSE MESSAGE (#128, #124 resolution 4).
 *
 * One row per draw-taking routing append that named a cause. The primary key is
 * `(room_id, cause_message_id)`, and that key IS the rule: a daemon that
 * processes one channel message twice — a retry after a lost ack, a crash
 * between the draw and its own bookkeeping, two loop instances racing the same
 * message — cannot fund two sessions from it. The second claim collides and its
 * whole append transaction aborts, so the second draw is not merely uncounted,
 * it never happened.
 *
 * ## Why a table and not an index
 *
 * The draw-taking appends are TWO: `session_opened` (a spawn) and
 * `session_signaled {kind:'resume'}` (a continue) — #115 decision 2's
 * "spawns/continues", built across #118 and #127. They project into two
 * different tables, and no unique index spans two tables. A shared claim table
 * is the only spelling of "across draw-taking appends" that Postgres can
 * actually enforce, which is why the uniqueness lives here rather than as a
 * partial index on `sessions` that would silently miss every resume.
 *
 * ## What is NOT in here, deliberately
 *
 *  - `plan_opened`. A plan never draws (#124 resolution 2), so two boards from
 *    one message spend nothing; `plans.cause_message_id` carries the provenance
 *    and this table never sees it. Funding uniqueness is about the purse.
 *  - `message_posted`. The answer arm is speech, not spend.
 *  - `steer` and `interrupt`. Neither moves `plans.authorized_draws`.
 *  - A draw with NO cause message. A human opening a session by hand cites
 *    nothing, and "at most one arm per cause" says nothing about appends that
 *    name no cause. `cause_message_id` is NOT NULL here because a row with a
 *    null cause would claim nothing and collide with nothing — the projections
 *    simply write no row in that case.
 *  - A REFUSED draw. `draw_refused` grants nothing and funds nothing, so it
 *    leaves the cause message unclaimed and a later, funded retry may take it.
 */
export const fundedArms = pgTable(
  'funded_arms',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** The channel message this draw was routed from. NOT NULL — see the doc. */
    causeMessageId: uuid('cause_message_id').notNull(),
    /** Which draw-taking append claimed it: a spawn or a continue. */
    arm: text('arm').notNull(),
    /** The session the draw funded — the spawned one, or the resumed one. */
    sessionId: uuid('session_id').notNull(),
    /** The `core_events.id` of the append that took the draw. */
    drawnByEventId: text('drawn_by_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** THE BACKSTOP. One funded arm per (room, cause message), full stop. */
    primaryKey({
      name: 'funded_arms_room_cause_pk',
      columns: [t.roomId, t.causeMessageId],
    }),
    /** The cause is a message in THIS room — the same composite edge everywhere. */
    foreignKey({
      name: 'funded_arms_cause_same_room_fk',
      columns: [t.roomId, t.causeMessageId],
      foreignColumns: [messages.roomId, messages.id],
    }).onDelete('cascade'),
    /** The funded session is in THIS room. */
    foreignKey({
      name: 'funded_arms_session_same_room_fk',
      columns: [t.roomId, t.sessionId],
      foreignColumns: [sessions.roomId, sessions.id],
    }).onDelete('cascade'),
    /** The two draw-taking appends, and nothing else may claim an arm. */
    check('funded_arms_arm_is_a_draw', sql`${t.arm} IN ('spawn', 'continue')`),
  ],
);

/* ── proposals (pre-acceptance staging) ─────────────────────────────────── */

export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    interpretationId: uuid('interpretation_id').references(() => interpretations.id, {
      onDelete: 'set null',
    }),
    type: acceptedObjectType('type').notNull(),
    payload: jsonb('payload').$type<ObjectPayload>().notNull(),
    confidence: real('confidence').notNull(),
    proposerKind: proposerKind('proposer_kind').notNull(),
    proposerModel: text('proposer_model'),
    proposerUserId: uuid('proposer_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Who *typed* this proposal, as against `proposer_*`, which is what the
     * reading claims to be (#22 r9, D1).
     *
     * Until r9 the read model recorded only the claim. A member who staged a
     * proposal marked `proposer_kind='model'` produced a row that read, to every
     * query built over this table, exactly like one an interpretation pipeline had
     * emitted — and the `core_events` row that knew better is the log, not the
     * read model. Nothing anyone reads could name the person.
     *
     * Deliberately shaped like `core_events.actor_kind`/`actor_id` rather than
     * like `proposer_*`: the stager is an `Actor`, so it has a `system` variant
     * that `proposer_kind` has no spelling for, and `actor_id` carries the user id
     * for a human or an agent and the model id for a model under the same check
     * constraint that table uses. It is not an FK for the same reason `core_events.actor_id`
     * is not one — the column is polymorphic. A deleted user leaves the id behind
     * here on purpose: "who staged this attribution" is a fact about an append,
     * not a live pointer.
     */
    stagedByKind: actorKind('staged_by_kind').notNull(),
    stagedById: text('staged_by_id'),
    /**
     * The span of a cited message the reading rests on, verbatim.
     *
     * Also new in r9, and for the same reason: it is the field every attribution
     * rule is computed from, `validateProposalProvenance` checks it, and it was
     * the one part of the forged reading that no read model could show. A
     * projection that carries the citation list but not the sentence being
     * attributed can render a `~` that nobody can check by eye.
     */
    quote: text('quote'),
    status: proposalStatus('status').notNull().default('proposed'),
    /**
     * Which execution session staged this reading, when one did (#116; the
     * proposal half of #114 T3's session→drafted index). Nullable because a
     * person may stage a reading directly, without an execution session.
     *
     * ## Exactly how far this is checked, and where it stops
     *
     * CROSS-AGENT spoofing is refused, in two places that do not depend on each
     * other. `record_proposal` derives the proposer from the authenticated
     * principal and admits only an OPEN session whose plan's `agent_user_id` is
     * that principal, in that room; and 0043/0044 make the same two conditions
     * table facts, so a direct writer that bypasses the command cannot bind a
     * reading to another agent's session or to one that has already exited. The
     * composite `(room_id, session_id)` FK independently makes cross-room
     * provenance impossible in every write path, and stays the sole authority
     * for that condition (both triggers fall through to it).
     *
     * WITHIN one agent, this is the agent's word. `session_id` arrives as
     * command payload on a connection authenticated at the AGENT level, not at
     * the session level — one credential covers every session that agent owns —
     * so an agent holding two open sessions may truthfully name either, and
     * nothing here can tell which process actually produced the text. The
     * server checks ownership and liveness; it does not check authorship. Read
     * this column as "an agent asserted this session drafted it", not as "this
     * session drafted it".
     *
     * Closing that last gap needs a per-session credential — the
     * `execution_authority` binding — which is deferred to #132. Until it lands,
     * do not build anything that treats a same-agent session attribution as
     * adversarially sound.
     */
    sessionId: uuid('session_id'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('proposals_room_status_idx').on(t.roomId, t.status),
    foreignKey({
      name: 'proposals_session_same_room_fk',
      columns: [t.roomId, t.sessionId],
      foreignColumns: [sessions.roomId, sessions.id],
    }),
    /** Composite-FK target — an object may only be accepted from its own room's proposal. */
    uniqueIndex('proposals_room_id_key').on(t.roomId, t.id),
    check('proposals_confidence_range', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check(
      'proposals_proposer_identified',
      sql`(${t.proposerKind} = 'model' AND ${t.proposerModel} IS NOT NULL)
          OR (${t.proposerKind} = 'human' AND ${t.proposerUserId} IS NOT NULL)
          OR (${t.proposerKind} = 'agent' AND ${t.proposerUserId} IS NOT NULL)`,
    ),
    /**
     * The same rule `core_events_actor_id_matches_kind` states, on the same
     * shape: `staged_by_id` is the user id for a human and the model id for a
     * model, and is NULL for the system actor and only for it. Without it,
     * `{kind:'system', staged_by_id:'alice'}` is a row that reads as a person
     * having staged something the process staged.
     */
    check(
      'proposals_staged_by_id_matches_kind',
      sql`(${t.stagedByKind} = 'system') = (${t.stagedById} IS NULL)`,
    ),
    check(
      'proposals_staged_by_id_not_blank',
      sql`${t.stagedById} IS NULL OR length(${t.stagedById}) > 0`,
    ),
    index('proposals_staged_by_idx').on(t.stagedByKind, t.stagedById),
  ],
);

/**
 * Provenance: which messages a proposal was read out of.
 *
 * `room_id` is carried here purely so both edges can be composite: without it
 * a proposal in room A could cite a message in room B as its source, and the
 * provenance link the UI shows would cross the isolation boundary.
 */
export const proposalSources = pgTable(
  'proposal_sources',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id').notNull(),
    messageId: uuid('message_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.proposalId, t.messageId] }),
    foreignKey({
      name: 'proposal_sources_proposal_same_room_fk',
      columns: [t.roomId, t.proposalId],
      foreignColumns: [proposals.roomId, proposals.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'proposal_sources_message_same_room_fk',
      columns: [t.roomId, t.messageId],
      foreignColumns: [messages.roomId, messages.id],
    }).onDelete('cascade'),
  ],
);

/* ── accepted objects (single table, type discriminator) ────────────────── */

export const acceptedObjects = pgTable(
  'accepted_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    type: acceptedObjectType('type').notNull(),
    /** Validated by the matching @atrium/core zod schema before it lands here. */
    payload: jsonb('payload').$type<ObjectPayload>().notNull(),
    /** Objectives group everything else; objectives may nest under an objective. */
    objectiveId: uuid('objective_id'),
    /** The proposal this was accepted from, when it came through interpretation. */
    proposalId: uuid('proposal_id'),
    /**
     * Which session drafted this, when a session did (#116, from #114 T3's
     * roll-up: a session → drafted-objects index). Nullable and still null in
     * practice after #117: that ticket gave `proposer_kind` its agent value so a
     * session may DRAFT a `~`, but the session id is not yet threaded from the
     * command onto the `object_accepted` event, so the projection has nothing to
     * file here. The column exists so the provenance edge is in the schema, and
     * it is composite `(room_id, session_id)` so a fact can never point at a
     * session from another room. It is provenance only — it carries no judgement
     * and flipping it moves no `~` to a `✓`.
     */
    sessionId: uuid('session_id'),
    /** Bumped by every correction; cheap optimistic-concurrency token. */
    revision: integer('revision').notNull().default(0),
    /** Set by a `retract` correction — the row is never deleted. */
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    /** Denormalised from the `supersedes` edge for cheap "is this still true?". */
    supersededById: uuid('superseded_by_id'),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The KIND of the actor that accepted this, projected from the fold's
     * `acceptedBy` (`ObjectRecord.acceptedBy.kind`). This is the read model's
     * half of @atrium/core's one certification predicate: `epistemicStateOf` is
     * `isHuman(acceptedBy) || humanTouchedAt !== null`, and `accepted_by` alone
     * cannot answer `isHuman` because an `agent` also carries a `users` id
     * (0017). Deliberately NOT NULL: every accepted row has an accepter kind,
     * and a nullable column would let a forgotten projection render a machine's
     * reading as a fact. `_ActorKindParity` pins this enum to `Actor['kind']`.
     *
     * `DEFAULT 'model'` is the fail-CLOSED value, not a convenience: the
     * projection always sets this explicitly from the fold, so the default is
     * reached only by a writer that forgot who accepted — and the safe answer to
     * "we do not know who certified this" is "a machine did", which renders `~`
     * and asks a person, never `✓`. Same judgement 0018 recorded for keeping a
     * safe default over a no-default error that fires at an unaudited call site.
     */
    acceptedByKind: actorKind('accepted_by_kind').notNull().default('model'),
    /**
     * When a human first touched this object — accepted it, or corrected it
     * afterwards — or `null` while it is still only a machine's reading. The
     * second half of the predicate, projected from `ObjectRecord.humanTouchedAt`
     * on both `object_accepted` AND `object_corrected` (a correction by a person
     * promotes `~`→`✓`, so the correction projection must move it too). Until
     * this column existed the covenant was unobservable: a `✓` on screen was not
     * evidence a person made it.
     */
    humanTouchedAt: timestamp('human_touched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('accepted_objects_room_type_idx').on(t.roomId, t.type),
    index('accepted_objects_objective_idx').on(t.objectiveId),
    index('accepted_objects_live_idx')
      .on(t.roomId, t.type)
      .where(sql`${t.retractedAt} IS NULL AND ${t.supersededById} IS NULL`),
    /** Composite-FK target for relations, attention, corrections and this table itself. */
    uniqueIndex('accepted_objects_room_id_key').on(t.roomId, t.id),
    /**
     * Every reference out of this row is composite. `reduce` already refuses a
     * cross-room supersession and a cross-room proposal citation
     * (`applyObjectAccepted`, `applyRelationAdded`); these say the same thing
     * to the database, so a writer that bypasses the reducer cannot do what
     * the reducer forbids.
     */
    foreignKey({
      name: 'accepted_objects_objective_same_room_fk',
      columns: [t.roomId, t.objectiveId],
      foreignColumns: [t.roomId, t.id],
    }),
    foreignKey({
      name: 'accepted_objects_superseded_by_same_room_fk',
      columns: [t.roomId, t.supersededById],
      foreignColumns: [t.roomId, t.id],
    }),
    foreignKey({
      name: 'accepted_objects_proposal_same_room_fk',
      columns: [t.roomId, t.proposalId],
      foreignColumns: [proposals.roomId, proposals.id],
    }),
    /** Composite, like every other reference out of this row: a drafting session
     * belongs to the same room as the object it drafted. */
    foreignKey({
      name: 'accepted_objects_session_same_room_fk',
      columns: [t.roomId, t.sessionId],
      foreignColumns: [sessions.roomId, sessions.id],
    }),
  ],
);

/**
 * THE COVENANT ANCHOR — the complete-form record a human `✓` binds to on the
 * object/span axis (#180; governed by #163 complete-form, #164 DETECT-only).
 *
 * A `✓` over a span of the live Yjs document vouches for the EXACT certified
 * *rendered* content, fail-closed: it stays true only while that content
 * re-resolves byte-identically, and auto-stales the moment it drifts (map #162).
 * This is the object/span analogue of the SESSION content anchor — session
 * certify binds a `✓` to `md5(artifact::text)` (0034) — brought to the CRDT-span
 * axis and made complete: a bare state vector was ruled a "well-formed lie" in
 * the round-2 gauntlet because it preserves structure, not meaning, so the anchor
 * carries the rendered digest and the enclosed-item identity too.
 *
 * Authority lives on the gated ledger, never in the CRDT: this is a Postgres row
 * the room reads read-only, not a Yjs field agent-peers can write. The DETECT
 * read authority (#181) resolves `@atrium/core`'s `resolveCovenant()` against
 * these columns; the drift scheduler (#182) re-runs it on Yjs update events. This
 * table owns only the persistence + the certify-time capture.
 */
export const covenantAnchors = pgTable(
  'covenant_anchors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** The accepted object whose span this `✓` is over. */
    objectId: uuid('object_id').notNull(),
    /** The logical revision the `✓` was bound to. */
    revision: integer('revision').notNull(),
    /** Opaque, caller-encoded Yjs state vector — resolution context, not compared. */
    stateVector: text('state_vector').notNull(),
    /** Opaque, caller-encoded Yjs delete set / snapshot — resolution context. */
    deleteSet: text('delete_set').notNull(),
    /** The identity of every item inside the span, in document order (see core). */
    enclosedItems: jsonb('enclosed_items').$type<EnclosedItem[]>().notNull(),
    /** SHA-256 (64 lower-case hex) of the canonical rendered fragment at certify. */
    renderedDigest: text('rendered_digest').notNull(),
    /**
     * The KIND of the certifier. Only a human may certify (map #162, #164); the
     * check constraint below is the table backstop under the app guard, mirroring
     * `sessions_certify_needs_artifact` (0034). `accepted_by alone cannot answer
     * isHuman` — an agent also carries a users id — so the kind is stored.
     */
    certifierKind: actorKind('certifier_kind').notNull(),
    certifierId: uuid('certifier_id').references(() => users.id, { onDelete: 'set null' }),
    certifiedAt: timestamp('certified_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One live anchor per certified span; re-certify replaces it (a new signature). */
    uniqueIndex('covenant_anchors_object_key').on(t.roomId, t.objectId),
    /** Composite, like every reference out of a semantic row: the span is in THIS room. */
    foreignKey({
      name: 'covenant_anchors_object_same_room_fk',
      columns: [t.roomId, t.objectId],
      foreignColumns: [acceptedObjects.roomId, acceptedObjects.id],
    }),
    /** The digest is a SHA-256 hex string — a malformed one is a lie the DB refuses. */
    check('covenant_anchors_digest_is_sha256', sql`${t.renderedDigest} ~ '^[0-9a-f]{64}$'`),
    /** Only a human certifies. The covenant's whole claim is a human vouched for this. */
    check('covenant_anchors_certifier_is_human', sql`${t.certifierKind} = 'human'`),
    check('covenant_anchors_revision_nonneg', sql`${t.revision} >= 0`),
  ],
);

/**
 * A selected address inside authored message text. `surface` is evidence, not a
 * label cache: the projection validates it against the UTF-16 body slice before
 * inserting this row. The trigger installed by migration 0015 independently
 * validates the closed target alphabet and anchors every target to stored room
 * data rather than to the caller-supplied room id.
 */
export const messageReferences = pgTable(
  'message_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull(),
    messageId: uuid('message_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: messageReferenceKind('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    start: integer('start').notNull(),
    end: integer('end').notNull(),
    surface: text('surface').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_references_message_ordinal_key').on(t.messageId, t.ordinal),
    uniqueIndex('message_references_room_id_key').on(t.roomId, t.id),
    index('message_references_target_idx').on(t.roomId, t.kind, t.targetId),
    foreignKey({
      name: 'message_references_message_same_room_fk',
      columns: [t.roomId, t.messageId],
      foreignColumns: [messages.roomId, messages.id],
    }).onDelete('cascade'),
    check('message_references_ordinal_nonnegative', sql`${t.ordinal} >= 0`),
    check('message_references_span_nonempty', sql`${t.start} >= 0 AND ${t.end} > ${t.start}`),
    check('message_references_surface_not_blank', sql`length(${t.surface}) > 0`),
    check('message_references_surface_is_address', sql`left(${t.surface}, 1) = '@'`),
  ],
);

/** Provenance for objects created directly by a human, with no proposal. */
export const objectSources = pgTable(
  'object_sources',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id').notNull(),
    messageId: uuid('message_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.objectId, t.messageId] }),
    foreignKey({
      name: 'object_sources_object_same_room_fk',
      columns: [t.roomId, t.objectId],
      foreignColumns: [acceptedObjects.roomId, acceptedObjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'object_sources_message_same_room_fk',
      columns: [t.roomId, t.messageId],
      foreignColumns: [messages.roomId, messages.id],
    }).onDelete('cascade'),
  ],
);

/* ── relations (typed edges) ────────────────────────────────────────────── */

/**
 * SQL table `relations`. Exported as `objectRelations` so the name never
 * collides with drizzle's own `relations()` query helper.
 */
export const objectRelations = pgTable(
  'relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    kind: relationKind('kind').notNull(),
    fromObjectId: uuid('from_object_id').notNull(),
    /** Exactly one target column is populated — see the check constraints. */
    toObjectId: uuid('to_object_id'),
    toMessageId: uuid('to_message_id'),
    toUrl: text('to_url'),
    toFileKey: text('to_file_key'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('relations_from_idx').on(t.fromObjectId, t.kind),
    index('relations_to_object_idx').on(t.toObjectId),
    uniqueIndex('relations_edge_key')
      .on(t.fromObjectId, t.kind, t.toObjectId)
      .where(sql`${t.toObjectId} IS NOT NULL`),
    check(
      'relations_single_target',
      sql`(CASE WHEN ${t.toObjectId} IS NULL THEN 0 ELSE 1 END
         + CASE WHEN ${t.toMessageId} IS NULL THEN 0 ELSE 1 END
         + CASE WHEN ${t.toUrl} IS NULL THEN 0 ELSE 1 END
         + CASE WHEN ${t.toFileKey} IS NULL THEN 0 ELSE 1 END) = 1`,
    ),
    check(
      'relations_structural_targets_object',
      sql`${t.kind} = 'evidence' OR ${t.toObjectId} IS NOT NULL`,
    ),
    check(
      'relations_evidence_targets_source',
      sql`${t.kind} <> 'evidence' OR ${t.toObjectId} IS NULL`,
    ),
    check(
      'relations_no_self_edge',
      sql`${t.fromObjectId} <> ${t.toObjectId} OR ${t.toObjectId} IS NULL`,
    ),
    /**
     * An edge is the sharpest cross-room hazard in the schema: it is *made of*
     * references. All three composite, so a relation cannot reach out of its
     * own room even if the reducer is bypassed.
     */
    foreignKey({
      name: 'relations_from_object_same_room_fk',
      columns: [t.roomId, t.fromObjectId],
      foreignColumns: [acceptedObjects.roomId, acceptedObjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'relations_to_object_same_room_fk',
      columns: [t.roomId, t.toObjectId],
      foreignColumns: [acceptedObjects.roomId, acceptedObjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'relations_to_message_same_room_fk',
      columns: [t.roomId, t.toMessageId],
      foreignColumns: [messages.roomId, messages.id],
    }).onDelete('cascade'),
  ],
);

/* ── attention (stored projection) ──────────────────────────────────────── */

/**
 * Attention items — a stored projection, and the one table with a polymorphic
 * subject (routed from #21).
 *
 * `object_id` used to be a plain foreign key onto `accepted_objects`, which
 * made `needs_decision` unstorable: a decision never auto-accepts, so the thing
 * a person is being asked to rule on is a **proposal**, and no object exists
 * yet. The column is now `subject_id` with a `subject_kind` discriminator that
 * matches @atrium/core's `AttentionSubjectKind` exactly (parity asserted at the
 * bottom of this file).
 *
 * Both edges stay room-scoped, which is the part that is easy to lose when a
 * reference goes polymorphic. Postgres has no "FK to one of two tables", so the
 * kind is projected into two generated columns — each null unless the
 * discriminator selects it — and each carries its own composite `(room_id, …)`
 * foreign key. Generated, not written: nothing can set them inconsistently with
 * `subject_kind`, and there is no trigger to keep in step. Exactly one is
 * non-null for every row, by construction rather than by a check.
 */
export const attentionItems = pgTable(
  'attention_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Which table `subject_id` names. @atrium/core's `AttentionSubjectKind`.
     *
     * No column default. The migration uses one to backfill the rows that
     * predate this column and then drops it: a default here would let a writer
     * omit the discriminator and land on `'object'`, which for a proposal
     * subject means pointing the object edge at a proposal id. The FK would
     * refuse it — but a refusal at the right column beats a refusal three
     * inferences away.
     */
    subjectKind: text('subject_kind').$type<AttentionSubjectKind>().notNull(),
    /** The accepted object, or the staged proposal — see `subject_kind`. */
    subjectId: uuid('subject_id').notNull(),
    /** Non-null exactly when `subject_kind = 'object'`. Carries that edge's FK. */
    subjectObjectId: uuid('subject_object_id').generatedAlwaysAs(
      sql`CASE WHEN "subject_kind" = 'object' THEN "subject_id" END`,
    ),
    /** Non-null exactly when `subject_kind = 'proposal'`. Same, for proposals. */
    subjectProposalId: uuid('subject_proposal_id').generatedAlwaysAs(
      sql`CASE WHEN "subject_kind" = 'proposal' THEN "subject_id" END`,
    ),
    /** Non-null exactly when `subject_kind = 'message'`. */
    subjectMessageId: uuid('subject_message_id').generatedAlwaysAs(
      sql`CASE WHEN "subject_kind" = 'message' THEN "subject_id" END`,
    ),
    /**
     * Non-null exactly when `subject_kind = 'session'` (#127). The fourth
     * subject edge, added with the same three parts the other three have — a
     * generated column, a composite same-room FK, and a name in the allowlist —
     * so a subscription-expiry escalation names the SESSION that is still
     * waiting rather than pointing at some message standing in for it.
     */
    subjectSessionId: uuid('subject_session_id').generatedAlwaysAs(
      sql`CASE WHEN "subject_kind" = 'session' THEN "subject_id" END`,
    ),
    class: attentionClass('class').notNull(),
    /**
     * Why this person specifically — @atrium/core's `RationaleReason`, structured
     * (#21 r2, major 8).
     *
     * It was `text NOT NULL`, and core no longer produces that string as the
     * stored value: it produces a discriminated union and renders the sentence on
     * demand with `renderRationale`. Storing the rendered sentence would freeze a
     * template into every row — change the wording and the history says the old
     * one — and would make "which rule raised this" a substring search over
     * prose. NOT NULL by design either way: no unexplained pings.
     */
    reason: jsonb('reason').$type<RationaleReason>().notNull(),
    status: attentionStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * One item per (person, subject, class). The kind is part of the key: an
     * object and the proposal it was accepted from are different subjects and
     * may legitimately both have raised an item.
     */
    uniqueIndex('attention_items_user_subject_class_key').on(
      t.userId,
      t.subjectKind,
      t.subjectId,
      t.class,
    ),
    index('attention_items_user_status_idx').on(t.userId, t.status),
    /**
     * The structured twin of the old `length(btrim(rationale)) > 0`: an item
     * whose reason names no rule is the unexplained ping that check existed to
     * refuse, and `{}` is exactly how one arrives now. The discriminator is the
     * one field every variant has, so it is the one worth requiring here; the
     * variant's own fields are @atrium/core's to validate.
     */
    check('attention_items_reason_has_kind', sql`length(coalesce(${t.reason}->>'kind', '')) > 0`),
    check(
      'attention_items_subject_kind_allowlist',
      sql`${t.subjectKind} IN ('object', 'proposal', 'message', 'session')`,
    ),
    /**
     * "Needs you" must never point at something from a room you cannot see —
     * and that has to keep holding now that "something" is two tables.
     */
    foreignKey({
      name: 'attention_items_object_same_room_fk',
      columns: [t.roomId, t.subjectObjectId],
      foreignColumns: [acceptedObjects.roomId, acceptedObjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'attention_items_proposal_same_room_fk',
      columns: [t.roomId, t.subjectProposalId],
      foreignColumns: [proposals.roomId, proposals.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'attention_items_message_same_room_fk',
      columns: [t.roomId, t.subjectMessageId],
      foreignColumns: [messages.roomId, messages.id],
    }).onDelete('cascade'),
    /** The fourth subject edge (#127) — same shape, same guarantee. */
    foreignKey({
      name: 'attention_items_session_same_room_fk',
      columns: [t.roomId, t.subjectSessionId],
      foreignColumns: [sessions.roomId, sessions.id],
    }).onDelete('cascade'),
  ],
);

/* ── corrections (event log) ────────────────────────────────────────────── */

export const corrections = pgTable(
  'corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id').notNull(),
    action: correctionAction('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    byUserId: uuid('by_user_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    /** The `core_events.id` this correction is the projection of. */
    eventId: text('event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('corrections_object_idx').on(t.objectId, t.createdAt),
    uniqueIndex('corrections_event_key').on(t.eventId),
    foreignKey({
      name: 'corrections_object_same_room_fk',
      columns: [t.roomId, t.objectId],
      foreignColumns: [acceptedObjects.roomId, acceptedObjects.id],
    }).onDelete('cascade'),
  ],
);

/* ── inferred row types ─────────────────────────────────────────────────── */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type CoreEventRow = typeof coreEvents.$inferSelect;
export type NewCoreEventRow = typeof coreEvents.$inferInsert;
export type Interpretation = typeof interpretations.$inferSelect;
export type NewInterpretation = typeof interpretations.$inferInsert;
export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;
export type AcceptedObjectRow = typeof acceptedObjects.$inferSelect;
export type NewAcceptedObjectRow = typeof acceptedObjects.$inferInsert;
export type RelationRow = typeof objectRelations.$inferSelect;
export type NewRelationRow = typeof objectRelations.$inferInsert;
export type AttentionItemRow = typeof attentionItems.$inferSelect;
export type NewAttentionItemRow = typeof attentionItems.$inferInsert;
export type CorrectionRow = typeof corrections.$inferSelect;
export type NewCorrectionRow = typeof corrections.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type PlanRow = typeof plans.$inferSelect;
export type NewPlanRow = typeof plans.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

/**
 * Compile-time proof that the Postgres enums and the @atrium/core zod enums
 * cannot drift apart. If someone adds a sixth object type in one place and not
 * the other, this file stops compiling.
 */
type Assert<A extends B, B> = A;
export type _ObjectTypeParity = Assert<
  (typeof acceptedObjectType.enumValues)[number],
  CoreAcceptedObjectType
> &
  Assert<CoreAcceptedObjectType, (typeof acceptedObjectType.enumValues)[number]>;
export type _RelationKindParity = Assert<(typeof relationKind.enumValues)[number], RelationKind> &
  Assert<RelationKind, (typeof relationKind.enumValues)[number]>;
export type _AttentionClassParity = Assert<
  (typeof attentionClass.enumValues)[number],
  AttentionClass
> &
  Assert<AttentionClass, (typeof attentionClass.enumValues)[number]>;
export type _AttentionStatusParity = Assert<
  (typeof attentionStatus.enumValues)[number],
  AttentionStatus
> &
  Assert<AttentionStatus, (typeof attentionStatus.enumValues)[number]>;
export type _AttentionSubjectKindParity = Assert<
  (typeof attentionSubjectKind.enumValues)[number],
  AttentionSubjectKind
> &
  Assert<AttentionSubjectKind, (typeof attentionSubjectKind.enumValues)[number]>;
export type _ProposalStatusParity = Assert<
  (typeof proposalStatus.enumValues)[number],
  ProposalStatus
> &
  Assert<ProposalStatus, (typeof proposalStatus.enumValues)[number]>;
export type _CorrectionActionParity = Assert<
  (typeof correctionAction.enumValues)[number],
  CorrectionAction
> &
  Assert<CorrectionAction, (typeof correctionAction.enumValues)[number]>;

/**
 * One-way, deliberately: every @atrium/core event type must be storable in
 * `core_events`, but `event_type` is a strict superset — `message_posted` and
 * `attention_resolved` are room history the reducer has no opinion about. Add a
 * seventh `CoreEvent` and this stops compiling until the enum learns about it.
 *
 * One way is the whole of what it buys, and the missing direction is a real gap
 * rather than a shrug: a value added *here* and not to the database compiles,
 * and a value added to the database and not here compiles too. Neither is a
 * TypeScript question — `event_type` is deployed by hand-written SQL in
 * 0003–0008 — so it is asked of `enum_range(NULL::event_type)` in
 * `integration/db/ledger-constraints.test.ts` instead (#22 gauntlet r6, minor 4).
 */
export type _CoreEventTypeCoverage = Assert<CoreEventType, (typeof eventType.enumValues)[number]>;

/** `actor_kind` is exactly @atrium/core's `Actor['kind']`, both directions. */
export type _ActorKindParity = Assert<(typeof actorKind.enumValues)[number], Actor['kind']> &
  Assert<Actor['kind'], (typeof actorKind.enumValues)[number]>;

/**
 * The `event_type` values the reducer folds — everything else is ledger-only.
 *
 * Written as a map first, because the direction that bites is the one an array
 * cannot express. `satisfies readonly CoreEventType[]` only says *every listed
 * type is a core type*; it says nothing about a core type that was never
 * listed. That was r1's major 3: add a sixth `CoreEvent`, forget this list, and
 * it compiles — the new type is silently classified as server-only, never
 * folded, and vanishes from every replay while live ingestion still applies it.
 * The two states then diverge with no error anywhere.
 *
 * `satisfies Record<CoreEventType, true>` closes it in both directions at once:
 * a missing key is a missing-property error, and a stray key is an
 * excess-property error. `_CoreEventTypesAreExhaustive` below states the same
 * thing a second way, on the derived tuple, so neither the map nor the array
 * can drift from the union on its own.
 */
const coreEventTypeSet = {
  proposal_recorded: true,
  proposal_rejected: true,
  proposal_superseded: true,
  object_accepted: true,
  object_corrected: true,
  relation_added: true,
} as const satisfies Record<CoreEventType, true>;

export const coreEventTypes = [
  'proposal_recorded',
  'proposal_rejected',
  'proposal_superseded',
  'object_accepted',
  'object_corrected',
  'relation_added',
] as const satisfies readonly (keyof typeof coreEventTypeSet)[];

/** Every core event type is in the list above — the direction `satisfies` misses. */
export type _CoreEventTypesAreExhaustive = Assert<CoreEventType, (typeof coreEventTypes)[number]> &
  Assert<keyof typeof coreEventTypeSet, (typeof coreEventTypes)[number]>;

/** True when a ledger row is one @atrium/core's `reduce` consumes. */
export function isCoreEventType(type: string): type is CoreEventType {
  return (coreEventTypes as readonly string[]).includes(type);
}
