import { readFile } from 'node:fs/promises';
import type { LoopDaemonOptions } from './daemon.js';

/**
 * The daemon's configuration, from the environment.
 *
 * The daemon is a pure protocol client: it is told WHERE the server is, WHICH
 * room is its channel, and WHERE its two files live (the agent cookie the seed
 * wrote, #142; and its own journal). It resolves none of this over a side-door —
 * there is no HTTP bootstrap and no database read, by covenant (#139, #148).
 *
 *   ATRIUM_LOOP_WS_URL       ws(s):// URL of the command path (e.g. ws://host:4000/ws)
 *   ATRIUM_LOOP_COOKIE_FILE  the seed's agent-session cookie file (#142)
 *   ATRIUM_LOOP_ROOM_ID      the channel room's id (a uuid). The room is the
 *                            agent's own channel; its id is a provisioning fact,
 *                            obtained the way the run-book documents (the seed
 *                            prints the slug; the id is one `select` away).
 *   ATRIUM_LOOP_JOURNAL      path to the durable outcome journal (created if absent)
 *   ATRIUM_LOOP_HARNESS      optional; the harness stamped on open_session (data only)
 *   ATRIUM_LOOP_MODEL        optional; the model stamped on open_session (data only)
 */
export interface LoopConfig extends LoopDaemonOptions {}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function loadConfig(): Promise<LoopConfig> {
  const url = requireEnv('ATRIUM_LOOP_WS_URL');
  const cookieFile = requireEnv('ATRIUM_LOOP_COOKIE_FILE');
  const roomId = requireEnv('ATRIUM_LOOP_ROOM_ID');
  const journalPath = requireEnv('ATRIUM_LOOP_JOURNAL');
  const cookie = (await readFile(cookieFile, 'utf8')).trim();
  if (cookie === '') throw new Error(`cookie file ${cookieFile} is empty`);
  const harness = process.env.ATRIUM_LOOP_HARNESS?.trim() || undefined;
  const model = process.env.ATRIUM_LOOP_MODEL?.trim() || undefined;
  return { url, cookie, roomId, journalPath, harness, model };
}
