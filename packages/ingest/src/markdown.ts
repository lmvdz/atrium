import { extractAttachments, normalizeText, normalizeTimestamp } from './text.js';
import type { IngestMessage } from './validate.js';

/**
 * Pasted-markdown → canonical JSONL.
 *
 * init.md allows a conversation to arrive as "JSON, Markdown, or pasted text",
 * so this is the escape hatch for a transcript nobody can hand us an API for.
 * The grammar is deliberately forgiving about punctuation and strict about the
 * two things that carry meaning — who spoke, and when:
 *
 * ```md
 * ## alice — 2024-03-01T09:00:00Z
 * We need to decide on the storage layer.
 *
 * ### bob (2024-03-01 09:04)      ← a bare time takes `defaultOffset`
 * Postgres. [reply to #1]         ← ordinal reply marker, resolved to an id
 *
 * **carol** 2024-03-01 09:11
 * Agreed.
 * ```
 *
 * Header forms:
 *  - any markdown heading (`#`..`######`) — headings delimit messages, so a
 *    transcript body that uses its own headings needs the bold form instead;
 *  - `**author**` followed by a timestamp, a colon, or nothing — the timestamp
 *    requirement is what stops a bold phrase mid-paragraph from being read as
 *    a new speaker.
 *
 * Everything up to the next header is the body; content before the first
 * header is preamble and is ignored.
 *
 * Ids are positional and stable — `md:<sourceId>:0001` — so re-converting the
 * same transcript yields the same corpus, byte for byte. Nothing reads a
 * clock: a message with no timestamp inherits its predecessor's, and a first
 * message with none falls back to `defaultTs` (or is an error).
 */

export interface MarkdownOptions {
  /** Id namespace; also the corpus name. Defaults to `transcript`. */
  sourceId?: string;
  /** Offset applied to timestamps written without one. Defaults to `Z`. */
  defaultOffset?: string;
  /** Timestamp for a first message that has none. Must carry an offset. */
  defaultTs?: string;
}

export interface MarkdownIssue {
  line: number;
  message: string;
}

export class MarkdownConversionError extends Error {
  constructor(readonly issues: MarkdownIssue[]) {
    super(
      `markdown transcript could not be converted:\n${issues
        .map((issue) => `  line ${issue.line}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'MarkdownConversionError';
  }
}

const HEADING = /^#{1,6}\s+(.+?)\s*$/;
/** ```` ``` ```` or `~~~`, optionally indented — toggles "inside a code block". */
const FENCE = /^ {0,3}(```+|~~~+)/;
const BOLD_AUTHOR = /^\*\*([^*]+)\*\*\s*(.*?)\s*$/;
const REPLY_MARKER = /(?:[([]\s*(?:in\s+)?repl(?:y|ying)\s+to\s+#(\d+)\s*[)\]]|↳\s*#(\d+))\s*$/i;
const TIMESTAMP =
  /(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?/;
/** Separators and wrappers people put between a name and a time. */
const AUTHOR_TRIM = /^[\s\-–—·|@[(]+|[\s\-–—·|:,[\]()]+$/g;

interface Block {
  line: number;
  author: string;
  ts: string | undefined;
  replyOrdinal: number | undefined;
  body: string[];
}

interface HeaderCandidate {
  /** Known up front for the bold form; derived from `rest` for headings. */
  author: string | undefined;
  rest: string;
  /** The bold form is only a header if it looks like one. */
  requiresTimestamp: boolean;
}

function headerCandidate(line: string): HeaderCandidate | undefined {
  const bold = BOLD_AUTHOR.exec(line);
  if (bold) {
    const author = (bold[1] ?? '').trim();
    const rest = bold[2] ?? '';
    if (author !== '') {
      const bare = rest.trim();
      return { author, rest, requiresTimestamp: bare !== '' && bare !== ':' };
    }
  }
  const heading = HEADING.exec(line);
  if (heading) return { author: undefined, rest: heading[1] ?? '', requiresTimestamp: false };
  return undefined;
}

function buildTimestamp(match: RegExpExecArray, defaultOffset: string): string {
  const [, date, hh, mm, ss, offset] = match;
  const time = `${hh ?? '00'}:${mm ?? '00'}:${ss ?? '00'}`;
  const zone = offset === undefined ? defaultOffset : offset === 'z' ? 'Z' : offset;
  return normalizeTimestamp(`${date}T${time}${zone}`);
}

/**
 * Convert a pasted markdown transcript. Every problem in the file is reported
 * at once via `MarkdownConversionError` rather than failing on the first.
 */
export function markdownToMessages(source: string, options: MarkdownOptions = {}): IngestMessage[] {
  const sourceId = options.sourceId ?? 'transcript';
  const defaultOffset = options.defaultOffset ?? 'Z';
  const issues: MarkdownIssue[] = [];

  let defaultTs: string | undefined;
  if (options.defaultTs !== undefined) {
    try {
      defaultTs = normalizeTimestamp(options.defaultTs);
    } catch (error) {
      issues.push({ line: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const blocks: Block[] = [];
  const lines = normalizeText(source).split('\n');
  let current: Block | undefined;

  let insideFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // A `## heading` inside a fenced code block is code, not a new speaker.
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      if (current) current.body.push(line);
      continue;
    }
    if (insideFence) {
      if (current) current.body.push(line);
      continue;
    }

    const candidate = headerCandidate(line);
    if (!candidate) {
      if (current) current.body.push(line);
      continue;
    }

    let rest = candidate.rest;
    let replyOrdinal: number | undefined;
    const reply = REPLY_MARKER.exec(rest);
    if (reply) {
      const ordinal = Number.parseInt(reply[1] ?? reply[2] ?? '', 10);
      if (Number.isFinite(ordinal)) replyOrdinal = ordinal;
      rest = rest.slice(0, reply.index);
    }

    const timestamp = TIMESTAMP.exec(rest);
    if (!timestamp && candidate.requiresTimestamp) {
      if (current) current.body.push(line);
      continue;
    }

    let ts: string | undefined;
    if (timestamp) {
      try {
        ts = buildTimestamp(timestamp, defaultOffset);
      } catch (error) {
        issues.push({
          line: i + 1,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      rest = `${rest.slice(0, timestamp.index)} ${rest.slice(timestamp.index + timestamp[0].length)}`;
    }

    const author = (candidate.author ?? rest).replace(AUTHOR_TRIM, '').trim();
    if (author === '') {
      issues.push({ line: i + 1, message: 'header has no author' });
      current = undefined;
      continue;
    }

    current = { line: i + 1, author, ts, replyOrdinal, body: [] };
    blocks.push(current);
  }

  if (blocks.length === 0) {
    issues.push({ line: 1, message: 'no message headers found' });
    throw new MarkdownConversionError(issues);
  }

  const width = Math.max(4, String(blocks.length).length);
  const idFor = (ordinal: number): string =>
    `md:${sourceId}:${String(ordinal).padStart(width, '0')}`;

  const messages: IngestMessage[] = [];
  let previousTs: string | undefined;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block) continue;
    const ordinal = index + 1;

    const ts = block.ts ?? previousTs ?? defaultTs;
    if (ts === undefined) {
      issues.push({
        line: block.line,
        message: 'message has no timestamp, no predecessor to inherit one from, and no defaultTs',
      });
      continue;
    }
    previousTs = ts;

    if (
      block.replyOrdinal !== undefined &&
      (block.replyOrdinal < 1 || block.replyOrdinal >= ordinal)
    ) {
      issues.push({
        line: block.line,
        message: `reply marker #${block.replyOrdinal} must refer to an earlier message (1..${ordinal - 1})`,
      });
      continue;
    }

    const text = normalizeText(block.body.join('\n'));
    const attachments = extractAttachments(text);
    const message: IngestMessage = { id: idFor(ordinal), author: block.author, ts, text };
    if (block.replyOrdinal !== undefined) message.reply_to = idFor(block.replyOrdinal);
    if (attachments.length > 0) message.attachments = attachments;
    messages.push(message);
  }

  if (issues.length > 0) throw new MarkdownConversionError(issues);
  return messages;
}
