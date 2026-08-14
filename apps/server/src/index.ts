import { randomUUID } from 'node:crypto';
import {
  createAtriumAuth,
  describeUnknown,
  guardedErrorLog,
  resolveAuthSecret,
  trustedProxyStrategy,
} from '@atrium/auth';
import { createDatabase } from '@atrium/db';
import { createAttachmentSigner } from './attachments.js';
import { createCommandService } from './commands.js';
import { loadEnv } from './env.js';
import { createEventBus } from './event-bus.js';
import {
  createExecutionOwnership,
  createExecutionProvider,
  wireExecutionCoordinator,
} from './execution/configure.js';
import { reconcileWedgedSessions } from './execution/reconcile.js';
import { createAcceptanceProvider } from './jobs/acceptance-provider.js';
import { createGatewayProvider } from './jobs/provider.js';
import { createLedger, type Tx } from './ledger.js';
import { createLogger } from './logger.js';
import { startQueue } from './queue.js';
import { createMembershipAuthorizer } from './session.js';
import { sweepExpiredSubscriptions } from './subscriptions.js';
import { createSessionResolver, createUpgradeAuthenticator } from './ws-auth.js';
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

  /* ---------------------------------------------------------------------------
   * WHAT THE MERGE WIRED, AND THE ONE THING IT LEFT UNWIRED.
   *
   * The realtime lane shipped this server with `createStubSessionAuthenticator()`
   * and wrote beside it: "#26 replaces this and nothing else." It is replaced,
   * below, by the auth lane's real Better Auth upgrade authenticator and session
   * resolver — so the merged server no longer accepts an invented identity, and
   * a socket no longer outlives the session that opened it.
   *
   * NOT WIRED, AND REPORTED RATHER THAN DONE QUIETLY: room membership is still
   * answered by `createMembershipAuthorizer` (session.ts), which reads
   * `memberships` directly, and NOT by `@atrium/auth`'s `loadRoomMembership`,
   * which joins `workspace_members` and caps the role at the workspace role. The
   * auth lane found the difference and its own docblock names the cost — a
   * `memberships` row that outlived its `workspace_members` row (a revocation
   * sweep that hit the 5s lock timeout, a crash between two hooks) is still full
   * authority on this surface — and says two copies of an authorization
   * predicate is how one of them ends up wrong.
   *
   * It is not swapped here because `Authorizer.authorize` takes a transaction
   * `runner` and takes a `FOR SHARE` row lock INSIDE the append transaction —
   * the fix for #22 r1's time-of-check/time-of-use finding — and
   * `loadRoomMembership` has no transactional form. Merging the two predicates
   * means giving the auth-lane query a runner-aware, lock-taking variant, which
   * is a change to `packages/auth` with its own review, not a merge resolution.
   * Until then the two predicates coexist and this comment is the receipt.
   * ------------------------------------------------------------------------- */

  // Cross-instance fan-out on Postgres LISTEN/NOTIFY (#22 r2). init.md forbids
  // Redis, and there is no need for it: a commit is announced on a channel and
  // every instance reads the rows out of the ledger itself. A single-instance
  // deployment carries the bus too and simply never hears from anyone.
  //
  // The doorbell is rung by `atrium_append_core_event` rather than by this
  // process (#22 r3), so the instance id goes to the *ledger*, which passes it
  // to the function as the notification's origin. The bus only listens.
  const bus = createEventBus({ sql: database.sql, logger });

  // The live core state is a fold of the ledger, so it is rebuilt from the
  // ledger — before the socket opens, because a client that connected to a
  // half-hydrated server would be told a `head` the state does not yet reflect.
  const ledger = createLedger({ db: database.db, logger, instanceId: bus.instanceId });
  await ledger.hydrate();

  /* ---------------------------------------------------------------------------
   * THE INTERPRETATION WORKER (#23), AND THE ORDER IT HAS TO BE WIRED IN.
   *
   * The queue must exist before the command service, because the command
   * service's append transaction is where the enqueue happens — that is the
   * whole point of it (#19's gauntlet: a message committed with no job is a
   * message nothing will ever read). So the queue starts first, holding a
   * `getCommands`-shaped hole for nothing; the ledger is what the worker needs,
   * and the ledger is already up.
   *
   * `INTERPRET_MODEL_DEFAULT` / `INTERPRET_MODEL_ESCALATION` have no defaults.
   * Unset, the worker is not wired AND the enqueue hook is not installed: no
   * jobs are created, so nothing accumulates in a dead-letter queue, and this
   * line is the receipt. Choosing a model on the operator's behalf is the one
   * thing this must not do — it is somebody's bill.
   * ------------------------------------------------------------------------- */
  const routing =
    env.INTERPRET_MODEL_DEFAULT && env.INTERPRET_MODEL_ESCALATION
      ? { default: env.INTERPRET_MODEL_DEFAULT, escalation: env.INTERPRET_MODEL_ESCALATION }
      : null;
  if (routing === null) {
    logger.error(
      'interpretation is DISABLED — set INTERPRET_MODEL_DEFAULT and INTERPRET_MODEL_ESCALATION',
      {
        default: env.INTERPRET_MODEL_DEFAULT ?? null,
        escalation: env.INTERPRET_MODEL_ESCALATION ?? null,
      },
    );
  }

  // Before the socket server exists there can be no local subscribers. Still
  // relay to already-running instances; once realtime is constructed this is
  // replaced with the local+broadcast implementation below.
  let signalProjectionChanged = (roomId: string) => {
    bus.relay(roomId, {
      type: 'projection_changed',
      roomId,
      at: new Date().toISOString(),
    });
  };

  const queue = await startQueue({
    databaseUrl: env.DATABASE_URL,
    concurrency: env.INTERPRET_WORKER_CONCURRENCY,
    coalesceSeconds: env.INTERPRET_COALESCE_SECONDS,
    retryLimit: env.INTERPRET_RETRY_LIMIT,
    logger,
    interpretation: routing
      ? {
          db: database.db,
          ledger,
          provider:
            env.INTERPRET_PROVIDER === 'acceptance-deterministic'
              ? createAcceptanceProvider()
              : createGatewayProvider(),
          routing,
          onProjectionChanged: (roomId) => signalProjectionChanged(roomId),
          config: {
            maxWindowMessages: env.INTERPRET_MAX_WINDOW_MESSAGES,
            contextMessagesBefore: env.INTERPRET_CONTEXT_MESSAGES,
          },
        }
      : undefined,
  });

  const attachments = createAttachmentSigner({
    endpoint: env.S3_PUBLIC_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });

  /* ---------------------------------------------------------------------------
   * THE EXECUTION PROVIDER (#120), AND WHY IT IS DISABLED BY DEFAULT.
   *
   * When `EXECUTION_PROVIDER` is set, a granted `session_opened` resolves an
   * isolated workspace, runs a harness, and settles back to `session_settled` /
   * `session_failed` with the artifact — driven directly (no channel loop yet).
   * Unset, execution is DISABLED and this is the receipt: a session opens and
   * settles only when something else settles it. A process that would spawn real
   * work off inbound traffic must be opted into out loud, exactly as the
   * interpretation worker is. A `draw_refused` never reaches the adapter — the
   * wrapper fires only on `draw.outcome === 'granted'` (#118).
   *
   * Phase 1 (the provider + the durable artifact repo + the artifact verifier)
   * runs BEFORE the command service, so the verifier can be injected into it:
   * a `settle_session` artifact is trusted only if it names a real object the
   * provider pushed to its durable remote (#120 F2). Disabled, no verifier is
   * wired and any caller-supplied artifact is dropped — the safe default.
   * ------------------------------------------------------------------------- */
  const executionRuntime = await createExecutionProvider({ env, logger });
  if (executionRuntime === null) {
    logger.info('execution is DISABLED — set EXECUTION_PROVIDER to run granted sessions', {});
  }

  // This process's execution instance id — the value stamped as a granted provider
  // session's lease OWNER at grant, and the id the coordinator's claim matches on
  // (#120 round-6). Reused from the bus so logs correlate, or a fresh id when there
  // is no bus; either way it is unique per boot, so a prior boot's leases carry a
  // DIFFERENT id and its heartbeats stop, which is what lets reconciliation tell a
  // dead owner's session from this process's live one.
  const executionInstanceId = bus.instanceId ?? randomUUID();

  // The projection side effects that must commit with an append. Named once and
  // shared, so the command service and the subscription-expiry sweep (#127) run
  // the SAME hooks — a second literal here would be a second answer to "what else
  // commits with a ledger row", free to drift from the first.
  const projectionHooks = routing
    ? {
        onMessagePosted: ({ tx, roomId }: { tx: Tx; roomId: string }) =>
          queue.enqueueInterpretation(tx, roomId),
      }
    : {};

  const baseCommands = createCommandService({
    db: database.db,
    ledger,
    authorizer: createMembershipAuthorizer(database.db),
    attachmentCapabilities: attachments,
    verifyArtifact: executionRuntime?.verifyArtifact,
    // Present iff a provider is wired: a granted `open_session` then records a
    // `provider`-mode execution-authority record (owner = this instance, a
    // capability token) in the SAME transaction as the draw (#120 round-6 F1).
    // Absent, every session is `external` (external-settle mode).
    executionInstanceId: executionRuntime ? executionInstanceId : undefined,
    projectionHooks,
  });

  const executionOwnership = executionRuntime
    ? createExecutionOwnership({ db: database.db, instanceId: executionInstanceId, logger })
    : null;
  const executionWiring =
    executionRuntime && executionOwnership
      ? wireExecutionCoordinator({
          provider: executionRuntime.provider,
          commands: baseCommands,
          logger,
          ownership: executionOwnership,
        })
      : null;
  const commands = executionWiring?.commands ?? baseCommands;

  /**
   * How often this process keeps its ownership leases warm and sweeps for a dead
   * owner's wedge (#120 round-5 F4). Comfortably under the stale threshold so a
   * live owner's lease never reads as stale between beats.
   */
  const EXECUTION_HEARTBEAT_MS = 5_000;
  /**
   * How long a lease may go without a heartbeat before its owner is presumed dead
   * and its session reconciled. Six heartbeats of slack, so event-loop jitter on a
   * live owner never trips it — but a crashed owner's wedge clears within seconds.
   */
  const EXECUTION_LEASE_STALE_MS = 30_000;

  /**
   * How long shutdown waits for in-flight executions (#120 round-3 F5). Well
   * under the 30s force-exit watchdog, and deliberately NOT long enough for a
   * ten-minute harness — the grace is for the run that is seconds from its
   * settle, and anything longer is startup reconciliation's job.
   */
  const EXECUTION_DRAIN_GRACE_MS = 10_000;

  /* ---------------------------------------------------------------------------
   * STARTUP RECONCILIATION (#120 round-3 F5).
   *
   * Before a single socket is accepted: any session the LAST process left `open`
   * has a draw already spent against its plan's human-set slice and no execution
   * alive to produce its receipt. It gets `session_failed` — an honest exit for a
   * run that was killed, not a fabricated clean one — so a crash costs a receipt
   * that says so rather than a permanent wedge nobody can clear.
   *
   * It runs on the BASE command service on purpose. The wrapper only fires the
   * coordinator on a granted `open_session`, which this never issues, and running
   * a reconciliation through the wrapper would be one more path to reason about
   * for no gain.
   *
   * It reconciles ONLY a session whose OWNERSHIP LEASE has gone stale (#120
   * round-5 F4) — a dead owner's wedge. An external-settle session holds no lease
   * and is never touched, whether this boot runs execution or not; a live peer's
   * session has a fresh heartbeat and is left running. This replaces the round-4
   * boot flag, which force-failed live external sessions on a disabled→enabled
   * reboot and killed a concurrent instance's running sessions. It runs on EVERY
   * boot (not gated on execution): a disabled boot can still safely clear a prior
   * enabled boot's crash wedge, because "stale lease" is the whole predicate.
   * ------------------------------------------------------------------------- */
  const reconciled = await reconcileWedgedSessions({
    db: database.db,
    commands: baseCommands,
    logger,
    staleAfterMs: EXECUTION_LEASE_STALE_MS,
  });
  if (reconciled.found > 0) {
    logger.warn('startup reconciled sessions left open by a previous process', {
      found: reconciled.found,
      failed: reconciled.failed,
      unreconciled: reconciled.unreconciled,
    });
  }

  /* ---------------------------------------------------------------------------
   * THE OWNERSHIP HEARTBEAT + PERIODIC SWEEP (#120 round-5 F4, round-6 F8).
   *
   * Two jobs, deliberately split by which boots they run on:
   *
   *   * The HEARTBEAT keeps THIS process's own leases warm, and only a boot that
   *     runs execution owns any — so it fires only when `executionOwnership` is
   *     present. Heartbeat FIRST, so this process's live leases are fresh before
   *     the sweep reads them.
   *   * The SWEEP reconciles any lease that has gone stale — a dead owner's wedge.
   *     It runs on EVERY boot regardless of whether execution is enabled this boot
   *     (#120 round-6 F8): a DISABLED boot must still be able to clear a prior
   *     ENABLED boot's crash wedge, because "stale lease" is the whole predicate
   *     and reconciliation settles through the ordinary command path. Gating the
   *     sweep on the provider being wired would leave a wedge un-cleared for as
   *     long as the operator ran with execution off.
   *
   * Both are best-effort: a failure is logged and the next beat retries, never
   * takes the process down.
   * ------------------------------------------------------------------------- */
  const executionSweepTimer: NodeJS.Timeout = setInterval(() => {
    void (async () => {
      try {
        if (executionOwnership) await executionOwnership.heartbeat();
        const swept = await reconcileWedgedSessions({
          db: database.db,
          commands: baseCommands,
          logger,
          staleAfterMs: EXECUTION_LEASE_STALE_MS,
        });
        if (swept.found > 0) {
          logger.warn('periodic sweep reconciled sessions with a dead execution owner', {
            found: swept.found,
            failed: swept.failed,
            unreconciled: swept.unreconciled,
          });
        }
        // THE SUBSCRIPTION EXPIRY SWEEP (#127). Rides the same beat as the
        // execution sweep and for the same reason: both turn a silently wedged
        // process into something a person can see. A wait past its mandatory
        // horizon is marked `expired` and escalated to the agent's OWNER, so an
        // unmatched subscribe cannot hold a session open forever and block its
        // plan's settle (#119) with nothing owed to anybody. Runs on EVERY boot,
        // execution enabled or not: a wait is a ledger fact, not a provider one.
        const waits = await sweepExpiredSubscriptions({
          db: database.db,
          ledger,
          logger,
          projectionHooks,
        });
        if (waits.escalated > 0 || waits.skipped > 0) {
          logger.warn('periodic sweep escalated expired session subscriptions', {
            found: waits.found,
            escalated: waits.escalated,
            skipped: waits.skipped,
          });
        }
      } catch (error) {
        logSafely('execution heartbeat/sweep failed', () => ({ error: describeUnknown(error) }));
      }
    })();
  }, EXECUTION_HEARTBEAT_MS);
  executionSweepTimer.unref();

  let ready = false;
  const realtime = createRealtimeServer({
    host: env.SERVER_HOST,
    port: env.SERVER_PORT,
    heartbeatIntervalMs: env.WS_HEARTBEAT_INTERVAL_MS,
    // Undefined when nobody set it, which is the shipped window rather than "no
    // revalidation" — the option has no "off". See `ws-server.ts` (#22 r9, D2).
    membershipRevalidateIntervalMs: env.WS_MEMBERSHIP_REVALIDATE_INTERVAL_MS,
    logger,
    isReady: () => ready,
    commands,
    ledger,
    bus,
    attachments,
    // #26, arrived. The stub is gone; this is Better Auth reading the same
    // cookie the web app mints, over the same tables.
    session: { authenticateUpgrade: createUpgradeAuthenticator({ auth, db: database.db, logger }) },
    // A WebSocket handshake is not same-origin-protected and carries cookies,
    // so the browser's `Origin` is checked against the same origin Better Auth
    // trusts on the HTTP side.
    allowedOrigins: [env.APP_URL],
    allowOriginless: env.WS_ALLOW_ORIGINLESS,
    // And a socket does not get to outlive the session that opened it. This
    // rides the membership revalidation pass rather than a sweep of its own —
    // see `revalidateSessions` in ws-server.ts.
    revalidateSession: createSessionResolver({ auth, db: database.db, logger }),
    revalidateTtlMs: env.WS_REVALIDATE_TTL_MS,
  });
  signalProjectionChanged = (roomId) => realtime.projectionChanged(roomId);

  await realtime.listen();

  ready = true;
  logger.info('atrium server ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    logger.info('shutting down', { signal });

    // Force-exit if anything hangs; a stuck shutdown is worse than a hard one.
    // Comfortably longer than the execution drain grace below, so the drain gets
    // its full window instead of being pre-empted by its own watchdog.
    const forced = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000);
    forced.unref();

    try {
      clearInterval(executionSweepTimer);
      await realtime.close();
      await queue.stop();
      // In-flight executions get a BOUNDED grace before anything they depend on
      // is torn down (#120 round-3 F5). The order is the point: the socket server
      // is already closed (no new `open_session` can be granted), so this drains a
      // set that can only shrink, and it happens BEFORE the scratch repo is
      // deleted and the database is closed — the two things a settling run needs.
      // Reverting the order severs a run mid-settle and hands it to startup
      // reconciliation, which is the backstop, not the plan.
      if (executionWiring) {
        const stranded = await executionWiring.drainExecutions(EXECUTION_DRAIN_GRACE_MS);
        if (stranded > 0) {
          logger.warn('shutting down with executions still running', { count: stranded });
        }
      }
      // CANCEL whatever the drain grace did not settle (#120 round-7 F4). The
      // grace above buys the common case — a run seconds from its settle — its
      // receipt; this kills the rest before we tear their workspace out from under
      // them. Without it, `SIGTERM` deleted scratch and `process.exit`'d while a
      // harness child (or a remote sandbox) kept executing loose — an orphaned
      // process spending against a session Atrium had already abandoned. Ordered
      // AFTER the drain (so a settling run is not severed early) and BEFORE the
      // scratch dispose (so nothing is still writing into a directory we delete).
      if (executionRuntime) {
        try {
          await executionRuntime.provider.cancelAll();
        } catch (error) {
          logSafely('cancelling in-flight executions failed', () => ({
            error: describeUnknown(error),
          }));
        }
      }
      // Tears down the SCRATCH working repo only; the DURABLE artifact repo is
      // left intact so settled receipts still resolve after shutdown (#120 F3).
      if (executionRuntime) await executionRuntime.dispose();
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
