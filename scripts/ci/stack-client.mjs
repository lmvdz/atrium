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
        ...(cleartext
          ? {}
          : { servername: target.domain, ...(target.ca ? { ca: target.ca } : {}) }),
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
 */
export async function establishSession(target, mail, prefix) {
  const jar = new Jar();
  const email = uniqueEmail(prefix);
  const displayName = `CI ${prefix}`;
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
