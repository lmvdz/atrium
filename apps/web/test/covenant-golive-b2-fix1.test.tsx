/* ---------------------------------------------------------------------------
 * GO-LIVE B2 FIX1 (#168) — THE THREE UI-LEVEL COVENANT HONESTY HOLES A BLIND
 * DUAL-LINEAGE GAUNTLET FOUND, PINNED SO THEY STAY CLOSED.
 *
 *  F1 (CRITICAL) — a journaled door must not paint "sent to the room" for a frame
 *      that never left the socket. When `covenant.steer/interrupt` reports
 *      `dispatched:false` (the socket was not OPEN, so `RealtimeClient.send`
 *      dropped the frame), the status strip's note says "not sent", NEVER "sent".
 *
 *  F2 (CRITICAL) — the certify control's transient "certified" result must not
 *      migrate across sessions. Certifying session A then selecting an uncertified
 *      session B must NOT leave "certified" on B, and an A-confirm that resolves
 *      AFTER the switch must not paint success on B.
 *
 *  F3 (LOW) — on a LIVE mount an anchored comment is a local-only draft (the
 *      durable comment write is not wired), so its feed echo must not claim it was
 *      authored on the room register; the `/prototype` fixture route is unchanged.
 * ------------------------------------------------------------------------- */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CERTIFY_HOLD_MS } from '@/lib/certify-hold';
import { ArtifactPane } from '../app/prototype/ArtifactPane';
import { ThreadStatus } from '../app/prototype/ChatChrome';
import { commentEcho } from '../app/prototype/conversation-model';
import { DOOR_NAMES, type LiveCovenant } from '../app/prototype/covenant';
import { MoldingSurface } from '../app/prototype/MoldingSurface';
import type { StreamState } from '../app/prototype/mock';
import type { Artifact, Selection } from '../app/prototype/types';
import type { ControlPlaneData, SessionArtifact } from '../lib/control-plane-data';

afterEach(() => {
  cleanup();
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

/* ═══ F1 — the status strip tells the truth about a dropped frame ═══════════ */

/** A live covenant whose steer/interrupt report a given `dispatched`. Everything
    else is a benign spy; only the dispatch answer is under test here. */
function signalCovenant(dispatched: boolean): LiveCovenant {
  const drop = {
    dispatched,
    commandId: dispatched ? 'cmd-7' : null,
    inert: dispatched
      ? undefined
      : 'the live realtime client is not connected yet, so nothing was sent — the durable command was not dispatched',
  };
  return {
    certifyArm: vi.fn(),
    certifyConfirm: vi.fn(async () => ({ door: DOOR_NAMES.certify, reached: true })),
    certifyDisarm: vi.fn(),
    fund: vi.fn(async () => ({ door: DOOR_NAMES.fund, reached: true })),
    certifyClaim: vi.fn(() => ({ door: DOOR_NAMES.certifyClaim, ...drop })),
    steer: vi.fn(() => ({ door: DOOR_NAMES.steer, ...drop })),
    interrupt: vi.fn(() => ({ door: DOOR_NAMES.interrupt, ...drop })),
    retract: vi.fn(() => ({ door: DOOR_NAMES.retract, ...drop })),
    supersede: vi.fn(() => ({ door: DOOR_NAMES.supersede, ...drop })),
    mediateSteer: vi.fn(() => ({
      door: DOOR_NAMES.mediateSteer,
      reached: false as const,
      inert: 'x',
    })),
    run: vi.fn(() => ({ door: DOOR_NAMES.run, reached: false as const, inert: 'x' })),
  };
}

describe('F1 — a dropped frame is reported "not sent", never "sent to the room"', () => {
  function steerWith(covenant: LiveCovenant) {
    render(
      <ThreadStatus
        selected={SELECTED}
        stream={STREAM}
        signal={{ covenant, sessionId: 's-open-1', running: true, viewerId: 'u-1' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'steer this session' }));
    const input = screen.getByLabelText('steer message');
    fireEvent.change(input, { target: { value: 'stop — off scope' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
  }

  it('dispatched:false (socket not OPEN) → the note says "not sent", not "sent to the room"', () => {
    steerWith(signalCovenant(false));
    const note = screen.getByTitle(/steer not sent|steer sent/).textContent ?? '';
    expect(note).toContain('not sent');
    expect(note).not.toContain('sent to the room');
  });

  it('dispatched:true (OPEN socket) → the honest positive note names the commandId', () => {
    steerWith(signalCovenant(true));
    const note = screen.getByTitle(/steer sent/).textContent ?? '';
    expect(note).toContain('sent to the room');
    expect(note).toContain('cmd-7');
  });
});

/* ═══ F2 — the certify result is scoped to the session it certified ══════════ */

const landing = (id: string, certified: boolean): Artifact => ({
  id,
  kind: 'diff',
  title: `feat/${id}`,
  sub: 'PR',
  certified,
  sessionDiff: { fileCount: 0, additions: 0, deletions: 0, truncated: false, files: [] },
});

/** A covenant whose certifyConfirm resolution is controllable, so a test can make
    A's confirm resolve BEFORE or AFTER the session switch. */
function certifyCovenant(
  confirm: () => Promise<{ door: typeof DOOR_NAMES.certify; reached: true }>,
) {
  return {
    certifyArm: vi.fn(),
    certifyConfirm: vi.fn(confirm),
    certifyDisarm: vi.fn(),
    fund: vi.fn(),
    certifyClaim: vi.fn(),
    steer: vi.fn(),
    interrupt: vi.fn(),
    retract: vi.fn(),
    supersede: vi.fn(),
    mediateSteer: vi.fn(),
    run: vi.fn(),
  } as unknown as LiveCovenant;
}

/** Complete a certify hold on the given actionId under fake timers. */
function holdCertify(actionId: string) {
  const button = document.querySelector<HTMLButtonElement>(
    `button[data-hold-action="${actionId}"]`,
  );
  if (button === null) throw new Error(`certify hold ${actionId} not rendered`);
  act(() => {
    fireEvent.pointerDown(button);
  });
  act(() => {
    vi.advanceTimersByTime(CERTIFY_HOLD_MS + 100);
  });
}

describe('F2 — a certified result never migrates onto another session', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function paneFor(covenant: LiveCovenant, art: Artifact) {
    return (
      <ArtifactPane
        artifacts={[art]}
        activeId={art.id}
        onSelectArtifact={() => {}}
        comments={[]}
        onComment={() => {}}
        onDraft={() => {}}
        certify={{
          covenant,
          sessionId: art.id,
          artifactDigest: `digest-${art.id}`,
          viewerId: 'u-1',
        }}
      />
    );
  }

  it('certify A → "certified"; switch to uncertified B → B shows NO "certified"', async () => {
    const covenant = certifyCovenant(async () => ({ door: DOOR_NAMES.certify, reached: true }));
    const view = render(paneFor(covenant, landing('A', false)));

    holdCertify('certify-A');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('certified')).toBeTruthy();
    expect(covenant.certifyConfirm).toHaveBeenCalledWith('A');

    // select the OTHER, uncertified session — the pane re-renders in place.
    view.rerender(paneFor(covenant, landing('B', false)));
    // the keyed CertifyControl remounted fresh: no stale "certified" on B, and B's
    // own uncertified certify control is offered.
    expect(screen.queryByText('certified')).toBeNull();
    expect(screen.getByRole('button', { name: /certify this session/i })).toBeTruthy();
  });

  it('an A-confirm that resolves AFTER the switch does not paint "certified" on B', async () => {
    let resolveA: (v: { door: typeof DOOR_NAMES.certify; reached: true }) => void = () => {};
    const deferred = new Promise<{ door: typeof DOOR_NAMES.certify; reached: true }>((res) => {
      resolveA = res;
    });
    const covenant = certifyCovenant(() => deferred);
    const view = render(paneFor(covenant, landing('A', false)));

    holdCertify('certify-A'); // A's confirm is now in flight, unresolved
    await act(async () => {
      await Promise.resolve();
    });
    // switch to B BEFORE A's confirm resolves
    view.rerender(paneFor(covenant, landing('B', false)));
    // now let A's confirm resolve — it must land on the UNMOUNTED A control, not B
    await act(async () => {
      resolveA({ door: DOOR_NAMES.certify, reached: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('certified')).toBeNull();
  });
});

/* ═══ F3 — a live-mount comment does not claim room-register authorship ══════ */

function planeWithDiff(): ControlPlaneData {
  const now = '2026-08-15T12:00:00.000Z';
  const artifact: SessionArtifact = {
    branch: 'feat/ledger-spine',
    diff: {
      fileCount: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      files: [
        {
          path: 'doc.md',
          status: 'modified',
          additions: 1,
          deletions: 0,
          binary: false,
          hunks: [{ header: '@@ -1 +1,2 @@', lines: [' a', '+b'] }],
        },
      ],
    },
  };
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
                status: 'settled',
                contextPct: 0.33,
                progress: null,
                spendMicros: 900_000,
                exitSummary: null,
                artifact,
                artifactDigest: 'digest-abc',
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

/* The comment echo's honesty lives in the pure `commentEcho` selector `addComment`
   calls. The DocView select-to-comment gesture that reaches it needs caret/range
   geometry jsdom does not provide, so the branch is pinned at its source here, and
   the surface still mounts on both routes (so the wiring compiles and runs). */
describe('F3 — the live comment echo is honest about durability', () => {
  it('a LIVE mount → a NOT-delivered echo that never claims room-register authorship', () => {
    const echo = commentEcho(true, 'src/x.ts:12', 'const total = sum()', 'is this billed?');
    // structurally not a sent-looking authored message — it renders as a ✗ notice.
    expect(echo.delivery).toBe('refused');
    // and it says, in words, that nothing durable happened.
    expect(echo.text).toContain('not delivered');
    expect(echo.text).toContain('not yet written to the room ledger');
    // it MUST NOT wear the authored-comment "💬" the fixture route uses.
    expect(echo.text).not.toContain('💬');
  });

  it('the /prototype FIXTURE route → the unchanged authored "said" echo', () => {
    const echo = commentEcho(false, 'src/x.ts:12', 'const total = sum()', 'is this billed?');
    expect(echo.delivery).toBe('said');
    expect(echo.text).toContain('💬');
    expect(echo.text).not.toContain('not delivered');
  });

  it('both routes mount and render (the comment wiring compiles and runs)', () => {
    const live = render(
      <MoldingSurface
        tree={planeWithDiff()}
        roomId="r-live-42"
        viewerId="u-viewer"
        workspaceSlug="acme"
        roomSlug="ledger-migration"
      />,
    );
    expect(live.getByLabelText('open artifact')).toBeTruthy();
    live.unmount();
    render(<MoldingSurface />);
    expect(screen.getByLabelText('open artifact')).toBeTruthy();
  });
});
