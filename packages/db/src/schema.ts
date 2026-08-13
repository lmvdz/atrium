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
  enumValues: ['object', 'proposal', 'message'] as const,
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
     * transaction as each `session_opened` it grants (`projectSessionOpened`),
     * under the global ledger lock, so it equals `count(sessions)` for the plan by
     * construction and cannot be forged. This is the number the spawn gate reads
     * and compares to `rlimit_slice` — never the adapter-reported `spent_micros`.
     */
    authorizedDraws: bigint('authorized_draws', { mode: 'number' }).notNull().default(0),
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
 * The execution artifact a settled session produced — #120's ExecutionProvider
 * output, surfaced in #121's review pane. All fields optional: the shape a merge
 * carries (branch + commit) differs from what a test run carries (pass/fail
 * counts), and an audit session carries neither. `diffStat` is a rendered
 * summary line (`+128 −34 · 6 files`), not structured hunks — the control plane
 * shows the shape of the change, and the terminal is the break-glass detail.
 */
export interface SessionArtifact {
  /** The branch the work landed on, when it produced one. */
  readonly branch?: string;
  /** The commit sha, when it produced one. */
  readonly commit?: string;
  /** A one-line diff summary — additions, deletions, files touched. */
  readonly diffStat?: string;
  /** Tests that passed, when the session ran a suite. */
  readonly testsPassed?: number;
  /** Tests that failed, when the session ran a suite. */
  readonly testsFailed?: number;
  /** A free one-line note about the artifact — kept short, system voice. */
  readonly summary?: string;
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
    /** The `core_events.id` of the `session_opened` that projected this. */
    openedByEventId: text('opened_by_event_id'),
    /** The `core_events.id` of the settling/failing event, once it exits. */
    settledByEventId: text('settled_by_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_plan_idx').on(t.planId),
    index('sessions_room_status_idx').on(t.roomId, t.status),
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
     * Which session staged this reading, when a session did (#116; the proposal
     * half of #114 T3's session→drafted index). Nullable and still null in
     * practice after #117: that ticket widened `proposer_kind` so an agent
     * session may DRAFT — `draftToProposal` now admits an agent session and marks
     * the reading `proposer_kind='agent'` with the agent's `proposer_user_id` —
     * but the session *id* is not carried on the `proposal_recorded` event yet,
     * so there is nothing for the projection to file here. The proposer is
     * identified (by its `users` row); wiring the session-id provenance edge is
     * the remaining half and needs the id threaded onto the event, which the
     * proposer widening does not. Kept composite `(room_id, session_id)` so the
     * provenance cannot cross a room the day it is populated.
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
      sql`${t.subjectKind} IN ('object', 'proposal', 'message')`,
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
