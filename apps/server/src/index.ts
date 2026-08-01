import { createAtriumAuth, resolveAuthSecret, trustedProxyStrategy } from '@atrium/auth';
import { createDatabase, memberships, rooms } from '@atrium/db';
import { and, eq, isNull } from 'drizzle-orm';
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
   * Room membership, straight from the table the web app writes. An archived
   * room has no live members, so archiving one closes it to commands without a
   * second rule anywhere.
   */
  const loadRoomMembership: LoadRoomMembership = async (roomId, userId) => {
    const [row] = await database.db
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(rooms, eq(memberships.roomId, rooms.id))
      .where(
        and(
          eq(memberships.roomId, roomId),
          eq(memberships.userId, userId),
          isNull(rooms.archivedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  };

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
      logger.error('shutdown failed', { error: (error as Error).message });
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
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection — exiting', { reason: String(reason) });
    process.exit(1);
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { error: error.message, stack: error.stack });
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
