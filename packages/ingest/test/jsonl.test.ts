import { describe, expect, it } from 'vitest';
import { serializeCorpus, serializeMessage } from '../src/jsonl.js';
import { CorpusValidationError, type IngestMessage, validateCorpusText } from '../src/validate.js';

const message: IngestMessage = {
  id: 'a',
  author: 'alice',
  ts: '2024-03-01T09:00:00.000Z',
  text: 'hello',
};

describe('serializeMessage', () => {
  it('writes keys in canonical order regardless of construction order', () => {
    const scrambled = {
      attachments: [{ url: 'https://example.com/a.png', name: 'a.png' }],
      text: 'hello',
      reply_to: 'b',
      ts: '2024-03-01T09:00:00.000Z',
      author: 'alice',
      id: 'a',
    } as IngestMessage;
    expect(serializeMessage(scrambled)).toBe(
      '{"id":"a","author":"alice","ts":"2024-03-01T09:00:00.000Z","text":"hello","reply_to":"b","attachments":[{"name":"a.png","url":"https://example.com/a.png"}]}',
    );
  });

  it('omits absent optionals rather than emitting null or []', () => {
    const line = serializeMessage(message);
    expect(line).not.toContain('reply_to');
    expect(line).not.toContain('attachments');
  });

  it('keeps contentType last when it is present', () => {
    const line = serializeMessage({
      ...message,
      attachments: [{ name: 'a.png', url: 'https://example.com/a.png', contentType: 'image/png' }],
    });
    expect(line).toContain(
      '{"name":"a.png","url":"https://example.com/a.png","contentType":"image/png"}',
    );
  });
});

describe('serializeCorpus', () => {
  const later: IngestMessage = { ...message, id: 'b', ts: '2024-03-01T10:00:00.000Z' };

  it('sorts into canonical order and terminates with a single newline', () => {
    const jsonl = serializeCorpus([later, message]);
    expect(jsonl.split('\n').filter(Boolean)).toHaveLength(2);
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(jsonl.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(jsonl.split('\n')[0] ?? '{}').id).toBe('a');
  });

  it('is byte-identical for any input permutation — the idempotence property', () => {
    expect(serializeCorpus([message, later])).toBe(serializeCorpus([later, message]));
  });

  it('round-trips through the validator', () => {
    const jsonl = serializeCorpus([later, message]);
    const { messages, issues } = validateCorpusText(jsonl);
    expect(issues).toEqual([]);
    expect(serializeCorpus(messages)).toBe(jsonl);
  });

  it('refuses to write a corpus that would fail its own validator', () => {
    expect(() => serializeCorpus([message, { ...message, id: 'c', reply_to: 'missing' }])).toThrow(
      CorpusValidationError,
    );
  });

  it('renders an empty corpus as an empty file, not a blank line', () => {
    expect(serializeCorpus([])).toBe('');
  });
});
