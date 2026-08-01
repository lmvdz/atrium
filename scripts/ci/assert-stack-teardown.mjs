/**
 * `docker compose down -v` leaves nothing behind.
 *
 * ## Why this is an assertion and not a cleanup step
 *
 * Because "the stack tears down" is a property of the compose file, and a
 * property nobody checks is a property that decays. A named volume added without
 * being declared in `volumes:`, a container started outside the project, a
 * network with an external reference — each survives a `down -v` quietly, and on
 * a long-lived VPS the symptom is a stale Postgres volume being adopted by the
 * next `up` with last month's schema in it. On a CI runner the symptom is
 * nothing at all, which is worse: the leak is invisible until it is somebody's
 * production data directory.
 *
 * The teardown itself is the step before this one in the job. It is a separate
 * step on purpose, so the policy engine can require the *pair* — an assertion
 * that ran before the teardown would find a running stack and be right about
 * nothing.
 *
 * ## What it looks for
 *
 * Everything docker labels with this compose project: containers (including
 * exited ones), volumes, and networks. `down -v` removes all three, so any
 * survivor is a finding, and the finding names it.
 *
 * ## The mutation it catches
 *
 * Drop the `-v` from the teardown step and the four named volumes survive;
 * declare a volume in a service without listing it under top-level `volumes:`
 * and it survives as an anonymous volume. Both go red here.
 */

import { docker } from './compose.mjs';
import { check, report } from './stack-client.mjs';

const project = process.env.ATRIUM_COMPOSE_PROJECT?.trim() || 'atrium';
const label = `com.docker.compose.project=${project}`;

function listing(kind, args) {
  const raw = docker([kind, 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}', ...args]);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// `-a`, so a container that merely exited still counts. A stopped container
// holds its writable layer and its anonymous volumes.
const containers = docker([
  'ps',
  '-a',
  '--filter',
  `label=${label}`,
  '--format',
  '{{.Names}} ({{.Status}})',
])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const volumes = listing('volume', []);
const networks = listing('network', []);

check(
  containers.length === 0,
  `${containers.length} container(s) survived \`down -v\`: ${containers.join(', ')}`,
);
check(
  volumes.length === 0,
  `${volumes.length} volume(s) survived \`down -v\`: ${volumes.join(', ')}`,
);
check(
  networks.length === 0,
  `${networks.length} network(s) survived \`down -v\`: ${networks.join(', ')}`,
);

if (containers.length + volumes.length + networks.length === 0) {
  console.info(`Nothing labelled \`${label}\` remains: 0 containers, 0 volumes, 0 networks.`);
}
report('assert-stack-teardown');
