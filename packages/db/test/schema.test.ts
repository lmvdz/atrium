import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcceptedObjectType,
  AttentionClass,
  ProposalStatus,
  RECEIPT_POLICY,
  RelationKind,
} from '@atrium/core';
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
  commandReceipts,
  coreEvents,
  coreEventTypes,
  corrections,
  eventType,
  interpretations,
  isCoreEventType,
  memberships,
  messageReferenceKind,
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

  /**
   * CATCHES: a second register for "who was named here" reappearing at the schema
   * layer. Decision #92 made `message_references` the single register and dropped
   * `messages.mention_user_ids` (drizzle/0019). If a migration or a schema edit
   * re-adds the column — the exact split this ticket closed — this fails. Paired
   * with the projection-level guard in
   * `apps/server/test/attention-projection.test.ts` (the worker manufactures no
   * mention attention; the live reference path in projections.ts is the sole
   * producer), both ends of the split are pinned.
   */
  it('carries no second mention register — mention_user_ids is gone for good', () => {
    const columns = getTableConfig(messages).columns.map((c) => c.name);
    expect(columns).not.toContain('mention_user_ids');
  });

  /**
   * The reference alphabet names the two PARTICIPANT kinds — a person and an
   * agent, both identities that can be @-mentioned and can receive attention —
   * and the three room-item kinds, and nothing else. An allowlist assertion: the
   * two anonymous actor kinds (model, system) must never be spellable as a
   * reference target, because they carry no identity to be one.
   */
  it('lets a reference name a person or an agent, plus the three item kinds', () => {
    expect([...messageReferenceKind.enumValues]).toEqual([
      'human',
      'agent',
      'attachment',
      'proposal',
      'object',
    ]);
    expect(messageReferenceKind.enumValues).not.toContain('model');
    expect(messageReferenceKind.enumValues).not.toContain('system');
    expect(messageReferenceKind.enumValues).not.toContain('unknown');
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

describe('durable command receipts', () => {
  const config = getTableConfig(commandReceipts);

  it('keys a retry by room, authenticated actor, command and caller key', () => {
    // Catches: `command_receipt_key_drops_actor` — one participant can occupy
    // another participant's client-generated key and either retrieve their
    // result or prevent their command from landing.
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'room_id',
      'actor_kind',
      'actor_id',
      'command_name',
      'idempotency_key',
    ]);
  });

  it('binds both ends of the receipt interval to ledger rows in the same room', () => {
    // Catches: `command_receipt_event_fk_loses_room` — a forged or corrupted
    // receipt can name an equally numbered event from another room and return
    // somebody else's payload as the retry result.
    const foreignKeys = config.foreignKeys.map((fk) => fk.reference());
    expect(foreignKeys.map((fk) => fk.columns.map((column) => column.name))).toEqual(
      expect.arrayContaining([
        ['room_id', 'first_room_seq'],
        ['room_id', 'last_room_seq'],
      ]),
    );
    for (const endpoint of foreignKeys.filter((fk) => fk.columns.length === 2)) {
      expect(endpoint.foreignColumns.map((column) => column.name)).toEqual(['room_id', 'room_seq']);
    }
  });

  it('constrains the claimed interval, fingerprint and caller-sized key', () => {
    const checks = config.checks.map((constraint) => constraint.name);
    // Catches: `command_receipt_interval_accepts_a_partial_batch` — the stored
    // count can disagree with its endpoints, so a retry returns fewer or more
    // events than the command originally committed.
    expect(checks).toContain('command_receipts_interval_matches_count');
    expect(checks).toContain('command_receipts_event_count_positive');
    // Catches: `command_receipt_accepts_unversioned_payload_text` — arbitrary
    // caller text occupies the fingerprint column and defeats exact mismatch
    // detection; the boundary stores one lowercase SHA-256 representation.
    expect(checks).toContain('command_receipts_fingerprint_is_sha256');
    expect(checks).toContain('command_receipts_idempotency_key_bounded');
    // A system actor has no actor_id and therefore no stable retry namespace.
    expect(checks).toContain('command_receipts_actor_has_identity');
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
    expect(compositeFks(attentionItems)).toContainEqual(['room_id', 'subject_message_id']);
    expect(compositeFks(corrections)).toContainEqual(['room_id', 'object_id']);
    expect(compositeFks(messages)).toContainEqual(['room_id', 'reply_to_id']);
  });

  it('keeps the attention subject allowlisted, and all targets generated', () => {
    const columns = getTableConfig(attentionItems).columns;
    const named = (name: string) => columns.find((column) => column.name === name);
    // Mutation: leave subject_kind as an enum whose newly-added value cannot be
    // consumed in the same transactional migration, or omit the closed CHECK
    // after converting it to text.
    expect(named('subject_kind')?.getSQLType()).toBe('text');
    expect(getTableConfig(attentionItems).checks.map((check) => check.name)).toContain(
      'attention_items_subject_kind_allowlist',
    );
    expect(named('subject_id')?.notNull).toBe(true);
    // Generated, not written. It is what makes "exactly one target is set, and
    // it is the one the discriminator names" true by construction rather than
    // by a check constraint somebody has to keep in step.
    expect(named('subject_object_id')?.generated).toBeDefined();
    expect(named('subject_proposal_id')?.generated).toBeDefined();
    expect(named('subject_message_id')?.generated).toBeDefined();
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
    const entries = journal.entries as { idx: number; tag: string; when: number }[];
    expect(entries.map((entry) => entry.idx)).toEqual(files.map((_, index) => index));
    expect(entries.map((entry) => entry.tag)).toEqual(
      files.map((file) => file.replace(/\.sql$/, '')),
    );
    /**
     * Mutation: generate a later-numbered migration with an earlier timestamp.
     * Drizzle compares each folder timestamp to the latest applied row, so an
     * upgrade silently skips that migration even though fresh databases pass.
     */
    const latest = entries.at(-1);
    expect(latest?.when).toBeGreaterThan(
      Math.max(...entries.slice(0, -1).map((entry) => entry.when)),
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

/* ---------------------------------------------------------------------------
 * #86 — THE ONE NUMBER TWO LANGUAGES BOTH OWN.
 *
 * `atrium_receipt_window` (drizzle/0011) carries the cited messages plus the
 * room's next N after the newest citation. `laterRevision`
 * (packages/core/src/escalation.ts) reads at most
 * `RECEIPT_POLICY.maxLaterMessagesScanned` of them and decides what a short tail
 * MEANS from `RECEIPT_POLICY.maxLaterMessagesCarried`. A static SQL migration
 * cannot read a TypeScript constant, and #86 rejected generating the migration
 * from it — migrations must be readable and immutable after the fact, and a
 * generated migration is one whose meaning lives elsewhere.
 *
 * So both are hand-written and this is what keeps them in step: the same shape
 * `apps/web/test/token-contrast.test.ts` uses to hold `design/tokens.css`
 * against its consumers, and it exists because #86 IS the failure of two
 * hand-written rules drifting with nothing asserting agreement — and git
 * produced no conflict marker, because they were in different files and
 * different languages.
 *
 * The drift this catches is not hypothetical in either direction:
 *
 *  - literal LOWERED (say to 50) — the window stops at 50, the checker reads 50,
 *    finds no correction and CERTIFIES, while 150 messages the policy says must
 *    be read were never supplied and never looked at. Certifying against
 *    evidence never seen is the one direction of #86 that is dangerous.
 *  - literal RAISED without `maxLaterMessagesScanned` moving — costs an append
 *    more rows than any check will read, for nothing.
 *  - the two set EQUAL — a window the room outgrew and a room that simply ended
 *    become the same bytes, and the checker cannot tell them apart. The `+ 1` is
 *    the mechanism, not a margin.
 * ------------------------------------------------------------------------- */
describe('the receipt window’s bound is one number, written twice, asserted equal', () => {
  const WINDOW_MIGRATION = '0011_the_window_reaches_past_the_citations.sql';

  function windowMigration(): string {
    return readFileSync(join(migrationsDir, WINDOW_MIGRATION), 'utf8');
  }

  /**
   * Comments stripped before any rule reads the file. This migration argues for
   * its own number in prose and names the constants it is pinned to, so a rule
   * that read the documentation as evidence would pass on a file whose CODE said
   * something else entirely — which is the `token-contrast.test.ts` house rule
   * and the reason it is applied here rather than assumed.
   */
  function code(): string {
    return windowMigration().replace(/--[^\n]*/g, '');
  }

  it('declares the carried-messages bound as a named constant with one literal', () => {
    // Catches: `window_bound_becomes_anonymous` — inlining the number at the
    // `LIMIT` so nothing names it, which makes the assertion below unable to
    // find it and (before this test existed) makes it look absent rather than
    // wrong. Also `window_bound_declared_twice`, which would let one of two
    // spellings drift while the other passed.
    const declarations = [
      ...code().matchAll(/c_later_messages_carried\s+constant\s+integer\s*:=\s*(\d+)\s*;/g),
    ];
    expect(
      declarations,
      `${WINDOW_MIGRATION} must declare c_later_messages_carried exactly once, as an integer literal`,
    ).toHaveLength(1);
  });

  it('uses the constant it declared, and uses it at the LIMIT', () => {
    // Catches: `window_bound_declared_but_unused` — declaring `:= 201` and then
    // writing `LIMIT 50`, or dropping the LIMIT altogether. Both leave the
    // literal this file pins looking correct while the function carries a
    // different number of messages, and the equality assertion below would pass
    // on either. A constant nothing reads is a comment with a type; use is
    // checked by looking for the use.
    const source = code();
    expect(
      source,
      'the tail must be bounded by the declared constant, not by a bare number',
    ).toMatch(/LIMIT\s+c_later_messages_carried/);
    // …and the tail must be ordered before it is cut, or the bound selects an
    // arbitrary 201 rows rather than the room's earliest — and the correction
    // this whole window exists to make findable is usually the very next message.
    expect(source, 'the bounded tail must be ordered by the room’s own message order').toMatch(
      /ORDER\s+BY\s+m\."seq"\s+LIMIT\s+c_later_messages_carried/,
    );
  });

  it('carries exactly one more message than the checker reads', () => {
    // Catches: `receipt_policy_carried_equals_scanned`,
    // `receipt_policy_carried_below_scanned`, `window_migration_bound_drifts`.
    //
    // Three numbers, one rule. `laterRevision` refuses at runtime
    // (`window_carries_fewer_than_this_check_reads`) when carried <= scanned, so
    // the product fails closed if this ever ships wrong — but it fails closed by
    // refusing EVERY model acceptance, which is #86 all over again. This is the
    // check that says so at build time instead.
    const declared = Number(
      /c_later_messages_carried\s+constant\s+integer\s*:=\s*(\d+)\s*;/.exec(code())?.[1],
    );
    expect(declared, 'the migration’s literal must parse as a number').not.toBeNaN();
    expect(
      declared,
      `${WINDOW_MIGRATION} and RECEIPT_POLICY.maxLaterMessagesCarried are the same number written twice`,
    ).toBe(RECEIPT_POLICY.maxLaterMessagesCarried);
    expect(
      RECEIPT_POLICY.maxLaterMessagesCarried,
      'the supplier must stop strictly LATER than the checker reads, or a truncated window and a room that ended are the same bytes',
    ).toBe(RECEIPT_POLICY.maxLaterMessagesScanned + 1);
  });

  it('is the migration the receipt window’s reach actually lives in', () => {
    // Catches: `window_assertion_points_at_nothing`. Every assertion above reads
    // one file by name. If the function is later redefined in a 0012 and this
    // keeps reading 0011, all four go on passing while measuring a superseded
    // definition — a stale anchor that reads as green, which is the failure mode
    // this campaign has now recorded against its own mutation ledger.
    const redefinitions = migrationFiles().filter((file) =>
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+"atrium_receipt_window"/.test(
        readFileSync(join(migrationsDir, file), 'utf8').replace(/--[^\n]*/g, ''),
      ),
    );
    expect(
      redefinitions.at(-1),
      'the assertions above read this file; the newest definition of the window must be in it',
    ).toBe(WINDOW_MIGRATION);
  });
});
