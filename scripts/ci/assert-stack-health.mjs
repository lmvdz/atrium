/**
 * Every container in the stack is up, healthy, and has not been restarting.
 *
 * ## Why this exists next to `docker compose up --wait`
 *
 * `--wait` is a wait, not an assertion. It returns 0 when every service reached
 * a settled state, and there are three ways that is weaker than it sounds:
 *
 *  1. A service with **no health check** only has to be *running*. Round 4's
 *     `app` was running. It answered 500 to every request for three rounds.
 *     So this asserts that every long-lived service *declares* a health check —
 *     deleting one would otherwise silently downgrade it from "healthy" to
 *     "the process has not exited yet".
 *  2. A container can be **restarting in a loop** and still be observed
 *     "running" between crashes. `RestartCount` is read here, and a service
 *     that has restarted at all during a run this short is a failure.
 *  3. A **one-shot** service (`migrate`, `minio-init`) can exit non-zero; the
 *     dependents' `service_completed_successfully` catches it at start-up, but
 *     nothing re-checks the code afterwards. Both are asserted to have exited 0.
 *
 * ## The enrolment rule
 *
 * The two lists below are the stack's shape, written down. A new service that is
 * neither long-lived nor one-shot fails this script rather than joining the
 * stack unchecked — the same discipline `assert-workspace-enrollment.mjs`
 * applies to test workspaces, for the same reason: an unenrolled thing is a
 * thing nobody is counting.
 */

import { inspect, psAll } from './compose.mjs';
import { check, report } from './stack-client.mjs';

/** Services that stay up, and must therefore say whether they are well. */
const LONG_LIVED = ['postgres', 'minio', 'mailpit', 'server', 'app', 'proxy'];
/** Services that do one thing and exit; the exit code is the whole verdict. */
const ONE_SHOT = ['migrate', 'minio-init'];

const containers = psAll();
check(containers.length > 0, 'the compose project has no containers at all');

const byService = new Map(containers.map((container) => [container.Service, container]));
for (const service of [...LONG_LIVED, ...ONE_SHOT]) {
  check(byService.has(service), `the stack has no \`${service}\` container`);
}
for (const service of byService.keys()) {
  check(
    LONG_LIVED.includes(service) || ONE_SHOT.includes(service),
    `\`${service}\` is in the stack but in neither list in scripts/ci/assert-stack-health.mjs, so nothing here decides what "well" means for it`,
  );
}

for (const service of LONG_LIVED) {
  const container = byService.get(service);
  if (!container) continue;
  const detail = inspect(container.ID);
  const state = detail.State ?? {};

  check(state.Running === true, `\`${service}\` is not running (status ${state.Status})`);
  check(
    detail.Config?.Healthcheck?.Test?.length > 0 || detail.State?.Health !== undefined,
    `\`${service}\` declares no health check, so "up" is the strongest thing anyone can say about it — and round 4's \`app\` was up`,
  );
  check(
    state.Health?.Status === 'healthy',
    `\`${service}\` is ${state.Health?.Status ?? 'unmonitored'}, not healthy${
      state.Health?.Log?.length
        ? ` (last probe: ${JSON.stringify(state.Health.Log.at(-1)?.Output ?? '').slice(0, 300)})`
        : ''
    }`,
  );
  check(
    (detail.RestartCount ?? 0) === 0,
    `\`${service}\` has restarted ${detail.RestartCount} time(s); a crash loop is not a healthy service, it is a service between crashes`,
  );
}

for (const service of ONE_SHOT) {
  const container = byService.get(service);
  if (!container) continue;
  const detail = inspect(container.ID);
  const state = detail.State ?? {};
  check(
    state.Status === 'exited',
    `\`${service}\` is ${state.Status}; it is a one-shot job and should have finished`,
  );
  check(state.ExitCode === 0, `\`${service}\` exited ${state.ExitCode}, not 0`);
}

console.info(
  `Inspected ${containers.length} containers: ${LONG_LIVED.length} long-lived, ${ONE_SHOT.length} one-shot.`,
);
report('assert-stack-health');
