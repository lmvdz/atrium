/* ---------------------------------------------------------------------------
 * THE ARTIFACT PANE SHOWS THE REAL DIFF OF THE SELECTED LIVE SESSION (#168 B1).
 *
 * `molding-mount.test.tsx` proves the process TREE flips from fixture to a live
 * `ControlPlaneData`. This proves the OTHER read the go-live surface owes: the
 * ArtifactPane's diff. Before B1 the pane read `sessionArtifacts()` — a MOCK
 * seam — so a real room rendered a fabricated `src/billing/invoice.ts` diff no
 * matter what the session actually produced. Now the pane maps the CURRENTLY-
 * SELECTED session's real `SessionArtifact.diff` through the shipped `DiffView`.
 *
 *   * LIVE DIFF REACHES THE PANE. A plane whose first session carries a real
 *     `artifact.diff` renders THAT diff's file — not the fixture's.
 *   * FLIP THE INPUT. A different `artifact.diff` on the mounted plane moves the
 *     rendered file path — the pane forwards the column, it did not memoise a
 *     mock.
 *   * HONEST EMPTY STATE. A session with a null artifact (or an artifact with no
 *     `.diff`) renders the shipped `DiffView` ABSENT state, never a mock diff.
 *   * THE `/prototype` FALLBACK STILL RENDERS. With no live tree the pane keeps
 *     the `sessionArtifacts()` fixture so that route is unbroken.
 * ------------------------------------------------------------------------- */

import type { SessionDiff } from '@atrium/db';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MoldingSurface } from '../app/prototype/MoldingSurface';
import type { ControlPlaneData, SessionArtifact } from '../lib/control-plane-data';

afterEach(cleanup);

/** A one-file structured diff (`SessionDiff`) touching `path` — coherent totals,
    so `DiffView` renders it as a real structured diff, not an incomplete report. */
function diffTouching(path: string): SessionDiff {
  return {
    fileCount: 1,
    additions: 1,
    deletions: 0,
    truncated: false,
    files: [
      {
        path,
        status: 'modified',
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: [
          { header: '@@ -1,1 +1,2 @@', lines: [' export const x = 1', '+export const y = 2'] },
        ],
      },
    ],
  };
}

/** A LIVE plane whose FIRST session (the one `firstSelection` opens on) carries
    `artifact` — distinct ids/names from the seeded fixture, so a pass proves the
    live read, never the `treeData()`/`sessionArtifacts()` fallback. */
function planeWithArtifact(artifact: SessionArtifact | null): ControlPlaneData {
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
                status: 'settled',
                contextPct: 0.33,
                progress: null,
                spendMicros: 900_000,
                exitSummary: null,
                artifact,
                artifactDigest: null,
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

/** Render the surface and open the artifact pane (closed by default). */
function renderWithArtifactOpen(tree?: ControlPlaneData) {
  const view = render(<MoldingSurface tree={tree} />);
  fireEvent.click(view.getByLabelText('open artifact'));
  return view;
}

describe('the artifact pane shows the selected live session’s real diff (#168 B1)', () => {
  it('renders the LIVE session’s own diff file, not the fixture diff', () => {
    const { container } = renderWithArtifactOpen(
      planeWithArtifact({ branch: 'feat/ledger-spine', diff: diffTouching('src/ledger/spine.ts') }),
    );
    expect(container.querySelector('[data-diff-file-path="src/ledger/spine.ts"]')).toBeTruthy();
    // and NOT the seeded fixture's file — proving the mock seam did not fire.
    expect(container.querySelector('[data-diff-file-path="src/billing/invoice.ts"]')).toBeNull();
  });

  it('FLIP THE INPUT: a different artifact.diff moves the rendered file path', () => {
    const first = renderWithArtifactOpen(
      planeWithArtifact({ branch: 'feat/a', diff: diffTouching('src/ledger/spine.ts') }),
    );
    expect(
      first.container.querySelector('[data-diff-file-path="src/ledger/spine.ts"]'),
    ).toBeTruthy();
    cleanup();

    const second = renderWithArtifactOpen(
      planeWithArtifact({ branch: 'feat/b', diff: diffTouching('src/auth/tokens.ts') }),
    );
    expect(
      second.container.querySelector('[data-diff-file-path="src/auth/tokens.ts"]'),
    ).toBeTruthy();
    expect(
      second.container.querySelector('[data-diff-file-path="src/ledger/spine.ts"]'),
    ).toBeNull();
  });

  it('HONEST EMPTY STATE: a null artifact renders the shipped absent state, no mock diff', () => {
    const { container } = renderWithArtifactOpen(planeWithArtifact(null));
    // the shipped DiffView's honest absent render — NOT a fabricated diff.
    expect(container.querySelector('[data-diff-absent="true"]')).toBeTruthy();
    expect(container.querySelector('[data-diff-file-path]')).toBeNull();
    // and none of the fixture's file paths leaked in as a stand-in.
    expect(container.querySelector('[data-diff-file-path="src/billing/invoice.ts"]')).toBeNull();
  });

  it('an artifact WITHOUT a diff also renders the honest absent state', () => {
    const { container } = renderWithArtifactOpen(
      planeWithArtifact({ branch: 'merge/only', commit: 'abc1234' }),
    );
    expect(container.querySelector('[data-diff-absent="true"]')).toBeTruthy();
    expect(container.querySelector('[data-diff-file-path]')).toBeNull();
  });

  it('the /prototype fallback (no live tree) still renders its fixture diff', () => {
    const { container } = renderWithArtifactOpen(undefined);
    // no live tree ⇒ the fixture seam renders, so the route is unbroken.
    expect(container.querySelector('[data-diff-file-path="src/billing/invoice.ts"]')).toBeTruthy();
  });
});
