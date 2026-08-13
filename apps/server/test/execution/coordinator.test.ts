import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Command, CommandResult } from '../../src/commands.js';
import {
  type ClaimedSession,
  createExecutionCoordinator,
} from '../../src/execution/coordinator.js';
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
    cancelAll: async () => {},
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

/**
 * An in-memory ownership whose `claim` succeeds, returning the stored context a
 * real claim would read off the row (#120 round-6). `ownership` is MANDATORY on
 * the coordinator now (F4), so every construction passes one — the guard can no
 * longer be omitted into silence, only faked. `claimed` overrides the stored
 * context so a test can prove the coordinator uses THIS, not its caller's payload.
 */
function okOwnership(claimed: Partial<ClaimedSession> = {}) {
  const claim = vi.fn(
    async (_input: { sessionId: string; roomId: string }): Promise<ClaimedSession | null> => ({
      planId: claimed.planId ?? randomUUID(),
      harness: claimed.harness ?? 'omp',
      model: claimed.model ?? 'haiku',
      authority: claimed.authority ?? 'test-authority',
    }),
  );
  return { claim };
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
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: okOwnership(),
    });

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
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: okOwnership(),
    });

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
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: okOwnership(),
    });

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

  it('settles FAILED when resolve throws — the session is never left orphaned (#120 F5)', async () => {
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

    // A provider whose `resolve` throws — an unwired sandbox, a colliding ref, a
    // wedged scratch repo. `run` must never be reached.
    let ran = 0;
    const throwingProvider: ExecutionProvider = {
      kind: 'throws-on-resolve',
      resolve: async () => {
        throw new Error('resolve exploded (unwired sandbox)');
      },
      run: async () => {
        ran++;
        return settledReport;
      },
      cancelAll: async () => {},
    };
    const coordinator = createExecutionCoordinator({
      commands,
      provider: throwingProvider,
      logger,
      ownership: okOwnership(),
    });

    const outcome = await coordinator.openAndRun(agent, {
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    // The granted session is SETTLED FAILED with no artifact — not left `open`
    // with a spent draw and no receipt. `run` never happened. The vocabulary is
    // still exactly {open_session, settle_session}. Revert F5 (hoist `resolve`
    // above the try in coordinator.ts) and the throw escapes `openAndRun`: no
    // settle command is issued and this reds.
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.artifact).toBeNull();
    expect(ran).toBe(0);
    expect(commands.calls.map((c) => c.name)).toEqual(['open_session', 'settle_session']);
    const settle = commands.calls[1];
    if (settle?.name === 'settle_session') {
      expect(settle.outcome).toBe('failed');
      expect(settle.artifact).toBeNull();
    }
  });
});

/**
 * ROUND 3, F2 — the settle is inside the failure boundary too.
 *
 * `resolve`/`run` were wrapped; the `settle_session` that WRITES the receipt was
 * not. The `authorized_draws` increment has already committed by then, so a
 * settle fault — a lost membership, a projection refusing a session that is no
 * longer open, a ledger fault — threw out of `runGranted` into the
 * fire-and-forget `.catch` in `wireExecutionCoordinator`, which only logs. The
 * session stayed `open` forever with a SPENT draw and no receipt: billed and
 * wedged, which is precisely the state F5 was written to make unreachable.
 */
describe('a settle fault still drives the session terminal (#120 r3 F2)', () => {
  /** A runner whose first `settle_session` throws and whose second succeeds. */
  function settleThrowsOnce(sessionId: string) {
    const calls: Command[] = [];
    let settles = 0;
    return {
      calls,
      settleAttempts: () => settles,
      execute: vi.fn(async (_session: Session, command: Command): Promise<CommandResult> => {
        calls.push(command);
        if (command.name === 'open_session') {
          return {
            kind: 'appended',
            roomId: command.roomId,
            seq: 1,
            roomSeq: 1,
            actor: { kind: 'agent', userId: agent.userId },
            event: {} as never,
            issues: [],
            draw: { outcome: 'granted', sessionId },
          };
        }
        settles++;
        if (settles === 1) throw new Error('projection fault: session is no longer open');
        return {
          kind: 'appended',
          roomId: command.roomId,
          seq: 2,
          roomSeq: 2,
          actor: { kind: 'agent', userId: agent.userId },
          event: {} as never,
          issues: [],
        };
      }),
    };
  }

  it('does not let a settle throw escape runGranted', async () => {
    const sessionId = randomUUID();
    const commands = settleThrowsOnce(sessionId);
    const coordinator = createExecutionCoordinator({
      commands,
      provider: spyProvider(settledReport),
      logger,
      ownership: okOwnership(),
    });

    // REVERT-REDS: hoist the settle back out of the try in coordinator.ts and
    // this REJECTS instead of resolving — the exact escape that leaves a granted
    // session open with a spent draw.
    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    // A TERMINAL state, reported as failed — never `open`, and never the clean
    // `settled` the run alone would have earned.
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.artifact).toBeNull();

    // And a SECOND settle was actually attempted, spelled `failed` with no
    // artifact — the receipt the session is owed, not merely a swallowed error.
    expect(commands.settleAttempts()).toBe(2);
    // `runGranted` is entered directly, so the calls are the two settles.
    const retry = commands.calls[1];
    expect(retry?.name).toBe('settle_session');
    if (retry?.name === 'settle_session') {
      expect(retry.outcome).toBe('failed');
      expect(retry.artifact).toBeNull();
      expect(retry.exitSummary).toContain('the settle failed');
    }
  });

  it('reports failed — never the run outcome — when BOTH settles throw', async () => {
    const sessionId = randomUUID();
    const calls: Command[] = [];
    const commands = {
      calls,
      execute: vi.fn(async (_session: Session, command: Command): Promise<CommandResult> => {
        calls.push(command);
        throw new Error('ledger unreachable');
      }),
    };
    const coordinator = createExecutionCoordinator({
      commands,
      provider: spyProvider(settledReport),
      logger,
      ownership: okOwnership(),
    });

    // Nothing in-process can write a receipt when the ledger itself is gone. The
    // contract is that `runGranted` still RESOLVES (so the fire-and-forget catch
    // is not left holding the bag) and reports `failed`, leaving the session to
    // startup reconciliation rather than claiming it settled.
    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('failed');
    expect(calls.filter((call) => call.name === 'settle_session')).toHaveLength(2);
  });

  it('treats a non-appended settle as a fault, not as a receipt', async () => {
    const sessionId = randomUUID();
    const calls: Command[] = [];
    const commands = {
      calls,
      // A settle that comes back as something other than `appended` wrote no
      // event. Round 2 logged that and returned the run's own outcome anyway,
      // reporting a session settled on the strength of an append that did not
      // happen.
      execute: vi.fn(async (_session: Session, command: Command): Promise<CommandResult> => {
        calls.push(command);
        return { kind: 'seen', roomId: command.roomId, userId: agent.userId, seenSeq: 0 };
      }),
    };
    const coordinator = createExecutionCoordinator({
      commands,
      provider: spyProvider(settledReport),
      logger,
      ownership: okOwnership(),
    });

    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });
    expect(outcome.kind).toBe('failed');
    expect(calls.filter((call) => call.name === 'settle_session')).toHaveLength(2);
  });
});

describe('runGranted refuses a session without a committed granted draw (#120 r5 F1)', () => {
  it('does NOT resolve, run, or settle when ownership.claim returns false', async () => {
    const sessionId = randomUUID();
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
    });
    const provider = spyProvider(settledReport);
    // The claim finds no granted+open+unclaimed provider session for this id — the
    // "never-granted" (or re-entrant) case the round-4 gauntlet drove through
    // `runGranted` (resolved=1, ran=1). A null claim means the provider is never
    // reached.
    const claim = vi.fn(async (): Promise<ClaimedSession | null> => null);
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: { claim },
    });

    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    // The guard fired BEFORE the provider: nothing resolved, nothing ran, and no
    // settle was attempted for a session Atrium never authorized. Revert the
    // `ownership.claim` guard in `runGranted` and this reds — the provider resolves
    // and runs a fabricated session id.
    expect(claim).toHaveBeenCalledWith({ sessionId, roomId: expect.any(String) });
    expect(outcome).toEqual({ kind: 'failed', sessionId, artifact: null });
    expect(provider.resolved).toBe(0);
    expect(provider.ran).toBe(0);
    expect(commands.calls.filter((c) => c.name === 'settle_session')).toHaveLength(0);
  });

  it('resolves, runs, and settles when ownership.claim returns true', async () => {
    const sessionId = randomUUID();
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
    });
    const provider = spyProvider(settledReport);
    const claim = vi.fn(
      async (): Promise<ClaimedSession | null> => ({
        planId: randomUUID(),
        harness: 'omp',
        model: 'haiku',
        authority: 'test-authority',
      }),
    );
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: { claim },
    });

    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    expect(outcome.kind).toBe('settled');
    expect(provider.resolved).toBe(1);
    expect(provider.ran).toBe(1);
    expect(commands.calls.filter((c) => c.name === 'settle_session')).toHaveLength(1);
  });
});

describe('the run context is the STORED context, not the caller payload (#120 r6 F5)', () => {
  it('resolves/runs with the claim-returned plan/harness/model and its authority', async () => {
    const sessionId = randomUUID();
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
    });
    // The provider records the ctx it was handed.
    const seenCtx: SessionContext[] = [];
    const provider: ExecutionProvider = {
      kind: 'ctx-spy',
      resolve: async (ctx) => {
        seenCtx.push(ctx);
        return {
          sessionId: ctx.sessionId,
          dir: '/tmp/none',
          branch: `atrium/session/${ctx.sessionId}`,
          remote: '/tmp/repo',
          dispose: async () => {},
        };
      },
      run: async () => settledReport,
      cancelAll: async () => {},
    };
    // The STORED context differs from what the caller passes to runGranted — the
    // coordinator must use the stored values, never the caller's.
    const stored = { planId: randomUUID(), harness: 'stored-harness', model: 'stored-model' };
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: okOwnership({ ...stored, authority: 'cap-42' }),
    });

    await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      // Caller-supplied values that MUST be ignored in favour of the stored ones.
      planId: 'caller-plan',
      harness: 'caller-harness',
      model: 'caller-model',
    });

    // REVERT-REDS: build `ctx` from `granted.*` instead of `claimed.*` in
    // coordinator.ts and these three reds — the caller's payload would flow to the
    // provider.
    const seen = seenCtx[0];
    expect(seen).toBeDefined();
    expect(seen?.planId).toBe(stored.planId);
    expect(seen?.harness).toBe('stored-harness');
    expect(seen?.model).toBe('stored-model');

    // And the settle carries the claim's capability token, not the caller's.
    const settle = commands.calls.find((c) => c.name === 'settle_session');
    if (settle?.name === 'settle_session') expect(settle.authority).toBe('cap-42');
  });
});

describe('a malformed provider report never leaves the session open (#120 r6 F7)', () => {
  it('synthesizes a failed receipt when run() returns undefined', async () => {
    const sessionId = randomUUID();
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
    });
    // A provider that resolves a real workspace but returns a GARBAGE report — the
    // interface is TS-only, so nothing stops it at compile time.
    const provider: ExecutionProvider = {
      kind: 'bad-report',
      resolve: async (ctx) => ({
        sessionId: ctx.sessionId,
        dir: '/tmp/none',
        branch: `atrium/session/${ctx.sessionId}`,
        remote: '/tmp/repo',
        dispose: async () => {},
      }),
      // Malformed: not an ExecutionReport at all.
      run: async () => undefined as never,
      cancelAll: async () => {},
    };
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: okOwnership(),
    });

    // REVERT-REDS: drop the `ReportSchema.parse(...)` inside the try in
    // coordinator.ts and reading `report.terminal.ok` throws OUTSIDE the boundary,
    // escaping runGranted with NO settle — the session is left open. With the parse,
    // the malformed report is caught and the session is driven to a failed receipt.
    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.artifact).toBeNull();
    const settle = commands.calls.find((c) => c.name === 'settle_session');
    expect(settle?.name).toBe('settle_session');
    if (settle?.name === 'settle_session') expect(settle.outcome).toBe('failed');
  });

  it('rejects an OUT-OF-RANGE report at parse and still reaches a failed receipt (#120 r7 F2)', async () => {
    const sessionId = randomUUID();
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
    });
    // A provider whose report is well-SHAPED but OUT OF BOUNDS: contextPct above 1,
    // a negative spend. Round 6's schema bounded nothing, so this PARSED; the
    // primary settle then rejected it at the durable `SettleReceiptBounds`, and the
    // fallback failed-settle REUSED the same invalid values and rejected too — the
    // session left open with no receipt. Round 7 bounds the report at parse.
    const provider: ExecutionProvider = {
      kind: 'out-of-range',
      resolve: async (ctx) => ({
        sessionId: ctx.sessionId,
        dir: '/tmp/none',
        branch: `atrium/session/${ctx.sessionId}`,
        remote: '/tmp/repo',
        dispose: async () => {},
      }),
      run: async () => ({
        terminal: { ok: true, exitCode: 0 },
        receipt: {
          exitSummary: 'claims a clean exit',
          spendMicros: -1,
          contextPct: 2,
          artifact: null,
        },
      }),
      cancelAll: async () => {},
    };
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: okOwnership(),
    });

    // REVERT-REDS: drop the bounds from `ReportSchema` (contextPct min/max,
    // spendMicros nonnegative int) and this report parses; the settle path rejects
    // it at the durable boundary and, absent the safe-value fallback, never lands a
    // receipt — the session stays open. With the fix the garbage is caught at parse
    // and a failed terminal is synthesized and settled.
    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    expect(outcome.kind).toBe('failed');
    const settle = commands.calls.find((c) => c.name === 'settle_session');
    expect(settle?.name).toBe('settle_session');
    if (settle?.name === 'settle_session') {
      expect(settle.outcome).toBe('failed');
      // The settle carries SAFE values, never the report's out-of-range ones, so
      // the durable bounds accept it.
      expect(settle.spendMicros === null || settle.spendMicros >= 0).toBe(true);
      expect(settle.contextPct === null || settle.contextPct <= 1).toBe(true);
    }
  });
});

describe('a claim throw is inside the failure boundary (#120 r7 F3, red-on-revert)', () => {
  it('returns failed — never throws — when ownership.claim throws, so the session is reconcilable', async () => {
    const sessionId = randomUUID();
    const commands = fakeCommands({
      kind: 'appended',
      roomId: 'r',
      seq: 1,
      roomSeq: 1,
      actor: { kind: 'agent', userId: agent.userId },
      event: {} as never,
      issues: [],
    });
    // The provider must NEVER be reached — a claim that throws resolved no lease, so
    // there is nothing to run.
    const provider = spyProvider(settledReport);
    // A claim that THROWS (a deadlock, a connection blip) rather than returning null.
    const claim = vi.fn(async (): Promise<never> => {
      throw new Error('deadlock detected');
    });
    const coordinator = createExecutionCoordinator({
      commands,
      provider,
      logger,
      ownership: { claim },
    });

    // REVERT-REDS: remove the try/catch around `ownership.claim` in `runGranted` and
    // the throw escapes into the fire-and-forget `.catch`, wedging the leased-at-
    // grant session open-and-heartbeated. With the fix it returns `{failed}` and the
    // provider is never touched, so the grant-stamped lease ages out and
    // reconciliation repairs it.
    const outcome = await coordinator.runGranted(agent, {
      sessionId,
      roomId: randomUUID(),
      planId: randomUUID(),
      harness: 'omp',
      model: 'haiku',
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.artifact).toBeNull();
    // Nothing was resolved, run, or settled — the claim faulted before any of it.
    expect(provider.resolved).toBe(0);
    expect(provider.ran).toBe(0);
    expect(commands.calls.find((c) => c.name === 'settle_session')).toBeUndefined();
  });
});
