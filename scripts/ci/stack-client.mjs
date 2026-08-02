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
import { join } from 'node:path';
import { repoRoot } from './repo-root.mjs';

/**
 * Where the stack is, and how to prove it is who it says it is.
 *
 * ── WHY AN UNREADABLE CA IS NOT A THROW ANY MORE (#40 round 9, D1) ──────────
 * This read the CA at module scope with a bare `readFileSync`, and every stack
 * assertion calls it at module scope too. `ATRIUM_STACK_CA` points at
 * `caddy-root.crt`, which is written by `compose-stack.mjs trust-ca` — step 10
 * of the deploy job, six steps after the positive control at step 4. So in the
 * world the positive control actually runs in, every one of those scripts died
 * with `Error: ENOENT … caddy-root.crt` and a stack frame naming itself.
 *
 * A blind critic measured what that made the control worth: its `expect` was
 * `/assert-page-serves/`, the ENOENT frame says `assert-page-serves.mjs:110`,
 * and **any** Node stack trace supplies the file's own name for free. The
 * control proved the assertion went red because a file was missing, never
 * because the deployment was missing — and with the CA present it would not
 * have matched at all, because `connect ECONNREFUSED` names
 * `TCPConnectWrap.afterConnect` and nothing else.
 *
 * So the missing CA is *recorded* rather than thrown: `caProblem` carries it,
 * `requireDeployment` turns it into a failed assertion with a message, and the
 * script reaches a verdict instead of a crash. A crash is not a verdict — this
 * repository has a whole module (`child-verdict.mjs`) about that distinction,
 * and the three cold controls were living on the wrong side of it.
 */
export function stackTarget(env = process.env) {
  const domain = env.ATRIUM_STACK_DOMAIN?.trim() || 'atrium.localhost';
  const path = env.ATRIUM_STACK_CA?.trim();
  let ca;
  let caProblem;
  if (path) {
    try {
      ca = readFileSync(path);
    } catch (error) {
      caProblem = `ATRIUM_STACK_CA points at ${path}, which could not be read (${error.message}). That file is written by \`compose-stack.mjs trust-ca\`, out of the running proxy container, so this means the deployment has not been brought up — or its certificate authority never made it out of it. Every request below would fail certificate verification against a root nothing here has.`;
    }
  }
  return {
    domain,
    /** The address the published port is on. DNS's job, done explicitly. */
    address: env.ATRIUM_STACK_ADDRESS?.trim() || '127.0.0.1',
    httpsPort: Number(env.ATRIUM_STACK_HTTPS_PORT ?? 443),
    httpPort: Number(env.ATRIUM_STACK_HTTP_PORT ?? 80),
    /** Caddy's local root, copied out of the proxy container. */
    ca,
    /** Why there is no `ca`, when there was meant to be one. */
    caProblem,
    caPath: path || undefined,
    origin: `https://${domain}`,
  };
}

/**
 * The world these assertions are about, established before any of them runs.
 *
 * ── AN EXPECTATION THAT MATCHES AN IDENTITY (#40 round 9, D1) ───────────────
 * The positive control's job is to prove that an assertion's answer is a
 * function of the deployment. Round 8's deploy controls asked only that the
 * script go red and that its output contain its own name — which is what a
 * stack trace, an ENOENT, a syntax error and "node: command not found" all
 * contain. The exploit measured against it was twenty lines: re-import every
 * binding the original file imported, call `stackTarget()`, call `report(…)`.
 * `positive-control deploy` printed **"red as required"**, and the same file
 * printed `passed.` against a live stack it had never looked at.
 *
 * The fix is not a better regular expression over a crash. It is that the cold
 * run must produce a *recorded failure with a sentence in it*, so the control
 * can be satisfied by behaviour — an assertion that ran and said no — rather
 * than by the file's own name appearing somewhere in a stack.
 *
 * Called at the top of each stack assertion. When the deployment is not there
 * it records why and reports immediately: everything after it would be a second
 * failure about the same absence, and one honest sentence beats twenty
 * `ECONNREFUSED`s. When the deployment *is* there it returns and the assertion
 * does its own work.
 *
 * ── WHAT THE CONTROLS ACTUALLY MATCH, SAID CORRECTLY (#40 round 10, D1) ─────
 * Round 9's comment here claimed `expectationProblems` "refuses any control
 * whose expectation could be satisfied by this message alone". Nothing did that,
 * and nothing could: the cold world's red *is* this message, so a rule refusing
 * it would refuse every deploy control there is. A sentence about a mechanism
 * that does not exist is worse than no sentence, because it is read as one.
 *
 * What is true is narrower and is enforced. The message a *refused connection*
 * produces is the only one the deploy controls may expect; every other sentence
 * `absentDeployment` can return — the ones about a certificate authority that
 * could not be read, or a peer that answered and could not be verified — is
 * generated into the corpus `expectationProblems` refuses patterns against,
 * because each of those describes a world other than "nothing is listening".
 * And `distinguishProblems` runs the entry point against a closed port and
 * against a decoy that accepts the connection, and requires the two outputs to
 * differ: a precondition that answers the same way in both worlds is not a
 * precondition anybody is measuring the deployment with.
 *
 * @param {string} what the assertion's name, for the annotations
 * @param {object} target from `stackTarget()`
 * @param {(target: object, path: string, options?: object) => Promise<object>} [get]
 *   injectable so the contracts can drive both answers without a stack
 * @param {(what: string) => void} [finish] injectable for the same reason
 */
export async function requireDeployment(what, target, get = once, finish = report) {
  let outcome;
  try {
    outcome = { response: await get(target, '/', { method: 'HEAD' }) };
  } catch (error) {
    outcome = { error };
  }
  const absent = absentDeployment(target, outcome);
  if (absent === undefined) return;
  check(false, absent);
  finish(what);
}

/**
 * Codes that mean the connection never reached a peer at all.
 *
 * The distinction this whole function turns on: a socket that was *refused* says
 * nothing is there, and every other outcome says something is — a TLS error, a
 * reset, a status. `ETIMEDOUT` is in here because a port with nothing behind it
 * on a filtered host times out rather than refusing, and `ENOTFOUND`/`EAI_AGAIN`
 * because a name that does not resolve is the same absence one layer up.
 */
const NO_PEER = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Why there is no deployment to ask questions of, or `undefined`.
 *
 * The decision, separated from the acting on it, for the reason `verdict` is
 * separated from `report`: a function that ends the process cannot be tested by
 * anything in the process, and this one is load-bearing for every deploy control
 * in `positive-control.mjs` — the sentence it returns is what those controls
 * match, and a version that returned `undefined` unconditionally would put all
 * three of them back to being satisfied by a stack trace.
 *
 * ── THE OBSERVATION COMES FIRST, AND THAT IS THE FIX (#40 round 10, D1) ─────
 * Round 9 opened with `if (target?.caProblem !== undefined) return caProblem;`
 * — before a single request. `ATRIUM_STACK_CA` is set at job level and the file
 * it names is written by `trust-ca`, six steps *after* the positive control
 * runs, so in the only world the control ever runs in that first line always
 * fired and the deployment branch below it was dead code. A blind critic
 * measured it: a live server on one port and nothing on another produced
 * **byte-identical output**. A control that cannot tell its two worlds apart is
 * not a control, whatever its expectation matches.
 *
 * So the request is made first and the *socket's answer* decides. Refused means
 * nothing is there, and that is the sentence the cold controls are graded on —
 * it is produced whether or not a certificate authority was readable, which is
 * what makes the cold world's red about the deployment. Anything else means
 * something answered, and *then* an unreadable CA is the thing worth saying,
 * because a handshake that failed against a root we do not have is genuinely
 * ambiguous and must not be read as "nothing is serving".
 *
 * Every branch returns a different sentence on purpose: `distinguishProblems` in
 * positive-control.mjs runs an entry point against a closed port and against a
 * decoy listener and requires the two outputs to differ, which is a property of
 * this function and nothing else.
 *
 * @param {object} target from `stackTarget()`
 * @param {{response?: object, error?: object}} outcome what one request did
 * @returns {string|undefined}
 */
export function absentDeployment(target, outcome) {
  const where = `${target.origin}/ (${target.address}:${target.httpsPort}, SNI ${target.domain})`;
  const error = outcome?.error;
  if (error !== undefined) {
    const code = error.code ?? error.message;
    if (NO_PEER.has(error.code)) {
      return `nothing is serving this deployment: a request to ${where} was refused with ${code}, so no process accepted the connection at all. Every assertion in this file is a question about a running deployment, and there is not one to ask.`;
    }
    if (target?.caProblem !== undefined) {
      return `something accepted a connection on ${target.address}:${target.httpsPort} and the request to ${where} then failed with ${code} — and this run has no certificate authority to judge that by. ${target.caProblem} A handshake that fails against a root nothing here has is not evidence that the deployment is absent, and it is not evidence that it is healthy either.`;
    }
    return `something is answering on ${target.address}:${target.httpsPort} but it is not this deployment: the request to ${where} failed with ${code} against the certificate authority ${target.caPath ?? '(none configured)'} names. A peer that accepts the connection and then cannot complete the exchange is a different failure from an absent one, and this file may not treat it as the same.`;
  }
  if (target?.caProblem !== undefined) {
    return `a request to ${where} completed without this run having a certificate authority to verify it against. ${target.caProblem} Certificate verification is the only thing making these assertions questions about *this* deployment, so an answer obtained without it is not one this file may use.`;
  }
  if (typeof outcome?.response?.status !== 'number') {
    return `a HEAD of ${target.origin}/ came back without a status, so nothing here can say what is answering on ${target.address}:${target.httpsPort}. An answer this file cannot read is not an answer it may assume was fine.`;
  }
  return undefined;
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

/**
 * The ones that are a file this deployment must be able to serve.
 *
 * Classified on the path, requested whole. A build that stamps its chunks —
 * `/_next/static/chunks/page.js?dpl=abc`, and `?v=` and `?ts=` are the same
 * idea — has an extension in the middle of the URL, so an anchored test on the
 * whole string skips it *silently*: the fetch loop would check the stylesheets
 * and report clean while every script 404ed, and if the query-bearing script
 * were the only asset it would report "nothing servable here" on a healthy
 * stack. Wrong in both directions from one anchor, found by a blind review.
 */
const SERVABLE_ASSET = /\.(?:js|mjs|css|json|woff2?|ttf|otf|svg|png|webp|ico|map)$/;
const assetPath = (url) => url.split(/[?#]/)[0];

/**
 * The subset of `buildAssets(html)` that is a file, not a route.
 *
 * Exported because "this page names a chunk" has to be assertable per response.
 * `buildAssetProblems` is handed all four bodies joined, so its own
 * `servable.length === 0` is satisfied by *one* asset anywhere in the union — an
 * asset-free signed-out `/` passes it as long as `/app` names something. Round 4
 * had a per-body check for this and round 5 deleted it on the grounds that the
 * fetch loop covered it. It does not; see the four `check(...)` calls in
 * assert-page-serves.mjs, which are the per-body half, restored.
 */
export function servableAssets(html) {
  return buildAssets(html).filter((path) => SERVABLE_ASSET.test(assetPath(path)));
}

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
 * already up.
 *
 * ── WHAT IT DOES NOT REPLACE (#40 round 6) ──────────────────────────────────
 * Round 5 deleted round 4's per-response `buildAssets(anonymous.body) !== ''`
 * and claimed the fetch loop covered it, because it "gives `assets !== ''`
 * something to stand on". It does not, and the difference is one word: this
 * function is called on all four bodies **joined**, so its `servable.length ===
 * 0` asks whether the *union* names an asset. A blind review measured it — the
 * round-4 check goes red on an asset-free signed-out `/`, and this one accepts
 * it as long as `/app` names a chunk. A page that names no chunks is a page
 * that is not the Next build, and no amount of fetching *other* pages' chunks
 * says otherwise. The per-body half is back, in assert-page-serves.mjs, over
 * `servableAssets` rather than over `buildAssets`: `/_next/static/` paths that
 * are not files were the round-5 lesson about this same string, and a page
 * whose only "asset" is a route has not named a chunk either.
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
  const servable = servableAssets(html);
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
    const body = String(response.body ?? '');
    if (body.length === 0) {
      problems.push(
        `GET ${path} returned 200 with an empty body, so whatever is answering for the build's assets is not the build.`,
      );
      continue;
    }
    // A 200 is not enough on its own: a catch-all route, or a proxy answering
    // every path with the app shell, returns the *page* for a missing chunk and
    // the browser gets a 200 it cannot execute. A real chunk or stylesheet
    // never begins with a document. Deliberately this narrow — anything about
    // the content-type header would be a constant the mutation writes.
    if (
      /^\s*(?:<!doctype html|<html\b)/i.test(body) &&
      /\.(?:js|mjs|css|map)$/.test(assetPath(path))
    ) {
      problems.push(
        `GET ${path} returned 200 with an HTML document in it, so something is answering for the build's assets with a page. A chunk the browser cannot execute is a chunk that is not there, and a 200 makes it quieter than a 404 rather than better.`,
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
  // Counted before anything can go wrong with it: what this records is that the
  // script *asked the deployment something*, which is the observation a floor of
  // recorded assertions cannot distinguish from `check(true, …)`. See
  // `assertionsRun` below and `minRequests` in .github/ci-manifest.json.
  observations.requests += 1;
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

/**
 * What this process actually did, as opposed to what its source code says.
 *
 * ── A FLOOR OVER A LOOP IS A FLOOR OVER NOTHING (#40 round 10, D2) ──────────
 * Round 9's `assertionFloorProblems` counts `check()` **call sites** in the
 * source. Four scripts record every problem through *one* site over a computed
 * list — `for (const problem of problems) check(false, problem);` — and so
 * carried a floor of 1. A blind critic replaced the `isMainModule` block of
 * `assert-stack-schema.mjs` (529 lines, the one assertion standing between
 * `migrate` exiting 0 and the schema existing) with a query for `select 1` and
 * an empty list, and measured it against the live migrated stack:
 * `assert-stack-schema: passed.` — **exit 0, zero schema compared**, with the
 * positive control still red as required and every other gate green. A ratchet
 * over a quantity the author sets in one line measures the author's cooperation.
 *
 * So the floors are also *runtime* quantities now, and these are the counters:
 *
 *   - `assertions` — one per `check(…)`, plus whatever `compared(n, …)` records
 *     for a comparison that examined `n` subjects and found nothing wrong. A
 *     comparison that produces no problem still happened, and counting only the
 *     problems is what made a floor of 1 satisfiable by comparing nothing.
 *   - `requests` — one per `once(…)`, i.e. per question actually put to the
 *     deployment. This is the half a tautology cannot fake: round 10's D3
 *     exploit was twenty-three `check(true, …)` calls, which satisfies any count
 *     of recorded assertions and asks the deployment exactly one thing.
 *
 * `verdict` compares both against `.github/ci-manifest.json`, so a script that
 * stops doing the work goes red *against the live stack* rather than being
 * caught only by a reader of its source.
 */
export const observations = { assertions: 0, requests: 0 };

export function check(condition, message) {
  observations.assertions += 1;
  if (!condition) failures.push(message);
  return condition;
}

/**
 * `n` subjects were compared and the comparison is what produced `problems`.
 *
 * The counterpart to `check` for the scripts whose assertions are a fold over a
 * computed population: the population's size is the number of assertions made,
 * and it must come from the comparison itself rather than from a literal beside
 * it. `checkSchema` returns how many table, column, constraint and index
 * comparisons it performed; a rewrite that skips the comparison cannot report
 * that it performed them without performing them.
 *
 * @param {number} count how many subjects were examined
 * @param {string} what  the comparison, for the message when `count` is not one
 * @returns {number} `count`, so a caller can pass it straight through
 */
export function compared(count, what) {
  if (!Number.isInteger(count) || count < 0) {
    failures.push(
      `${what} reported ${JSON.stringify(count)} comparisons, which is not a count of anything. The number of assertions a fold over a population makes is the population's size, and it has to be produced by the fold.`,
    );
    return 0;
  }
  observations.assertions += count;
  return count;
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

/**
 * Print every failure as a GitHub annotation and *return* the exit status.
 *
 * ── WHY THE VERDICT IS SEPARATE FROM THE EXIT (#40 round 7) ─────────────────
 * `report` is the last statement of six of the deploy job's assertion scripts,
 * so this two-line decision — "were there failures?" — is the exit status of all
 * six. Round 6 centralised the *guard*; this was already centralised and nothing
 * outside these scripts tested it, which is the same defect one function over: a
 * `report` that always exits 0 turns six red gates green with one edit, and
 * every count claim in every receipt stays true.
 *
 * A function that calls `process.exit` cannot be tested by anything in the
 * process that calls it. So the decision is a value here, `report` is the thin
 * wrapper that acts on it, and `packages/ci-guard` asserts the decision from
 * outside `scripts/` with a registry row in `checker-graph.mjs` behind it.
 */
/**
 * The runtime floors this script is held to, out of the enrollment manifest.
 *
 * Read here rather than passed in, and read through `repoRoot()` rather than
 * relative to the working directory, for the reason repo-root.mjs exists: a
 * check that silently reads nothing from the wrong directory is a check that
 * passes from the wrong directory. An unreadable manifest is a *failure* of this
 * gate and not a reason to skip it — the same shape as `checkReadmeClaims`'
 * round-9 hole, which was a `catch { return []; }` around a missing README.
 *
 * @param {string} what the script's bare name, as it is passed to `report`
 * @param {typeof readFileSync} [read] injectable for the witnesses
 * @returns {{floors?: {minRun?: number, minRequests?: number}, problem?: string}}
 */
export function runtimeFloors(what, read = readFileSync) {
  const key = `scripts/ci/${what}.mjs`;
  let manifest;
  try {
    manifest = JSON.parse(String(read(join(repoRoot(), '.github', 'ci-manifest.json'), 'utf8')));
  } catch (error) {
    return {
      problem: `${what} could not read .github/ci-manifest.json to find out how much work it is required to have done (${error.message}). A floor nobody could read is a floor nobody is held to, and this one is the only thing that tells this script apart from one whose comparison was deleted.`,
    };
  }
  const entry = manifest?.assertions?.scripts?.[key];
  return { floors: entry === undefined ? undefined : entry };
}

/**
 * Whether this run did as much as the manifest says this script does.
 *
 * Separated from `verdict` so the witnesses outside `scripts/` can put every
 * shape through it — including the ones that are awkward to produce on purpose,
 * like a script that made its assertions and asked the deployment nothing.
 *
 * @param {string} what
 * @param {{assertions: number, requests: number}} counts
 * @param {(what: string) => object} [floorsOf]
 * @returns {string[]}
 */
export function runtimeFloorProblems(what, counts, floorsOf = runtimeFloors) {
  const { floors, problem } = floorsOf(what);
  if (problem !== undefined) return [problem];
  if (floors === undefined) return [];
  const problems = [];
  if (typeof floors.minRun === 'number' && counts.assertions < floors.minRun) {
    problems.push(
      `${what} recorded ${counts.assertions} assertion(s) in this run and .github/ci-manifest.json says it makes at least ${floors.minRun}. This is the count of comparisons actually *evaluated*, not of \`check(…)\` call sites: four scripts here record every problem through one call site over a computed list, so a version of this file that computes an empty list passes a source-level floor of 1 while comparing nothing at all — measured on r9 against a live migrated stack as "assert-stack-schema: passed." with zero schema compared.`,
    );
  }
  if (typeof floors.minRequests === 'number' && counts.requests < floors.minRequests) {
    problems.push(
      `${what} put ${counts.requests} request(s) to the deployment and .github/ci-manifest.json says it puts at least ${floors.minRequests}. A recorded assertion whose condition is a constant costs one line and satisfies any count of assertions; it cannot fake having asked the deployment anything, and the r10 D3 exploit — twenty-three \`check(true, …)\` calls after the precondition — asked it exactly once.`,
    );
  }
  return problems;
}

/**
 * The one line every failing assertion script ends with.
 *
 * Exported because `positive-control.mjs` derives a corpus entry from it (#40
 * round 10, D6): two controls expected `/assert-stack-config: \d+ assertion\(s\)
 * failed\./`, which is *any* recorded failure in that file — including one from
 * a world the control did not plant. A corpus of wrong reds that is written down
 * by hand goes stale the moment the code produces a new spelling, so the
 * spellings this repository produces itself are generated from the code that
 * produces them.
 */
export const failureSummary = (what, count) => `${what}: ${count} assertion(s) failed.`;

export function verdict(what) {
  failures.push(...runtimeFloorProblems(what, observations));
  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${what}: ${failure}`);
    console.error(failureSummary(what, failures.length));
    dumpStackLogs();
    return 1;
  }
  // The counts, printed on the way past, because a green line that says only
  // "passed" is the one thing this whole round is about: `assert-stack-schema:
  // passed.` was true of a run that compared no schema at all. What was
  // observed, not what was hoped for.
  console.info(
    `${what}: passed. ${observations.assertions} assertion(s) recorded, ${observations.requests} request(s) to the deployment.`,
  );
  return 0;
}

/** Every assertion recorded so far, forgotten. Only the tests need this. */
export function resetFailures() {
  failures.length = 0;
  observations.assertions = 0;
  observations.requests = 0;
}

/** Print every failure as a GitHub annotation and exit accordingly. */
export function report(what) {
  process.exit(verdict(what));
}
