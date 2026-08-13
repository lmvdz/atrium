import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Command, CommandResult } from '../../src/commands.js';
import { createExecutionCoordinator } from '../../src/execution/coordinator.js';
import type {
  ExecutionProvider,
  ExecutionReport,
  SessionContext,
  Workspace,
} from '../../src/execution/provider.js';
import type { Session } from '../../src/session.js';

/**
 * The coordinator's two guards, with no git and no database — the budget refusal
 * and the covenant vocabulary, isolated so the revert that breaks each is one
 * line and the red is immediate.
 */

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const agent: Session = { userId: randomUUID(), principalKind: 'agent' };

/** A command runner that scripts the `open_session` draw and records every call. */
function fakeCommands(openResult: CommandResult) {
  const calls: Command[] = [];
  return {
    calls,
    execute: vi.fn(async (_session: Session, command: Command): Promise<CommandResult> => {
      calls.push(command);
      if (command.name === 'open_session') return openResult;
      // settle_session (or anything else) acks as an appended lifecycle event.
      return {
        kind: 'appended',
        roomId: command.roomId,
        seq: 1,
        roomSeq: 1,
        actor: { kind: 'agent', userId: agent.userId },
        event: {} as never,
        issues: [],
      };
    }),
  };
}

/** A provider that records whether it was resolved/run, and returns a fixed report. */
function spyProvider(report: ExecutionReport): ExecutionProvider & {
  resolved: number;
  ran: number;
  disposed: number;
} {
  const state = { resolved: 0, ran: 0, disposed: 0 };
  const workspace: Workspace = {
    sessionId: 'ws',
    dir: '/tmp/none',
    branch: 'atrium/session/ws',
    remote: '/tmp/repo',
    dispose: async () => {
      state.disposed++;
    },
  };
  return {
    kind: 'spy',
    resolve: async (_ctx: SessionContext) => {
      state.resolved++;
      return workspace;
    },
    run: async () => {
      state.ran++;
      return report;
    },
    get resolved() {
      return state.resolved;
    },
    get ran() {
      return state.ran;
    },
    get disposed() {
      return state.disposed;
    },
  };
}

const settledReport: ExecutionReport = {
  terminal: { ok: true, exitCode: 0 },
  receipt: {
    exitSummary: 'ok',
    spendMicros: 0,
    contextPct: null,
    artifact: { branch: 'atrium/session/ws', commit: 'abc123', remote: '/tmp/repo' },
  },
};

describe('the coordinator enforces the budget guard (#118)', () => {
  it('NEVER resolves a workspace when the draw is refused', async () => {
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
      draw: { outcome: 'refused', reason: 'budget', slice: 3, authorizedDraws: 3 },
    });
    const provider = spyProvider(settledReport);
    const coordinator = createExecutionCoordinator({ commands, provider, logger });

    const outcome = await coordinator.openAndRun(agent, {
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    // The refusal is surfaced, the provider is untouched, and NO settle command
    // was issued — the draw did not happen, so neither did the execution. Revert
    // the `draw.outcome !== 'granted'` guard in coordinator.ts and this reds: the
    // provider resolves a workspace for a draw the budget refused.
    expect(outcome).toEqual({ kind: 'refused', reason: 'budget', slice: 3, authorizedDraws: 3 });
    expect(provider.resolved).toBe(0);
    expect(provider.ran).toBe(0);
    expect(commands.calls.map((c) => c.name)).toEqual(['open_session']);
  });

  it('resolves, runs, and settles on a granted draw', async () => {
    const sessionId = randomUUID();
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
      draw: { outcome: 'granted', sessionId },
    });
    const provider = spyProvider(settledReport);
    const coordinator = createExecutionCoordinator({ commands, provider, logger });

    const outcome = await coordinator.openAndRun(agent, {
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    expect(outcome.kind).toBe('settled');
    expect(provider.resolved).toBe(1);
    expect(provider.ran).toBe(1);
    expect(provider.disposed).toBe(1);
    // The vocabulary is exactly {open_session, settle_session} — nothing that
    // certifies. The covenant, structurally: there is no verb here that flips a
    // `~` to a `✓`.
    expect(commands.calls.map((c) => c.name)).toEqual(['open_session', 'settle_session']);
    const settle = commands.calls[1];
    expect(settle?.name).toBe('settle_session');
    if (settle?.name === 'settle_session') {
      expect(settle.outcome).toBe('settled');
      expect(settle.artifact).toEqual(settledReport.receipt.artifact);
    }
  });

  it('settles FAILED when the terminal is not clean', async () => {
    const sessionId = randomUUID();
    const failReport: ExecutionReport = {
      terminal: { ok: false, exitCode: 1, detail: 'boom' },
      receipt: { exitSummary: 'died', spendMicros: null, contextPct: null, artifact: null },
    };
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
      draw: { outcome: 'granted', sessionId },
    });
    const provider = spyProvider(failReport);
    const coordinator = createExecutionCoordinator({ commands, provider, logger });

    const outcome = await coordinator.openAndRun(agent, {
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    expect(outcome.kind).toBe('failed');
    const settle = commands.calls[1];
    if (settle?.name === 'settle_session') {
      expect(settle.outcome).toBe('failed');
      expect(settle.artifact).toBeNull();
    }
  });
});
