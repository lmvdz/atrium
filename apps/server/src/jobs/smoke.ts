import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from '@atrium/db';
import { messages, rooms, users, workspaces } from '@atrium/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { createLedger } from '../ledger.js';
import { createLogger } from '../logger.js';
import { runInterpretation } from './interpret.js';
import { createGatewayProvider } from './provider.js';

/**
 * The recorded smoke run #23's verification gate asks for: the real default
 * model, a slice of a real corpus, and a cost line.
 *
 *   ATRIUM_SMOKE_DATABASE_URL=postgres://…  \
 *   INTERPRET_MODEL_DEFAULT=…               \
 *   AI_GATEWAY_API_KEY=…                    \
 *   pnpm --filter @atrium/server exec tsx src/jobs/smoke.ts [corpus] [count]
 *
 * ## Two rules this file will not bend
 *
 * **It calls the real provider, or it fails.** There is no mock branch, no
 * `--dry-run`, and no fallback if the gateway refuses — a smoke test that
 * quietly runs against a stub produces a green line about a call nobody made.
 *
 * **It never invents a cost.** The gateway reports one or it does not; when it
 * does not, this prints "not reported" and says so, because a cost line is a
 * number somebody will plan against and `$0.0000` because a field was missing
 * is a fabricated receipt.
 *
 * The room it builds is disposable and is torn down at the end. It writes to
 * whatever database it is pointed at, so point it at a scratch one.
 */

interface CorpusLine {
  id: string;
  author: string;
  ts: string;
  text: string;
}

function loadCorpus(path: string, count: number): CorpusLine[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, count)
    .map((line) => JSON.parse(line) as CorpusLine);
  if (lines.length === 0) throw new Error(`no messages in ${path}`);
  return lines;
}

async function main(): Promise<void> {
  const [corpusArg, countArg] = process.argv.slice(2);
  const corpusPath = resolve(corpusArg ?? 'corpora/ts9998.jsonl');
  const count = Number(countArg ?? 20);

  const databaseUrl = process.env.ATRIUM_SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('set ATRIUM_SMOKE_DATABASE_URL (or DATABASE_URL)');

  const model = process.env.INTERPRET_MODEL_DEFAULT;
  const escalation = process.env.INTERPRET_MODEL_ESCALATION ?? model;
  if (!model) {
    throw new Error(
      'set INTERPRET_MODEL_DEFAULT — the smoke run exists to exercise the configured default pass, and there is no default id in this repository to fall back on',
    );
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    // Stated up front rather than discovered as a 401 three seconds later, and
    // still a hard stop: the run is worthless without a real call.
    throw new Error(
      'AI_GATEWAY_API_KEY is not set — this run calls the AI Gateway for real and will not substitute anything for it',
    );
  }

  const corpus = loadCorpus(corpusPath, count);
  const logger = createLogger('info');
  const database = createDatabase({ url: databaseUrl });

  const workspaceId = randomUUID();
  const roomId = randomUUID();
  const authorIds = new Map<string, string>();

  try {
    await database.db.insert(workspaces).values({
      id: workspaceId,
      name: 'interpretation smoke',
      slug: `smoke-${roomId.slice(0, 8)}`,
    });
    for (const line of corpus) {
      if (authorIds.has(line.author)) continue;
      const id = randomUUID();
      authorIds.set(line.author, id);
      await database.db
        .insert(users)
        .values({ id, email: `${id}@smoke.invalid`, displayName: line.author });
    }
    await database.db
      .insert(rooms)
      .values({ id: roomId, workspaceId, slug: `smoke-${roomId.slice(0, 8)}`, name: 'smoke' });
    /**
     * No `memberships` and no `workspace_members` rows, and that is not an
     * oversight twice over.
     *
     * The worker never asks whether anybody is a member: it appends as a
     * `model` actor with no `authorize` callback, and the append procedure's
     * authorization applies to human actors. Seeding a membership would be
     * seeding a fact this path does not read.
     *
     * It is also forbidden. `packages/auth`'s room-membership boundary refuses
     * any file under `apps/` that can reach the `memberships` table — the
     * joined read that caps a room role at the workspace role lives in
     * `@atrium/auth` and nowhere else, and a smoke fixture is exactly the kind
     * of file that quietly reopens that door. The check is a test, and it
     * failed on the first draft of this file.
     */
    for (const line of corpus) {
      await database.db.insert(messages).values({
        roomId,
        authorId: authorIds.get(line.author) as string,
        body: line.text,
        createdAt: new Date(line.ts),
      });
    }

    const ledger = createLedger({ db: database.db, logger });
    await ledger.hydrate();

    const startedAt = Date.now();
    const run = await runInterpretation(
      {
        db: database.db,
        ledger,
        provider: createGatewayProvider(),
        routing: { default: model, escalation: escalation as string },
        logger,
        config: { maxWindowMessages: count, contextMessagesBefore: 0 },
      },
      { roomId },
    );
    const elapsedMs = Date.now() - startedAt;

    const cost =
      run.costUsd === null ? 'not reported by the gateway' : `$${run.costUsd.toFixed(6)} USD`;

    console.log('\n── interpretation smoke run ────────────────────────────────');
    console.log(`corpus            ${corpusPath}`);
    console.log(`messages read     ${run.messageIds.length}`);
    console.log(`authors           ${authorIds.size}`);
    console.log(`tier              ${run.tier}`);
    console.log(`triggers          ${run.triggers.join(', ') || '(none)'}`);
    console.log(`model requested   ${model}`);
    console.log(`model answered    ${run.model}`);
    console.log(`provider calls    ${run.providerCalls}`);
    console.log(`elapsed           ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`input tokens      ${run.inputTokens ?? 'not reported'}`);
    console.log(`output tokens     ${run.outputTokens ?? 'not reported'}`);
    console.log(`COST              ${cost}`);
    console.log(`proposals         ${run.proposalsRecorded.length}`);
    console.log(`auto-accepted     ${run.objectsAccepted.length}`);
    console.log(`readings refused  ${run.rejected.length}`);
    for (const rejected of run.rejected) {
      console.log(`  · ${rejected.reason}: ${rejected.detail.slice(0, 200)}`);
    }
    console.log('────────────────────────────────────────────────────────────\n');
  } finally {
    // The room and everything hanging off it. `rooms` cascades to messages,
    // interpretations, proposals and core_events; `users` cascades to
    // memberships and workspace_members. Torn down even when the run threw —
    // a smoke run that leaves a room behind is one nobody runs twice.
    const seeded = [...authorIds.values()];
    await database.db.delete(rooms).where(eq(rooms.id, roomId));
    if (seeded.length > 0) await database.db.delete(users).where(inArray(users.id, seeded));
    await database.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
