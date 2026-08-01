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
