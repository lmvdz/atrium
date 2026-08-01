import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcceptedObjectType, AttentionClass, ProposalStatus, RelationKind } from '@atrium/core';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as authSchemaModule from '../src/auth-schema.js';
import * as schemaModule from '../src/schema.js';
import {
  acceptedObjects,
  acceptedObjectType,
  attentionClass,
  attentionItems,
  corrections,
  interpretations,
  memberships,
  messages,
  objectRelations,
  proposalStatus,
  proposals,
  relationKind,
  rooms,
  users,
} from '../src/schema.js';

const migrationsDir = join(import.meta.dirname, '..', 'drizzle');

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function migrationSql(): string {
  const files = migrationFiles();
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');
}

/**
 * Every SQL table name the Drizzle schema declares, both modules.
 *
 * The modules export enums, types and helpers alongside the tables, so the
 * exports are widened to `unknown` and narrowed by drizzle's own `is` — a type
 * predicate cannot be written against the precise union of every table's
 * literal name, and pretending otherwise would only move the cast somewhere
 * less obvious.
 */
function declaredTableNames(): string[] {
  const exported: unknown[] = [...Object.values(schemaModule), ...Object.values(authSchemaModule)];
  const tables = exported.filter((value): value is PgTable => is(value, PgTable));
  return [...new Set(tables.map((table) => getTableConfig(table).name))].sort();
}

describe('schema ↔ core parity', () => {
  it('uses the same five accepted object types as @atrium/core', () => {
    expect([...acceptedObjectType.enumValues]).toEqual([...AcceptedObjectType.options]);
  });

  it('uses the same five relation kinds as @atrium/core', () => {
    expect([...relationKind.enumValues]).toEqual([...RelationKind.options]);
  });

  it('uses the same attention classes and proposal statuses as @atrium/core', () => {
    expect([...attentionClass.enumValues]).toEqual([...AttentionClass.options]);
    expect([...proposalStatus.enumValues]).toEqual([...ProposalStatus.options]);
  });
});

describe('table shape', () => {
  it('declares every table issue #3 resolved on', () => {
    const names = [
      users,
      rooms,
      memberships,
      messages,
      interpretations,
      proposals,
      acceptedObjects,
      objectRelations,
      attentionItems,
      corrections,
    ].map((table) => getTableConfig(table).name);
    expect(names).toEqual([
      'users',
      'rooms',
      'memberships',
      'messages',
      'interpretations',
      'proposals',
      'accepted_objects',
      'relations',
      'attention_items',
      'corrections',
    ]);
  });

  it('keeps messages append-only — no updated_at, no deleted_at', () => {
    const columns = getTableConfig(messages).columns.map((c) => c.name);
    expect(columns).toContain('seq');
    expect(columns).not.toContain('updated_at');
    expect(columns).not.toContain('deleted_at');
  });

  it('stores the five object types in one table with a discriminator + jsonb payload', () => {
    const columns = getTableConfig(acceptedObjects).columns;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('type')?.enumValues).toEqual([...AcceptedObjectType.options]);
    expect(byName.get('payload')?.getSQLType()).toBe('jsonb');
    expect(byName.get('payload')?.notNull).toBe(true);
  });

  it('requires a rationale on every attention item', () => {
    const rationale = getTableConfig(attentionItems).columns.find((c) => c.name === 'rationale');
    expect(rationale?.notNull).toBe(true);
  });

  it('carries the (message_id, interpretation_version) unique constraint from issue #16', () => {
    const uniques = getTableConfig(interpretations).indexes.filter((i) => i.config.unique);
    const columns = uniques.flatMap((i) =>
      (i.config.columns ?? []).map((c) => ('name' in c ? c.name : String(c))),
    );
    expect(columns).toEqual(['message_id', 'interpretation_version']);
  });

  it('constrains relations to exactly one target', () => {
    const checks = getTableConfig(objectRelations).checks.map((c) => c.name);
    expect(checks).toContain('relations_single_target');
    expect(checks).toContain('relations_structural_targets_object');
    expect(checks).toContain('relations_no_self_edge');
  });
});

describe('generated migration', () => {
  /**
   * Derived from the schema, not hand-copied.
   *
   * A list of table names written out here is a list that goes stale the first
   * time somebody adds a table and forgets this file — and a migration test
   * that has gone stale is worse than none, because it is green. Enumerating
   * the Drizzle tables and demanding each one appear means "you added a table
   * and did not regenerate" is a red test rather than a runtime surprise.
   */
  it('creates every table the schema declares', () => {
    const sql = migrationSql();
    const declared = declaredTableNames();
    expect(declared.length).toBeGreaterThan(15);
    for (const table of declared) {
      expect(sql, `no CREATE TABLE for "${table}" — run \`pnpm db:generate\``).toContain(
        `CREATE TABLE "${table}"`,
      );
    }
  });

  /**
   * Nothing has ever shipped, so there is nothing to migrate *from*. Round 1
   * left `0001` adding `rooms.workspace_id NOT NULL` with no backfill, which is
   * a migration that cannot run against any database with rows in it — and the
   * fix for a schema no deployment has seen is not an expand/backfill dance,
   * it is one initial migration that is simply correct.
   *
   * This assertion is what stops that squash quietly un-squashing.
   *
   * **The one-time cost, written down rather than discovered.** Rewriting the
   * journal is not backwards compatible with a database that already ran the
   * old `0000`/`0001` pair: `drizzle-kit` records applied migrations by hash,
   * so a rewritten `0000` reads as *unapplied* and will be run again against
   * tables that already exist. That is fine here and only here — no deployment
   * of Atrium exists, and the only databases carrying the old journal are
   * developer laptops and the throwaway e2e container, both of which are meant
   * to be dropped (`docker compose down -v`, or just delete the database).
   * Nobody should ever "upgrade" a phantom deployment across this line. The
   * next migration to be written is `0001`, and from that point the ordinary
   * rules apply again.
   */
  it('is a single initial migration, because nothing has shipped yet', () => {
    const files = migrationFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^0000_/);
  });

  it('creates rooms.workspace_id as part of the table, not as a bare ALTER', () => {
    const sql = migrationSql();
    expect(sql).not.toContain('ALTER TABLE "rooms" ADD COLUMN "workspace_id"');
    expect(sql).toMatch(/CREATE TABLE "rooms"[\s\S]*?"workspace_id" uuid NOT NULL/);
  });

  it('emits the interpretation idempotency constraint and the relation checks', () => {
    const sql = migrationSql();
    expect(sql).toContain('interpretations_message_version_key');
    expect(sql).toContain('relations_single_target');
    expect(sql).toContain('attention_items_rationale_present');
  });
});
