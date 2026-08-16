/* ---------------------------------------------------------------------------
 * NO COVENANT ACT FUNCTION IS INVOKED DURING RENDER (#168 B1).
 *
 * THE LANDMINE THIS GUARDS: `ThreadStatus` used to read a door's NAME for a
 * label by CALLING `covenant.steer(...)` / `covenant.interrupt(...)` in render
 * position. That is harmless only while the act body is inert — the moment
 * go-live B2 gives `steer`/`interrupt` a live durable body, EVERY render of the
 * status strip would fire a durable `signal_session`. B1 removes it: the label
 * reads the `DOOR_NAMES` constant, and a covenant ACT function is never called
 * during render.
 *
 * This test spies on EVERY covenant act function and asserts ZERO calls after
 * rendering the status strip and the whole surface (fixture route AND a live
 * mount). It goes RED the instant a render-time invocation is (re)introduced —
 * the exact regression B2 must not ship.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadStatus } from '../app/prototype/ChatChrome';
import { covenant, DOOR_NAMES } from '../app/prototype/covenant';
import { MoldingSurface } from '../app/prototype/MoldingSurface';
import type { StreamState } from '../app/prototype/mock';
import type { Selection } from '../app/prototype/types';
import type { ControlPlaneData } from '../lib/control-plane-data';

/* ── F5 (#168 B2 fix1): the LIVE transports, spied ──────────────────────────
 * The inert-singleton spies below (`spyOnActs`) only cover the honestly-inert
 * `covenant` object. On a real room route the surface builds `makeCovenant`
 * (`LiveCovenant`) bound to the REAL transports — the realtime client's
 * signalSession/correctObject/supersedeObject, the certify Server Actions, and
 * `issueRoomCommand`. A render-time invocation of a LIVE door would call one of
 * THOSE, not the singleton, and the old guard (whose live mount omitted the room
 * context, so `makeCovenant` was never constructed) could not see it. These
 * hoisted mocks make every live transport a spy so a live mount can assert ZERO
 * transport calls after render. `isConnected` returns true, so a render-time
 * `steer`/`interrupt` WOULD reach `signalSession` — the test goes RED on it. */
const liveTransports = vi.hoisted(() => ({
  signalSession: vi.fn(() => 'cmd-signal'),
  correctObject: vi.fn(() => 'cmd-correct'),
  supersedeObject: vi.fn(() => ({ commandId: 'cmd-supersede', clientSupersessionId: 'sup' })),
  isConnected: vi.fn(() => true),
  armCertify: vi.fn(async (_input?: unknown) => ({ ok: true as const, attemptToken: 'tok' })),
  confirmCertify: vi.fn(async (_input?: unknown) => ({ ok: true as const })),
  disarmCertify: vi.fn(async (_input?: unknown) => ({ ok: true as const })),
  issueRoomCommand: vi.fn(async (_command?: unknown) => ({
    ok: true as const,
    issues: [] as string[],
  })),
}));

vi.mock('@/src/lib/realtime', async (importActual) => {
  const actual = await importActual<typeof import('@/src/lib/realtime')>();
  return {
    ...actual,
    // A fake client: the effect's lifecycle verbs are inert, and the three
    // covenant transports plus `isConnected` are the shared spies.
    createRealtimeClient: () => ({
      connect: async () => {},
      close: () => {},
      setPresence: () => {},
      leave: () => {},
      join: () => {},
      signalSession: liveTransports.signalSession,
      correctObject: liveTransports.correctObject,
      supersedeObject: liveTransports.supersedeObject,
      isConnected: liveTransports.isConnected,
    }),
  };
});
vi.mock('@/lib/room-command', () => ({
  issueRoomCommand: (command: unknown) => liveTransports.issueRoomCommand(command),
}));
vi.mock('@/app/app/[workspace]/[room]/control/actions', () => ({
  armSessionCertificationAction: (input: unknown) => liveTransports.armCertify(input),
  certifySessionAction: (input: unknown) => liveTransports.confirmCertify(input),
  disarmSessionCertificationAction: (input: unknown) => liveTransports.disarmCertify(input),
}));

afterEach(() => {
  cleanup();
  for (const spy of Object.values(liveTransports)) spy.mockClear();
  vi.restoreAllMocks();
});

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

/** Every act function on the covenant seam — the ones that MUST NOT be called
    in render position, and whose live bodies B2 will make durable. */
const ACT_NAMES = [
  'certify',
  'certifyClaim',
  'fund',
  'steer',
  'mediateSteer',
  'interrupt',
  'retract',
  'supersede',
  'run',
] as const;

/** Spy on every act function; return the spies so a test can assert 0 calls. */
function spyOnActs() {
  return ACT_NAMES.map((name) => vi.spyOn(covenant, name));
}

/** A minimal live plane so the surface can mount on the "real room" path too.
    `session` overrides let a caller light the covenant bindings: an `open` status
    lights steer/interrupt, a non-null `artifactDigest` lights certify (#168 B2
    fix1, F5). Defaults keep the original settled/no-digest plane. */
function livePlane(
  session: { status?: 'open' | 'settled'; artifactDigest?: string | null } = {},
): ControlPlaneData {
  const now = '2026-08-15T12:00:00.000Z';
  return {
    room: { id: 'r-live-42', name: 'ledger-migration' },
    viewerId: 'u-viewer',
    updatedAt: now,
    decisions: [],
    unseen: [],
    unseenTotal: 0,
    agents: [
      {
        userId: 'a-quill',
        name: 'quill',
        host: 'linux-ci-11',
        harness: 'claude-code',
        model: 'opus-5',
        budgetLimitMicros: 4_000_000,
        plans: [
          {
            id: 'p-migrate',
            agentUserId: 'a-quill',
            title: 'migrate the ledger spine',
            status: 'open',
            budgetLimitMicros: 4_000_000,
            spentMicros: 900_000,
            rlimitSlice: 10,
            authorizedDraws: 4,
            refusedDraws: 0,
            sessions: [
              {
                id: 's-migrate-1',
                planId: 'p-migrate',
                harness: 'claude-code',
                model: 'opus-5',
                status: session.status ?? 'settled',
                contextPct: 0.33,
                progress: null,
                spendMicros: 900_000,
                exitSummary: null,
                artifact: null,
                artifactDigest: session.artifactDigest ?? null,
                certifiedById: null,
                certifyArmedById: null,
                certifiedByName: null,
                certifiedByKind: null,
                certifiedAt: null,
                certifiedHeldMs: null,
                certifyArmedAt: null,
                certifyArmedByName: null,
                certifyArmedByKind: null,
                createdAt: '2026-08-15T11:50:00.000Z',
                updatedAt: now,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('rendering never invokes a covenant act function (#168 B1 landmine)', () => {
  it('ThreadStatus fires ZERO covenant acts and still labels its doors', () => {
    const spies = spyOnActs();
    const { container } = render(<ThreadStatus selected={SELECTED} stream={STREAM} />);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // the labels are still present — read from the DOOR_NAMES constant, not a call.
    const footerHtml = container.querySelector('footer')?.innerHTML ?? '';
    expect(footerHtml).toContain(DOOR_NAMES.steer);
    expect(footerHtml).toContain(DOOR_NAMES.interrupt);
  });

  it('the whole surface (fixture route) fires ZERO covenant acts', () => {
    const spies = spyOnActs();
    render(<MoldingSurface />);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('the whole surface mounted on a LIVE plane fires ZERO covenant acts', () => {
    const spies = spyOnActs();
    render(<MoldingSurface tree={livePlane()} />);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

/** A live room plane whose first session is OPEN and carries an `artifactDigest`,
    so mounting with full room context builds `makeCovenant` AND lights BOTH the
    certify binding (needs a digest) and the steer/interrupt binding (needs a
    running session). A render-time live-door call would hit a spied transport. */
function liveRoomPlane(): ControlPlaneData {
  return livePlane({ status: 'open', artifactDigest: 'digest-abc' });
}

describe('rendering never invokes a LIVE covenant door (#168 B2 fix1, F5)', () => {
  const ROOM = {
    roomId: 'r-live-42',
    viewerId: 'u-viewer',
    workspaceSlug: 'acme',
    roomSlug: 'ledger-migration',
  } as const;

  it('a full-room mount BUILDS makeCovenant yet fires ZERO live transports on render', () => {
    const view = render(<MoldingSurface tree={liveRoomPlane()} {...ROOM} />);
    // open the artifact pane so the live CertifyControl (a live-covenant consumer)
    // is actually rendered — opening is a layout toggle, not a covenant act.
    fireEvent.click(view.getByLabelText('open artifact'));
    // NOT ONE live door left the client / reached a gate during render.
    expect(liveTransports.signalSession).not.toHaveBeenCalled();
    expect(liveTransports.correctObject).not.toHaveBeenCalled();
    expect(liveTransports.supersedeObject).not.toHaveBeenCalled();
    expect(liveTransports.armCertify).not.toHaveBeenCalled();
    expect(liveTransports.confirmCertify).not.toHaveBeenCalled();
    expect(liveTransports.disarmCertify).not.toHaveBeenCalled();
    expect(liveTransports.issueRoomCommand).not.toHaveBeenCalled();
  });
});

describe('DOOR_NAMES is the single source of truth for each act’s door', () => {
  it('each act returns the door its DOOR_NAMES entry names', () => {
    expect(covenant.certify('s').door).toBe(DOOR_NAMES.certify);
    expect(covenant.certifyClaim('o').door).toBe(DOOR_NAMES.certifyClaim);
    expect(covenant.fund('p', 1).door).toBe(DOOR_NAMES.fund);
    expect(covenant.steer('s', '').door).toBe(DOOR_NAMES.steer);
    expect(covenant.interrupt('s', '').door).toBe(DOOR_NAMES.interrupt);
    expect(covenant.retract('o').door).toBe(DOOR_NAMES.retract);
    expect(covenant.supersede('a', 'b').door).toBe(DOOR_NAMES.supersede);
    expect(covenant.run('s').door).toBe(DOOR_NAMES.run);
    expect(covenant.mediateSteer('s', { anchor: 'a', quote: 'q', body: 'b' }).door).toBe(
      DOOR_NAMES.mediateSteer,
    );
  });
});
