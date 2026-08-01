import { describe, expect, it } from 'vitest';
import {
  assertValidCorpus,
  CorpusValidationError,
  checkCorpus,
  compareMessages,
  IngestMessage,
  sortMessages,
  validateCorpusText,
} from '../src/validate.js';

const base = {
  id: 'github:owner/repo#1',
  author: 'alice',
  ts: '2024-03-01T09:00:00.000Z',
  text: 'hello',
};

describe('IngestMessage', () => {
  it('accepts the canonical shape', () => {
    expect(IngestMessage.safeParse(base).success).toBe(true);
    expect(
      IngestMessage.safeParse({
        ...base,
        reply_to: 'github:owner/repo#1',
        attachments: [{ name: 'sketch.png', url: 'https://example.com/sketch.png' }],
      }).success,
    ).toBe(true);
  });

  it('accepts an empty body — an image-only comment is still a message', () => {
    expect(IngestMessage.safeParse({ ...base, text: '' }).success).toBe(true);
  });

  it.each([
    ['empty id', { ...base, id: '' }],
    ['empty author', { ...base, author: '' }],
    ['timestamp without an offset', { ...base, ts: '2024-03-01T09:00:00' }],
    ['non-ISO timestamp', { ...base, ts: 'yesterday' }],
    ['missing text', { id: base.id, author: base.author, ts: base.ts }],
    ['unknown key', { ...base, channel: 'general' }],
    ['null reply_to instead of omission', { ...base, reply_to: null }],
    ['empty attachments array', { ...base, attachments: [] }],
    ['attachment without a url', { ...base, attachments: [{ name: 'x' }] }],
    ['attachment with a non-http url', { ...base, attachments: [{ name: 'x', url: 'ftp://a/b' }] }],
  ])('rejects %s', (_label, value) => {
    expect(IngestMessage.safeParse(value).success).toBe(false);
  });
});

describe('ordering', () => {
  it('sorts by timestamp then id, deterministically for any permutation', () => {
    const a = { ...base, id: 'a', ts: '2024-03-01T09:00:00.000Z' };
    const b = { ...base, id: 'b', ts: '2024-03-01T09:00:00.000Z' };
    const c = { ...base, id: 'c', ts: '2024-03-01T08:00:00.000Z' };
    expect(sortMessages([a, b, c]).map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(sortMessages([b, c, a]).map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(compareMessages(a, a)).toBe(0);
  });
});

describe('checkCorpus', () => {
  it('passes a well-formed corpus', () => {
    const parent = { ...base, id: 'a', ts: '2024-03-01T09:00:00.000Z' };
    const child = { ...base, id: 'b', ts: '2024-03-01T09:01:00.000Z', reply_to: 'a' };
    expect(checkCorpus([parent, child])).toEqual([]);
  });

  it('catches duplicate ids', () => {
    const issues = checkCorpus([base, base]);
    expect(issues.map((issue) => issue.code)).toContain('duplicate-id');
  });

  it('catches a reply_to that resolves nowhere in the file', () => {
    const issues = checkCorpus([{ ...base, reply_to: 'github:owner/repo#999' }]);
    expect(issues).toEqual([expect.objectContaining({ code: 'dangling-reply', line: 1 })]);
  });

  it('catches a reply_to that points forward', () => {
    const first = { ...base, id: 'a', ts: '2024-03-01T09:00:00.000Z', reply_to: 'b' };
    const second = { ...base, id: 'b', ts: '2024-03-01T09:01:00.000Z' };
    expect(checkCorpus([first, second]).map((issue) => issue.code)).toEqual(['forward-reply']);
  });

  it('catches a self-reply', () => {
    expect(checkCorpus([{ ...base, reply_to: base.id }]).map((i) => i.code)).toEqual([
      'self-reply',
    ]);
  });

  it('catches lines that are not in canonical order', () => {
    const later = { ...base, id: 'a', ts: '2024-03-01T10:00:00.000Z' };
    const earlier = { ...base, id: 'b', ts: '2024-03-01T09:00:00.000Z' };
    expect(checkCorpus([later, earlier]).map((issue) => issue.code)).toEqual(['out-of-order']);
  });
});

describe('validateCorpusText', () => {
  const line = (value: unknown): string => JSON.stringify(value);

  it('parses and validates a good file, tolerating the trailing newline', () => {
    const text = `${line(base)}\n`;
    const { messages, issues } = validateCorpusText(text);
    expect(issues).toEqual([]);
    expect(messages).toHaveLength(1);
  });

  it('reports the line number of a malformed line', () => {
    const text = `${line(base)}\nnot json\n`;
    const { issues } = validateCorpusText(text);
    expect(issues).toEqual([expect.objectContaining({ line: 2, code: 'invalid-json' })]);
  });

  it('reports schema failures per field with the offending path', () => {
    const text = `${line({ ...base, ts: 'nope' })}\n`;
    const { issues } = validateCorpusText(text);
    expect(issues[0]?.code).toBe('schema');
    expect(issues[0]?.message).toContain('ts');
  });

  it('reports interior blank lines but not the final newline', () => {
    const { issues } = validateCorpusText(
      `${line(base)}\n\n${line({ ...base, id: 'github:owner/repo#2' })}\n`,
    );
    expect(issues).toEqual([expect.objectContaining({ line: 2, code: 'invalid-json' })]);
  });

  it('keeps line numbers aligned with the file after a bad line', () => {
    const text = `not json\n${line({ ...base, id: 'a' })}\n${line({ ...base, id: 'a' })}\n`;
    const { issues } = validateCorpusText(text);
    expect(issues.map((issue) => [issue.line, issue.code])).toEqual([
      [1, 'invalid-json'],
      [3, 'duplicate-id'],
    ]);
  });
});

describe('assertValidCorpus', () => {
  it('throws with every issue collected', () => {
    expect(() => assertValidCorpus([base, base])).toThrow(CorpusValidationError);
  });

  it('is quiet on a valid corpus', () => {
    expect(() => assertValidCorpus([base])).not.toThrow();
  });
});
