/**
 * HTTPS as a boot condition, not as a comment.
 *
 * Round 4 shipped a compose stack whose proxy listened on `:80` and whose
 * `APP_URL` defaulted to `http://`, with a paragraph in `deploy/Caddyfile`
 * telling the operator to change it. Codex's round-4 delta called that what it
 * is: **a comment is not a control.** Every session cookie, every verification
 * link and every invitation link in that deployment crosses the network in
 * cleartext, and nothing in the repository notices.
 *
 * So this is the same discipline `mailer.ts` already applies to the console
 * transport: in production, an insecure public URL is a *refusal to start*, not
 * a warning nobody reads. `MailerNotConfiguredError` and
 * `InsecureTransportError` are siblings on purpose — both say "this
 * configuration is one somebody would deploy by accident, and the only way to
 * make that impossible is to make the process die".
 *
 * ## What counts as "the transport", and why it is the *public* URLs
 *
 * This process cannot see its own socket's TLS state, and it should not try:
 * terminating TLS at a reverse proxy and forwarding cleartext over a private
 * network is the normal, correct topology (it is the one `docker-compose.yml`
 * ships). What decides whether a *browser* is protected is the set of URLs the
 * deployment advertises — the origin cookies are minted for, and the origin the
 * client is told to open a WebSocket against. If those say `http://` and
 * `ws://`, the deployment is plaintext no matter what is running in front.
 *
 * So the rule is: **every public origin this deployment declares must be a
 * secure one.** `APP_URL` on both processes, `NEXT_PUBLIC_WS_URL` on the web
 * app, and every entry either of them hands Better Auth as a trusted origin.
 *
 * ## No override, deliberately
 *
 * There is no `ATRIUM_ALLOW_INSECURE=1`. An escape hatch here is the comment
 * again with extra steps: the deployment that reaches for it is exactly the one
 * this check exists for. Development and test are unaffected — they are not
 * production — and `next build` is exempted for the same reason `resolveMailer`
 * exempts it: it compiles route modules without serving a request, and a build
 * machine must not need a production hostname to compile one.
 */

/** The environment fields that decide whether the rule applies at all. */
export interface TransportSource {
  NODE_ENV?: string | undefined;
  NEXT_PHASE?: string | undefined;
}

/** A named public URL, so the error can say which setting is wrong. */
export interface DeclaredOrigin {
  /** The variable or option it came from, e.g. `APP_URL`. */
  name: string;
  /** Its value. `undefined`/`null`/empty is skipped — presence is somebody else's gate. */
  value: string | null | undefined;
}

/**
 * The two schemes a browser treats as a secure context, and nothing else.
 *
 * `wss:` is here because `NEXT_PUBLIC_WS_URL` is a public URL of this
 * deployment in exactly the sense above: it is what the browser opens, and a
 * `ws://` socket carrying a session cookie is the same exposure as an `http://`
 * page carrying one.
 */
const secureSchemes = new Set(['https:', 'wss:']);

/**
 * Is this a URL a browser will treat as a secure context?
 *
 * Anything unparseable is **not** secure. A value nobody can parse is not a
 * configuration, which is the same answer `trustedProxyStrategy` gives to
 * `hops=lots`.
 */
export function isSecureUrl(value: string): boolean {
  try {
    return secureSchemes.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** True while `next build` is compiling modules and serving no request. */
export function isBuildPhase(env: TransportSource): boolean {
  return env.NEXT_PHASE === 'phase-production-build';
}

/**
 * Does the secure-transport rule apply to this process right now?
 *
 * Exported because both `apps/web/lib/env.ts` and `apps/server/src/env.ts` ask
 * the same question, and two spellings of "am I in production?" is how one of
 * them ends up laxer than the other.
 */
export function requiresSecureTransport(env: TransportSource = process.env): boolean {
  return env.NODE_ENV === 'production' && !isBuildPhase(env);
}

export class InsecureTransportError extends Error {
  /** The `name: value` pairs that failed, so a caller can log them structurally. */
  readonly problems: readonly DeclaredOrigin[];

  constructor(problems: readonly DeclaredOrigin[]) {
    super(
      `Atrium refuses to start: ${problems
        .map((problem) => `${problem.name}=${problem.value}`)
        .join(', ')} — a production deployment must serve over TLS. ` +
        'Session cookies, verification links and invitation links all cross the ' +
        'network on these origins, and on http:// or ws:// they cross it in ' +
        'cleartext to every device between the browser and this process. Set ' +
        'https:// (and wss:// for the realtime URL); docker-compose.yml takes a ' +
        'domain in ATRIUM_DOMAIN and Caddy obtains the certificate itself. There ' +
        'is deliberately no override — see packages/auth/src/transport.ts.',
    );
    this.name = 'InsecureTransportError';
    this.problems = problems;
  }
}

/**
 * Refuse to continue when a production deployment declares an insecure origin.
 *
 * A no-op outside production, and during `next build`. Values that are absent
 * are skipped rather than failed: "is it set?" belongs to the gates that
 * already ask it (`required()` in `apps/web/lib/env.ts`, `productionRequired`
 * in `apps/server/src/env.ts`), and duplicating it here would produce two
 * different sentences for one missing variable.
 *
 * @param declared the public origins this deployment advertises.
 * @param env      the environment to judge against.
 */
export function assertSecureTransport(
  declared: readonly DeclaredOrigin[],
  env: TransportSource = process.env,
): void {
  if (!requiresSecureTransport(env)) return;

  const problems = declared.filter(
    (origin) =>
      typeof origin.value === 'string' && origin.value !== '' && !isSecureUrl(origin.value),
  );
  if (problems.length === 0) return;
  throw new InsecureTransportError(problems);
}

/**
 * Whether Better Auth should mark this deployment's cookies `Secure`.
 *
 * Better Auth would infer this from `baseURL` on its own. It is stated
 * explicitly for the same reason `rateLimit.enabled` is: an inherited default
 * is a decision nobody made, and this one decides whether the session cookie is
 * allowed onto a cleartext connection. Stated, it is also *testable* — see
 * `transport.test.ts`, which builds a real instance and asks the library's own
 * `getCookies` what that instance's session cookie ends up looking like, rather
 * than asserting that a line of config is present (or, worse, recomputing the
 * same value inside the test and calling that a check).
 *
 * Derived from the URL rather than from `NODE_ENV`: a developer running
 * `pnpm dev` on `http://localhost:3000` must still be able to sign in, and a
 * production deployment cannot reach here with an `http://` baseURL at all
 * because `assertSecureTransport` refused to start.
 */
export function useSecureCookies(baseURL: string): boolean {
  return isSecureUrl(baseURL);
}
