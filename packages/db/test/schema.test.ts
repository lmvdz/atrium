import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcceptedObjectType, AttentionClass, ProposalStatus, RelationKind } from '@atrium/core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
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

function migrationSql(): string {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');
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
  it('exists and creates every table', () => {
    const sql = migrationSql();
    for (const table of [
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
      'proposal_sources',
      'object_sources',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('emits the interpretation idempotency constraint and the relation checks', () => {
    const sql = migrationSql();
    expect(sql).toContain('interpretations_message_version_key');
    expect(sql).toContain('relations_single_target');
    expect(sql).toContain('attention_items_rationale_present');
  });
});
