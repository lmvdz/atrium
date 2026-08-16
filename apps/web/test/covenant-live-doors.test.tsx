/* ---------------------------------------------------------------------------
 * GO-LIVE B2 (#168) — EACH LIVE COVENANT DOOR EMITS ITS EXACT GATED COMMAND ON A
 * HUMAN GESTURE, AND NOTHING ON RENDER.
 *
 * `makeCovenant` binds every door to its real transport. These are the
 * flip-the-input assertions: call a door and the CORRECT durable command leaves
 * the CORRECT transport with the CORRECT arguments; the reserved human-only gates
 * (certify, fund) report `reached:true` ONLY on the server's awaited `ok` and a
 * refusal is surfaced, never swallowed; a door fired with no live client sends
 * nothing; and rendering the live surface fires no door at all.
 *
 * The server reducer is what actually holds the covenant — `apps/server`'s
 * `certificationClassOf` refuses a non-human at BOTH the `certifies` (certify) and
 * `authorizes-spend` (fund) doors before any append (`commands.ts` ~:1767). That
 * refusal is asserted at the seam here as a `reached:false` carrying the server's
 * sentence, and end-to-end in `apps/server`/`packages/core` (see the report). This
 * file proves the CLIENT never fakes success and always reaches the gate.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPane } from '../app/prototype/ArtifactPane';
import { ThreadStatus } from '../app/prototype/ChatChrome';
import {
  type CovenantDeps,
  type CovenantOutcome,
  DOOR_NAMES,
  type LiveCovenant,
  makeCovenant,
} from '../app/prototype/covenant';
import type { StreamState } from '../app/prototype/mock';
import type { Artifact, Selection } from '../app/prototype/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A fake realtime client — only the three verbs the covenant doors call, each a
    spy returning a stable command id so `dispatched`/`commandId` can be asserted. */
function fakeClient() {
  return {
    signalSession: vi.fn(() => 'cmd-signal'),
    correctObject: vi.fn(() => 'cmd-correct'),
    supersedeObject: vi.fn(() => ({ commandId: 'cmd-supersede', clientSupersessionId: 'sup-1' })),
  };
}

/** Fully-injected deps: a live client plus fake reserved-gate transports. Each
    override lets a test flip one transport's answer (ok/refusal). */
function deps(over: Partial<CovenantDeps> = {}): CovenantDeps {
  return {
    roomId: 'room-1',
    workspaceSlug: 'acme',
    roomSlug: 'ledger',
    client: () => fakeClient(),
    armCertify: vi.fn(async () => ({ ok: true as const, attemptToken: 'tok-1' })),
    confirmCertify: vi.fn(async () => ({ ok: true as const })),
    disarmCertify: vi.fn(async () => ({ ok: true as const })),
    issueRoomCommand: vi.fn(async () => ({ ok: true as const, issues: [] })),
    ...over,
  };
}

describe('the journaled realtime doors emit the exact durable command', () => {
  it('steer → signalSession(room, session, "steer", {body})', () => {
    const client = fakeClient();
    const covenant = makeCovenant(deps({ client: () => client }));
    const outcome = covenant.steer('sess-1', 'keep it in billing');
    expect(client.signalSession).toHaveBeenCalledWith('room-1', 'sess-1', 'steer', {
      body: 'keep it in billing',
    });
    expect(outcome).toMatchObject({
      door: DOOR_NAMES.steer,
      dispatched: true,
      commandId: 'cmd-signal',
    });
  });

  it('interrupt → signalSession(room, session, "interrupt", {body})', () => {
    const client = fakeClient();
    const covenant = makeCovenant(deps({ client: () => client }));
    covenant.interrupt('sess-1', 'stop — off scope');
    expect(client.signalSession).toHaveBeenCalledWith('room-1', 'sess-1', 'interrupt', {
      body: 'stop — off scope',
    });
  });

  it('retract → correctObject(room, object, "retract")', () => {
    const client = fakeClient();
    const covenant = makeCovenant(deps({ client: () => client }));
    const outcome = covenant.retract('obj-9');
    expect(client.correctObject).toHaveBeenCalledWith('room-1', 'obj-9', 'retract');
    expect(outcome).toMatchObject({ door: DOOR_NAMES.retract, dispatched: true });
  });

  it('supersede → supersedeObject(room, replacement, retired)', () => {
    const client = fakeClient();
    const covenant = makeCovenant(deps({ client: () => client }));
    const outcome = covenant.supersede('retired-1', 'replacement-2');
    // NOTE the argument order: replacement BEFORE retired, matching the client.
    expect(client.supersedeObject).toHaveBeenCalledWith('room-1', 'replacement-2', 'retired-1');
    expect(outcome).toMatchObject({ door: DOOR_NAMES.supersede, commandId: 'cmd-supersede' });
  });

  it('certifyClaim → correctObject(room, object, "amend", {verification:"verified"})', () => {
    const client = fakeClient();
    const covenant = makeCovenant(deps({ client: () => client }));
    covenant.certifyClaim('claim-3');
    expect(client.correctObject).toHaveBeenCalledWith('room-1', 'claim-3', 'amend', {
      patch: { verification: 'verified' },
    });
  });

  it('is honestly inert when no live client is connected — nothing is sent', () => {
    const covenant = makeCovenant(deps({ client: () => null }));
    const outcome = covenant.steer('sess-1', 'hi');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.commandId).toBeNull();
    expect(outcome.inert).toContain('not connected');
  });
});

describe('the RESERVED human-only gates report reached ONLY on the server ok', () => {
  it('fund → issueRoomCommand(set_plan_rlimit) and reached=true on ok', async () => {
    const issueRoomCommand = vi.fn(async () => ({ ok: true as const, issues: [] }));
    const covenant = makeCovenant(deps({ issueRoomCommand }));
    const outcome = await covenant.fund('plan-7', 5);
    expect(issueRoomCommand).toHaveBeenCalledWith({
      name: 'set_plan_rlimit',
      roomId: 'room-1',
      planId: 'plan-7',
      slice: 5,
    });
    expect(outcome).toEqual({ door: DOOR_NAMES.fund, reached: true });
  });

  it('fund surfaces a server REFUSAL as reached=false with the server sentence', async () => {
    const issueRoomCommand = vi.fn(async () => ({
      ok: false as const,
      code: 'invalid',
      message: 'a plan’s budget is set by a person (human = init)',
    }));
    const covenant = makeCovenant(deps({ issueRoomCommand }));
    const outcome = await covenant.fund('plan-7', 5);
    expect(outcome.reached).toBe(false);
    expect(outcome.refusal).toContain('human = init');
  });

  it('certify arm→confirm threads the server attemptToken and reaches on ok', async () => {
    const armCertify = vi.fn(async () => ({ ok: true as const, attemptToken: 'tok-42' }));
    const confirmCertify = vi.fn(async () => ({ ok: true as const }));
    const covenant = makeCovenant(deps({ armCertify, confirmCertify }));
    covenant.certifyArm('sess-9', 'digest-abc');
    const outcome = await covenant.certifyConfirm('sess-9');
    expect(armCertify).toHaveBeenCalledWith({
      sessionId: 'sess-9',
      workspaceSlug: 'acme',
      roomSlug: 'ledger',
      reviewedDigest: 'digest-abc',
    });
    // the confirm carries the EXACT token the arm minted — not a client value.
    expect(confirmCertify).toHaveBeenCalledWith({
      sessionId: 'sess-9',
      workspaceSlug: 'acme',
      roomSlug: 'ledger',
      attemptToken: 'tok-42',
    });
    expect(outcome).toEqual({ door: DOOR_NAMES.certify, reached: true });
  });

  it('certify with NO reviewed digest arms nothing and never certifies', async () => {
    const armCertify = vi.fn(async () => ({ ok: true as const, attemptToken: 't' }));
    const confirmCertify = vi.fn(async () => ({ ok: true as const }));
    const covenant = makeCovenant(deps({ armCertify, confirmCertify }));
    covenant.certifyArm('sess-9', ''); // no reading to bind a signature to
    const outcome = await covenant.certifyConfirm('sess-9');
    expect(armCertify).not.toHaveBeenCalled();
    expect(confirmCertify).not.toHaveBeenCalled();
    expect(outcome).toEqual({ door: DOOR_NAMES.certify, reached: false, refusal: 'not_armed' });
  });

  it('certify surfaces a server REFUSAL (e.g. not_human) as reached=false', async () => {
    const confirmCertify = vi.fn(async () => ({
      ok: false as const,
      reason: 'not_human' as const,
    }));
    const covenant = makeCovenant(deps({ confirmCertify }));
    covenant.certifyArm('sess-9', 'digest-abc');
    const outcome = await covenant.certifyConfirm('sess-9');
    expect(outcome).toEqual({
      door: DOOR_NAMES.certify,
      reached: false,
      refusal: 'not_human',
    });
  });

  it('certify DISARM cancels the exact attempt the arm minted', async () => {
    const armCertify = vi.fn(async () => ({ ok: true as const, attemptToken: 'tok-x' }));
    const disarmCertify = vi.fn(async () => ({ ok: true as const }));
    const covenant = makeCovenant(deps({ armCertify, disarmCertify }));
    covenant.certifyArm('sess-9', 'digest-abc');
    covenant.certifyDisarm('sess-9');
    await Promise.resolve();
    await Promise.resolve();
    expect(disarmCertify).toHaveBeenCalledWith({ sessionId: 'sess-9', attemptToken: 'tok-x' });
  });
});

describe('the not-yet-representable doors stay honestly inert', () => {
  it('mediateSteer sends nothing (both wire gaps still open) and names its door', () => {
    const client = fakeClient();
    const covenant = makeCovenant(deps({ client: () => client }));
    const outcome = covenant.mediateSteer('sess-1', { anchor: 'a', quote: 'q', body: 'b' });
    expect(client.signalSession).not.toHaveBeenCalled();
    expect(outcome.reached).toBe(false);
    expect(outcome.door).toBe(DOOR_NAMES.mediateSteer);
  });

  it('run sends nothing (no client verb, no gesture) and names its door', () => {
    const client = fakeClient();
    const covenant = makeCovenant(deps({ client: () => client }));
    const outcome = covenant.run('sess-1');
    expect(outcome.reached).toBe(false);
    expect(outcome.door).toBe(DOOR_NAMES.run);
  });
});

/* ── the GESTURE half: a human click on the surface fires the door, render does not ── */

const STREAM: StreamState = {
  phase: 'planning',
  lines: [],
  added: 3,
  removed: 1,
  files: 1,
  elapsedMs: 0,
  spendMicros: 0,
  concern: null,
};
const SELECTED: Selection = { kind: 'session', id: 's-live' };

/** A spied live covenant so a gesture test can assert which door fired. */
function spyCovenant(): LiveCovenant {
  return {
    certifyArm: vi.fn(),
    certifyConfirm: vi.fn(async () => ({ door: DOOR_NAMES.certify, reached: true })),
    certifyDisarm: vi.fn(),
    fund: vi.fn(async () => ({ door: DOOR_NAMES.fund, reached: true })),
    certifyClaim: vi.fn(() => ({
      door: DOOR_NAMES.certifyClaim,
      dispatched: true,
      commandId: 'c',
    })),
    steer: vi.fn(() => ({ door: DOOR_NAMES.steer, dispatched: true, commandId: 'cmd-steer' })),
    interrupt: vi.fn(() => ({
      door: DOOR_NAMES.interrupt,
      dispatched: true,
      commandId: 'cmd-int',
    })),
    retract: vi.fn(() => ({ door: DOOR_NAMES.retract, dispatched: true, commandId: 'c' })),
    supersede: vi.fn(() => ({ door: DOOR_NAMES.supersede, dispatched: true, commandId: 'c' })),
    mediateSteer: vi.fn(
      (): CovenantOutcome => ({ door: DOOR_NAMES.mediateSteer, reached: false, inert: 'x' }),
    ),
    run: vi.fn((): CovenantOutcome => ({ door: DOOR_NAMES.run, reached: false, inert: 'x' })),
  };
}

describe('ThreadStatus steer/interrupt: a human gesture fires the gated door', () => {
  it('rendering fires NO door; clicking steer + submitting fires covenant.steer', () => {
    const covenant = spyCovenant();
    render(
      <ThreadStatus
        selected={SELECTED}
        stream={STREAM}
        signal={{ covenant, sessionId: 's-open-1', running: true, viewerId: 'u-1' }}
      />,
    );
    // render fired nothing
    expect(covenant.steer).not.toHaveBeenCalled();
    expect(covenant.interrupt).not.toHaveBeenCalled();

    // open the composer, type, submit — THE human gesture
    fireEvent.click(screen.getByRole('button', { name: 'steer this session' }));
    const input = screen.getByLabelText('steer message');
    fireEvent.change(input, { target: { value: 'keep it in billing' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(covenant.steer).toHaveBeenCalledWith('s-open-1', 'keep it in billing');
    expect(covenant.interrupt).not.toHaveBeenCalled();
  });

  it('clicking interrupt + submitting fires covenant.interrupt', () => {
    const covenant = spyCovenant();
    render(
      <ThreadStatus
        selected={SELECTED}
        stream={STREAM}
        signal={{ covenant, sessionId: 's-open-1', running: true, viewerId: 'u-1' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'interrupt this session' }));
    const input = screen.getByLabelText('interrupt reason');
    fireEvent.change(input, { target: { value: 'off scope' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(covenant.interrupt).toHaveBeenCalledWith('s-open-1', 'off scope');
  });

  it('a settled session leaves steer/interrupt DISABLED — a click cannot fire', () => {
    const covenant = spyCovenant();
    render(
      <ThreadStatus
        selected={SELECTED}
        stream={STREAM}
        signal={{ covenant, sessionId: 's-settled', running: false, viewerId: 'u-1' }}
      />,
    );
    const steer = screen.getByRole('button', {
      name: 'steer (awaiting the live session)',
    }) as HTMLButtonElement;
    expect(steer.disabled).toBe(true);
    fireEvent.click(steer);
    expect(covenant.steer).not.toHaveBeenCalled();
  });

  it('the fixture route (no signal binding) keeps steer/interrupt disabled', () => {
    render(<ThreadStatus selected={SELECTED} stream={STREAM} />);
    expect(
      (
        screen.getByRole('button', {
          name: 'steer (awaiting the live session)',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'interrupt (awaiting the live session)',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe('ArtifactPane certify: a live binding offers the hold, render fires nothing', () => {
  const landing: Artifact = {
    id: 'sess-1',
    kind: 'diff',
    title: 'feat/x',
    sub: 'PR',
    certified: false,
    sessionDiff: { fileCount: 0, additions: 0, deletions: 0, truncated: false, files: [] },
  };

  it('renders the Certify hold when bound + uncertified, and fires no door on render', () => {
    const covenant = spyCovenant();
    render(
      <ArtifactPane
        artifacts={[landing]}
        activeId="sess-1"
        onSelectArtifact={() => {}}
        comments={[]}
        onComment={() => {}}
        onDraft={() => {}}
        certify={{ covenant, sessionId: 'sess-1', artifactDigest: 'digest-abc', viewerId: 'u-1' }}
      />,
    );
    expect(screen.getByRole('button', { name: /certify this session/i })).toBeTruthy();
    // render must not arm/confirm anything
    expect(covenant.certifyArm).not.toHaveBeenCalled();
    expect(covenant.certifyConfirm).not.toHaveBeenCalled();
  });

  it('an already-certified landing shows no certify control (nothing to sign)', () => {
    const covenant = spyCovenant();
    render(
      <ArtifactPane
        artifacts={[{ ...landing, certified: true }]}
        activeId="sess-1"
        onSelectArtifact={() => {}}
        comments={[]}
        onComment={() => {}}
        onDraft={() => {}}
        certify={{ covenant, sessionId: 'sess-1', artifactDigest: 'digest-abc', viewerId: 'u-1' }}
      />,
    );
    expect(screen.queryByRole('button', { name: /certify this session/i })).toBeNull();
  });

  it('the fixture route (no certify binding) shows the inert "awaiting a human" hint', () => {
    render(
      <ArtifactPane
        artifacts={[landing]}
        activeId="sess-1"
        onSelectArtifact={() => {}}
        comments={[]}
        onComment={() => {}}
        onDraft={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /certify this session/i })).toBeNull();
    expect(screen.getByText('awaiting a human')).toBeTruthy();
  });
});
