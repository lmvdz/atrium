/**
 * The image that is about to write to the database is the one this run built —
 * asserted **before** it is allowed to run.
 *
 * ## The ordering defect this closes (#40, round-2 gauntlet)
 *
 * "`migrate` runs during `up`, *before* its image identity is checked, so a
 * wrong migration image can mutate the database before the job rejects it."
 *
 * That is exactly the shape of the problem, and it is not fixed by asserting
 * harder afterwards. `migrate` is a one-shot: `server` and `app` both declare
 * `depends_on: migrate: service_completed_successfully`, so compose runs it to
 * completion *inside* `docker compose up`. By the time `assert-image-identity`
 * inspects containers, the migration has already been applied — from whatever
 * image answered to the name — and a wrong one has already altered a persistent
 * volume. Every check after that point is reporting on a database it cannot
 * un-migrate.
 *
 * `app` and `server` do not have this problem: they are long-lived, they are
 * still there to be inspected, and nothing they did is irreversible before the
 * first assertion runs. So this file is deliberately about **`migrate` only**,
 * and `assert-image-identity.mjs` still owns all three afterwards — including
 * `migrate`, whose exited container is inspected there. Two checks, two moments,
 * and this is the one that can still say no.
 *
 * ## What it compares
 *
 * The image name the *resolved* configuration gives `migrate` — merged across
 * every `-f` file and every overlay, which is the same resolution
 * `record-built-images.mjs` used — against the ID recorded for it in the
 * manifest. `docker image inspect` turns the name into the ID that answers to it
 * *now*, which is the whole point: a tag is late-binding, and this asks what it
 * currently binds to a moment before compose asks the same question.
 *
 * ## Mutations it catches
 *
 * - an overlay pointing `migrate` at a different image (ledger case
 *   `swapped-migration-image`). Caught before `up`, so nothing has touched the
 *   database. Run the same mutation with this step deleted and the migration
 *   applies first; that ordering is what `required-step-prerequisites` pins.
 * - a `migrate` image that has gone missing between the build and the boot:
 *   `docker image inspect` fails and this is red, rather than compose pulling
 *   something from a registry under the same name.
 * - the manifest missing, or missing `migrate`: red, not skipped.
 */

import { readFileSync } from 'node:fs';
import { docker } from './compose.mjs';
import { isMainModule } from './main-module.mjs';
import { imageNames, manifestPath } from './record-built-images.mjs';
import { check, compared, report } from './stack-client.mjs';

/**
 * The comparison, as a pure function, so `gate-selftest.mjs` can put the
 * mismatches through it without a docker daemon.
 *
 * @param {{image: string, id: string} | undefined} built  the manifest's entry
 * @param {string} configured  the image name the resolved configuration gives it
 * @param {string} resolved    what that name currently resolves to
 * @param {(count: number, what: string) => number} [record] counts what was
 *   compared, for the reason `checkSchema` does (#40 round 10, D2)
 */
export function checkMigrationImage(built, configured, resolved, record = compared) {
  const problems = [];
  // Three: the manifest has an entry, the configured name resolves to an image
  // ID at all, and that ID is the one this run built. Each is a comparison this
  // function performs, and the early returns below are refusals to make the rest
  // of them — so the count is recorded as they are reached.
  record(1, 'checkMigrationImage');
  if (!built?.id) {
    problems.push(
      'the image manifest records nothing for `migrate`, so nothing says which image this run built for the container that writes the schema. `record-built-images.mjs` runs right after the build for this reason.',
    );
    return problems;
  }
  record(1, 'checkMigrationImage');
  if (!/^sha256:[0-9a-f]{64}$/.test(String(resolved))) {
    problems.push(
      `\`docker image inspect ${configured}\` gave ${JSON.stringify(resolved)}, which is not an image ID. The migration container's image cannot be identified, and it is about to run.`,
    );
    return problems;
  }
  record(1, 'checkMigrationImage');
  if (resolved !== built.id) {
    problems.push(
      `the resolved configuration runs \`migrate\` from \`${configured}\`, which is image ${resolved}, but this run built ${built.id} as \`${built.image}\`. \`migrate\` executes inside \`docker compose up\` — \`server\` and \`app\` both wait on it — so letting the boot proceed would apply an unknown schema to a persistent volume and only then have it rejected. Refused here, before anything is started.`,
    );
  }
  return problems;
}

if (isMainModule(import.meta.url)) {
  const path = manifestPath();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Recorded, not a literal exit: see the same change in
    // assert-image-identity.mjs (#40 round 10, D5).
    check(
      false,
      `no readable image manifest at ${path} (${error.message}). Without it there is nothing to compare the migration image against, and the migration runs during the boot.`,
    );
    report('assert-migration-image');
  }

  const configured = imageNames().migrate;
  let resolved = '';
  try {
    resolved = docker(['image', 'inspect', configured, '--format', '{{.Id}}']).trim();
  } catch (error) {
    resolved = `(docker image inspect failed: ${error.message.split('\n')[0]})`;
  }

  const problems = checkMigrationImage(manifest.migrate, configured, resolved);
  for (const problem of problems) check(false, problem);
  if (problems.length === 0) {
    console.info(
      `\`migrate\` will run from ${configured} = ${resolved.slice(7, 19)}, which is the image this run built. Checked before \`up\`, because the migration happens during it.`,
    );
  }
  report('assert-migration-image');
}
