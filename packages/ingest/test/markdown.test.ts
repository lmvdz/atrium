import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serializeCorpus } from '../src/jsonl.js';
import { MarkdownConversionError, markdownToMessages } from '../src/markdown.js';
import { checkCorpus, validateCorpusText } from '../src/validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const transcript = readFileSync(join(HERE, 'fixtures', 'transcript.md'), 'utf8');

describe('markdownToMessages — fixture transcript', () => {
  const messages = markdownToMessages(transcript, { sourceId: 'transcript' });

  it('finds every speaker and ignores the preamble', () => {
    expect(messages.map((m) => m.author)).toEqual(['alice', 'bob', 'carol', 'dave', 'erin']);
  });

  it('assigns stable positional ids', () => {
    expect(messages.map((m) => m.id)).toEqual([
      'md:transcript:0001',
      'md:transcript:0002',
      'md:transcript:0003',
      'md:transcript:0004',
      'md:transcript:0005',
    ]);
  });

  it('reads the three timestamp forms and normalises them to UTC', () => {
    expect(messages.map((m) => m.ts)).toEqual([
      '2024-03-01T09:00:00.000Z',
      '2024-03-01T09:04:00.000Z',
      '2024-03-01T09:11:00.000Z', // 11:11 +02:00
      '2024-03-01T09:11:00.000Z', // inherited from carol
      '2024-03-01T10:00:00.000Z',
    ]);
  });

  it('resolves ordinal reply markers to ids that exist in the corpus', () => {
    expect(messages[1]?.reply_to).toBe('md:transcript:0001');
    expect(messages[4]?.reply_to).toBe('md:transcript:0003');
    expect(checkCorpus(messages)).toEqual([]);
  });

  it('keeps a bold run mid-paragraph in the body instead of splitting on it', () => {
    expect(messages[0]?.text).toContain('**Worth noting**');
  });

  it('does not treat a heading inside a fenced code block as a speaker', () => {
    expect(messages[1]?.text).toContain('## this line looks like a header');
    expect(messages[1]?.text).toContain("const storage = 'postgres';");
  });

  it('extracts embedded images as attachments', () => {
    expect(messages[2]?.attachments).toEqual([
      { name: 'schema sketch', url: 'https://example.com/sketch.png' },
    ]);
  });

  it('converts to a corpus that validates and is idempotent', () => {
    const jsonl = serializeCorpus(messages, 'transcript');
    expect(validateCorpusText(jsonl).issues).toEqual([]);
    expect(serializeCorpus(markdownToMessages(transcript, { sourceId: 'transcript' }))).toBe(jsonl);
  });
});

describe('markdownToMessages — options and failures', () => {
  it('namespaces ids by sourceId', () => {
    const [first] = markdownToMessages('## a — 2024-01-01T00:00:00Z\nhi', { sourceId: 'sync' });
    expect(first?.id).toBe('md:sync:0001');
  });

  it('applies defaultOffset to bare times', () => {
    const [first] = markdownToMessages('## a — 2024-01-01 12:00\nhi', {
      defaultOffset: '-05:00',
    });
    expect(first?.ts).toBe('2024-01-01T17:00:00.000Z');
  });

  it('falls back to defaultTs only for a first message that has none', () => {
    const messages = markdownToMessages('**a**:\nhi\n\n**b**:\nthere', {
      defaultTs: '2024-01-01T00:00:00Z',
    });
    expect(messages.map((m) => m.ts)).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
    ]);
  });

  it('never invents a timestamp from the wall clock', () => {
    expect(() => markdownToMessages('**a**:\nhi')).toThrow(MarkdownConversionError);
  });

  it('rejects a defaultTs without an offset', () => {
    expect(() => markdownToMessages('**a**:\nhi', { defaultTs: '2024-01-01 00:00' })).toThrow(
      MarkdownConversionError,
    );
  });

  it('rejects a forward or self reply marker', () => {
    const source =
      '## a — 2024-01-01T00:00:00Z (reply to #2)\nhi\n\n## b — 2024-01-01T00:01:00Z\nyo';
    expect(() => markdownToMessages(source)).toThrow(/must refer to an earlier message/);
  });

  it('reports every problem at once', () => {
    const source =
      '## a — 2024-01-01T00:00:00Z (reply to #4)\nhi\n\n## b — 2024-01-01T00:01:00Z (reply to #9)\nyo';
    try {
      markdownToMessages(source);
      expect.unreachable('expected a MarkdownConversionError');
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConversionError);
      expect((error as MarkdownConversionError).issues).toHaveLength(2);
    }
  });

  it('rejects a transcript with no headers at all', () => {
    expect(() => markdownToMessages('just some prose\nand more prose')).toThrow(
      /no message headers found/,
    );
  });

  it('normalises CRLF input', () => {
    const [first] = markdownToMessages('## a — 2024-01-01T00:00:00Z\r\nline one\r\nline two\r\n');
    expect(first?.text).toBe('line one\nline two');
  });
});
