import {
  createAtriumAuth,
  describeUnknown,
  guardedErrorLog,
  loadRoomMembership as loadAuthorizedRoomMembership,
  resolveAuthSecret,
  trustedProxyStrategy,
} from '@atrium/auth';
import { createDatabase } from '@atrium/db';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { startQueue } from './queue.js';
import { createSessionResolver, createUpgradeAuthenticator } from './ws-auth.js';
import { createRealtimeServer, type LoadRoomMembership } from './ws-server.js';

/**
 * Atrium server: one process, two responsibilities — the WebSocket realtime
 * surface and the pg-boss workers. init.md prescribes exactly one application
 * server and one worker process; they share this entrypoint until there is a
 * measured reason to split them.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const logSafely = guardedErrorLog(logger);

  logger.info('atrium server starting', { env: env.NODE_ENV, port: env.SERVER_PORT });

  const database = createDatabase({ url: env.DATABASE_URL, debug: env.LOG_LEVEL === 'debug' });

  // The same Better Auth configuration the web app runs, over the same tables.
  // The realtime server never mints a session; it only recognises one.
  const auth = createAtriumAuth({
    db: database.db,
    baseURL: env.APP_URL,
    secret: resolveAuthSecret(process.env),
    // The web app's origin, passed explicitly in both processes so neither ends
    // up with a laxer notion of "us" than the other.
    trustedOrigins: [env.APP_URL],
    // What is in front of this process, so the library's own limiter reads the
    // same forwarded headers `client-ip.ts` does — or, at hops=0, none.
    proxyStrategy: trustedProxyStrategy(process.env),
    logger,
  });

  /**
   * Room membership. The query is `@atrium/auth`'s, not this file's.
   *
   * Round 5 wrote it out here: `memberships` joined to `rooms`, filtered to a
   * live room. That read only the *derived* table, so a `memberships` row that
   * outlived its `workspace_members` row — a revocation sweep that hit the 5s
   * lock timeout, a crash between two hooks — was still full authority on this
   * surface. `loadRoomMembership` joins `workspace_members` and caps the role at
   * the workspace role, so this answer no longer depends on any cleanup having
   * run. It lives in the package because the web app asks the same question and
   * two copies of an authorization predicate is how one of them ends up wrong;
   * `packages/auth/src/room-access.ts` has the whole argument.
   */
  const loadRoomMembership: LoadRoomMembership = (roomId, userId) =>
    loadAuthorizedRoomMembership(database.db, roomId, userId, logger);

  let ready = false;
  const realtime = createRealtimeServer({
    host: env.SERVER_HOST,
    port: env.SERVER_PORT,
    heartbeatIntervalMs: env.WS_HEARTBEAT_INTERVAL_MS,
    logger,
    isReady: () => ready,
    authenticateUpgrade: createUpgradeAuthenticator({ auth, logger }),
    loadRoomMembership,
    // A WebSocket handshake is not same-origin-protected and carries cookies,
    // so the browser's `Origin` is checked against the same origin Better Auth
    // trusts on the HTTP side.
    allowedOrigins: [env.APP_URL],
    allowOriginless: env.WS_ALLOW_ORIGINLESS,
    // Passed rather than inferred: it decides whether a missing session
    // validator is a development convenience or a refusal to start.
    environment: env.NODE_ENV,
    // And a socket does not get to outlive the session that opened it.
    revalidateSession: createSessionResolver({ auth, logger }),
    revalidateTtlMs: env.WS_REVALIDATE_TTL_MS,
    // …nor the room membership that let it listen. This is the idle half: a
    // socket that only receives never triggers the per-command check.
    sweepIntervalMs: env.WS_SWEEP_INTERVAL_MS,
    // And a socket the sweep cannot verify does not get to sit there
    // indefinitely on the strength of a check that never succeeded.
    sweepFailureLimit: env.WS_SWEEP_FAILURE_LIMIT,
    sweepUnverifiedMs: env.WS_SWEEP_UNVERIFIED_MS,
  });

  await realtime.listen();

  const queue = await startQueue({
    databaseUrl: env.DATABASE_URL,
    concurrency: env.INTERPRET_WORKER_CONCURRENCY,
    logger,
  });

  ready = true;
  logger.info('atrium server ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    logger.info('shutting down', { signal });

    // Force-exit if anything hangs; a stuck shutdown is worse than a hard one.
    const forced = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    forced.unref();

    try {
      await realtime.close();
      await queue.stop();
      await database.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      // Exit code before description, everywhere in this file. See the block
      // below `unhandledRejection` for why that ordering is not pedantry.
      process.exitCode = 1;
      logSafely('shutdown failed', () => ({ error: describeUnknown(error) }));
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // An unhandled rejection means a promise chain died without anyone catching
  // it: the process is in a state nobody reasoned about. Logging and carrying
  // on is how a server ends up serving stale reads or half-open sockets for
  // hours. Exit, and let compose's `restart: unless-stopped` bring back a
  // process whose state we understand. Deliberately not a graceful shutdown —
  // the shutdown path itself may be what failed.
  /**
   * The last two handlers in the process, and the ones that most needed this.
   *
   * `String(reason)` is not total — that is the whole finding of round 9 — and
   * this listener is the one place where a throw has nowhere to go: a throw
   * inside an `unhandledRejection` listener is re-raised as an *uncaught
   * exception*, so a rejection value carrying a hostile `Symbol.toPrimitive`
   * skipped the `process.exit(1)` below it and diverted the process into the
   * graceful shutdown it deliberately does not want. The handler written to
   * guarantee "exit, and let compose restart us" could be argued out of it by
   * the value it was reporting.
   *
   * `exitCode` is set before anything is described, so even a total description
   * that somehow throws still leaves a process that dies non-zero.
   */
  process.on('unhandledRejection', (reason) => {
    process.exitCode = 1;
    logSafely('unhandled rejection — exiting', () => ({ reason: describeUnknown(reason) }));
    process.exit(1);
  });
  process.on('uncaughtException', (error: unknown) => {
    // Typed `Error` by Node's own signature, but `throw {}` is legal JavaScript
    // and reaches here verbatim. `stack` is read inside the guarded thunk.
    process.exitCode = 1;
    logSafely('uncaught exception', () => ({
      error: describeUnknown(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // `instanceof` runs a Proxy's `getPrototypeOf` trap, so even this line was a
  // way to start the process and never set a failing exit code.
  process.exitCode = 1;
  console.error(describeUnknown(error));
  process.exit(1);
});
