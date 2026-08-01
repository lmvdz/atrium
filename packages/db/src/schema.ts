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
  RationaleReason,
  RelationKind,
} from '@atrium/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
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

export const proposerKind = pgEnum('proposer_kind', ['model', 'human']);

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
 * What an attention item is *about* — @atrium/core's `AttentionSubjectKind`,
 * routed here from #21. A `needs_decision` item points at a **proposal**: a
 * decision never auto-accepts, so at the moment somebody has to rule on one
 * there is no accepted object to point at yet. See `attention_items`.
 */
export const attentionSubjectKind = pgEnum('attention_subject_kind', ['object', 'proposal']);

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
 * The first five are @atrium/core's `CoreEvent` types verbatim — the reducer
 * folds exactly those, and `_CoreEventTypeCoverage` below stops compiling if
 * core ever grows a sixth that is not listed here. The last two are room
 * history that the reducer has no concept of: a message is substrate, not
 * semantics, and an attention item is a per-person projection. Both still
 * belong in the ledger, because a client replaying `since(room, room_seq)`
 * must get the room back exactly as it was.
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
]);

/**
 * The trusted actor's kind, lifted out of `@atrium/core`'s `Actor` union and
 * held to it by the parity assert at the foot of this file.
 *
 * It is a **column**, not a payload field, and that is #21's contract rather
 * than a storage preference: the actor decides every human-only gate in the
 * reducer, and a payload is whatever the writer says it is. See `core_events`.
 */
export const actorKind = pgEnum('actor_kind', ['human', 'model', 'system']);

/** Typed payload union stored in `accepted_objects.payload` / `proposals.payload`. */
export type ObjectPayload =
  | DecisionPayload
  | CommitmentPayload
  | OpenQuestionPayload
  | ClaimPayload
  | ObjectivePayload;

/* ── identity ───────────────────────────────────────────────────────────── */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('rooms_slug_key').on(t.slug)],
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
 * Drizzle describes tables. Three of this table's rules are procedural and live
 * in `drizzle/0003_append_enforcement.sql`, which is the authority on them:
 *
 *  - **`atrium_append_core_event(...)` is the only way a row gets here.** A
 *    `BEFORE INSERT` trigger reads its own `PG_CONTEXT` call stack and refuses
 *    any insert not made from inside that function. #22's r1 gauntlet found the
 *    advisory lock to be *cooperative* — a migration, a seed script or an admin
 *    at a psql prompt could bypass canonical minting entirely — and a call-stack
 *    assertion is what makes it structural. It holds against the table owner and
 *    against a superuser, neither of whom a `REVOKE` binds.
 *  - **The advisory lock is asserted, not assumed.** The function takes it and
 *    the trigger re-checks `pg_locks` before letting the row through.
 *  - **Append-only is enforced.** `UPDATE`, `DELETE` and `TRUNCATE` on this
 *    table raise. "Nothing here is ever updated or deleted" used to be a
 *    sentence in a comment; it is now a trigger.
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
     * `actor_id` is the user id for a human, the model id for a model, and NULL
     * for the system actor — the shape #21's contract names, checked by
     * `core_events_actor_id_matches_kind` so the third case cannot be spelled as
     * an empty string.
     */
    actorKind: actorKind('actor_kind').notNull(),
    actorId: text('actor_id'),
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
    check(
      'core_events_payload_at_has_offset',
      sql`${t.payload}->>'at' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$'`,
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
     * `actor_id` is the user id for a human and the model id for a model, and is
     * NULL for the system actor and only for it. Without this, `{kind:'system',
     * actor_id:'alice'}` is a row that reads as a person having done something
     * the process did.
     */
    check(
      'core_events_actor_id_matches_kind',
      sql`(${t.actorKind} = 'system') = (${t.actorId} IS NULL)`,
    ),
    check('core_events_actor_id_not_blank', sql`${t.actorId} IS NULL OR length(${t.actorId}) > 0`),
    index('core_events_actor_idx').on(t.actorKind, t.actorId),
  ],
);

/* ── conversation substrate (append-only) ───────────────────────────────── */

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
    uniqueIndex('messages_room_client_id_key').on(t.roomId, t.clientMessageId),
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
    status: proposalStatus('status').notNull().default('proposed'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('proposals_room_status_idx').on(t.roomId, t.status),
    /** Composite-FK target — an object may only be accepted from its own room's proposal. */
    uniqueIndex('proposals_room_id_key').on(t.roomId, t.id),
    check('proposals_confidence_range', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check(
      'proposals_proposer_identified',
      sql`(${t.proposerKind} = 'model' AND ${t.proposerModel} IS NOT NULL)
          OR (${t.proposerKind} = 'human' AND ${t.proposerUserId} IS NOT NULL)`,
    ),
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
    /** Bumped by every correction; cheap optimistic-concurrency token. */
    revision: integer('revision').notNull().default(0),
    /** Set by a `retract` correction — the row is never deleted. */
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    /** Denormalised from the `supersedes` edge for cheap "is this still true?". */
    supersededById: uuid('superseded_by_id'),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
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
    subjectKind: attentionSubjectKind('subject_kind').notNull(),
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
 * sixth `CoreEvent` and this stops compiling until the enum learns about it.
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
