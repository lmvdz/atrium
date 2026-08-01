import { describe, expect, it } from 'vitest';
import { extractAttachments, normalizeText, normalizeTimestamp } from '../src/text.js';

describe('normalizeText', () => {
  it('normalises line endings and strips a byte order mark', () => {
    expect(normalizeText('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('trims leading blank lines and trailing whitespace', () => {
    expect(normalizeText('\n\n  hello  \n\n')).toBe('  hello');
  });

  it('keeps interior indentation, so fenced code survives', () => {
    expect(normalizeText('```\n    indented\n```')).toBe('```\n    indented\n```');
  });

  it('is idempotent and composes to the same bytes on a second pass', () => {
    const once = normalizeText('\r\nCafé́\r\n');
    expect(normalizeText(once)).toBe(once);
  });
});

describe('normalizeTimestamp', () => {
  it('converts an offset to UTC', () => {
    expect(normalizeTimestamp('2024-03-01T11:11:00+02:00')).toBe('2024-03-01T09:11:00.000Z');
  });

  it('accepts Z and sub-second precision', () => {
    expect(normalizeTimestamp('2016-07-28T00:03:48Z')).toBe('2016-07-28T00:03:48.000Z');
    expect(normalizeTimestamp('2016-07-28T00:03:48.250Z')).toBe('2016-07-28T00:03:48.250Z');
  });

  it('refuses offsetless input, which would resolve against the host timezone', () => {
    expect(() => normalizeTimestamp('2024-03-01T09:00:00')).toThrow(/offset/);
    expect(() => normalizeTimestamp('2024-03-01 09:00')).toThrow(/offset/);
  });

  it('refuses a real-looking but impossible date', () => {
    expect(() => normalizeTimestamp('2024-13-45T00:00:00Z')).toThrow();
  });
});

describe('extractAttachments', () => {
  it('takes markdown images in order of appearance', () => {
    expect(
      extractAttachments('![one](https://e.com/1.png) then ![two](https://e.com/2.png)'),
    ).toEqual([
      { name: 'one', url: 'https://e.com/1.png' },
      { name: 'two', url: 'https://e.com/2.png' },
    ]);
  });

  it('falls back to the filename when the alt text is empty', () => {
    expect(extractAttachments('![](https://e.com/path/my%20file.png)')).toEqual([
      { name: 'my file.png', url: 'https://e.com/path/my%20file.png' },
    ]);
  });

  it('takes links only when they point at a GitHub upload host', () => {
    const body =
      '[docs](https://example.com/docs) and [notes](https://github.com/user-attachments/files/1/notes.txt)';
    expect(extractAttachments(body)).toEqual([
      { name: 'notes', url: 'https://github.com/user-attachments/files/1/notes.txt' },
    ]);
  });

  it('deduplicates by url so a repeated embed is one attachment', () => {
    expect(extractAttachments('![a](https://e.com/1.png) ![b](https://e.com/1.png)')).toHaveLength(
      1,
    );
  });

  it('returns nothing for a body with no media', () => {
    expect(extractAttachments('just words, and a bare https://example.com link')).toEqual([]);
  });
});
