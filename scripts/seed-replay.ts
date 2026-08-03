import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, like } from 'drizzle-orm';
import { reconcileStoredAttention } from '../apps/server/src/attention-projection.js';
import type { ExtractedReading } from '../apps/server/src/jobs/extraction.js';
import { runInterpretation } from '../apps/server/src/jobs/interpret.js';
import type {
  InterpretationProvider,
  InterpretationRequest,
} from '../apps/server/src/jobs/provider.js';
import { createLedger } from '../apps/server/src/ledger.js';
import { createLogger } from '../apps/server/src/logger.js';
import {
  createDatabase,
  memberships,
  messages,
  rooms,
  users,
  workspaceMembers,
  workspaces,
} from '../packages/db/src/index.js';

interface CorpusLine {
  id: string;
  author: string;
  ts: string;
  text: string;
  reply_to?: string;
}

const WORKSPACE_SLUG = 'atrium-replay';
const ROOM_SLUG = 'typescript-9998';
const MODEL = 'replay/precomputed-v1';
const MEMBER_NAMES = new Set(['RyanCavanaugh', 'ahejlsberg', 'basickarl', 'ExE-Boss', 'pimterry']);
const CURRENT_OPEN_QUESTION = 'any plan to improve the developer experience on this subject?';

const readings = [
  {
    match:
      'trade-offs in the control flow analysis work based on running the real-world code (RWC) tests',
    text: 'trade-offs in the control flow analysis work based on running the real-world code (RWC) tests',
    type: 'objective',
  },
  {
    match:
      'In aggregate, I think our optimistic assumption that type guards are unaffected by intervening function calls is the best compromise.',
    text: 'optimistic assumption that type guards are unaffected by intervening function calls is the best compromise',
    type: 'decision',
  },
  {
    match: 'We will instead be using a function to obtain the current token:',
    text: 'will instead be using a function to obtain the current token',
    type: 'decision',
  },
  {
    match: CURRENT_OPEN_QUESTION,
    text: CURRENT_OPEN_QUESTION,
    type: 'open_question',
  },
] as const;

function stableUuid(value: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`atrium-replay:${value}`).digest('hex').slice(0, 32),
    'hex',
  );
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function transcript(request: InterpretationRequest) {
  const rows: Array<{ id: string; authorId: string; body: string }> = [];
  const matcher =
    /--- message ([0-9a-f-]{36}) · author ([0-9a-f-]{36}|\(unknown\)) ---\n([\s\S]*?)(?=\n--- message [0-9a-f-]{36} · author |$)/g;
  for (const match of request.prompt.matchAll(matcher)) {
    rows.push({ id: match[1] as string, authorId: match[2] as string, body: match[3] as string });
  }
  return rows;
}

const provider: InterpretationProvider = {
  async generate(request) {
    const window = transcript(request);
    const extracted: ExtractedReading[] = [];
    for (const reading of readings) {
      const source = window.find((message) => message.body.includes(reading.match));
      if (!source) continue;
      extracted.push({
        type: reading.type,
        text: 'text' in reading ? reading.text : reading.match,
        subject: reading.type === 'claim' || reading.type === 'commitment' ? source.authorId : null,
        confidence: 0.95,
        quote: reading.match,
        messageIds: [source.id],
      });
    }
    return {
      output: { readings: extracted },
      raw: { source: MODEL, readings: extracted },
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0 },
      model: MODEL,
    };
  },
};

async function main() {
  const databaseUrl = process.env.ATRIUM_REPLAY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('set ATRIUM_REPLAY_DATABASE_URL (or DATABASE_URL)');
  const corpusPath = resolve(process.argv[2] ?? '../../corpora/ts9998.jsonl');
  const corpus = readFileSync(corpusPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusLine);
  if (corpus.length !== 111)
    throw new Error(`expected the 111-message demo corpus, found ${corpus.length}`);

  const database = createDatabase({ url: databaseUrl });
  const logger = createLogger('error');
  const workspaceId = stableUuid('workspace');
  const roomId = stableUuid('room');
  const authors = [...new Set(corpus.map((line) => line.author))];
  const authorIds = new Map(authors.map((author) => [author, stableUuid(`author:${author}`)]));
  const messageIds = new Map(corpus.map((line) => [line.id, stableUuid(`message:${line.id}`)]));

  try {
    const [old] = await database.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, WORKSPACE_SLUG));
    if (old) await database.db.delete(workspaces).where(eq(workspaces.id, old.id));
    await database.db.delete(users).where(like(users.email, '%@replay.atrium.invalid'));

    await database.db.insert(users).values(
      authors.map((author) => ({
        id: authorIds.get(author) as string,
        email: `${authorIds.get(author)}@replay.atrium.invalid`,
        displayName: author,
      })),
    );
    await database.db.insert(workspaces).values({
      id: workspaceId,
      name: 'TypeScript control-flow analysis',
      slug: WORKSPACE_SLUG,
    });
    await database.db.insert(rooms).values({
      id: roomId,
      workspaceId,
      slug: ROOM_SLUG,
      name: 'function-call side effects',
      createdBy: authorIds.get('RyanCavanaugh'),
    });

    const memberIds = authors
      .filter((author) => MEMBER_NAMES.has(author))
      .map((author) => authorIds.get(author) as string);
    await database.db
      .insert(workspaceMembers)
      .values(memberIds.map((userId) => ({ organizationId: workspaceId, userId, role: 'member' })));
    await database.db
      .insert(memberships)
      .values(memberIds.map((userId) => ({ roomId, userId, role: 'member' })));
    await database.db.insert(messages).values(
      corpus.map((line) => ({
        id: messageIds.get(line.id) as string,
        roomId,
        authorId: authorIds.get(line.author) as string,
        body: line.text,
        replyToId: line.reply_to ? (messageIds.get(line.reply_to) ?? null) : null,
        clientMessageId: line.id,
        createdAt: new Date(line.ts),
      })),
    );

    const ledger = createLedger({ db: database.db, logger });
    await ledger.hydrate();
    let calls = 0;
    let proposalCount = 0;
    let autoAccepted = 0;
    const workerRejections: string[] = [];
    while (true) {
      const run = await runInterpretation(
        {
          db: database.db,
          ledger,
          provider,
          routing: { default: MODEL, escalation: MODEL },
          logger,
          config: { maxWindowMessages: 8, contextMessagesBefore: 0 },
        },
        { roomId },
      );
      if (run.messageIds.length === 0) break;
      calls += run.providerCalls;
      proposalCount += run.proposalsRecorded.length;
      autoAccepted += run.objectsAccepted.length;
      workerRejections.push(...run.rejected.map((item) => `${item.reason}: ${item.detail}`));
    }

    const evidenceWindow = corpus.map((line) => ({
      id: messageIds.get(line.id) as string,
      roomId,
      authorId: authorIds.get(line.author) as string,
      body: line.text,
      replyToId: line.reply_to ? (messageIds.get(line.reply_to) ?? null) : null,
      createdAt: line.ts,
    }));
    const attention = await reconcileStoredAttention({
      db: database.db,
      state: ledger.coreState(),
      roomId,
      messages: evidenceWindow,
      now: corpus.at(-1)?.ts ?? new Date().toISOString(),
    });

    console.log(`replay room       /replay/${WORKSPACE_SLUG}/${ROOM_SLUG}`);
    console.log(`messages          ${corpus.length}`);
    console.log(`reply edges       ${corpus.filter((line) => line.reply_to).length}`);
    console.log(`worker calls      ${calls} (${MODEL}; precomputed, no API spend)`);
    console.log(`proposals         ${proposalCount}`);
    console.log(`auto-accepted     ${autoAccepted}`);
    console.log(`worker rejected   ${workerRejections.length}`);
    for (const rejection of workerRejections) console.log(`  rejected         ${rejection}`);
    console.log('human-accepted    0 (no certification act exists in the corpus)');
    console.log(
      `attention pending ${attention.items.filter((item) => item.status === 'pending').length}`,
    );
    console.log(`attention refused ${attention.refusals.length}`);
    for (const refusal of attention.refusals) console.log(`  refused          ${refusal.reason}`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error),
  );
  process.exitCode = 1;
});
