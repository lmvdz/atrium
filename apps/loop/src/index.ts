#!/usr/bin/env node
import { loadConfig } from './config.js';
import { LoopDaemon } from './daemon.js';

/**
 * The reference channel-loop daemon process (#148).
 *
 * It provisions nothing and funds nothing — those are human acts (the run-book).
 * It authenticates as the agent, consumes its channel, conducts one turn per
 * inbound message, and keeps a durable journal. Ctrl-C or SIGTERM stops it
 * cleanly; on next start it re-reads from the journal cursor.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  const daemon = new LoopDaemon(config);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.info(`loop received ${signal}, stopping`);
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  await daemon.start();

  // A halt mid-turn (a crash the journal is designed to survive) exits non-zero
  // so a supervisor restarts the process, which re-reads from the cursor.
  await daemon.whenHalted;
  if (!stopping) {
    console.error('loop halted mid-turn; exiting for restart');
    await daemon.stop();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('loop failed to start', error);
  process.exit(1);
});
