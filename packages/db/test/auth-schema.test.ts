import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSchema } from 'better-auth/db';
import { organization } from 'better-auth/plugins/organization';
import type { PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  authModelOptions,
  authTables,
  organizationSchemaOptions,
  workspaceInvitations,
  workspaceMembers,
} from '../src/auth-schema.js';
import { rooms, users, workspaces } from '../src/schema.js';

/**
 * Better Auth's Drizzle adapter resolves a column as `table[fieldName]` at
 * runtime. That means a mismatch between what the library expects and what this
 * package declares is invisible to the compiler and shows up as a 500 on
 * somebody's first signup instead.
 *
 * So this file does not assert against a hand-copied list of columns — it asks
 * the installed Better Auth what schema it wants, using the exact options
 * `packages/auth` passes it, and checks our tables satisfy it. Upgrade the
 * library and add a field, and this test is what tells you.
 */

const authOptions = {
  appName: 'atrium',
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  ...authModelOptions,
  plugins: [organization({ schema: organizationSchemaOptions })],
};

const expected = getSchema(authOptions);

/**
 * The adapter indexes tables by name at runtime, which is exactly what the
 * compiler cannot follow — so the lookup is typed the way the adapter does it
 * and the assertions below stand in for the type system.
 */
const tables = authTables as unknown as Record<string, PgTable & Record<string, unknown>>;

describe('better auth ↔ drizzle parity', () => {
  it('resolves to exactly the tables we hand the adapter, under our names', () => {
    // `getSchema` returns models already keyed by their remapped model name, so
    // this asserts two things at once: the remapping reached the library, and
    // the plugin set defines no model we forgot to declare a table for. Upgrade
    // Better Auth and gain a model, and this is where you find out.
    expect(Object.keys(expected).sort()).toEqual(Object.keys(authTables).sort());
  });

  // `getSchema` keys models by their remapped name, so `model` below is already
  // the key the Drizzle adapter will look up in `authTables`.
  it('declares a table for every model better auth asks for', () => {
    for (const model of Object.keys(expected)) {
      expect(
        tables[model],
        `no drizzle table mapped for better-auth model "${model}"`,
      ).toBeDefined();
    }
  });

  it('declares a column for every field better auth asks for', () => {
    for (const [model, definition] of Object.entries(expected)) {
      const table = tables[model];
      expect(table).toBeDefined();
      if (!table) continue;

      // Every model needs an id; the adapter reads and writes it directly.
      expect(table.id, `${model} is missing "id"`).toBeDefined();

      for (const [field, attribute] of Object.entries(definition.fields)) {
        const property = attribute.fieldName ?? field;
        expect(
          table[property],
          `${model} is missing "${property}" (better-auth ${model}.${field})`,
        ).toBeDefined();
      }
    }
  });

  it('makes every required field NOT NULL and every unique field unique', () => {
    for (const [model, definition] of Object.entries(expected)) {
      const table = tables[model];
      if (!table) continue;
      const config = getTableConfig(table as PgTable);
      const columns = new Map(config.columns.map((column) => [column.name, column] as const));
      const uniqueColumns = new Set(
        config.indexes
          .filter((i) => i.config.unique)
          .flatMap((i) => (i.config.columns ?? []).map((c) => ('name' in c ? c.name : ''))),
      );

      for (const [field, attribute] of Object.entries(definition.fields)) {
        const property = attribute.fieldName ?? field;
        const column = table[property] as { name: string } | undefined;
        if (!column) continue;
        const declared = columns.get(column.name);
        if (attribute.required) {
          expect(declared?.notNull, `${model}.${column.name} must be NOT NULL`).toBe(true);
        }
        if (attribute.unique) {
          expect(uniqueColumns.has(column.name), `${model}.${column.name} must be unique`).toBe(
            true,
          );
        }
      }
    }
  });

  it('maps better auth onto the application tables rather than duplicating them', () => {
    // The whole reason Better Auth won issue #13: one users row per human, with
    // application data foreign-keyed straight at it.
    expect(tables.users).toBe(users);
    expect(tables.workspaces).toBe(workspaces);
  });
});

describe('workspace tenancy', () => {
  it('scopes rooms to a workspace', () => {
    const config = getTableConfig(rooms);
    const workspaceId = config.columns.find((c) => c.name === 'workspace_id');
    expect(workspaceId?.notNull).toBe(true);
    const uniques = config.indexes.filter((i) => i.config.unique).map((i) => i.config.name);
    expect(uniques).toContain('rooms_workspace_slug_key');
  });

  it('allows exactly one membership row per person per workspace', () => {
    const uniques = getTableConfig(workspaceMembers)
      .indexes.filter((i) => i.config.unique)
      .flatMap((i) => (i.config.columns ?? []).map((c) => ('name' in c ? c.name : '')));
    expect(uniques).toEqual(['organization_id', 'user_id']);
  });

  it('constrains an invitation to the four states better auth can put it in', () => {
    const checks = getTableConfig(workspaceInvitations).checks.map((c) => c.name);
    expect(checks).toContain('workspace_invitations_status_known');
  });
});

describe('generated migration', () => {
  const migrationsDir = join(import.meta.dirname, '..', 'drizzle');
  const sql = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), 'utf8'))
    .join('\n');

  it('creates every auth table', () => {
    for (const table of [
      'workspaces',
      'workspace_members',
      'workspace_invitations',
      'auth_sessions',
      'auth_accounts',
      'auth_verifications',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  /**
   * The columns Better Auth needs on `users` are now part of creating the
   * table, not bolted on by a second migration. Nothing has ever shipped, so
   * the squash into one initial migration is free — and it removes the
   * `rooms.workspace_id NOT NULL` step that could not have run against any
   * database that already had rooms.
   */
  it('declares better auth’s user columns in the initial CREATE TABLE', () => {
    expect(sql).not.toContain('ALTER TABLE "users" ADD COLUMN');
    const create = /CREATE TABLE "users" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
    expect(create).toContain('"email_verified"');
    expect(create).toContain('"updated_at"');
  });
});
