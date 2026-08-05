# Atrium handoff — 2026-08-05

Read `AGENTS.md`, then `init.md`, then this file. The code remains the source of
truth.

## What this branch is

`fix/live-v8-fidelity` carries the WIRE v8 frame convergence, the rich composer,
typed room references, attachment preview, the collapsible workspace split and
conversation follow. It strictly contains `build/live-multiplayer`,
`build/replay-app`, `join/worker-on-fixed-window` and `phase3/dogfood-protocol`.

**It is not merged.** `main` carries the Phase 2 tree instead — the one that
passed both independent full-diff reviews and its own browser gate. Tickets #25
and #27 are closed against that tree, with their receipts on the tracker.

## The browser gate

`pnpm test:e2e`, 8 workers, 16-core machine:

| when | result |
| --- | --- |
| start of this session | **101 passed · 76 failed** |
| end of this session | **157 passed · 11 failed**, and the follow specs now fail on the behaviour instead of a locator |

The Phase 2 tree measures 160 passed / 9 failed, and those nine pass in
isolation at two workers — the flaky auth/mail set.

## What was wrong

**The runner sat below the product's own floor.** `MINIMUM_WIDTH` moved 1024 →
1340 and `playwright.config.ts` set no viewport, so every spec inherited Desktop
Chrome's 1280×720 and rendered the below-minimum notice instead of the product.
`test/viewport.test.tsx` stayed green throughout because it compared the constant
to the stylesheet and both had moved together. It reads the runner now, and both
mutations are negative-controlled.

**The floor was the overflow.** At 1280 every offender's right edge was exactly
1340 — inherited from `.app`'s own `min-width`. The grid is
`44px minmax(0, 1fr) 300px`: 344 fixed pixels. Nothing needed 1340. The floor is
1280, measured. Four specs were still driving 1124 or 1240, widths the shell now
refuses in words; inside a frame the product says does not fit, what gets
measured is the refusal.

**Five controls were made invisible while left in the page.** The room rail, the
surface indicators, the Current state head, the theme control, and the strip's
identity block — each `display: none`, each still in the DOM and still announced
to a screen reader, none with a replacement. Four are restored, and the rail got
the fold affordance its own comment had promised. **The strip's identity block
(`.wsSpacer`, `.wsYou`) is still hidden.** It is not a control and no check
covers it, which is exactly why it needs a decision rather than a default.

**The palette failed AA.** v8 changed `--tx2` from `#9aa1a8` to `#77827b` while
lightening the backgrounds under it: 4.49:1 on `--bg3`/`--bg5`/`--bg7`, 4.19:1 on
`--bg6`, against 7.15–7.54:1 before. That is the component library's standard
secondary text — `.actor`, `.time`, `.tag`, `.glyph`, `.link`, `.systemBody` —
and none of it is v8's own chrome. `--tx2` is now `#7e8982`, clearing 4.5 on all
eight surfaces. Separately: thirteen rules below the 10px type floor, and
`--tx3`/`--tx4` carrying text although neither has ever reached AA against
anything in either palette. `design/CONVENTIONS.md` records both, and the scope
of its own "never edit tokens.css" rule.

**Two failures were the instrument, not the product.** The composer's reference
button was reported dead because its effect — inserting `@` into the draft —
lives on a DOM property that `innerHTML` and `innerText` cannot see. The
class-filter check was a hydration race: it clicked as soon as the
server-rendered region was visible. Both were fixed in the instrument.

## Still red — and where to start

**1. The follow defect is now reproducible in a fixture test.** This is the
first thing to work on.

`conversation-follow.spec.ts` had been red since it was written, and not for a
product reason: it located the composer by `getByRole('combobox', { name:
/Message #/ })`, and the fixture route opens with the composer BOUND to an owed
decision, so its accessible name is "Answer … in your own words" and the pattern
never matched. That is why the previous session's evidence that follow works came
from the authenticated two-account spec alone while this pair was dark.

Located by role, the check now sends and appends — and fails on the assertion
that matters:

```
expected |scrollTop - min(maxScroll, row.offsetTop)| <= 2
received 70
```

Seventy pixels, deterministic, at 1280×500. Start here. It is the first
mechanical reproduction of the thing the user has been reporting by eye. Note
that the row being followed is the viewer's OWN sent message, which may not be
"unread" — the follow target implemented in `943eeeb` is
`min(maxScroll, firstUnreadRow.offsetTop)`, so the test and the implementation
may disagree about which row is the target. Settle which is right before
changing either. **Do not add a sixth scrolling algorithm before that is
settled** — five commits in the previous session did exactly that with every
test green.

**2. The pin eats the conversation at a 420px viewport height** — 41.9px where
the check requires more than 50.4. This one is a consequence of restoring the
Current state head and the surface indicators: they cost vertical budget. The fix
is the pin yielding, or the shell declaring a minimum height the way it declares
a minimum width. Do not fix it by hiding those surfaces again.

**3. `replay.spec.ts` ×3** — the corpus walk, the divider counts, the reopen
case. Not yet triaged against the current tree.

**4. `multiplayer.spec.ts` and `auth.spec.ts`, one each** — both are in the
flaky-under-load set. Re-run in isolation at two workers before believing them.

## What not to do

Do not fix a failing check by loosening it. Several of these specs name the
mutation they catch; a spec retargeted to the v8 information architecture has to
state what the old one caught and what the new one catches, and every commit in
this range does.

## Image preview follow-up

`71810dc` added an actual-size scroll canvas, 25–400% zoom, centered 100% entry,
fit-to-window and pointer-drag panning. Focused tests pass; the user has not
visually retested. Check: actual size opens centered; all four edges reachable by
scroll and drag; zoom buttons usable at narrow widths; fit-to-window restores the
whole image; dragging neither closes the backdrop nor selects the image.

## Process notes

- Browser suites: 8 workers is fine on 16 cores. The auth specs are the flaky
  set; re-run failures in isolation at two workers before believing them.
- `pnpm test:integration` and `pnpm test:e2e` manage their own containers.
  Preserve `atrium-postgres-1` and `atrium-minio-1` — the user's own local
  infrastructure.
- **`pnpm lint` exits 1, and always has**, on `design/*.mjs` and
  `scripts/mutation-ledger.mjs`. No `apps/` or `packages/` source is among them.
  Check it as `pnpm lint >/dev/null; echo $?` — a pipeline ending in `tail`
  reports `tail`'s status, which is how the Phase 2 receipt came to claim exit 0.
- `gh` reached github.com from an ordinary shell on this machine, so the live
  tracker is readable here even though `AGENTS.md` records it as unreachable from
  a sandbox.
