/**
 * Talking to the compose project the deploy job brought up.
 *
 * The file list and project name are read from the environment rather than
 * hard-coded so that the same scripts run against a local stack. They are read
 * *once*, here, because two scripts that disagreed about which project they are
 * inspecting would each be right about a different stack — and one of them would
 * be reporting on nothing at all, which is the class of failure this whole
 * ticket is about.
 */

import { execFileSync } from 'node:child_process';

export function composeArgs(env = process.env) {
  const project = env.ATRIUM_COMPOSE_PROJECT?.trim() || 'atrium';
  const files = (env.ATRIUM_COMPOSE_FILES?.trim() || 'docker-compose.yml')
    .split(/[:,]/)
    .map((file) => file.trim())
    .filter(Boolean);
  return ['-p', project, ...files.flatMap((file) => ['-f', file])];
}

export function compose(args, { env = process.env } = {}) {
  return execFileSync('docker', ['compose', ...composeArgs(env), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** `docker compose ps` as objects, including containers that have exited. */
export function psAll(env = process.env) {
  const raw = compose(['ps', '-a', '--format', 'json'], { env }).trim();
  if (!raw) return [];
  // Compose emits one JSON object per line (and, on some versions, an array).
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Full `docker inspect` for one container id. */
export function inspect(id) {
  return JSON.parse(docker(['inspect', id]))[0];
}

/**
 * One value out of the stack's own database, read without going through the app.
 *
 * The credentials come from the running `postgres` container rather than from
 * this process's environment, for the same reason `assert-stack-config.mjs`
 * reads configuration back out of containers: the point of asking the database
 * directly is to get an answer that did not come from the thing under test, and
 * an answer obtained with credentials the test supplied itself is one step less
 * independent than it looks.
 *
 * `-tA` is tuples-only and unaligned, so the result is the value and nothing
 * else. Returns null for no row.
 *
 * Values go in through `sqlLiteral`. Every caller here interpolates a string
 * this repository generated, so the escaping is hygiene rather than a boundary —
 * but a helper that invites concatenation is a helper somebody will hand a
 * fixture name to.
 */
export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function queryDatabase(sql, env = process.env) {
  const postgres = psAll(env).find((container) => container.Service === 'postgres');
  if (!postgres) throw new Error('the stack has no `postgres` container to query');
  const { POSTGRES_USER = 'atrium', POSTGRES_DB = 'atrium' } = containerEnv(postgres.ID);
  const output = compose(
    ['exec', '-T', 'postgres', 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-tAc', sql],
    { env },
  ).trim();
  return output === '' ? null : output;
}

/** A container's environment, as a map. */
export function containerEnv(id) {
  const entries = inspect(id).Config?.Env ?? [];
  const env = {};
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}
