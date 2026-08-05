# Atrium handoff — 2026-08-04

Read `AGENTS.md`, then `init.md`, then this file. The code remains the source of
truth. This handoff records the state of the current UI fidelity session; it does
not replace the tracker or the product semantics in `init.md`.

## Current checkout

- Branch: `fix/live-v8-fidelity`
- Worktree was clean when this handoff was written.
- The development UI was served at `http://127.0.0.1:3000` and the server at
  `http://127.0.0.1:4000` during the session. Both development processes should
  be stopped after this handoff. The normal `atrium-postgres-1` and
  `atrium-minio-1` Docker containers predated this task and are deliberately
  preserved.
- Node: `/Users/lars/.local/share/mise/installs/node/22.22.2/bin`
- pnpm: `/Users/lars/.local/share/mise/installs/pnpm/10.15.0/pnpm`

## What was built in this session

The relevant commits, newest first:

- `71810dc` — image previews now have a true actual-size scroll canvas, 25–400%
  controls, centered 100% entry, fit-to-window, and pointer-drag panning.
- `cffc99e` — conversation follow animation is owned by Atrium rather than
  native smooth scrolling, so projection refreshes should not cancel it. Added
  a two-account authenticated realtime acceptance test and a narrowly scoped
  Firefox Playwright project.
- `943eeeb` — follow target is explicitly
  `min(maxScroll, firstUnreadRow.offsetTop)`.
- `957e352` — counted horizontal unread divider and matching jump button.
- `5644a2f` — optimistic-to-persisted message identity reconciliation no longer
  looks like a history prepend.
- `5076fe7` — initial conversation follow-mode implementation.
- `8609075` — vertically resizable Current State / Conversation panes, complete
  collapse at either edge, keyboard controls, and 60/40 reset.
- `624ef0a` — removed dishonest/inert process-tree view chrome and the broad row
  hover box.

Earlier commits on this branch contain attachment thumbnails/downloads, typed
references, contextual mentions, and rich composer work. Inspect `git log` rather
than reconstructing those changes from this summary.

## Verification receipts

- Latest full web unit run: 34 files, **744/744** passing.
- Latest web typecheck: passed.
- Conversation follow focused unit suite: 35/35 passing.
- A real two-account authenticated live-room follow test passes in Chromium and
  Playwright Firefox. It sends 12 remote messages to establish overflow, then a
  tall remote message, and measures the reader pane's actual `scrollTop` against
  the capped first-unread target.
- Playwright Firefox 153 runtime was installed locally for that check.
- Image preview focused suite: 7/7 passing.
- `.next` was deleted and the dev server was rebuilt cleanly after the user
  asked whether the package was stale. The served development bundle was also
  inspected and contained the current follow implementation.

## Unresolved: the user's real conversation still did not visibly follow

This is the first thing the next context should address.

The user repeatedly reported that the conversation pane barely moved or did not
move at all, in both Firefox and Chrome, despite all fixture and authenticated
two-account tests passing. Do **not** add another inferred scrolling algorithm
before observing their actual session. The test route and served bundle are
current, so “stale package” was not supported by the evidence.

Start by reproducing in the user's existing `/app/lars/general` room and capture
these facts at the moment a message arrives:

1. Does `[data-unread-divider]` appear? Does the counted jump button appear?
2. Before and after the event, record the conversation element's `scrollTop`,
   `scrollHeight`, `clientHeight`, and the first new row's `offsetTop` and
   `getBoundingClientRect()`.
3. Record whether the timeline component remounts across `router.refresh()` and
   whether its first-render branch (`previousMessageIds === null`) is what runs.
4. Record the exact message-ID sequence across optimistic append, ack removal,
   and persisted projection refresh.
5. Determine whether the visible scrollbar belongs to
   `[data-region="conversation"]` or another ancestor in the user's actual DOM.

Prefer a temporary, visible development diagnostic or browser-console capture
that reports those values from the real pane. Remove it after finding the cause.
The existing acceptance test is
`apps/web/e2e/live-conversation-follow.spec.ts`; keep it, but do not treat it as
proof that the user's reported defect is resolved.

## Image preview follow-up

The last user screenshot showed actual-size mode clipping an oversized image so
top/left pixels were unreachable. Commit `71810dc` fixes the underlying centered
flex-overflow issue and adds zoom/pan. The focused tests pass, but the user had
not yet visually retested it when the session ended. First visual retest should
check:

- actual size opens centered at 100%;
- all four edges are reachable by scroll and drag;
- zoom buttons remain usable at narrow widths;
- fit-to-window restores the entire image;
- dragging does not close the backdrop or select the image.

If browser coverage is added, exercise a real large raster image rather than an
SVG or a mocked intrinsic size.

## Process and cleanup notes

- Do not leave E2E Postgres/MinIO or ports 3100/4100 running. This session's
  `atrium-e2e-postgres` and `atrium-e2e-minio` containers were removed.
- Preserve `atrium-postgres-1` and `atrium-minio-1`; they are the user's normal
  local infrastructure.
- Browser suites are heavy; keep workers at 2 or fewer.
- The Playwright config now has a `firefox-conversation-follow` project scoped
  only to the two conversation-follow spec files, so it does not double the full
  suite.

## Recommended next objective

> Reproduce and resolve the conversation follow failure in the user's actual
> `/app/lars/general` session. Instrument the real conversation scroll owner and
> message reconciliation lifecycle, identify why its measured behavior differs
> from the passing two-account Chromium/Firefox acceptance test, implement the
> smallest evidence-backed fix, add a regression that catches that exact cause,
> visually confirm the first unread row and counted divider land correctly, and
> remove all temporary diagnostics and test-owned services before handoff.

After that defect is closed and visually confirmed, return to the repository's
actual campaign priority: joining the verified live data route to the verified
three-surface component system and replay work described in `AGENTS.md`,
`init.md`, and the live tracker/`docs/TRACKER.md`.
