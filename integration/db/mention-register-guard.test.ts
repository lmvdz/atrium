import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { describeError } from '../support/constraints.js';
import { openDatabase } from '../support/harness.js';

/*
 * drizzle/0019 drops `messages.mention_user_ids`. The column was dead for the
 * CLIENT, but the SERVER write path once filled it (projections.ts wrote
 * `event.mentionUserIds`), so a real database could carry legacy values that a
 * bare DROP would silently lose — and with them the mention attention of those
 * messages. A bare `uuid[]` has no offset/surface/ordinal, so it cannot be
 * back-filled into `message_references` (whose spans the trigger validates
 * against the authored body); the migration therefore REFUSES rather than
 * guesses, raising if any row still carries a non-empty value.
 *
 * This test runs the migration's OWN guard bytes (extracted from the .sql, not a
 * paraphrase) against a stub `messages` table in a throwaway schema.
 *
 * CATCHES: deleting the fail-if-populated guard from the migration (extraction
 * finds nothing → `guard` is undefined → the first expectation fails), moving it
 * AFTER the drop (the ordering expectation fails), or weakening it so a populated
 * column no longer aborts (the populated-row expectation fails).
 */

const MIGRATION_PATH = fileURLToPath(
  new URL('../../packages/db/drizzle/0020_mention_register.sql', import.meta.url),
);

const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

const handle = openDatabase(2);
afterAll(async () => handle.close());

describe('0020 refuses to drop mention_user_ids when legacy data survives', () => {
  // The guard is the sole `DO $$ … END $$;` block (the trigger uses `AS $$`, not
  // `DO $$`), extracted by its own bytes so this test runs what ships, not a
  // paraphrase. Comments are glued to the following statement in the .sql, so the
  // block is matched on the raw file rather than a statement split.
  const guardMatch = MIGRATION_SQL.match(/DO \$\$[\s\S]*?END\s*\$\$;/);
  const guard = guardMatch?.[0];
  const guardPos = guardMatch?.index ?? -1;
  const dropPos = MIGRATION_SQL.search(/DROP COLUMN "?mention_user_ids"?/);

  it('ships a fail-if-populated guard positioned BEFORE the drop', () => {
    expect(guard, 'the migration has no DO-block guard for mention_user_ids').toBeDefined();
    expect(guard, 'the guard does not mention the column it protects').toContain(
      'mention_user_ids',
    );
    expect(dropPos, 'the migration no longer drops mention_user_ids').toBeGreaterThanOrEqual(0);
    expect(guardPos).toBeGreaterThanOrEqual(0);
    expect(guardPos).toBeLessThan(dropPos);
  });

  /** Run the extracted guard against a stub table that still has the column. */
  async function runGuardWith(values: string): Promise<void> {
    const schema = `guard_probe_${randomUUID().replace(/-/g, '')}`;
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${schema}"`));
      // Resolve the guard's unqualified `messages` to the stub, never public.
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schema}"`));
      await tx.execute(
        sql.raw('CREATE TABLE messages (id uuid PRIMARY KEY, mention_user_ids uuid[])'),
      );
      if (values.length > 0) {
        await tx.execute(sql.raw(`INSERT INTO messages (id, mention_user_ids) VALUES ${values}`));
      }
      await tx.execute(sql.raw(guard as string));
      // Never commit the probe schema; a raise aborts the tx, a pass rolls back.
      throw new ProbeRollback();
    });
  }

  it('raises against a row that still carries a non-empty mention_user_ids', async () => {
    try {
      await runGuardWith(`('${randomUUID()}', ARRAY['${randomUUID()}']::uuid[])`);
    } catch (error) {
      if (error instanceof ProbeRollback) {
        throw new Error(
          'the guard let a populated mention_user_ids through — the drop would lose it',
        );
      }
      expect(describeError(error)).toContain('refusing to drop messages.mention_user_ids');
      return;
    }
    throw new Error('the guard did not run');
  });

  it('permits the drop when every row is empty or null — the launch case', async () => {
    // A pass reaches ProbeRollback; a wrongful raise surfaces as the pg error.
    try {
      await runGuardWith(`('${randomUUID()}', '{}'::uuid[]), ('${randomUUID()}', NULL)`);
      throw new Error('the transaction committed instead of rolling the probe schema back');
    } catch (error) {
      if (error instanceof ProbeRollback) return; // the guard stayed silent, as it must
      throw error;
    }
  });
});

/** Sentinel: force the probe transaction to roll its throwaway schema back. */
class ProbeRollback extends Error {}
