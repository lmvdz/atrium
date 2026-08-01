import 'server-only';
import { auth } from './auth';
import { appUrl, databaseUrl, isBuildPhase, proxyStrategy, realtimeUrl } from './env';

/**
 * Everything this process needs in order to serve, asked once, at start-up.
 *
 * ## The failure this exists to convert
 *
 * `apps/web` had no boot condition at all. Every gate it owns — the mail
 * transport, the secure-origin rule, the required proxy hop count, the database
 * URL — was evaluated lazily on the request path, because `next build` imports
 * every route module and a throw at module scope turns a missing variable into a
 * broken build. That laziness is right; the consequence was not. `AccountBar`
 * sits in the **root layout**, so `auth()` is constructed for every page
 * including the marketing shell, and a configuration error therefore surfaced as
 * an HTTP 500 on every route of a container reporting itself perfectly healthy.
 * Three rounds of gauntlet receipts described that deployment as working.
 *
 * A process that cannot serve anything must not be a process that answers. So
 * the same checks run here, once, before the first request — and a failure exits
 * the process rather than logging. `apps/server` has behaved this way since it
 * was written (`loadEnv()` throws in `main()`); this is the web app catching up,
 * and it is why `docker-compose.yml` can now put a health check on `app` that
 * means something.
 *
 * ## Why `process.exit` rather than a thrown error
 *
 * Next calls `register()` and does not contract to die when it rejects; a
 * rejected instrumentation hook that leaves the server listening is the 500-on
 * -every-page failure with an extra log line. Exiting is unambiguous: the
 * container dies, `restart: unless-stopped` restarts it, it dies again, and the
 * health check never passes — which is what `docker compose up --wait` and the
 * CI deploy job read as a failure. Loud, and impossible to mistake for serving.
 *
 * ## What it deliberately does not do
 *
 * It does not reach the database or the mail relay. `createAtriumAuth` builds a
 * client; it opens no connection, and neither does this. Waiting for Postgres at
 * boot would make the app's liveness depend on another container's, which is
 * what `depends_on` and the health checks are for. The claim here is narrower
 * and is exactly the one that was missing: **this process is configured well
 * enough that a page can render.**
 */
export function assertServingConfig(): void {
  // `next build` compiles route modules with NODE_ENV=production while serving
  // no request, and a build machine must not need a production hostname or SMTP
  // credentials to compile one. Same exemption `resolveMailer` and
  // `assertSecureTransport` make, asked the same way.
  if (isBuildPhase()) return;

  // Order matters only for the error message: the cheapest, most commonly wrong
  // values first, so an operator reading the crash sees the variable they forgot
  // rather than a stack trace from inside Better Auth.
  appUrl();
  databaseUrl();
  proxyStrategy();
  realtimeUrl();

  // And the whole composition root, which is what actually runs
  // `resolveMailer` (the mail-transport gate) and `assertSecureTransport` over
  // every declared origin. Constructing it here is not an optimisation — it is
  // the assertion. `auth()` memoises on `globalThis`, so the first request
  // reuses this instance rather than building a second one.
  auth();
}
