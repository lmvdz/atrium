/**
 * No realtime origin is compiled into the web image.
 *
 * ## The defect this is calibrated to
 *
 * `apps/web/next.config.ts` used to carry
 *
 *     env: { NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws' }
 *
 * and `NEXT_PUBLIC_*` is a build-time substitution in its own right. Measured
 * before the fix: building with `NEXT_PUBLIC_WS_URL=wss://probe.example/ws` put
 * that exact string into `.next/standalone/apps/web/server.js` and two server
 * chunks. `docker-compose.yml` set the real value at *runtime*, so the running
 * container used the build machine's `ws://localhost:4000/ws` fallback,
 * `assertSecureTransport` refused it — correctly — and every page answered 500.
 * A deployment-time setting that could not be set at deployment time.
 *
 * ## Why this scans for named literals rather than for "any URL"
 *
 * The obvious rule — no URL literal anywhere in the image — was written first
 * and thrown away, because it is unusable: a Next standalone bundle legitimately
 * carries `http://www.w3.org` (SVG namespaces), `http://json-schema.org`,
 * Next's own `http://localhost:3000` default, and fragments like `http://n` that
 * fall out of minification. Measured on this image: 292 URL literals, 43 of them
 * "offending" under that rule and none of them a defect. A gate that produces
 * 43 findings nobody can act on gets deleted, and then the one finding that
 * mattered goes with it.
 *
 * So the rule is narrow and it is about *this* defect class: the realtime URL,
 * the variable name whose prefix caused it, and the fallback host it resolved
 * to. Each entry below names the mutation that would put it back. The list is
 * the claim — nothing here says "and no other build-time constant exists".
 *
 * ## The mutations it catches, each verified by making it
 *
 * - re-adding the `env:` block to `apps/web/next.config.ts`: `server.js` embeds
 *   the whole `nextConfig` as JSON, so the key name lands verbatim.
 * - renaming `ATRIUM_WS_URL` back to `NEXT_PUBLIC_WS_URL` anywhere it is read:
 *   the prefix makes Next substitute the value and record the name.
 * - putting a `?? 'ws://localhost:4000/ws'` fallback back into the room page or
 *   `lib/env.ts`: both the scheme-with-a-host and the host:port match.
 * - hard-coding any `wss://…` for a specific deployment: same match, and the
 *   reason it is refused is that one image has to run at any hostname.
 */

import { docker } from './compose.mjs';
import { check, report } from './stack-client.mjs';

const image = process.env.ATRIUM_WEB_IMAGE?.trim();
if (!image) {
  console.error('::error::assert-image-origins: set ATRIUM_WEB_IMAGE to the built web image');
  process.exit(2);
}

/**
 * What must not appear in the app's own compiled output, and why.
 *
 * `source` is a JavaScript regular expression source string; it is shipped into
 * the container as text, so it must not contain a backtick.
 */
const FORBIDDEN = [
  {
    id: 'realtime-url',
    source: String.raw`wss?:\/\/[A-Za-z0-9]`,
    why: 'a `ws://` or `wss://` URL compiled into the bundle. The realtime origin is a deployment fact: it is read at request time from ATRIUM_WS_URL and handed to the browser as a prop, so one image runs at any hostname. A literal here is the value that made every page 500.',
  },
  {
    id: 'public-prefixed-ws-variable',
    source: 'NEXT_PUBLIC_WS_URL',
    why: 'the `NEXT_PUBLIC_` spelling of the realtime URL. That prefix *is* the build-time substitution — Next records the name and replaces the value — which is why the variable is `ATRIUM_WS_URL` now. Finding the old name in a shipped artefact means the substitution is back.',
  },
  {
    id: 'realtime-fallback-host',
    source: 'localhost:4000',
    why: "the realtime server's laptop port, baked in. This was the fallback half of the same defect: `process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws'`, evaluated on a build machine where the variable was never set.",
  },
];

/**
 * The scan runs inside the image, so it reads exactly the bytes that shipped.
 *
 * `node -e` rather than `grep`: the runtime is `node:22-alpine` and busybox
 * grep over minified JavaScript produces output nobody can act on. Node reports
 * the file, the pattern id, and a window of surrounding text.
 *
 * `node_modules` is excluded. Third-party code carries `ws://` in dev
 * transports, documentation strings and examples, none of which is an origin
 * this deployment advertises.
 */
const scan = String.raw`
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const patterns = JSON.parse(process.env.ATRIUM_FORBIDDEN);
const roots = ['/app/apps/web/server.js', '/app/apps/web/.next', '/app/packages'];
const found = [];
let scanned = 0;
function walk(path) {
  let info;
  try { info = statSync(path); } catch { return; }
  if (info.isDirectory()) {
    if (path.split('/').includes('node_modules')) return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  if (!/\.(js|mjs|cjs|json|map)$/.test(path)) return;
  scanned += 1;
  const text = readFileSync(path, 'utf8');
  for (const pattern of patterns) {
    const regexp = new RegExp(pattern.source, 'g');
    for (const match of text.matchAll(regexp)) {
      found.push({
        id: pattern.id,
        file: path,
        context: text.slice(Math.max(0, match.index - 40), match.index + 80),
      });
    }
  }
}
for (const root of roots) walk(root);
process.stdout.write(JSON.stringify({ scanned, found }));
`;

const raw = docker([
  'run',
  '--rm',
  '--entrypoint',
  'node',
  '--env',
  `ATRIUM_FORBIDDEN=${JSON.stringify(FORBIDDEN.map(({ id, source }) => ({ id, source })))}`,
  image,
  '-e',
  scan,
]);
const { scanned, found } = JSON.parse(raw);

check(scanned > 0, 'the scan found no compiled files at all — the paths in this script are wrong');

// One violation per pattern, with the first location. Minified bundles repeat a
// literal dozens of times and a hundred identical annotations hide the finding.
for (const pattern of FORBIDDEN) {
  const hits = found.filter((entry) => entry.id === pattern.id);
  check(
    hits.length === 0,
    `${hits.length} occurrence(s) of \`${pattern.id}\` in the web image — first at ${hits[0]?.file}: …${hits[0]?.context.replace(/\s+/g, ' ')}… — ${pattern.why}`,
  );
}

console.info(
  `Scanned ${scanned} compiled files in ${image} against ${FORBIDDEN.length} forbidden literals; ${found.length} occurrence(s).`,
);
report('assert-image-origins');
