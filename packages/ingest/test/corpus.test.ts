import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serializeCorpus } from '../src/jsonl.js';
import { SOURCES } from '../src/sources.js';
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

describe('holdout discipline', () => {
  it('keeps the eval corpus flagged and separate from the demo corpus', () => {
    const holdout = Object.values(SOURCES).filter((source) => source.evalOnly);
    const demo = Object.values(SOURCES).filter((source) => !source.evalOnly);
    expect(holdout).toHaveLength(1);
    expect(demo).toHaveLength(1);
    expect(holdout[0]?.out).not.toBe(demo[0]?.out);
  });

  it('holds a long threaded discussion, as the eval set needs', () => {
    const holdout = Object.values(SOURCES).find((source) => source.evalOnly);
    if (!holdout) throw new Error('no holdout source registered');
    const { messages } = validateCorpusText(readFileSync(resolve(REPO_ROOT, holdout.out), 'utf8'));
    expect(messages.length).toBeGreaterThanOrEqual(150);
    expect(messages.filter((message) => message.reply_to !== undefined).length).toBeGreaterThan(0);
  });
});
