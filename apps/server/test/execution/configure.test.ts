import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, CommandResult, CommandService } from '../../src/commands.js';
import type { Env } from '../../src/env.js';
import { configureExecution, parseArgv } from '../../src/execution/configure.js';
import type { ExecutionOwnership } from '../../src/execution/coordinator.js';
import { createLogger } from '../../src/logger.js';
import type { Session } from '../../src/session.js';

/**
 * A fake ownership for the composer tests (#120 round-6). These fixtures pass a
 * fake command service and hold no DB, so they inject the claim directly — the
 * guard is MANDATORY (F4), it just cannot be a real one here. `claim` always
 * succeeds, returning stored context, so the fire-and-forget run proceeds.
 */
const fakeOwnership: ExecutionOwnership = {
  claim: async () => ({
    planId: randomUUID(),
    harness: 'omp',
    model: 'haiku',
    authority: 'test-authority',
  }),
};

/**
 * The live-server wiring (`index.ts`'s path): a granted `session_opened` fires
 * the coordinator through the command-service wrapper; a refused draw does not;
 * an unset provider disables the whole thing.
 */

const logger = createLogger('error');
const agent: Session = { userId: randomUUID(), principalKind: 'agent' };
let scratch: string;

/**
 * A base command service whose `open_session` draw is scripted, and whose
 * `settle_session` resolves a deferred so the test can await the fire-and-forget
 * coordinator run.
 */
function baseService(draw: NonNullable<Extract<CommandResult, { kind: 'appended' }>['draw']>) {
  const settled: Command[] = [];
  let onSettle: (() => void) | null = null;
  const settlePromise = new Promise<void>((resolve) => {
    onSettle = resolve;
  });
  const service: CommandService = {
    execute: vi.fn(async (_s: Session, command: Command): Promise<CommandResult> => {
      if (command.name === 'settle_session') {
        settled.push(command);
        onSettle?.();
      }
      return {
        kind: 'appended',
        roomId: command.roomId,
        seq: 1,
        roomSeq: 1,
        actor: { kind: 'agent', userId: agent.userId },
        event: {} as never,
        issues: [],
        ...(command.name === 'open_session' ? { draw } : {}),
      };
    }),
    requireMembership: vi.fn(async () => ({ seenSeq: 0 })),
    stillMembers: vi.fn(async () => new Set<string>()),
  };
  return { service, settled, settlePromise };
}

function env(overrides: Partial<Env>): Env {
  return { EXECUTION_PROVIDER: 'shim', EXECUTION_SCRATCH_DIR: scratch, ...overrides } as Env;
}

const openSession: Command = {
  name: 'open_session',
  roomId: randomUUID(),
  planId: randomUUID(),
  harness: 'omp',
  model: 'haiku',
  // #128: an in-process caller states the routing receipt rather than leaning on
  // the schema default, because this object never goes through `Command.parse`.
  causeMessageId: null,
};

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'atrium-configure-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('configureExecution wires the provider to the session lifecycle', () => {
  it('returns null (execution disabled) when EXECUTION_PROVIDER is unset', async () => {
    const { service } = baseService({ outcome: 'granted', sessionId: randomUUID() });
    const configured = await configureExecution({
      env: env({ EXECUTION_PROVIDER: undefined }),
      commands: service,
      logger,
    });
    expect(configured).toBeNull();
  });

  it('fires the coordinator on a granted session_opened', async () => {
    const sessionId = randomUUID();
    const { service, settled, settlePromise } = baseService({ outcome: 'granted', sessionId });
    const configured = await configureExecution({
      env: env({}),
      commands: service,
      logger,
      ownership: fakeOwnership,
    });
    expect(configured).not.toBeNull();

    await configured?.commands.execute(agent, openSession);
    // The run is fire-and-forget; wait for the settle it produces.
    await settlePromise;

    expect(settled).toHaveLength(1);
    const settle = settled[0];
    if (settle?.name === 'settle_session') {
      expect(settle.sessionId).toBe(sessionId);
      expect(settle.outcome).toBe('settled');
      expect(settle.artifact?.branch).toBe(`atrium/session/${sessionId}`);
    }
    await configured?.dispose();
  });

  it('does NOT fire the coordinator on a refused draw (#118)', async () => {
    const { service, settled } = baseService({
      outcome: 'refused',
      reason: 'budget',
      slice: 0,
      authorizedDraws: 0,
    });
    const configured = await configureExecution({
      env: env({}),
      commands: service,
      logger,
      ownership: fakeOwnership,
    });

    await configured?.commands.execute(agent, openSession);
    // Give any (erroneous) fire-and-forget run a chance to happen, then assert
    // it did not: a refused draw never settles anything.
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toHaveLength(0);
    await configured?.dispose();
  });
});

describe('parseArgv refuses everything that is not a non-empty string array', () => {
  it('parses a JSON string array', () => {
    expect(parseArgv('["bash","-lc","npm test"]')).toEqual(['bash', '-lc', 'npm test']);
  });
  it('rejects a non-array, an empty array, and non-strings', () => {
    expect(() => parseArgv('"npm test"')).toThrow();
    expect(() => parseArgv('[]')).toThrow();
    expect(() => parseArgv('[1,2]')).toThrow();
    expect(() => parseArgv('not json')).toThrow();
  });
});
