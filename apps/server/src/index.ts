import { createDatabase } from '@atrium/db';
import { createCommandService } from './commands.js';
import { loadEnv } from './env.js';
import { createEventBus } from './event-bus.js';
import { createLedger } from './ledger.js';
import { createLogger } from './logger.js';
import { startQueue } from './queue.js';
import { createMembershipAuthorizer, createStubSessionAuthenticator } from './session.js';
import { createRealtimeServer } from './ws-server.js';

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

  // Cross-instance fan-out on Postgres LISTEN/NOTIFY (#22 r2). init.md forbids
  // Redis, and there is no need for it: a commit is announced on a channel and
  // every instance reads the rows out of the ledger itself. A single-instance
  // deployment carries the bus too and simply never hears from anyone.
  const bus = createEventBus({ sql: database.sql, logger });

  // The live core state is a fold of the ledger, so it is rebuilt from the
  // ledger — before the socket opens, because a client that connected to a
  // half-hydrated server would be told a `head` the state does not yet reflect.
  const ledger = createLedger({ db: database.db, logger, bus });
  await ledger.hydrate();

  const commands = createCommandService({
    db: database.db,
    ledger,
    authorizer: createMembershipAuthorizer(database.db),
  });

  let ready = false;
  const realtime = createRealtimeServer({
    host: env.SERVER_HOST,
    port: env.SERVER_PORT,
    heartbeatIntervalMs: env.WS_HEARTBEAT_INTERVAL_MS,
    logger,
    isReady: () => ready,
    commands,
    ledger,
    bus,
    // #26 replaces this and nothing else. See `session.ts`.
    session: createStubSessionAuthenticator(),
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
