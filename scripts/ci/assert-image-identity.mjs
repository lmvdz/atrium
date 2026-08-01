/**
 * The containers are running exactly the images this run built.
 *
 * ## The hole this closes
 *
 * Round 1's gauntlet, on the image scanner: it "reads the independently
 * configured `ATRIUM_WEB_IMAGE` tag and never compares an image ID/digest to the
 * running container's `.Image`, nor records what this run built". Three things
 * the deploy job speaks of as one — built, scanned, running — were held together
 * by a name that any of `docker tag`, a registry pull, or a build that quietly
 * failed can re-point at something else. And "a build that quietly stopped
 * happening" is not a hypothetical here: it is defect (3) of this very ticket,
 * where neither Dockerfile had built since `packages/ingest` landed and every
 * gate stayed green.
 *
 * So `record-built-images.mjs` writes down the image **IDs** the build produced,
 * and this file asserts that the containers carrying this repository's code are
 * running those IDs and no others. `.Image` on a container inspection is the
 * content-addressed identity of what it was created from — not a tag, not
 * resolvable to a different object later.
 *
 * ## Why `migrate` is in the list
 *
 * It is the one-shot that applies the schema, so it is the container whose image
 * decides what the database looks like — and it exits, which means nothing else
 * in this job ever looks at it again. A `migrate` running last week's image is a
 * stack whose schema and whose code were built from different trees, which is
 * the two-halves-that-never-meet class at the deployment layer.
 *
 * ## Mutations it catches
 *
 * - `app` (or `server`, or `migrate`) pointed by an overlay at a *different but
 *   functionally identical* image, so every behavioural assertion in this job
 *   stays green while the stack is not running what was built. That is ledger
 *   case `swapped-image`, and it is the case that shows the binding is real:
 *   nothing else in the job can tell the two images apart, because behaviourally
 *   there is nothing to tell.
 * - a `docker compose build` that failed while the previous image kept answering
 *   to the tag: the recorded ID is then the stale one *and* the running one, so
 *   this file is silent — deliberately. That case belongs to the build step's
 *   own exit code and to `required-step-prerequisites`, which orders the build
 *   before the record. Stated because a check that seems to cover it and does
 *   not is worse than one that says where the boundary is.
 * - the recording step deleted: this file has no manifest and fails rather than
 *   skipping, which is the fail-closed half of the same rule.
 */

import { readFileSync } from 'node:fs';
import { inspect, psAll } from './compose.mjs';
import { BUILT_SERVICES, manifestPath } from './record-built-images.mjs';
import { check, report } from './stack-client.mjs';

/**
 * The comparison, as a pure function, so `gate-selftest.mjs` can put the
 * mismatches through it without a docker daemon.
 *
 * @param {Record<string, {image: string, id: string}>} manifest  what was built
 * @param {Record<string, {image: string, id: string}>} running   what is running
 */
export function checkImageIdentity(manifest, running) {
  const problems = [];
  for (const service of BUILT_SERVICES) {
    const built = manifest[service];
    const live = running[service];
    if (!built) {
      problems.push(
        `the manifest records no image for \`${service}\`, so nothing says what this run built for it`,
      );
      continue;
    }
    if (!live) {
      problems.push(`the stack has no \`${service}\` container to compare against the manifest`);
      continue;
    }
    if (live.id !== built.id) {
      problems.push(
        `\`${service}\` is running image ${live.id} (created from \`${live.image}\`) but this run built ${built.id} as \`${built.image}\`. The stack is not running what was built, and therefore not what was scanned — which is the binding nothing checked before.`,
      );
    }
  }
  for (const service of Object.keys(manifest)) {
    if (!BUILT_SERVICES.includes(service)) {
      problems.push(
        `the manifest records \`${service}\`, which is not one of the services whose image identity is asserted (${BUILT_SERVICES.join(', ')}). Add it to BUILT_SERVICES or stop recording it — an unasserted entry is a name nobody is checking.`,
      );
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = manifestPath();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(
      `::error::assert-image-identity: no readable image manifest at ${path} (${error.message}). \`record-built-images.mjs\` runs right after the build for this reason; without it nothing binds the running containers to what was built.`,
    );
    process.exit(1);
  }

  const containers = new Map(psAll().map((container) => [container.Service, container]));
  const running = {};
  for (const service of BUILT_SERVICES) {
    const container = containers.get(service);
    if (!container) continue;
    const detail = inspect(container.ID);
    running[service] = { id: detail.Image, image: detail.Config?.Image ?? '(unnamed)' };
  }

  for (const problem of checkImageIdentity(manifest, running)) check(false, problem);
  if (BUILT_SERVICES.every((service) => running[service]?.id === manifest[service]?.id)) {
    console.info(
      `${BUILT_SERVICES.length} services are running exactly the image IDs this run built: ${BUILT_SERVICES.map((service) => `${service}=${manifest[service].id.slice(7, 19)}`).join(', ')}.`,
    );
  }
  report('assert-image-identity');
}
