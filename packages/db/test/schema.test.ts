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
  coreEvents,
  coreEventTypes,
  corrections,
  eventType,
  interpretations,
  isCoreEventType,
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

describe('the durable ledger (issue #22)', () => {
  /**
   * Structure, from drizzle's own metadata — not a grep over the SQL. What the
   * *database* does with these constraints is asserted in
   * `integration/db/ledger-constraints.test.ts`, against a real Postgres with
   * the migrations applied. This half only has to catch the schema drifting
   * away from the design.
   */
  const config = getTableConfig(coreEvents);

  it('carries both sequences: a global seq and a per-room room_seq', () => {
    const byName = new Map(config.columns.map((c) => [c.name, c]));
    // The global order the core's cursor lives in (#19 r3's consequence)...
    expect(byName.get('seq')?.primary).toBe(true);
    expect(byName.get('seq')?.getSQLType()).toBe('bigserial');
    // ...and the per-room client protocol from #12, wide enough not to run out.
    expect(byName.get('room_seq')?.getSQLType()).toBe('bigint');
    expect(byName.get('room_seq')?.notNull).toBe(true);
  });

  it('makes (room_id, room_seq) and the event id unique', () => {
    const unique = config.indexes
      .filter((i) => i.config.unique)
      .map((i) => (i.config.columns ?? []).map((c) => ('name' in c ? c.name : String(c))));
    expect(unique).toContainEqual(['room_id', 'room_seq']);
    expect(unique).toContainEqual(['id']);
  });

  it('keeps the lifted columns honest against the payload', () => {
    const checks = config.checks.map((c) => c.name);
    expect(checks).toContain('core_events_payload_id_matches');
    expect(checks).toContain('core_events_payload_type_matches');
    expect(checks).toContain('core_events_payload_has_at');
    expect(checks).toContain('core_events_room_seq_positive');
  });

  it('has no status, rejected or quarantine column — a refused event leaves no row', () => {
    const names = config.columns.map((c) => c.name);
    for (const forbidden of ['status', 'rejected', 'rejected_at', 'quarantined', 'valid']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('stores presence nowhere: the event_type enum has no presence or typing kind', () => {
    expect(eventType.enumValues).not.toContain('presence_changed');
    expect(eventType.enumValues).not.toContain('typing');
  });

  it('splits the enum into the reducer’s five and the ledger-only two', () => {
    expect([...coreEventTypes]).toEqual([
      'proposal_recorded',
      'proposal_rejected',
      'object_accepted',
      'object_corrected',
      'relation_added',
    ]);
    const ledgerOnly = eventType.enumValues.filter((v) => !isCoreEventType(v));
    expect(ledgerOnly).toEqual(['message_posted', 'attention_resolved']);
  });

  it('gives memberships a bigint seen_seq that matches room_seq’s width', () => {
    const seenSeq = getTableConfig(memberships).columns.find((c) => c.name === 'seen_seq');
    expect(seenSeq?.getSQLType()).toBe('bigint');
    expect(seenSeq?.notNull).toBe(true);
    // The int4 column it replaced is gone, not shadowed.
    expect(getTableConfig(memberships).columns.map((c) => c.name)).not.toContain('last_read_seq');
  });
});

describe('composite (room_id, id) foreign keys', () => {
  /** A plain FK checks existence; only a composite one checks "in this room". */
  const compositeFks = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table)
      .foreignKeys.map((fk) => fk.reference())
      .filter((ref) => ref.columns.length > 1)
      .map((ref) => ref.columns.map((c) => c.name));

  it('makes every relation endpoint room-scoped', () => {
    const fks = compositeFks(objectRelations);
    expect(fks).toContainEqual(['room_id', 'from_object_id']);
    expect(fks).toContainEqual(['room_id', 'to_object_id']);
    expect(fks).toContainEqual(['room_id', 'to_message_id']);
    // ...and leaves no bare-id one behind for a writer to slip through.
    const single = getTableConfig(objectRelations)
      .foreignKeys.map((fk) => fk.reference())
      .filter((ref) => ref.columns.length === 1)
      .map((ref) => ref.columns.map((c) => c.name)[0]);
    expect(single).not.toContain('from_object_id');
    expect(single).not.toContain('to_object_id');
    expect(single).not.toContain('to_message_id');
  });

  it('scopes objects, attention, corrections and replies the same way', () => {
    expect(compositeFks(acceptedObjects)).toContainEqual(['room_id', 'objective_id']);
    expect(compositeFks(acceptedObjects)).toContainEqual(['room_id', 'superseded_by_id']);
    expect(compositeFks(acceptedObjects)).toContainEqual(['room_id', 'proposal_id']);
    expect(compositeFks(attentionItems)).toContainEqual(['room_id', 'object_id']);
    expect(compositeFks(corrections)).toContainEqual(['room_id', 'object_id']);
    expect(compositeFks(messages)).toContainEqual(['room_id', 'reply_to_id']);
  });

  it('publishes the (room_id, id) unique keys those foreign keys need', () => {
    for (const table of [messages, proposals, acceptedObjects]) {
      const unique = getTableConfig(table)
        .indexes.filter((i) => i.config.unique)
        .map((i) => (i.config.columns ?? []).map((c) => ('name' in c ? c.name : String(c))));
      expect(unique).toContainEqual(['room_id', 'id']);
    }
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
      'core_events',
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

  it('quotes #22’s append invariant where the ledger is created', () => {
    // Not decoration. The shape of this table — no status column, a sequence
    // assigned inside the transaction — is unreadable without the rule it
    // follows from, and the next person to change it will read the migration.
    const sql = migrationSql();
    expect(sql).toContain('ONLY events accepted in canonical order');
    expect(sql).toContain('never persisted');
  });

  it('backfills seen_seq before dropping the column it replaces', () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const added = files.findIndex((f) =>
      readFileSync(join(migrationsDir, f), 'utf8').includes('SET "seen_seq" = "last_read_seq"'),
    );
    const dropped = files.findIndex((f) =>
      readFileSync(join(migrationsDir, f), 'utf8').includes('DROP COLUMN "last_read_seq"'),
    );
    expect(added).toBeGreaterThanOrEqual(0);
    expect(dropped).toBeGreaterThan(added);
  });
});
