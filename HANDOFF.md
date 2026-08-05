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
| `pnpm test:e2e` (8 workers) | 157 passed · 11 failed | **165 passed · 4 failed** |

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

## Still red — 4, and what each one is

Two are **load flakes**: they pass in isolation at two workers and fail only in
the 8-worker full run. Verified this session, repeatedly:

- `auth.spec.ts` — signup/verification/invitation/presence
- `replay.spec.ts` — reopens an answered question

(`gallery.spec.ts`'s focus-ring sweep was in this set and is now green in the
full run too.)

Two are **deterministic**:

**`multiplayer.spec.ts` — red on a PRODUCT-DESIGN question now, not a defect.**

Chasing it found **two real composer defects**, both independent of it, both
fixed and unit-covered:

- The reference control inserted a bare `@` at the caret. `mentionMatch` is
  `/(^|\s)@([^\s@]*)$/` — the `@` counts at the start of the draft or after
  whitespace — so after any non-space character the token did not match,
  `selectMention` took its null branch, and picking a target appended a SECOND
  `@`. Type "who owns this?", click the control, pick a person: `this?@@Grace `.
- `insert` wrote the DOM value and called `onChange` but never
  `setDraftMirror`. Invisible to a CONTROLLED consumer — every route in the app
  — and broken for an uncontrolled one, where `visibleDraft` falls back to the
  mirror and the component reads a draft predating its own append.

Every existing mention check types the `@` itself, which is why neither was
visible. The spec types the body and picks the mention last (prefixing was tried
and rejected: the semantic fixtures are classified from the body, and a leading
`@Name ` stopped "Open question:" opening its own sentence).

Then two stale assertions, both now correct. A mention row's `statement` was
read as null because the query coalesced only proposal and object payloads: a
typed human reference is written straight against the MESSAGE
(`projections.ts`), with the body on `reason.request`. And `toMatchObject`
asserted `subjectKind: 'proposal'` / `proposalStatus: 'accepted'`, which is
`computeMentions`' semantic path, not the typed-reference one.

**What is left is a question for you.** The last assertion requires every
pending attention row to render IN THE PIN. The mention does not, deliberately:
`LiveRoomSession` builds `contextualAttentionIds` from `view.referenceAttention`
and feeds the pin `actionableAttention`, which excludes them — so a typed
mention becomes a reference marker on its message and an "unfiled direct
references" line in the state lens, never a pin card. Verified by reading the
unrendered id back out of the database: `subject_kind` message, `class` mention,
`status` pending.

Is being mentioned an **obligation** (the pin: what needs THIS person) or a
**pointer** (a contextual reference on the row it was written in)? The product
says pointer; the pin's charter says "what needs you", and someone asking for
you by name is the clearest case of that. Either answer changes the assertion's
shape, and the dismissal below it too — `actOnAttention` drives the pin, and a
mention living on a reference marker resolves through `onOpenReferences`. Not
rewritten blind: 240-second scenario, only a run can verify it.

**`replay.spec.ts` — derives every replay-divider count. Unresolved.** Left
failing rather than wrapped in a workaround. Measured, and it repeats: the
chip's handler is live (a DOM `.click()` and a raw `page.mouse.click()` at its
own centre both apply the filter); its node is never replaced; only Playwright's
FIRST `locator.click()` does nothing. During that click the feed scrolls 0 → 8,
exactly its own `padding-top`, and the chip moves 581 → 573 after the click point
was fixed at 591 — **but positioning the chip mid-pane and waiting for two
identical scroll reads does not fix it**, so the scroll is real and is not the
cause. Copies of the test with extra read-only round-trips pass consistently.
Fails 3 of 3 in isolation at one worker, so it is not the browser-death mode.
Everything measured is in the spec's own comment.

Three remedies were tried against it and all three failed 3 of 3, so do not
spend the time again: positioning the chip mid-pane and waiting for two
identical scroll reads; `scrollIntoViewIfNeeded()` followed by a no-op poll;
and `scrollIntoViewIfNeeded()` followed by a real 300ms settle. The 8px scroll
is real and is NOT the cause.

## Process notes

- Browser suites: 8 workers on 16 cores. `pnpm test:integration` and
  `pnpm test:e2e` manage their own containers. Preserve `atrium-postgres-1` and
  `atrium-minio-1`; `atrium-e2e-*` are removed after a run.
- `test/timeline-handlers.test.tsx` now separates "the box has this shape" from
  "the reader moved" — two `scroll` events, not one. A stimulus that changes
  both at once is ambiguous and the product resolves it as a reshape.
- `PIN_GEOMETRY` says the belt is `min(340px, 34vh)`; `attention.module.css` says
  `min(260px, 30vh)`; three comments claim they agree. The sums work only because
  `PIN_GEOMETRY.overflow` still charges 46px for a control that has been a
  sibling of the list since round 5. Two wrongs cancelling. Not touched.
