import { describe, expect, it } from 'vitest';
import {
  extractAttachments,
  isAttachmentUrl,
  normalizeDocument,
  normalizeTimestamp,
  trimBlockBody,
  verbatimBody,
} from '../src/text.js';

describe('verbatimBody', () => {
  it('changes nothing at all — bodies are stored as the source sent them', () => {
    const body = '﻿Café line one  \r\nline two\t\n\n   ';
    expect(verbatimBody(body)).toBe(body);
  });

  it('keeps the two trailing spaces that make a markdown hard break', () => {
    expect(verbatimBody('first  \nsecond')).toBe('first  \nsecond');
  });

  it('keeps decomposed Unicode decomposed, so NFC never rewrites an author', () => {
    const decomposed = 'Café';
    expect(verbatimBody(decomposed)).toBe(decomposed);
    expect(verbatimBody(decomposed)).not.toBe(decomposed.normalize('NFC'));
  });

  it('survives a JSON round trip byte for byte, which is what determinism needs', () => {
    const body = 'a\r\nb  \n\tć​ ';
    expect(JSON.parse(JSON.stringify(verbatimBody(body)))).toBe(body);
  });
});

describe('normalizeDocument', () => {
  it('normalises line endings and strips a byte order mark, for parsing only', () => {
    expect(normalizeDocument('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('leaves everything else alone', () => {
    expect(normalizeDocument('  spaced  \n\n  ')).toBe('  spaced  \n\n  ');
  });
});

describe('trimBlockBody', () => {
  it('drops the blank lines around a transcript block', () => {
    expect(trimBlockBody('\n\nhello\n\n')).toBe('hello');
  });

  it('keeps trailing spaces on the last content line — that is a hard break', () => {
    expect(trimBlockBody('hello  \n\n')).toBe('hello  ');
  });

  it('keeps interior blank lines and indentation, so fenced code survives', () => {
    expect(trimBlockBody('```\n    indented\n\n```')).toBe('```\n    indented\n\n```');
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

describe('isAttachmentUrl', () => {
  it('accepts GitHub upload hosts', () => {
    expect(isAttachmentUrl('https://user-images.githubusercontent.com/1/2.png')).toBe(true);
    expect(isAttachmentUrl('https://private-user-images.githubusercontent.com/1/2.png')).toBe(true);
    expect(isAttachmentUrl('https://raw.githubusercontent.com/o/r/main/x.png')).toBe(true);
  });

  it('accepts github.com only under the upload path', () => {
    expect(isAttachmentUrl('https://github.com/user-attachments/files/1/notes.txt')).toBe(true);
    expect(isAttachmentUrl('https://github.com/vercel/next.js/pull/1')).toBe(false);
  });

  it('rejects a host that merely contains an upload host as a substring', () => {
    // The round-1 `url.includes(host)` check said yes to both of these.
    expect(isAttachmentUrl('https://user-images.githubusercontent.com.evil.test/x.png')).toBe(
      false,
    );
    expect(
      isAttachmentUrl('https://evil.test/?next=https://user-images.githubusercontent.com/1/2.png'),
    ).toBe(false);
    expect(isAttachmentUrl('https://evil.test/github.com/user-attachments/x')).toBe(false);
  });

  it('rejects non-http schemes and unparseable input', () => {
    expect(isAttachmentUrl('ftp://raw.githubusercontent.com/x')).toBe(false);
    expect(isAttachmentUrl('not a url')).toBe(false);
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

  it('orders by position in the body regardless of which syntax was used', () => {
    const body = [
      'See [the attachment](https://github.com/user-attachments/files/1/notes.txt)',
      'and <img src="https://user-images.githubusercontent.com/9/9/inline.png" alt="inline">',
    ].join(' ');
    expect(extractAttachments(body).map((a) => a.name)).toEqual(['the attachment', 'inline']);
  });

  it('resolves reference-style images', () => {
    const body = '![the sketch][sketch]\n\n[sketch]: https://e.com/sketch.png';
    expect(extractAttachments(body)).toEqual([
      { name: 'the sketch', url: 'https://e.com/sketch.png' },
    ]);
  });

  it('resolves collapsed and shortcut reference images', () => {
    expect(extractAttachments('![diagram][]\n\n[diagram]: https://e.com/d.png')).toEqual([
      { name: 'diagram', url: 'https://e.com/d.png' },
    ]);
    expect(extractAttachments('![trace]\n\n[trace]: https://e.com/t.png')).toEqual([
      { name: 'trace', url: 'https://e.com/t.png' },
    ]);
  });

  it('resolves reference-style links, upload hosts only', () => {
    const body = [
      'compare [the log][log] with [the spec][spec]',
      '',
      '[log]: https://github.com/user-attachments/files/7/run.log',
      '[spec]: https://example.com/spec',
    ].join('\n');
    expect(extractAttachments(body)).toEqual([
      { name: 'the log', url: 'https://github.com/user-attachments/files/7/run.log' },
    ]);
  });

  it('ignores a reference with no definition', () => {
    expect(extractAttachments('![missing][nowhere]')).toEqual([]);
  });

  it('takes a bare upload URL, and drops the sentence punctuation after it', () => {
    expect(
      extractAttachments('repro here https://user-images.githubusercontent.com/3/4.png.'),
    ).toEqual([{ name: '4.png', url: 'https://user-images.githubusercontent.com/3/4.png' }]);
  });

  it('takes an autolinked upload URL', () => {
    expect(extractAttachments('<https://raw.githubusercontent.com/o/r/main/chart.svg>')).toEqual([
      { name: 'chart.svg', url: 'https://raw.githubusercontent.com/o/r/main/chart.svg' },
    ]);
  });

  it('leaves a bare non-upload URL alone', () => {
    expect(extractAttachments('just words, and a bare https://example.com link')).toEqual([]);
  });

  it('deduplicates by url, keeping the first — and therefore the richest — name', () => {
    const body =
      '![a](https://user-images.githubusercontent.com/1/1.png) and again https://user-images.githubusercontent.com/1/1.png';
    expect(extractAttachments(body)).toEqual([
      { name: 'a', url: 'https://user-images.githubusercontent.com/1/1.png' },
    ]);
  });

  it('is not fooled by a lookalike host inside a link', () => {
    expect(
      extractAttachments('[bait](https://user-images.githubusercontent.com.evil.test/x.png)'),
    ).toEqual([]);
  });
});
