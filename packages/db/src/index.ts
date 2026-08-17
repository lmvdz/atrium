/**
 * @atrium/db — the schema and the client. Owns the tables; both apps consume it.
 *
 * The schema mirrors @atrium/core's zod shapes, and `schema.ts` ends with
 * compile-time parity assertions so the two can never silently drift.
 */
export * from './auth-schema.js';
export * from './client.js';
export * from './covenant-anchors.js';
export * from './schema.js';
