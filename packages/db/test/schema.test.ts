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

  it('requires a structured reason on every attention item, not a rendered sentence', () => {
    const columns = getTableConfig(attentionItems).columns;
    const reason = columns.find((c) => c.name === 'reason');
    expect(reason?.notNull).toBe(true);
    expect(reason?.getSQLType()).toBe('jsonb');
    // Catches: keeping `rationale` alongside `reason` as a rendered
    // denormalisation. #21 made the sentence a render of the reason
    // (`renderRationale`), so a stored copy is a second source for the same
    // fact — it freezes today's wording into every historical row, and "which
    // rule raised this" becomes a substring search over prose.
    expect(columns.map((c) => c.name)).not.toContain('rationale');
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

  it('splits the enum into the reducer’s six and the ledger-only two', () => {
    // Pinned by value on both sides, because the direction that bites is the
    // one a `satisfies` cannot express: a seventh core type added to
    // @atrium/core and forgotten here compiles, is classified as ledger-only,
    // is never folded, and vanishes from every replay while live ingestion
    // still applies it (r1, major 3). `proposal_superseded` is the sixth,
    // added by #21 for #8's re-interpretation.
    expect([...coreEventTypes]).toEqual([
      'proposal_recorded',
      'proposal_rejected',
      'proposal_superseded',
      'object_accepted',
      'object_corrected',
      'relation_added',
    ]);
    const ledgerOnly = eventType.enumValues.filter((v) => !isCoreEventType(v));
    expect(ledgerOnly).toEqual(['message_posted', 'attention_resolved']);
  });

  it('carries the trusted actor as two columns, and no actor in the payload', () => {
    const columns = config.columns.map((c) => c.name);
    // #21's contract, at the storage layer. Catches: reinstating the `actor`
    // jsonb column — which is not merely redundant, it is the shape whose
    // ability to disagree with the payload was r1's major 2.
    expect(columns).toContain('actor_kind');
    expect(columns).toContain('actor_id');
    expect(columns).not.toContain('actor');

    const checks = config.checks.map((c) => c.name);
    // The inverted equality. Catches: deleting
    // `core_events_payload_actor_matches` without replacing it, which is how a
    // finding gets lost during a contract change: the old constraint became
    // unsatisfiable, so the tempting move is to drop it, and the rule it
    // carried — one actor per row, in one place — goes with it.
    expect(checks).toContain('core_events_payload_has_no_actor');
    expect(checks).toContain('core_events_actor_id_matches_kind');
    expect(checks).not.toContain('core_events_payload_actor_matches');
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
    // Attention went polymorphic (#21 → #22): the subject is an object *or* a
    // proposal, and both edges have to stay room-scoped. A polymorphic
    // reference is the easiest place in a schema to quietly lose one.
    expect(compositeFks(attentionItems)).toContainEqual(['room_id', 'subject_object_id']);
    expect(compositeFks(attentionItems)).toContainEqual(['room_id', 'subject_proposal_id']);
    expect(compositeFks(corrections)).toContainEqual(['room_id', 'object_id']);
    expect(compositeFks(messages)).toContainEqual(['room_id', 'reply_to_id']);
  });

  it('keeps the attention subject discriminated, and both targets generated', () => {
    const columns = getTableConfig(attentionItems).columns;
    const named = (name: string) => columns.find((column) => column.name === name);
    expect(named('subject_kind')?.enumValues).toEqual(['object', 'proposal']);
    expect(named('subject_id')?.notNull).toBe(true);
    // Generated, not written. It is what makes "exactly one target is set, and
    // it is the one the discriminator names" true by construction rather than
    // by a check constraint somebody has to keep in step.
    expect(named('subject_object_id')?.generated).toBeDefined();
    expect(named('subject_proposal_id')?.generated).toBeDefined();
    // And the old bare column is gone, not merely unused: a `needs_decision`
    // item pointing at a proposal was unstorable while it existed.
    expect(named('object_id')).toBeUndefined();
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
   *
   * AND `0001` HAS NOW BEEN WRITTEN — by the core lane, adding three
   * `correction_action` enum values. So the assertion states the guarantee
   * rather than the file count it happened to imply on the day it was written:
   * "there is exactly ONE `0000_`, and it is first" is what stops the squash
   * un-squashing, and it stays true for every migration written after it.
   * `expect(files).toHaveLength(1)` did not mean "the squash held"; it meant
   * "nobody has migrated since", which is a different sentence and stops being
   * true the moment the schema moves.
   */
  it('is a single squashed initial migration, because nothing had shipped', () => {
    const files = migrationFiles();
    expect(files.filter((file) => file.startsWith('0000_'))).toHaveLength(1);
    expect(files[0]).toMatch(/^0000_/);
  });

  /**
   * THE OTHER HALF, AND THE ONE THAT ONLY MATTERS ONCE THERE IS MORE THAN ONE
   * MIGRATION. Numbers are the whole ordering — drizzle applies them in journal
   * order and names them by tag — so two lanes that each write `0001` produce a
   * directory that looks fine to a reader and applies one of them. Merging
   * three branches that had each moved the schema is exactly the situation that
   * makes it possible, so the numbering is asserted rather than eyeballed:
   * contiguous from 0000, no duplicates, and the journal saying the same thing
   * as the filesystem in the same order.
   */
  it('numbers its migrations contiguously, and the journal agrees with the files', () => {
    const files = migrationFiles();
    const numbers = files.map((file) => Number(file.slice(0, 4)));
    expect(numbers, 'migration numbers must be contiguous from 0000 with no duplicates').toEqual(
      files.map((_, index) => index),
    );

    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'));
    const entries = journal.entries as { idx: number; tag: string }[];
    expect(entries.map((entry) => entry.idx)).toEqual(files.map((_, index) => index));
    expect(entries.map((entry) => entry.tag)).toEqual(
      files.map((file) => file.replace(/\.sql$/, '')),
    );
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
