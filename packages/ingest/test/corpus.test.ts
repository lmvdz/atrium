import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serializeCorpus } from '../src/jsonl.js';
import { demoSource, SOURCES, sourcesWithRole } from '../src/sources.js';
import { corpusStats } from '../src/stats.js';
import { validateCorpusText } from '../src/validate.js';

/**
 * The committed corpora are part of the deliverable, so they are held to the
 * same bar as the code. Re-serialising what is on disk and comparing byte for
 * byte proves idempotence without a network round trip: if a rerun of the
 * fetch would emit anything different in shape, order or spacing, this fails.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

describe.each(Object.values(SOURCES))('corpus $id', (source) => {
  const text = readFileSync(resolve(REPO_ROOT, source.out), 'utf8');
  const { messages, issues } = validateCorpusText(text);

  it('has no validation issues', () => {
    expect(issues).toEqual([]);
  });

  it('is non-trivial', () => {
    expect(messages.length).toBeGreaterThan(50);
    expect(corpusStats(messages).participants).toBeGreaterThan(5);
  });

  it('is byte-identical when re-serialised — the idempotence guarantee', () => {
    expect(serializeCorpus(messages, source.id)).toBe(text);
  });

  it('ends with exactly one newline and has no blank lines', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text.includes('\n\n')).toBe(false);
  });

  it('carries no ingestion timestamp — nothing that would break a rerun', () => {
    for (const key of ['fetched_at', 'fetchedAt', 'ingested_at', 'generated_at']) {
      expect(text).not.toContain(key);
    }
  });

  it('resolves every reply_to inside the file', () => {
    const ids = new Set(messages.map((message) => message.id));
    for (const message of messages) {
      if (message.reply_to !== undefined) expect(ids.has(message.reply_to)).toBe(true);
    }
  });

  it('attributes every message to a source-derived id', () => {
    const prefix = `github:${source.owner}/${source.repo}#${source.number}`;
    expect(messages.every((message) => message.id.startsWith(prefix))).toBe(true);
  });
});

const corpusOf = (source: { out: string }) =>
  validateCorpusText(readFileSync(resolve(REPO_ROOT, source.out), 'utf8')).messages;

describe('holdout discipline', () => {
  it('registers exactly one demo corpus and exactly one eval holdout, and they differ', () => {
    expect(sourcesWithRole('demo')).toHaveLength(1);
    expect(sourcesWithRole('eval-holdout')).toHaveLength(1);
    expect(demoSource().out).not.toBe(sourcesWithRole('eval-holdout')[0]?.out);
  });

  it('never demos against the holdout', () => {
    expect(demoSource().number).not.toBe(37136);
  });

  it('holds a long threaded discussion, as the eval set needs', () => {
    const holdout = sourcesWithRole('eval-holdout')[0];
    if (!holdout) throw new Error('no holdout source registered');
    const messages = corpusOf(holdout);
    expect(messages.length).toBeGreaterThanOrEqual(150);
    expect(messages.filter((message) => message.reply_to !== undefined).length).toBeGreaterThan(0);
  });
});

/**
 * The demo corpus drives the threaded replay UI, so a flat one is useless
 * however large it is — the round-1 demo had 111 messages and zero reply edges.
 * These bounds are the ticket's, asserted rather than trusted.
 */
describe('the demo corpus', () => {
  const demo = demoSource();
  const messages = corpusOf(demo);
  const replies = messages.filter((message) => message.reply_to !== undefined);

  it('comes from a genuinely threaded source', () => {
    expect(demo.kind).toBe('github-discussion');
  });

  it('is between 150 and 500 messages', () => {
    expect(messages.length).toBeGreaterThanOrEqual(150);
    expect(messages.length).toBeLessThanOrEqual(500);
  });

  it('carries real reply topology, not a handful of edges', () => {
    expect(replies.length).toBeGreaterThan(100);
    // More replies than roots: the tree has depth, not one flat fan-out.
    expect(replies.length).toBeGreaterThan(messages.length - replies.length);
    expect(new Set(replies.map((reply) => reply.reply_to)).size).toBeGreaterThan(20);
  });

  it('is a many-voiced debate', () => {
    expect(corpusStats(messages).participants).toBeGreaterThan(50);
  });
});
