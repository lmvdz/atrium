# Atrium handoff — 2026-08-05

Read `AGENTS.md`, then `init.md`, then this file. The code remains the source of
truth.

## What this branch is

`fix/live-v8-fidelity` carries the WIRE v8 frame convergence, the rich composer,
typed room references, attachment preview/download, the collapsible workspace
split and conversation follow. It strictly contains `build/live-multiplayer`,
`build/replay-app`, `join/worker-on-fixed-window` and `phase3/dogfood-protocol`.

**It is not merged, and it should not be merged until its browser gate is green.**
`main` carries the Phase 2 tree instead — the tree that passed both independent
full-diff reviews and its own browser gate.

## The finding that supersedes the previous handoff

The previous handoff asked the next context to chase a conversation-follow defect
the user could see and no test could reproduce. That framing was wrong in one
specific way: **the test that would have reproduced it was never run.**

`pnpm test:e2e` on this branch, 2026-08-05, 8 workers, 16-core machine:

| tree | result |
| --- | --- |
| `build/live-multiplayer` (Phase 2) | 160 passed, 9 failed — all timeouts or auth-flow content, zero product assertions |
| `fix/live-v8-fidelity` (this branch) | **101 passed, 76 failed** — roughly fifty are product-shaped assertion failures |

The previous session's green receipts came from `apps/web` unit tests and two
focused specs. Neither covers the frame.

### Cause one — the runner viewport is below the product's own floor

`AppFrame.tsx` moved `MINIMUM_WIDTH` from 1024 to 1340 and `frame.module.css`
moved its media query to `max-width: 1339px`. `apps/web/playwright.config.ts`
sets no viewport, so every project inherits `devices['Desktop Chrome']` at
1280×720 — below the floor the product declares for itself.

`apps/web/test/viewport.test.tsx` still passes. It reads the constant and the CSS
and asserts they agree with each other. Both moved together; the runner did not,
and no artifact related the two. This is the "prose that names its authority is
not thereby correct" shape with two sources instead of one.

### Cause two — the room rail is hidden and its replacement does not exist

```css
.rail {
  /* V8 ships with the optional room rail folded. Room navigation remains in
     the live route and will return through the V8 fold affordance; retaining a
     permanently visible legacy column is the mismatch this batch removes. */
  display: none;
```

The fold affordance is not built. On the fixture route there is now no room
navigation at all, which `smoke.spec.ts` reports as *"the rail renders no room
chips, so the ordering above is measuring nothing"* and which makes every
`agreement.spec.ts` rail drive time out with the button present and invisible, at
all four widths.

### Cause three — two nested landmarks are both named Conversation

The workspace split wraps the feed in
`<section aria-label="Conversation pane" class="splitConversation">`, around
`<section aria-label="Conversation" data-region="conversation">`. Playwright's
`getByRole('region', { name: 'Conversation' })` now resolves to two elements, and
`auth.spec.ts` and `ws-auth.spec.ts` fail on the ambiguity rather than on
anything about messages.

This one is worth reading beside the follow defect. The CSS is right — the outer
pane is `overflow: hidden` and the inner feed keeps `overflow-y: auto` — so the
feed does still own the scroll. But an ambiguous accessible name on the scroll
container is the same class of defect as an ambiguous scroll owner, and
diagnostic 5 of the previous handoff was asking exactly this question.

## Failure counts by spec, this branch

| spec | failed |
| --- | ---: |
| `gallery.spec.ts` | 36 |
| `agreement.spec.ts` | 13 |
| `smoke.spec.ts` | 11 |
| `replay.spec.ts` | 8 |
| `conversation-follow.spec.ts` | 4 |
| `auth` / `surface` / `ws-auth` / `multiplayer` | 1 each |

Full logs are not committed. Reproduce with `pnpm test:e2e`.

## Recommended next objective

> Restore a browser gate over the V8 frame. Set the runner viewport at or above
> the product's declared floor; decide whether the folded rail's replacement
> affordance is built now or the specs are retargeted to the V8 information
> architecture, and say which and why; give the two nested Conversation regions
> distinct accessible names; then re-run and triage what still fails. That
> residue is the actual product-defect list, and it is where the conversation
> follow defect should be hunted — the four `conversation-follow.spec.ts`
> failures currently cannot find the composer at all.

Do not fix the failures by loosening the assertions. Several of them name the
mutation they catch; a spec retargeted to the V8 IA must state what the old one
caught and what the new one catches.

## Still open, unchanged

The user's real `/app/lars/general` session did not visibly follow the live edge.
That report stands and is not explained by anything above. The diagnostics the
previous handoff listed are still the right ones to collect, but collect them
after the gate is honest, not before.

## Image preview follow-up

`71810dc` added actual-size scroll canvas, 25–400% zoom, centered 100% entry,
fit-to-window and pointer-drag panning. The focused suite passes; the user has
not visually retested. Check: actual size opens centered; all four edges reachable
by scroll and drag; zoom buttons usable at narrow widths; fit-to-window restores
the whole image; dragging neither closes the backdrop nor selects the image.

## Process notes

- Browser suites: 8 workers is fine on 16 cores; the auth specs are the flaky
  set and their failures should be re-run in isolation before being believed.
- `pnpm test:integration` and `pnpm test:e2e` both manage their own containers.
  Preserve `atrium-postgres-1` and `atrium-minio-1`; they are the user's normal
  local infrastructure.
- `gh` reached github.com from this machine on 2026-08-05, so the live tracker is
  readable here even though `AGENTS.md` records it as unreachable from a
  sandboxed shell.
