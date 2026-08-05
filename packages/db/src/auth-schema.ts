import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users, workspaces } from './schema.js';

/**
 * Better Auth's tables, as Drizzle (issue #13's resolution, issue #26).
 *
 * These are the tables `npx @better-auth/cli generate` emits, adapted in three
 * deliberate ways:
 *
 *  1. `user` is our existing `users` table, not a second identity store. There
 *     is exactly one row per human and application data foreign-keys straight
 *     at it — the whole reason Better Auth won over the hosted candidates.
 *  2. `organization` is our `workspaces` table, for the same reason.
 *  3. Primary keys are real `uuid` columns rather than Better Auth's default
 *     32-char random strings, so they match every other id in the schema.
 *     `advanced.database.generateId: 'uuid'` (packages/auth) makes the library
 *     mint `crypto.randomUUID()` values that fit.
 *
 * The **property names below are load-bearing**: the Drizzle adapter looks
 * columns up as `table[betterAuthFieldName]`, so a property rename silently
 * breaks auth at runtime. `test/auth-schema.test.ts` asks Better Auth itself
 * what it expects and fails the build if any of it has drifted — that test is
 * the reason a rename cannot go unnoticed.
 */

/** Better Auth `session`. One row per signed-in browser. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Opaque bearer value carried in the session cookie. Never logged. */
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** Organization plugin: the workspace this browser is currently "in". */
    activeOrganizationId: uuid('active_organization_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_sessions_token_key').on(t.token),
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Better Auth `account`. Credentials: one row per provider, plus one for the password. */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The id this user has *at the provider* (for `credential`, our user id). */
    accountId: text('account_id').notNull(),
    /** `credential` for email+password, otherwise the OAuth provider id. */
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** scrypt hash written by Better Auth. Nothing in this repo ever reads it. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_accounts_provider_account_key').on(t.providerId, t.accountId),
    index('auth_accounts_user_idx').on(t.userId),
  ],
);

/** Better Auth `verification`. Short-lived tokens: email verification, password reset. */
export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('auth_verifications_identifier_idx').on(t.identifier),
    index('auth_verifications_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Better Auth `member` — who belongs to a workspace, and as what.
 *
 * `role` is plain text because the organization plugin writes a comma-separated
 * list when a member holds several roles. The allowed set is enforced in code by
 * `authorize()` (packages/auth), which denies any role it does not recognise, so
 * an unexpected value fails closed rather than escalating.
 */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workspace_members_org_user_key').on(t.organizationId, t.userId),
    index('workspace_members_user_idx').on(t.userId),
  ],
);

/**
 * Better Auth `invitation` — an emailed offer to join a workspace.
 *
 * Single-use is a *state machine*, not a delete: the row moves out of `pending`
 * on the first accept/reject/cancel and Better Auth refuses to act on any other
 * status. The check constraint below is the database's half of that promise.
 */
export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workspace_invitations_org_idx').on(t.organizationId),
    index('workspace_invitations_email_idx').on(t.email),
    check(
      'workspace_invitations_status_known',
      sql`${t.status} IN ('pending', 'accepted', 'rejected', 'canceled')`,
    ),
  ],
);

/**
 * The object handed to `drizzleAdapter(db, { schema })`. Its keys are Better
 * Auth model names *after* the `modelName` remapping below — the adapter looks
 * a table up as `schema[modelName]`, so the two must be edited together.
 */
export const authTables = {
  users,
  authSessions,
  authAccounts,
  authVerifications,
  workspaces,
  workspaceMembers,
  workspaceInvitations,
};

/**
 * Model/field remapping for the four core Better Auth models. Spread into
 * `betterAuth({ ... })`. Only `user` needs field-level remapping; everything
 * else already uses Better Auth's own property names.
 */
export const authModelOptions = {
  user: {
    modelName: 'users',
    fields: { name: 'displayName', image: 'avatarUrl' },
  },
  session: { modelName: 'authSessions' },
  account: { modelName: 'authAccounts' },
  verification: { modelName: 'authVerifications' },
};

/** The same remapping for the organization plugin's three models. */
export const organizationSchemaOptions = {
  organization: { modelName: 'workspaces' },
  member: { modelName: 'workspaceMembers' },
  invitation: { modelName: 'workspaceInvitations' },
};

export type AuthSession = typeof authSessions.$inferSelect;
export type AuthAccount = typeof authAccounts.$inferSelect;
export type AuthVerification = typeof authVerifications.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type WorkspaceInvitation = typeof workspaceInvitations.$inferSelect;
