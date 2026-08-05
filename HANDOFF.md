# Atrium handoff — 2026-08-05 (second session)

Read `AGENTS.md`, then `init.md`, then this file. The code remains the source of
truth.

## What this branch is

`fix/live-v8-fidelity` carries the WIRE v8 frame convergence, the rich composer,
typed room references, attachment preview, the collapsible workspace split and
conversation follow. It strictly contains `build/live-multiplayer`,
`build/replay-app`, `join/worker-on-fixed-window` and `phase3/dogfood-protocol`.

**It is not merged.** `main` carries the Phase 2 tree.

## The gate

| | start of session | end of session |
| --- | --- | --- |
| `pnpm -r build` | — | **0** |
| `pnpm typecheck` | — | **0** |
| `pnpm lint` | documented as always 1 | **0** — see below |
| `pnpm test --maxWorkers=2` | — | **3109 / 3109** |
| `pnpm test:integration` | — | **189 / 189** |
| `pnpm test:e2e` **at 4 workers** | — | **168 passed · 1 failed** |
| `pnpm test:e2e` at 8 workers | 157 passed · 11 failed | 162–165 passed, 4–7 failed, *shifting* |

**`pnpm lint` exits 0 now.** The previous handoff recorded it as exiting 1 "and
always has", on `design/*.mjs` and `scripts/mutation-ledger.mjs`. Those files
still produce diagnostics, but they are warnings and infos, not errors: 16
warnings, 51 infos, exit 0. Verified as `pnpm lint >/dev/null; echo $?`, twice.
Treat exit 1 as a real failure from here.

## The follow defect — resolved

**The brief's question was: do the spec and the implementation disagree about
which row is the target? Measured, they do not.** The effect passes
`firstAppendedId`; in the fixture that is `local-1`, the exact row the spec
finds by text — same element, same id. `firstUnreadAtTop` in `943eeeb` is a
local variable name, not a different row. Neither side needed retargeting, and
the 70px was not a mis-aimed scroll. **No scroll ran at all.**

What was actually wrong, recorded with every write to the element:

```
t=669  the first-render branch pins the feed to the bottom — writes 480,
       clamped to 424, while clientHeight is 56
t=758  that write's scroll event is DELIVERED — and the composer has since
       grown to hold the 19-line draft, so clientHeight is 22
```

A scroll event is dispatched at the next rendering opportunity, not when the
position changed. `handleScroll` read `clientHeight` at delivery, computed
`480 − 424 − 22 = 34 > 12`, and concluded "the reader scrolled away". The reader
had not touched anything. Follow switched off, the viewer's own sent message was
filed as **unread**, the divider pushed the row from offsetTop 466 to 494, and
the pane stayed at 424. `494 − 424 = 70`.

This is why five earlier commits each rewrote the scroll TARGET with every test
green and the pane still did not move: **the target was never wrong, the
decision to follow was.**

Firefox stranded 85px through the same door with a different key: it does not
report the clamped `scrollTop` before the event arrives (write 480 → read-back
424 → the event carries 409), and it delivers the scroll event *before* the
ResizeObserver callback (t=860 vs t=861), so nothing that re-pins on resize can
get there first.

The fix is one rule: **if the box changed shape since the last scroll event, the
position moving is the layout moving, not the reader.** A reshape can put the
reader back on the live edge; it can never take them off it. Negative-controlled
on both engines — removing the single `reshaped && followingRef.current` line
returns Chromium to exactly 70 and Firefox to exactly 85.

A ResizeObserver re-pinning to the bottom was tried alongside it and **removed**:
it overrode routes that place the feed deliberately. The persisted replay opens
at its since-you-left boundary, and the re-pin dragged it to the live edge —
`replay.spec.ts` caught it with viewport ratio 0. Do not add it back; the
comment in `Timeline.tsx` says so.

Confirmed on the real `/app/<ws>/general` route with two accounts: final delta
**0** on both sender and reader, the new row flush with the top of the pane
(0.1px), no divider, no jump button. The timeline does **not** remount across
`router.refresh()` — one mount across the whole session — so the first-render
branch runs exactly once. The id sequence at a send is
`pending:<uuid>:<ts>:<n>` then the persisted uuid; the swap re-runs the follow
and re-settles on the same position.

**Not instrumented against your own `/app/lars/general`.** That needs your
session and your database; the two-account live route is the closest equivalent
reachable from a test runner. Worth ten seconds of your own eyes.

## The pin at 420px — resolved, and the brief's premise was wrong

**The pin is in the Current-state pane, not the conversation's.** A pin that
yielded would return its pixels to Current state and the feed would not gain
one. Swept at 1280 wide, every height from 380 to 900: the room head is a
constant 74.5px and the composer a constant 81.5px, neither yields, and the
split was two `fr` rows with no floor:

```
420px viewport → state 185.1px holding a 131.8px pin — 53px of slack
                 conversation 123.4px, composer 81.5, FEED 41.9
```

The split now caps Current state's share at whatever leaves the conversation its
floor, and that floor is what the pane must be able to SHOW — the composer plus
two message rows at the 42px a compact WIRE row measures — not a number picked
to clear the assertion. At 420px: state 138.5, conversation 170.0, **feed 88.5**.
At 560 and above the cap does not bind and the frame is unchanged.

That then exposed a second defect the sweep could not see: the pin's belt is
`min(260px, 30vh)`, a share of the VIEWPORT, but the pin lives in a share of the
FRAME. At 138.5px they cross, and a card stretched past its clamp took the pin
to 185.5px — the "N more owed" control, made a sibling of the clipped list in
round 5 so a grown card could not eat it, was eaten anyway one container out. It
sat at y=266 in a pane ending at y=241. **This is where the pin genuinely does
yield**: it now takes the smaller of its viewport belt and the room its container
leaves, and `pinBudgetForBelt` derives the row count from that same number.

## The receipt's provenance jump was unreachable

`.lensBody` scrolls; the receipt puts `.rcTop` at `top: 0` and `.rcFoot` at
`bottom: 0` over it, both `z-index: 2`, and the scroller had no
`scroll-padding`. Anything parked flush against either edge lands underneath
them. The prior-answer provenance button reported visible, enabled and stable on
every attempt, and all twenty-five clicks over a full minute hit `.rcTop` or
`.rcFootNote`. Dead to pointer and to keyboard for any receipt long enough to
scroll. `scroll-padding-top`/`-bottom` fixes it.

## The strip's identity block — neither hidden nor identity

Filed as the fifth surface v8 hid. Measured, it is not. **`.wsYou` was never
hidden**: the `display: none` rule named it, but `.wsYou`'s own rule sets
`display: grid` later at equal specificity and wins. The monogram renders —
26px, "LA", titled "lars — you". A rule that appears to hide an element it does
not hide is its own defect, and it is what the previous handoff read.

What was switched off is `.wsSpacer`: `flex: 1`, whose only job is to push the
theme control and the monogram to the foot of the column. Without it the strip
stacked everything from y=38 to y=194 with ~700px of empty rail beneath, so the
two groups read as one list. Restored, with the check that did not exist:
`smoke.spec.ts` asserts the grouping (tile above the strip's midpoint, monogram
below it, strut not `display: none`), so a strut of any size passes and no strut
fails.

## The rail stays folded — your call, on your reasoning

`replay.spec.ts` asserted `1 room · 5 humans` visible; that is the rail's
`workspaceSub`, and v8 ships `.rail` hidden until `.appRailOpen`. You said the
rail could be incorporated into the process tree, with direct human/agent
messaging as the piece that would still be missing. So the fold stays and the
check unfolds it first. Reversible in one line.

**Open, and yours:** if room navigation moves into the process tree, where does
a quick direct channel to a person or agent live? That is the gap you named and
nothing here addresses it.

## EIGHT WORKERS IS OVERSUBSCRIBED ON THIS MACHINE — run the gate at 4

This is the single most useful thing measured this session, and it corrects the
brief. At **8 workers** the suite reports 4–7 failures and **the population
moves between runs**: one run lost `auth` + `replay reopen`, the next lost four
`gallery` specs that had just passed and kept `replay reopen`. Every one of them
passes in isolation. One died with `Protocol error (Runtime.callFunctionOn):
Internal server error, session closed` — the browser-death mode `AGENTS.md`
describes verbatim.

At **4 workers the suite is stable**: 167 passed · 2 failed, run twice, the same
two failures both times, and they are the only two that are deterministic.

So the count at 8 workers is not a measure of the product. Run the gate at 4.
Anything that fails at 8 and passes at 4 is the machine — do not spend a session
on it. (`auth.spec.ts` did get a real repair: its budget was the file-wide 60s
default while the test carries 71 awaited steps across two contexts, two
signups, an attachment round trip and a rich mention. It now sets 120s. That is
a harness budget, not an assertion — every check in it is unchanged.)

## Still red at 4 workers — 1

`multiplayer.spec.ts`, and the remaining failure is none of the six problems
fixed on the way to it. It **alternates** between two points in the
semantic-acceptance stage across identical runs at one worker: "claim <id> has
no live attention route", and the accepted-object walk below it. That is a
timing dependency between the interpretation worker and the attention
projection. Start there; it has nothing to do with mentions, composers or
locators.

### What was fixed to reach it

Two real **composer defects**, both independent of the scenario, both
unit-covered:

- The reference control inserted a bare `@` at the caret. `mentionMatch` is
  `/(^|\s)@([^\s@]*)$/` — the `@` counts at the start of the draft or after
  whitespace — so after any non-space character the token did not match and
  picking a target appended a SECOND `@`: `who owns this?@@Grace `.
- `insert` wrote the DOM value and called `onChange` but never
  `setDraftMirror` — invisible to a controlled consumer (every route in the
  app), broken for an uncontrolled one.

Then four stale assertions in the spec, each retargeted at the register the
product actually writes: the mention picked AFTER the body so
`reconcileMessageReferences` keeps the reference; the row's statement read from
`reason.request`; its subject asserted as `message`, not `proposal`; and the
certified id read from `message_references` rather than
`messages.mention_user_ids`.

### Two decisions taken, both reversible

**A mention is a pointer, not an obligation.** The pin gets
`actionableAttention`, which excludes `referenceAttention`, so a typed mention
renders as a marker on its message and an "unfiled direct references" line —
not a pin card. I took the product as right and the check as stale:
`referenceAttention` is a built surface, and "you were named here" is answered
by taking the reader to the message, which a list of things to act on cannot do.
The check now spans BOTH surfaces. If you want mentions in the pin instead, it
reverts to a plain equality.

**`mention_user_ids` is a second register for the same fact, and it is not
merely unused.** `attention-projection.ts:93` computes its targets from it while
the client never fills it. Either the column goes, or something fills it.
Leaving both is the shape AGENTS.md names. Not touched.

## Process notes

- Browser suites: **4 workers**, not 8 — see the section above; 8 is
  oversubscribed on this machine and its failure list is not reproducible.
  `pnpm test:integration` and
  `pnpm test:e2e` manage their own containers. Preserve `atrium-postgres-1` and
  `atrium-minio-1`; `atrium-e2e-*` are removed after a run.
- `test/timeline-handlers.test.tsx` now separates "the box has this shape" from
  "the reader moved" — two `scroll` events, not one. A stimulus that changes
  both at once is ambiguous and the product resolves it as a reshape.
- `PIN_GEOMETRY` says the belt is `min(340px, 34vh)`; `attention.module.css` says
  `min(260px, 30vh)`; three comments claim they agree. The sums work only because
  `PIN_GEOMETRY.overflow` still charges 46px for a control that has been a
  sibling of the list since round 5. Two wrongs cancelling. Not touched.
