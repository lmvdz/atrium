import type { IngestMessage } from './validate.js';

export interface CorpusStats {
  messages: number;
  participants: number;
  /** Earliest and latest `ts` in the corpus, or `null` when it is empty. */
  firstTs: string | null;
  lastTs: string | null;
  /** Messages carrying `reply_to`. */
  replies: number;
  attachments: number;
  /** Descending by message count, ties broken by name — deterministic. */
  topAuthors: Array<{ author: string; messages: number }>;
}

export function corpusStats(messages: readonly IngestMessage[], topN = 5): CorpusStats {
  const byAuthor = new Map<string, number>();
  let replies = 0;
  let attachments = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const message of messages) {
    byAuthor.set(message.author, (byAuthor.get(message.author) ?? 0) + 1);
    if (message.reply_to !== undefined) replies++;
    attachments += message.attachments?.length ?? 0;
    if (firstTs === null || message.ts < firstTs) firstTs = message.ts;
    if (lastTs === null || message.ts > lastTs) lastTs = message.ts;
  }

  const topAuthors = [...byAuthor.entries()]
    .map(([author, count]) => ({ author, messages: count }))
    .sort((a, b) => b.messages - a.messages || (a.author < b.author ? -1 : 1))
    .slice(0, topN);

  return {
    messages: messages.length,
    participants: byAuthor.size,
    firstTs,
    lastTs,
    replies,
    attachments,
    topAuthors,
  };
}

export function formatStats(stats: CorpusStats): string {
  const range =
    stats.firstTs && stats.lastTs ? `${stats.firstTs} → ${stats.lastTs}` : '(empty corpus)';
  const authors = stats.topAuthors.map((entry) => `${entry.author} (${entry.messages})`).join(', ');
  return [
    `  messages:     ${stats.messages}`,
    `  participants: ${stats.participants}`,
    `  range:        ${range}`,
    `  replies:      ${stats.replies}`,
    `  attachments:  ${stats.attachments}`,
    `  top authors:  ${authors || '—'}`,
  ].join('\n');
}
