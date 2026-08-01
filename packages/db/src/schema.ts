import type {
  AttentionClass,
  AttentionStatus,
  ClaimPayload,
  CommitmentPayload,
  AcceptedObjectType as CoreAcceptedObjectType,
  CorrectionAction,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
  ProposalStatus,
  RelationKind,
} from '@atrium/core';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
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

export const correctionAction = pgEnum('correction_action', ['amend', 'retract', 'restore']);

export const interpretationStatus = pgEnum('interpretation_status', [
  'pending',
  'succeeded',
  'failed',
]);

/** Typed payload union stored in `accepted_objects.payload` / `proposals.payload`. */
export type ObjectPayload =
  | DecisionPayload
  | CommitmentPayload
  | OpenQuestionPayload
  | ClaimPayload
  | ObjectivePayload;

/* ── identity ───────────────────────────────────────────────────────────── */

/**
 * The application's people table AND Better Auth's `user` model — one row per
 * human, not two. Better Auth field names that differ from ours are remapped in
 * `auth-schema.ts` (`name` → `displayName`, `image` → `avatarUrl`); every other
 * property name below is a Better Auth field name and must not be renamed.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  // Slugs are unique *within* a workspace: two tenants may both have #general.
  (t) => [
    uniqueIndex('rooms_workspace_slug_key').on(t.workspaceId, t.slug),
    index('rooms_workspace_idx').on(t.workspaceId),
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
    /** Drives the "since you left" digest — per room, never a global mark-all-read. */
    lastReadSeq: integer('last_read_seq').notNull().default(0),
  },
  (t) => [
    uniqueIndex('memberships_room_user_key').on(t.roomId, t.userId),
    index('memberships_user_idx').on(t.userId),
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
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
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
    check('proposals_confidence_range', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check(
      'proposals_proposer_identified',
      sql`(${t.proposerKind} = 'model' AND ${t.proposerModel} IS NOT NULL)
          OR (${t.proposerKind} = 'human' AND ${t.proposerUserId} IS NOT NULL)`,
    ),
  ],
);

/** Provenance: which messages a proposal was read out of. */
export const proposalSources = pgTable(
  'proposal_sources',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.messageId] })],
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
    objectiveId: uuid('objective_id').references((): AnyPgColumn => acceptedObjects.id, {
      onDelete: 'set null',
    }),
    /** The proposal this was accepted from, when it came through interpretation. */
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    /** Bumped by every correction; cheap optimistic-concurrency token. */
    revision: integer('revision').notNull().default(0),
    /** Set by a `retract` correction — the row is never deleted. */
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    /** Denormalised from the `supersedes` edge for cheap "is this still true?". */
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => acceptedObjects.id, {
      onDelete: 'set null',
    }),
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
  ],
);

/** Provenance for objects created directly by a human, with no proposal. */
export const objectSources = pgTable(
  'object_sources',
  {
    objectId: uuid('object_id')
      .notNull()
      .references(() => acceptedObjects.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.objectId, t.messageId] })],
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
    fromObjectId: uuid('from_object_id')
      .notNull()
      .references(() => acceptedObjects.id, { onDelete: 'cascade' }),
    /** Exactly one target column is populated — see the check constraints. */
    toObjectId: uuid('to_object_id').references(() => acceptedObjects.id, { onDelete: 'cascade' }),
    toMessageId: uuid('to_message_id').references(() => messages.id, { onDelete: 'cascade' }),
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
  ],
);

/* ── attention (stored projection) ──────────────────────────────────────── */

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
    objectId: uuid('object_id')
      .notNull()
      .references(() => acceptedObjects.id, { onDelete: 'cascade' }),
    class: attentionClass('class').notNull(),
    /** Why this person specifically. NOT NULL by design — no unexplained pings. */
    rationale: text('rationale').notNull(),
    status: attentionStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('attention_items_user_object_class_key').on(t.userId, t.objectId, t.class),
    index('attention_items_user_status_idx').on(t.userId, t.status),
    check('attention_items_rationale_present', sql`length(btrim(${t.rationale})) > 0`),
  ],
);

/* ── corrections (event log) ────────────────────────────────────────────── */

export const corrections = pgTable(
  'corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => acceptedObjects.id, { onDelete: 'cascade' }),
    action: correctionAction('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    byUserId: uuid('by_user_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('corrections_object_idx').on(t.objectId, t.createdAt)],
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
