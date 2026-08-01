import type { IngestAttachment, IngestMessage } from './validate.js';
import { assertValidCorpus, sortMessages } from './validate.js';

/**
 * Canonical serialisation. Two rules make a rerun byte-identical:
 *
 *  1. fixed key order — `JSON.stringify` follows insertion order, so the
 *     objects are rebuilt field by field rather than passed through;
 *  2. canonical message order — `(ts, id)` ascending, applied on write.
 *
 * Absent optional fields are omitted, never emitted as `null` or `[]`. And
 * nothing here reads a clock: no `fetched_at`, no `generated_at`. A timestamp
 * of ingestion is exactly the thing that would break byte-identity.
 */

function serializeAttachment(attachment: IngestAttachment): Record<string, unknown> {
  const ordered: Record<string, unknown> = { name: attachment.name, url: attachment.url };
  if (attachment.contentType !== undefined) ordered.contentType = attachment.contentType;
  return ordered;
}

/** One canonical JSON object, no trailing newline. */
export function serializeMessage(message: IngestMessage): string {
  const ordered: Record<string, unknown> = {
    id: message.id,
    author: message.author,
    ts: message.ts,
    text: message.text,
  };
  if (message.reply_to !== undefined) ordered.reply_to = message.reply_to;
  if (message.attachments !== undefined && message.attachments.length > 0) {
    ordered.attachments = message.attachments.map(serializeAttachment);
  }
  return JSON.stringify(ordered);
}

/**
 * Canonical JSONL for a whole corpus: sorted, validated, newline-terminated.
 * Throws `CorpusValidationError` rather than writing a corpus that would fail
 * its own validator.
 */
export function serializeCorpus(messages: readonly IngestMessage[], context = 'corpus'): string {
  const sorted = sortMessages(messages);
  assertValidCorpus(sorted, context);
  return sorted.length === 0 ? '' : `${sorted.map(serializeMessage).join('\n')}\n`;
}
