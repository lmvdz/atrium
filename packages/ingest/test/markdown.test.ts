import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serializeCorpus } from '../src/jsonl.js';
import { MarkdownConversionError, markdownToMessages } from '../src/markdown.js';
import { checkCorpus, sortMessages, validateCorpusText } from '../src/validate.js';

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

  it('normalises CRLF in the pasted document so it can be tokenised at all', () => {
    const [first] = markdownToMessages('## a — 2024-01-01T00:00:00Z\r\nline one\r\nline two\r\n');
    expect(first?.text).toBe('line one\nline two');
  });

  it('keeps the trailing spaces that make a markdown hard break', () => {
    const [first] = markdownToMessages('## a — 2024-01-01T00:00:00Z\nline one  \nline two  \n\n');
    // Round 1 stripped all trailing whitespace, silently reflowing the message.
    expect(first?.text).toBe('line one  \nline two  ');
  });
});

/**
 * Transcript order is positional; corpus order is `(ts, id)`. A reply whose
 * timestamp predates its parent's makes the two disagree in the one place that
 * matters — the reply would be stored ahead of the message it answers.
 */
describe('markdownToMessages — transcript order versus timestamp order', () => {
  const outOfOrder = readFileSync(join(HERE, 'fixtures', 'transcript-out-of-order.md'), 'utf8');

  it('rejects a reply stamped before the message it replies to', () => {
    // Round 1 returned this happily; only the CLI's serialize step caught it,
    // and only as a `forward-reply` against a re-sorted line number.
    expect(() => markdownToMessages(outOfOrder, { sourceId: 'ooo' })).toThrow(
      MarkdownConversionError,
    );
  });

  it('names the transcript line, both timestamps, and the edge', () => {
    try {
      markdownToMessages(outOfOrder, { sourceId: 'ooo' });
      expect.unreachable('expected a MarkdownConversionError');
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownConversionError);
      const issues = (error as MarkdownConversionError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]?.line).toBe(11);
      expect(issues[0]?.message).toContain('md:ooo:0002');
      expect(issues[0]?.message).toContain('2024-03-01T09:05:00.000Z');
      expect(issues[0]?.message).toContain('2024-03-01T09:20:00.000Z');
    }
  });

  it('would otherwise have produced a corpus whose reply precedes its parent', () => {
    // The property the throw protects, shown directly: sorted, the reply lands
    // ahead of its parent and the corpus checker calls it a forward reference.
    const messages = [
      { id: 'md:ooo:0002', author: 'bob', ts: '2024-03-01T09:20:00.000Z', text: 'yes' },
      {
        id: 'md:ooo:0003',
        author: 'carol',
        ts: '2024-03-01T09:05:00.000Z',
        text: 'only if',
        reply_to: 'md:ooo:0002',
      },
    ];
    expect(checkCorpus(sortMessages(messages)).map((issue) => issue.code)).toEqual([
      'forward-reply',
    ]);
  });

  it('accepts equal timestamps, where transcript position still breaks the tie', () => {
    const source =
      '## a — 2024-01-01T00:00:00Z\nfirst\n\n## b — 2024-01-01T00:00:00Z [reply to #1]\nsecond';
    const messages = markdownToMessages(source, { sourceId: 'tie' });
    expect(checkCorpus(sortMessages(messages))).toEqual([]);
  });
});
