import { Id, Timestamp } from '@atrium/core';
import { z } from 'zod';

/**
 * The canonical replay line format, decided in issue #2:
 *
 *     {id, author, ts, text, reply_to?, attachments?[]}
 *
 * One JSON object per line, one line per message. The shape is deliberately
 * small: a Slack or Discord export adapter is a field rename away, and pasted
 * markdown converts with the tiny parser in `markdown.ts`.
 *
 * The message shape does not live in `@atrium/core` — that package models
 * *interpreted* objects (decisions, commitments, claims) and the append-only
 * substrate is a `packages/db` table, not a core type. So the schema lives
 * here, but it reuses core's `Id` and `Timestamp` primitives so a corpus line
 * and a core object agree on what an id and a timestamp are.
 */

/**
 * An attachment as it exists *before* upload: a name and a URL. The
 * `packages/db` `MessageAttachment` (`{key, name, contentType, size}`) is the
 * post-upload form — mapping one to the other is a fetch, which is out of
 * scope here (files in, files out).
 */
export const IngestAttachment = z.strictObject({
  name: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  contentType: z.string().min(1).optional(),
});
export type IngestAttachment = z.infer<typeof IngestAttachment>;

export const IngestMessage = z.strictObject({
  /** Stable, source-derived, and reproducible: never a random uuid. */
  id: Id,
  /** Display handle of the speaker (`ghost` when the source account is gone). */
  author: z.string().min(1),
  /** ISO-8601 with an offset. Comes from the source; never from a local clock. */
  ts: Timestamp,
  /** Message body, newline-normalised. May be empty (an image-only comment). */
  text: z.string(),
  /** Present only when the source carries real threading. */
  reply_to: Id.optional(),
  /** Omitted rather than emitted empty, so the line stays minimal. */
  attachments: z.array(IngestAttachment).min(1).optional(),
});
export type IngestMessage = z.infer<typeof IngestMessage>;

export type CorpusIssueCode =
  | 'invalid-json'
  | 'schema'
  | 'duplicate-id'
  | 'dangling-reply'
  | 'forward-reply'
  | 'self-reply'
  | 'out-of-order';

export interface CorpusIssue {
  /** 1-based line number, or 0 for whole-file issues. */
  line: number;
  code: CorpusIssueCode;
  message: string;
}

/**
 * Canonical order: ascending timestamp, ties broken by id. Deterministic for
 * any input permutation, which is half of why a rerun is byte-identical.
 */
export function compareMessages(a: IngestMessage, b: IngestMessage): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Sort a copy into canonical order. */
export function sortMessages(messages: readonly IngestMessage[]): IngestMessage[] {
  return [...messages].sort(compareMessages);
}

/**
 * Structural checks that a per-line schema cannot make: unique ids, `reply_to`
 * resolving to a message *in this file* and *earlier* in it, and canonical
 * ordering. `lineOf` maps an array index to a file line number so the same
 * function serves both an in-memory pipeline and a file read.
 */
export function checkCorpus(
  messages: readonly IngestMessage[],
  lineOf: (index: number) => number = (i) => i + 1,
): CorpusIssue[] {
  const issues: CorpusIssue[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    const previous = seen.get(message.id);
    if (previous !== undefined) {
      issues.push({
        line: lineOf(i),
        code: 'duplicate-id',
        message: `duplicate id ${message.id} (first seen on line ${lineOf(previous)})`,
      });
    } else {
      seen.set(message.id, i);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    const parent = message.reply_to;
    if (parent === undefined) continue;
    if (parent === message.id) {
      issues.push({
        line: lineOf(i),
        code: 'self-reply',
        message: `message ${message.id} replies to itself`,
      });
      continue;
    }
    const parentIndex = seen.get(parent);
    if (parentIndex === undefined) {
      issues.push({
        line: lineOf(i),
        code: 'dangling-reply',
        message: `reply_to ${parent} does not resolve to a message in this file`,
      });
    } else if (parentIndex > i) {
      issues.push({
        line: lineOf(i),
        code: 'forward-reply',
        message: `reply_to ${parent} points forward, to line ${lineOf(parentIndex)}`,
      });
    }
  }

  for (let i = 1; i < messages.length; i++) {
    const previous = messages[i - 1];
    const current = messages[i];
    if (!previous || !current) continue;
    if (compareMessages(previous, current) > 0) {
      issues.push({
        line: lineOf(i),
        code: 'out-of-order',
        message: `line is not in canonical (ts, id) order after ${previous.id}`,
      });
    }
  }

  return issues;
}

export interface CorpusReadResult {
  messages: IngestMessage[];
  issues: CorpusIssue[];
}

/**
 * Parse and fully validate JSONL text. Bad lines are reported, not thrown:
 * the CLI wants every problem in one pass, not the first one.
 */
export function validateCorpusText(text: string): CorpusReadResult {
  const issues: CorpusIssue[] = [];
  const messages: IngestMessage[] = [];
  const lineNumbers: number[] = [];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const lineNumber = i + 1;
    if (raw.trim() === '') {
      if (i === lines.length - 1) continue; // the file's single trailing newline
      issues.push({ line: lineNumber, code: 'invalid-json', message: 'blank line' });
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      issues.push({
        line: lineNumber,
        code: 'invalid-json',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const parsed = IngestMessage.safeParse(json);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) {
        const path = problem.path.join('.');
        issues.push({
          line: lineNumber,
          code: 'schema',
          message: path ? `${path}: ${problem.message}` : problem.message,
        });
      }
      continue;
    }

    messages.push(parsed.data);
    lineNumbers.push(lineNumber);
  }

  issues.push(...checkCorpus(messages, (index) => lineNumbers[index] ?? index + 1));
  issues.sort((a, b) => a.line - b.line);
  return { messages, issues };
}

/** Throwing wrapper for pipeline code that should never produce a bad corpus. */
export class CorpusValidationError extends Error {
  constructor(
    readonly issues: CorpusIssue[],
    context = 'corpus',
  ) {
    super(
      `${context} failed validation:\n${issues
        .map((issue) => `  line ${issue.line}: [${issue.code}] ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'CorpusValidationError';
  }
}

/** Validate an in-memory corpus, throwing on any issue. */
export function assertValidCorpus(messages: readonly IngestMessage[], context = 'corpus'): void {
  const issues = checkCorpus(messages);
  for (let i = 0; i < messages.length; i++) {
    const parsed = IngestMessage.safeParse(messages[i]);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) {
        issues.push({
          line: i + 1,
          code: 'schema',
          message: `${problem.path.join('.')}: ${problem.message}`,
        });
      }
    }
  }
  if (issues.length > 0) throw new CorpusValidationError(issues, context);
}
