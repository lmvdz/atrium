/**
 * @atrium/ingest — replay ingest.
 *
 * Conversations in, canonical JSONL out (issue #2): one
 * `{id, author, ts, text, reply_to?, attachments?[]}` per line. Files in,
 * files out — this package never touches the database, never interprets, and
 * never reads a clock, so the same source always produces the same bytes.
 */
export * from './gh.js';
export * from './github-thread.js';
export * from './jsonl.js';
export * from './markdown.js';
export * from './pipeline.js';
export * from './sources.js';
export * from './stats.js';
export * from './text.js';
export * from './validate.js';
