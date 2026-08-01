/**
 * An HTTP client for talking to the compose stack the way a browser does.
 *
 * ## Why this is `node:https` and not `fetch`
 *
 * The stack is TLS-only. `docker-compose.yml` gives Caddy a hostname as its site
 * address, Caddy obtains a certificate for it, and both application processes
 * refuse to serve production over anything but `https://`. To talk to that from
 * a test we need three things at once: connect to the published port on this
 * machine, present the deployment's hostname in the TLS handshake (SNI) *and* in
 * the `Host` header, and trust the certificate authority that actually signed
 * the certificate.
 *
 * `fetch` gives us none of them without a DNS entry and a global CA install.
 * `node:https` gives us all three as ordinary options, which means the
 * assertions run identically on a laptop and on a CI runner, with no
 * `/etc/hosts` edit and no `NODE_EXTRA_CA_CERTS` — and, more importantly, with
 * **certificate verification on**. `rejectUnauthorized` is never set to false
 * anywhere in this file. An assertion that skipped verification would pass
 * against a stack whose TLS was broken, which is the same shape of lie as a
 * health endpoint that returns 200 while every page 500s.
 *
 * Setting SNI and `Host` by hand is exactly what a browser does after its DNS
 * lookup returns this address. It is not a shortcut past the proxy: every
 * request below goes through Caddy on the published port, gets routed by the
 * shipped Caddyfile, and arrives at `app` or `server` with the `X-Forwarded-For`
 * chain Caddy built.
 *
 * ## Why it drives real forms
 *
 * `packages/auth/src/mounted.ts` publishes exactly three Better Auth routes over
 * HTTP, and `POST /sign-up/email` is deliberately not one of them: every
 * mutation goes through a Server Action so it passes the sign-up/sign-in
 * throttle. So a signup assertion cannot call an API — it has to submit the
 * form. `formFields` reads the rendered `<form>` (including the `$ACTION_ID_…`
 * hidden input Next writes for progressive enhancement) and `multipart` posts it
 * back. What is exercised is therefore the page a person gets, the action that
 * page names, and the limiter in front of it.
 */

import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Where the stack is, and how to prove it is who it says it is. */
export function stackTarget(env = process.env) {
  const domain = env.ATRIUM_STACK_DOMAIN?.trim() || 'atrium.localhost';
  const ca = env.ATRIUM_STACK_CA?.trim();
  return {
    domain,
    /** The address the published port is on. DNS's job, done explicitly. */
    address: env.ATRIUM_STACK_ADDRESS?.trim() || '127.0.0.1',
    httpsPort: Number(env.ATRIUM_STACK_HTTPS_PORT ?? 443),
    httpPort: Number(env.ATRIUM_STACK_HTTP_PORT ?? 80),
    /** Caddy's local root, copied out of the proxy container. */
    ca: ca ? readFileSync(ca) : undefined,
    origin: `https://${domain}`,
  };
}

/** A cookie jar, because a session is a cookie and the flows depend on it. */
export class Jar {
  #cookies = new Map();

  accept(setCookie) {
    for (const raw of setCookie ?? []) {
      const [pair] = raw.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      // An expiry in the past is a deletion; keeping it would send a dead
      // session cookie and make "signed out" look like "signed in badly".
      if (/;\s*max-age=0/i.test(raw) || value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  has(predicate) {
    return [...this.#cookies.keys()].some((name) => predicate(name));
  }

  get names() {
    return [...this.#cookies.keys()];
  }

  /** `[name, value]` pairs — what a forgery has to be shaped like. */
  get entries() {
    return [...this.#cookies];
  }
}

/**
 * A value of the same length, drawn from the same characters, that is not it.
 *
 * ── WHY THIS IS NOT `'0'.repeat(24) + '.' + 'f'.repeat(24)` (#40 round 5) ───
 * `assert-page-serves.mjs` sends a cookie that is not a session, precisely so
 * that the signed-out page it gets back came from a request a proxy would have
 * routed to the app — and then claimed the request "cannot be conditioned on
 * something a proxy cannot see". A constant of twenty-four zeroes and
 * twenty-four `f`s is conditionable on both counts: one line of Caddy
 * (`header_regexp Cookie "=0{24}\."`, or a length test) tells it from a real
 * Better Auth token without knowing anything a proxy is not allowed to know.
 *
 * So the forgery is derived from the real cookie instead: the same length, and
 * a uniform draw from the alphabet the real value itself uses. A discriminator
 * over length or character class now has to be one that would reject the real
 * session too. What it still is not is *unforgeable* — a proxy that could
 * verify the signature could tell them apart, and a proxy that could do that is
 * the app.
 */
export function forgeLike(value, random = (bound) => randomInt(bound)) {
  const alphabet = [...new Set(value)];
  if (alphabet.length < 2) {
    throw new Error(
      `cannot forge a cookie like ${JSON.stringify(value)}: it uses ${alphabet.length} distinct character(s), so every same-length draw from its own alphabet is either it or trivially distinguishable`,
    );
  }
  for (;;) {
    const forged = Array.from({ length: value.length }, () => alphabet[random(alphabet.length)]);
    const candidate = forged.join('');
    if (candidate !== value) return candidate;
  }
}

/**
 * Every `/_next/static/…` URL a rendered page references, deduplicated.
 *
 * Two ways to get this wrong, and the first draft of it managed both in turn.
 *
 * Round 4's `[^"'\s)]+` captured the escaping around the copy Next embeds in
 * its RSC payload — `self.__next_f.push([1,"…HL[\"/_next/static/css/x.css\"…"])`
 * yields `…/x.css\`, a URL the deployment is right to 404 — so a checker that
 * fetched what it found would have gone red on a healthy stack.
 *
 * The obvious repair, an allowlist of filename characters, is wrong in the
 * other direction *in this repository specifically*: `apps/web/app` contains
 * `(auth)/sign-in`, `app/[workspace]/[room]` and `api/auth/[...all]`, and Next
 * puts those segments in the chunk path — `(` and `)` literally, `[` and `]`
 * percent-encoded. A class of letters-digits-dots-slashes truncates every one
 * of them at the first bracket, and the truncated prefix quietly fails the
 * extension test below, so the assets would go unchecked while the check
 * reported clean. That is this ticket's own defect, committed by its fix.
 *
 * So: everything up to a character that cannot be *inside* a URL in HTML, then
 * trailing punctuation that cannot *end* a filename removed — which is what
 * takes the `)` off a `url(/_next/static/media/x.woff2)` in a `<style>` block
 * without touching the `)` in `(auth)`.
 */
export function buildAssets(html) {
  return [
    ...new Set(
      [...String(html).matchAll(/\/_next\/static\/[^"'\s<>\\`]+/g)].map((match) =>
        match[0].replace(/[)\],;}]+$/, ''),
      ),
    ),
  ].sort();
}

/** The ones that are a file this deployment must be able to serve. */
const SERVABLE_ASSET = /\.(?:js|mjs|css|json|woff2?|ttf|otf|svg|png|webp|ico|map)$/;

/**
 * Every build asset the page names is actually served.
 *
 * ── THE DEFECT (#40 round 5) ────────────────────────────────────────────────
 * Round 4 compared the *set* of `/_next/static/…` names in two responses and
 * called it a proof that both came from the same build. It is, and that was not
 * the question anybody needed answered. Delete line 35 of `apps/web/Dockerfile`
 * — `COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static` —
 * and the deployment serves SSR HTML whose every script and stylesheet 404s: a
 * dead, unstyled, non-hydrating page, which is the single most common real
 * failure of a Next standalone image. Both responses name the same chunks,
 * because they come from the same broken build, so the comparison holds and the
 * job stays green end to end. **No script in `scripts/ci/` ever fetched a
 * `/_next/static/…` URL.**
 *
 * Two strings from two responses of one build cannot answer "is the build
 * there". Fetching can, and it is one request per chunk against a stack that is
 * already up. It also gives `assets !== ''` something to stand on: a page that
 * names assets nobody can retrieve is no better evidence of a Next build than a
 * page that names none.
 *
 * @param {object} target from `stackTarget()`
 * @param {string} html   the rendered page
 * @param {(path: string) => Promise<{status: number, body: string}>} [get]
 *   injectable so `gate-selftest.mjs` can prove this catches a 404 and an empty
 *   body without a running stack
 * @returns {Promise<string[]>} human-readable problems; empty means every one
 *   of them came back 200 with something in it
 */
export async function buildAssetProblems(target, html, get = (path) => once(target, path)) {
  const named = buildAssets(html);
  const servable = named.filter((path) => SERVABLE_ASSET.test(path));
  if (servable.length === 0) {
    return [
      `the page references ${named.length} \`/_next/static/…\` path(s) and none of them is a file this deployment could serve (${named.join(', ') || 'none at all'}). A page produced by a Next build names its script and stylesheet chunks by content hash; four lines of \`respond\` in the Caddyfile name none, and a build whose \`static\` directory never made it into the image names them and cannot serve them.`,
    ];
  }
  const problems = [];
  for (const path of servable) {
    let response;
    try {
      response = await get(path);
    } catch (error) {
      problems.push(`GET ${path} could not be fetched at all: ${error.message}`);
      continue;
    }
    if (response.status !== 200) {
      problems.push(
        `GET ${path} returned ${response.status}, not 200. The page names this chunk, so the browser asks for it: a deployment that renders the HTML and 404s its own assets is a dead page with a correct-looking body, and it is what deleting \`COPY --from=build /app/apps/web/.next/static\` from apps/web/Dockerfile produces. Every structural check above passes on it.`,
      );
      continue;
    }
    if (String(response.body ?? '').length === 0) {
      problems.push(
        `GET ${path} returned 200 with an empty body, so whatever is answering for the build's assets is not the build.`,
      );
    }
  }
  return problems;
}

/**
 * One request, no redirect following.
 *
 * @param {object} target       from `stackTarget()`
 * @param {string} path         e.g. `/sign-up`
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {Buffer|string} [options.body]
 * @param {Jar} [options.jar]   sends and accepts cookies
 * @param {boolean} [options.cleartext] use the `:80` listener instead of TLS
 */
export function once(target, path, options = {}) {
  const { method = 'GET', headers = {}, body, jar, cleartext = false } = options;
  const send = cleartext ? httpRequest : httpsRequest;
  const requestHeaders = { Host: target.domain, ...headers };
  if (jar) {
    const cookie = jar.header();
    if (cookie) requestHeaders.Cookie = cookie;
  }
  if (body !== undefined) requestHeaders['Content-Length'] = String(Buffer.byteLength(body));

  return new Promise((resolve, reject) => {
    const request = send(
      {
        host: target.address,
        port: cleartext ? target.httpPort : target.httpsPort,
        // The hostname in the handshake, so Caddy serves the right certificate
        // and matches the right site block.
        // `rejectUnauthorized: true` is written rather than relied on. It is
        // the default, and the default is what `NODE_TLS_REJECT_UNAUTHORIZED=0`
        // changes — measured against a self-signed server: with that variable
        // set and no explicit option the request returns 200, and with the
        // option written it still fails DEPTH_ZERO_SELF_SIGNED_CERT. One
        // `env:` line would otherwise have made this job's "certificate
        // verification is never disabled" false without touching this file.
        // `no-command-shadowing` refuses that line as well; this is the half
        // that does not depend on another program having run.
        ...(cleartext
          ? {}
          : {
              servername: target.domain,
              rejectUnauthorized: true,
              ...(target.ca ? { ca: target.ca } : {}),
            }),
        path,
        method,
        headers: requestHeaders,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          jar?.accept(response.headers['set-cookie']);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** `once`, following same-origin redirects — which is what a browser does. */
export async function follow(target, path, options = {}) {
  let current = path;
  let response = await once(target, current, options);
  const trail = [{ path: current, status: response.status }];
  for (let hop = 0; hop < 8; hop += 1) {
    if (response.status < 300 || response.status > 399) break;
    const location = response.headers.location;
    if (!location) break;
    current = location.startsWith('http')
      ? new URL(location).pathname + new URL(location).search
      : location;
    // A redirect is followed with GET, per the 303 the Server Actions emit.
    response = await once(target, current, { ...options, method: 'GET', body: undefined });
    trail.push({ path: current, status: response.status });
  }
  return { ...response, trail, path: current };
}

/**
 * The fields of a rendered form, including Next's `$ACTION_ID_…` hidden input.
 *
 * Read out of the HTML rather than hard-coded, because the action id is a build
 * artefact: hard-coding one would turn a rebuild into a mysteriously failing
 * assertion, and guessing one would prove nothing about the page.
 */
export function formFields(html, marker) {
  const forms = html.match(/<form[^>]*>[\s\S]*?<\/form>/g) ?? [];
  const form = marker ? forms.find((candidate) => candidate.includes(marker)) : forms[0];
  if (!form) throw new Error(`no form${marker ? ` containing ${marker}` : ''} in the response`);
  const fields = {};
  for (const input of form.match(/<input[^>]*>/g) ?? []) {
    const name = /name="([^"]*)"/.exec(input)?.[1];
    if (!name) continue;
    fields[name] = /value="([^"]*)"/.exec(input)?.[1] ?? '';
  }
  return fields;
}

/** A `multipart/form-data` body, which is what Next's no-JS form posts. */
export function multipart(fields) {
  const boundary = `----atrium${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return {
    body: Buffer.from(parts.join(''), 'utf8'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Submit a form the way a browser with no JavaScript would.
 *
 * `Origin` is set because Next checks it against `Host` for Server Actions, and
 * a request that omitted it would be testing the CSRF escape hatch rather than
 * the flow.
 */
export function submit(target, path, fields, options = {}) {
  const { body, contentType } = multipart(fields);
  return follow(target, path, {
    ...options,
    method: 'POST',
    body,
    headers: { 'Content-Type': contentType, Origin: target.origin, ...(options.headers ?? {}) },
  });
}

/** Mailpit's HTTP API, reached from wherever this script is running. */
export function mailpit(env = process.env) {
  const base = env.ATRIUM_MAILPIT_URL?.trim() || 'http://127.0.0.1:8025';
  return {
    base,
    async get(path) {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) throw new Error(`mailpit ${path} → ${response.status}`);
      return response.json();
    },
    async deleteAll() {
      const response = await fetch(`${base}/api/v1/messages`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`mailpit DELETE /api/v1/messages → ${response.status}`);
    },
  };
}

/**
 * Poll until `check` returns something truthy, or fail loudly with context.
 *
 * A throw from `check` is a retry, not a failure — a service that is still
 * starting refuses connections — but the last one is kept and reported, because
 * "timed out" without the reason is the least useful line a CI log can contain.
 */
export async function until(what, check, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const because = lastError ? `; last error: ${lastError.message}` : '';
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${because}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A fresh address per run, so a re-run never collides with its own history. */
export function uniqueEmail(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@atrium.test`;
}

/**
 * A verified account on the running stack, created the way a person creates
 * one: the sign-up form, the mail the stack actually sent, the link in it.
 *
 * Every step is returned rather than only the result, so the assertions can be
 * written where they belong — `assert-signup-verifies.mjs` interrogates each
 * step, `assert-ws-upgrade.mjs` only needs the cookie jar at the end — without
 * two files carrying two copies of the flow that could drift apart.
 *
 * It deliberately asserts nothing itself. A helper that threw on a wrong status
 * would decide, in a shared file, which failures the callers are allowed to see.
 *
 * ## `cookiesBeforeVerifying`, and why it is a snapshot
 *
 * A jar is mutable and this function runs the flow to its end, so by the time a
 * caller reads `jar` there *is* a session in it — that is the point. Anything
 * about the state *before* the link was followed therefore has to be captured
 * while it is true. The first draft of `assert-signup-verifies.mjs` asserted
 * "no session cookie before verification" against the final jar and went red on
 * a stack that was behaving perfectly; the proxy's own access log showed the
 * pre-verification `/app` correctly bouncing to `/sign-in`. The assertion was
 * right about the property and wrong about the moment. So the moment is
 * recorded here.
 */
export async function establishSession(target, mail, prefix) {
  const jar = new Jar();
  const email = uniqueEmail(prefix);
  /**
   * The display name carries the address's random suffix.
   *
   * Round 1's gauntlet, on the websocket check: it asserted the socket welcomed
   * `CI ws`, which is the same string on every run and for every account this
   * helper has ever made. A server that welcomed the *wrong* session would have
   * satisfied it, and so would one that welcomed a leftover account from an
   * earlier run against the same database. The name is now unique per account,
   * so "the socket welcomed the account that opened it" is a claim about this
   * account rather than about a constant.
   */
  const displayName = `CI ${prefix} ${email.slice(prefix.length + 1, email.indexOf('@'))}`;
  const password = 'correct-horse-battery-staple';

  const form = await follow(target, '/sign-up', { jar });
  const fields = formFields(form.body, '$ACTION_ID_');
  const submitted = await submit(
    target,
    '/sign-up',
    { ...fields, displayName, email, password },
    { jar },
  );
  const beforeVerifying = await follow(target, '/app', { jar });
  const cookiesBeforeVerifying = [...jar.names];

  const summary = await until(
    `the verification mail for ${email}`,
    async () => {
      const listed = await mail.get('/api/v1/messages?limit=100');
      return (listed.messages ?? []).find((candidate) =>
        (candidate.To ?? []).some((to) => to.Address?.toLowerCase() === email.toLowerCase()),
      );
    },
    { timeoutMs: 60_000 },
  );
  const message = await mail.get(`/api/v1/message/${summary.ID}`);
  const link = /https?:\/\/[^\s<>"]+/.exec(String(message.Text ?? ''))?.[0];
  const url = link ? new URL(link) : null;
  const verified = url ? await follow(target, `${url.pathname}${url.search}`, { jar }) : null;

  return {
    jar,
    email,
    displayName,
    password,
    form,
    fields,
    submitted,
    beforeVerifying,
    cookiesBeforeVerifying,
    message,
    link,
    url,
    verified,
  };
}

export const failures = [];

export function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

/**
 * The stack's own logs, printed when an assertion fails.
 *
 * There is nowhere else they can come from. `.github/workflows/ci.yml` allows
 * no `continue-on-error` and no step condition except `failure()` on an
 * artifact upload, so a failing assertion ends the job before any later step
 * could collect them — and a red deploy job whose only evidence is "GET /
 * returned 500" is a red deploy job somebody re-runs instead of reading. So the
 * script that failed prints them itself.
 *
 * Best-effort by construction: `probe-caller.mjs` imports this module and runs
 * inside a container with no docker socket, so every failure here is swallowed.
 * That is the one place in this repository where swallowing an error is right —
 * it is decorating a failure that has already been decided, and letting it throw
 * would replace a real assertion message with a spurious one.
 */
function dumpStackLogs() {
  const project = process.env.ATRIUM_COMPOSE_PROJECT?.trim();
  if (!project) return;
  try {
    const files = (process.env.ATRIUM_COMPOSE_FILES?.trim() || 'docker-compose.yml')
      .split(/[:,]/)
      .filter(Boolean)
      .flatMap((file) => ['-f', file]);
    const logs = execFileSync(
      'docker',
      ['compose', '-p', project, ...files, 'logs', '--no-color', '--tail', '120'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    console.error(`::group::${project} container logs (last 120 lines per service)`);
    console.error(logs);
    console.error('::endgroup::');
  } catch {
    // No docker here, or the project is already gone. Not worth a word.
  }
}

/** Print every failure as a GitHub annotation and exit accordingly. */
export function report(what) {
  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${what}: ${failure}`);
    console.error(`${what}: ${failures.length} assertion(s) failed.`);
    dumpStackLogs();
    process.exit(1);
  }
  console.info(`${what}: passed.`);
  process.exit(0);
}
