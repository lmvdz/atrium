/**
 * What `docker compose build` just produced, by content-addressed identity.
 *
 * ## Why a tag is not an answer
 *
 * Round 1's gauntlet: `assert-image-origins.mjs` read `ATRIUM_WEB_IMAGE`, a tag
 * configured independently of the build, and never compared an image ID against
 * the running container's `.Image`. So three things the job talks about as one
 * thing — the image that was **built**, the image that is **scanned**, and the
 * image that is **running** — were bound to each other by nothing but a name,
 * and a name is late-binding: `docker tag` is one command, a registry pull under
 * the same tag is one command, and a build that failed leaves the previous
 * image answering to the tag. The failure #40 exists for is *precisely* a build
 * that stopped happening and nobody noticing, so a scanner that reads whatever
 * currently answers to a name is the wrong instrument for it.
 *
 * This step resolves each service's image name to its **image ID** immediately
 * after the build, and writes the result down. Everything downstream refers to
 * the ID: `assert-image-identity.mjs` asserts the containers are running exactly
 * these, and `assert-image-origins.mjs` scans exactly this one. The tag is then
 * only a way of finding the image once, at the moment it was made.
 *
 * ## What this proves and what it does not
 *
 * It proves the three uses are the same object. It does not prove that object
 * came from *this source tree*: the resolution happens after the build, so a
 * build that was a complete cache hit records the cached ID — which is correct
 * (content-addressed caching means identical inputs, so it *is* the image this
 * source builds) but it is a claim about docker's cache keys, not one this file
 * establishes. Nor does it prove the build ran at all; that is
 * `required-step-prerequisites` in the workflow policy, which puts the build
 * ahead of this step and this step ahead of the assertions.
 *
 *   ATRIUM_IMAGE_MANIFEST=/tmp/images.json node scripts/ci/record-built-images.mjs
 *
 * Writes `{ "<service>": { "image": "<tag>", "id": "sha256:…" }, … }`.
 */

import { writeFileSync } from 'node:fs';
import { compose, docker } from './compose.mjs';
import { isMainModule } from './main-module.mjs';

/**
 * The services whose image identity is load-bearing.
 *
 * The three that run this repository's own code. Everything else in the stack
 * is a third-party image pinned by tag in `docker-compose.yml` — `postgres`,
 * `minio`, `caddy`, `mailpit` — and pinning those to an ID recorded on the
 * runner would assert that CI and the deployment pulled the same digest, which
 * they have no reason to and which would go red on every upstream release.
 */
export const BUILT_SERVICES = ['app', 'server', 'migrate'];

/** Where the manifest lives, for this step and every reader of it. */
export function manifestPath(env = process.env) {
  const path = env.ATRIUM_IMAGE_MANIFEST?.trim();
  if (!path) {
    throw new Error(
      'set ATRIUM_IMAGE_MANIFEST to the file this run records its built image IDs in; without it nothing binds the built image to the running one',
    );
  }
  return path;
}

/**
 * Each service's image name, as the merged configuration resolves it.
 *
 * A service with `build:` and no `image:` — which is all three of these — is
 * tagged `<project>-<service>` by `docker compose build`, and `compose config`
 * does *not* fill that in, so it is derived here from the resolved project name
 * rather than written down anywhere. That derivation is the one piece of
 * convention in this chain, and it fails closed: if compose ever tags built
 * images differently, `docker image inspect` finds nothing and this step is red
 * on the next run rather than recording a stale ID.
 *
 * This is also why `ATRIUM_WEB_IMAGE` is gone from the deploy job. A tag
 * configured beside the build, rather than derived from it, is exactly the
 * free-floating name that let the scanner read an image nobody was running.
 */
export function imageNames(env = process.env) {
  const resolved = JSON.parse(compose(['config', '--format', 'json'], { env }));
  const project = resolved.name;
  if (!project) throw new Error('the resolved compose configuration has no project name');
  const names = {};
  for (const service of BUILT_SERVICES) {
    const definition = resolved.services?.[service];
    if (!definition) {
      throw new Error(`the resolved compose configuration has no \`${service}\` service`);
    }
    names[service] = definition.image ?? `${project}-${service}`;
  }
  return names;
}

if (isMainModule(import.meta.url)) {
  const path = manifestPath();
  const manifest = {};
  for (const [service, image] of Object.entries(imageNames())) {
    const id = docker(['image', 'inspect', image, '--format', '{{.Id}}']).trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) {
      console.error(
        `::error::record-built-images: \`docker image inspect ${image}\` gave ${JSON.stringify(id)}, which is not an image ID`,
      );
      process.exit(1);
    }
    manifest[service] = { image, id };
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [service, { image, id }] of Object.entries(manifest)) {
    console.info(`${service}: ${image} = ${id}`);
  }
  console.info(`Recorded ${Object.keys(manifest).length} built image IDs in ${path}.`);
}
