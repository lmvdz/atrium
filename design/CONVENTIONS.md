# Atrium design conventions

How to use `design/tokens.css`. Both the tokens and these rules come from the
prior Atrium design lineage (Prototype → v6), extracted from `Atrium v6.dc.html`
on 2026-07-31. The full rationale is in
`plans/research-live-call-design-system/BRIEF.md` (concept 9); this file is the
operating manual.

The system is stable across six versions of iteration. Treat it as settled: use
the tokens, do not add hexes. If something needs a color that is not here, that
is a signal the thing needs a semantic class, not a new swatch.

## Themes

Light (`:root`) is the default — warm paper. Dark is opt-in by putting the class
`atr-dark` on `<html>`. Both themes define exactly the same 51 token names, so no
component ever branches on theme; it just reads `var(--tx1)` and gets the right
answer. Adding a token means adding it to both blocks.

## Semantic ramps

Four hues, each meaning one thing. The meaning is the contract — never pick a hue
because it looks right.

| Hue | Means | Tokens |
| --- | --- | --- |
| green | verified, settled, passing | `--grn` `--grn2` `--grn3` `--grnbd` `--grnbg` `--grnav` |
| amber | needs you — a gate awaiting a human | `--amb` `--amb2` `--ambbd` `--ambbd2` `--ambbg` … `--ambbg5` |
| red | destructive or failed | `--red` `--red2` `--red3` `--redbd` `--redbg` `--redbg2` `--redbg3` |
| blue | human — person-authored surfaces | `--blu` `--blu2` `--blu3` `--replybg` `--filebg` `--filebd` |

Within a ramp the shape is consistent: the bare name is the foreground, `2`/`3`
are shifted foregrounds (hover, secondary, de-emphasized), `bd` is a border, `bg`
is a fill, and higher `bg` numbers step the fill further from the page. Amber
carries the most fill steps because needs-you states nest — an amber row inside
an amber card inside an amber pin still has to separate.

Green means *checked by something other than the claimant*. It is not "good news."
An agent or an LLM reporting its own success is a claim, and claims are not green.

Amber and red are not interchangeable severities. Amber is a reversible gate that
wants an answer; red is destructive or already failed. That distinction drives the
friction rule below, so getting it wrong has behavioral consequences, not just
visual ones.

## Neutral ramps

- **Surfaces** `--bg0` … `--bg7`. `--bg0` is the page. `--bg1` is the primary
  raised surface (panels, cards). The rest are the well-trodden variations the
  prototypes settled into — insets, hovers, headers, sunken rows. Pick by role,
  not by lightness: in dark theme the ramp is not monotonic, so "one step lighter"
  is not a thing you can rely on.
- **Rules** `--line` (hairline, the default divider), `--line2` (a divider you are
  meant to notice), `--line3` (emphatic — section boundaries, focused borders).
  Note the first one is `--line`, not `--line1`.
- **Text** `--tx0` (primary, highest contrast) → `--tx4` (faintest). `--tx1` is
  body text; `--tx0` is reserved for the few things that must win. `--tx2` is
  secondary prose, `--tx3` is metadata and routine-event glyphs, `--tx4` is the
  quietest legible thing on the page.

## Typography

Two families, split by *who is speaking*.

- **IBM Plex Mono** for machine chrome: timeline rows, log lines, receipts,
  status chips, counts, timestamps, identifiers, section labels. Anything the
  system emitted or that is scannable-as-data.
- **Inter** for human chrome: prose, message bodies, composer, buttons, headings,
  anything a person wrote or reads as sentences.

That split is the point — it is how a reader tells derived state from someone's
words without reading either. `body` is Inter; mono is applied where the machine
speaks.

**Do not import Sora.** The v6 source still preloads it in the font stylesheet
link but never applies it anywhere — vestigial across four versions. Drop it.

Font loading: import only `IBM Plex Mono` (400, 500, 600, 400 italic) and `Inter`
(400, 500, 600, 700). Those are the weights the source actually uses.

## Density

The system is deliberately dense — an operator surface, not a marketing page.

- **12.5px** base body size on the app shell. This is the baseline everything else
  is relative to; it is smaller than a typical web default on purpose.
- **10–11.5px** for timeline and list rows (10, 10.5, 11, 11.5 are the sizes in
  use — 10 and 11 dominate). Rows are information, not reading material.
- **10px uppercase with `letter-spacing: .14em`** for section labels. This is the
  single most-repeated typographic idiom in the source (67 occurrences) and it is
  what makes a label read as a label rather than as content. Write the text in
  uppercase; the source does not use `text-transform`.
- Timeline rows use a fixed column grid — `44px 14px 76px 1fr` (time · glyph ·
  actor · text) — so the glyph column always lands in the same place and the
  epistemic status of a whole screen is scannable in one vertical pass.
- Small type at these sizes leans on `--tx2`/`--tx3` rather than on size alone for
  hierarchy. Do not go below 10px for anything a user must read.

## A number that needs a disclaimer is the wrong number

Every review round adds a clause. No round had ever removed one, and after eleven
of them the most valuable real estate on this page — the top three lines of the
CURRENT STATE pane — was spent on arithmetic disclaimers about its own counts:

```
13 objects · 4 settled · 8 unverified · 2 items awaiting you · updated 09:07
4 + 8 + 1 open = 13 of 13 · awaiting you overlaps them, it does not add to them
the need-you counts below sum to 4, not 3 — an object under two objectives is
counted by both, and is still one item in Needs you
```

Three lines explaining why the numbers do not add, above the numbers. The pin
trailer had the same shape from the other direction: **six unrelated statistics in
one 30-word run-on** with nothing but middots between them. Each clause was
demanded by a round that was individually right, and the accumulation is a defect
none of those rounds could see from inside itself.

**The rule. A count that needs a sentence beside it to be read correctly is the
wrong count to show.** The honest fix is fewer numbers, not more prose about them.
Ask what a returning reader needs on the first screen, show those, and delete the
reconciliations. Three specific traps, each one a real line that was removed:

- **Do not print an equation to apologise for a partition.** `4 + 8 + 1 = 13`
  existed because "settled" and "unverified" were presented as slices of one pie
  that "awaiting you" cut across. Stop claiming the partition and the equation has
  nothing to reconcile.
- **Do not apologise for a sum the page never showed.** The overlap caveat added
  up the per-objective counts *on the reader's behalf* and then explained the
  total. Each header is true of its own section; nothing on screen adds them
  together but the note that regrets it.
- **A count that duplicates a sentence beside it is not corroboration.** The
  trailer printed `N failures` next to a lead whose first branch *is* the failure
  count, and `N overdue` next to a lead that says how many things are late.

And the counterweight, so this does not become licence: **remove displayed prose,
never a guarantee.** Every invariant, every mint stays. What goes is the page
explaining its own arithmetic to a reader who did not ask.

**One honest exception, because a blind reviewer refused the blanket version.**
Deleting `last check HH:MM` deleted the *read* behind it — the scan for the most
recent dated verification in the room — and that was a freshness fact, not
prose. `updated HH:MM` is not a replacement: it is `S.now`, which a chat message
advances. So the room-level freshness signal is **gone, not relocated**, and the
lead's `N of M unverified` is a different fact that happens to answer the same
worry most of the time. Written down that way rather than as an equivalence,
because a prune that quietly drops a read while claiming it drops only prose is
the same defect as a count that needs a disclaimer. **And delete the arithmetic
with the line** — the first cut left every removed statistic's computation
standing in `clearSummary()`, dead work that reads like a guarantee and is the
easiest way for a statistic to come back without a decision.

Two things to preserve while pruning, both of which cost nothing on screen:

- **A disclaimer that answers a real question moves off the screen, not out of
  reach.** The objective-overlap explanation lives on the header's `title` now.
  Be exact about what that is: a button with visible text takes its accessible
  *name* from that text, so `title` is a description and a tooltip — available to
  a pointer and to most screen readers, not to touch, and not a line anyone pays
  for. That is the right trade for a caveat nobody asked for; it would be the
  wrong trade for anything a reader needs to act.
- **Fewer numbers is not fewer groups.** The trailer's remaining facts are
  separated by a rule rather than by punctuation. The run-on was a legibility
  problem as much as a count problem, and dropping four statistics without
  grouping the rest would have fixed half of it.

**Sweep the prune as a class, not where it was noticed.** #10 r12 pruned the pane
and left the identical shape one column to its left, on every screen after the
reader's first write: `SINCE YOU RETURNED · 0 NEED YOU · 0 CHANGES · 0 DISCUSSION ·
0 ROUTINE`, then `0 unseen since 09:12 today · 4 rows here are yours — your own
activity is never counted back to you as unseen`. Four permanently-disabled zero
chips — *the same four controls that round's own driver reported as enumerated but
never driven, because there is nothing to drive* — and a two-clause disclaimer
explaining the zeros. **A chip that filters nothing is not a control**, and a group
with nothing unseen says what is in it in one clause instead of four zeros and an
apology for them. When a round writes a doctrine, its first job is to run the
doctrine over the whole page.

**And r13 did not sweep it either — the same divider, one clause over.** On the first
screen, under the chips: `chips count rows · NEEDS YOU counts the items behind them`. A
two-clause reconciliation whose entire job was to tell a reader that `2 NEED YOU` on the
divider and `NEEDS YOU 3` on the tab count different things. That is the trap named at the
top of this section — *a count that needs a sentence beside it to be read correctly is the
wrong count to show* — written by the round that shipped it. **A count names its own
unit and then nothing has to reconcile it**: the chips read `2 NEED-YOU ROWS`, `4 CHANGE
ROWS`, `31 ROUTINE ROWS`, and the sentence explaining the collision is gone because the
collision is. The same move fixed the other pair on that screen: the lens said `13 objects
· 9 unverified` while the pin trailer said `~ 6 of 10 unverified` — two true counts of one
word over two scopes, arithmetically consistent and unexplained. Both read `N of M` now,
which is one number fewer and puts the difference in the count instead of in prose about it.

**And when you delete an explanation, re-verify the thing it explained is still
true.** r11 counted "unverified" with one predicate on both sides of the screen and
printed the scope. r12 widened the lens predicate to include open questions — the
right reading — and, in the same commit, deleted the scope clause. Neither change
was wrong; together they left the lens saying `8 unverified` and the pin trailer
saying `~ 7 of 13 unverified` over the same thirteen records with nothing owed, and
the sentence that would have made a reader ask was gone. **One predicate, named
once, called by every surface that counts it** — and a number in a minted sentence
is re-derived from the records the sentence declares it read, on every paint, so
two honest counts of the same thing cannot disagree on one screen.

**And that sentence was unqualified for a round, which is how the largest hole on
the page stayed open.** r13 shipped it as written above while the code beside
`COUNTED_CLAIMS` was honest that the re-derivation only reached eight *phrasings*.
The rail's owed badge minted thirteen verification reads and its entire sentence
was the characters `3` — no phrasing to match, no field word for `checkVocabulary`
or `checkQuantifiers`, and `say()`'s own point-read mutation gated on a field word
appearing in the sentence, so all thirteen read-mutations were skipped as well.
Four instruments, one sentence, silence: patch that badge to return `7` over a room
holding two and five surfaces on one screen contradict each other with a clean
console. **A denylist of phrasings is unbounded — enumerate the compliant forms
instead and report what matches none of them.** Every numeral in a minted sentence
is now read by one of four: a phrasing pattern, a predicate the sentence *declares*
(`say(views, phrase, owner, ["needsYou"])`, re-derived from those same records), a
number the record itself holds, or a declared non-count shape (clock, date,
duration, money, percentage). Anything else is reported on the paint that renders
it. **And the reach is generated, not described**: `design/prototype-counts.txt` is
every numeral on screen with what read it, digits normalised to `#`, produced by
the same function the checker calls and compared against the live walk on every
driver run. This paragraph may not describe that file's contents; it cites it.

**A caveat is conditioned on the thing it is about.** r12 moved the objective-overlap
explanation into the header's `title` and gated it on whether anything under that
objective was owed — so the objective whose overlap is *total* carried no overlap
sentence at all, because nothing under it needed you. Gate a caveat on whether the
condition it describes exists. Better still, make the shape visible in the count
itself: every objective header reads `N of 13 objects` now, one denominator, so the
headers read as overlapping slices of one room rather than as parts of a sum, and
the caveat has less work to do.

## Epistemic glyphs

Every rendered fact carries exactly one glyph. The glyph is *derived from the
data's provenance*, never hand-set. The invariant, stated in the source and worth
repeating: **a claim never dresses as a fact.**

| Glyph | Meaning | Color |
| --- | --- | --- |
| `✓` | verified — checked by the system, not self-reported | `--grn` |
| `~` | claim — self-reported, rendered with a dotted underline | neutral, underline flags it |
| `?` | explicitly unverified | `--amb` |
| `·` | routine / informational | `--tx3` |
| `◆` | needs you — escalation or decision pending | `--amb` |
| `■` | destructive decision pending — **reserved; `glyphOf()` has no branch that produces it, and nothing in v1 is destructive** | `--red` |
| `✗` | failed | `--red` |

The `■` row is honest about being empty on purpose. It was load-bearing for ten
rounds — the friction rule keyed on it — while no code path could assign it, so
the rule it keyed had one side. Friction is decided by the reversibility audit
now, not by this row; if something destructive arrives, it gets `■` *and* the
audit will already have flagged it.

`~` and `✓` are the load-bearing pair. An LLM-derived decision is a `~` claim
until a human accepts it, at which point it becomes `✓`. The dotted underline on
`~` is not decoration — it is the visual difference between "someone said it" and
"the system checked it," and it must survive into every surface that renders
derived state.

`·` is not "unimportant" — it is "no attention owed." Routine events collapse, but
they collapse legibly (count + time range + actors + a peek affordance), never to
a bare "N hidden."

## Asymmetric friction

Friction is applied in proportion to reversibility, not to importance. This is the
most consistent single decision in the whole corpus — unchanged across every
version and independently arrived at on both design branches.

**Reversibility is a fact about the control set, not a property of a glyph.** The
rule used to read: amber `◆` gates get one click, red `■` decisions get a
press-and-hold. #10 r11 reported honestly that the irreversible tier was
unexercised, and a blind reviewer found the consequence: `glyphOf()` has no branch
that can return `■`, so **the partition had one side**, and every action on the
page defaulted to the safest tier by virtue of a glyph nothing could produce.
Under it, `Ask justin instead` — one unconfirmed click — set the assignee, cleared
`owedTo`, left `canAnswer` false and `canReopen` false, and **no control anywhere
took it back**. A rule that classifies by appearance will exempt whatever does not
wear the costume.

So the question is asked of what the page actually offers, after the action:
**does a control exist that puts this back?** Every action answers for its own
irreversibility in one of exactly three ways, strongest first:

1. **A control puts it back.** After the action the page offers you the control
   that restores it — `reassign` ↔ `takeback`, `signed`/`answered`/`opt`/`verify`
   ↔ `reopen`. This is the only one of the three that is an actual undo, and it
   is the one to reach for: #10 r12 answered the reassign trap by *building the
   way back*, not by putting a modal in front of it.
2. **It asked first.** The control opens a prompt with a cancel instead of
   writing — reopen wants the reason, verify wants the evidence — so the click
   that commits is the second one. This is checked in the DOM (the control has to
   be a disclosure, `aria-expanded`) rather than declared in a table, because a
   table saying "this one asks" is the kind of claim this artifact has shipped
   false four times.
3. **It named what it writes.** The label carries the value — *"Reschedule to
   today 17:00"* — and what it replaces stays on the record and in the chain.
   **This is the weakest tier**, honest only for an action that erases nothing,
   and it is written down as a tier rather than as an exemption precisely so the
   next reviewer can see which actions are leaning on it. Today exactly one is.

An action with none of the three is the defect, and `reversibilityAudit()` says so
on every render, driven by the same `offeredActions()` the renders build their
buttons from — so it cannot be an audit of a control set the page does not have.

**And "the same function the renders use" is itself checked, over every control
that reaches a write and not only the ones wearing `data-fx`.** The first draft
of that check walked `[data-fx]` alone, which is the selector list r10 shipped
and r11 replaced, one layer down — and a blind reviewer used it to find the gap:
`Answer in your own words →` opens the composer, Send calls
`answerQuestion`/`answerDecision`, and that write had no action id at all. On a
question whose card carries no wording it is the *only* action the pin offers, so
the friction rule was blind to the one move available. `WRITE_CONTROLS` maps each
control's own markup to its action id — `[data-fx]`, `[data-opt]`,
`[data-verify]`, `[data-bind]`, `#rcReopen` — and a new control has to name which
action it is or the check says so. **A control that reaches a write and is not in
the offered set is a write the friction rule cannot see.**

Do not add a confirmation modal to an action that has an undo; **build the undo
before you reach for the friction.** Where a hold is genuinely right — a
destructive action with no way back and nothing to name — press-and-hold for 2
seconds with a progress bar, click-only, recording who armed it and when. Nothing
in v1 is in that class, and the audit is what will tell you when something is,
rather than a glyph nobody assigns.

**A hold has to be implemented, not declared.** Found in the #39 round-1
gauntlet: five buttons carried `data-hold="2000"`, the label said "— hold" and
the tooltip promised two seconds, while `onClick` fired on the first press and
nothing anywhere read the attribute. A safety affordance that does not exist is
worse than none, because the person trusts it. The working shape is
`primitives/HoldToAct.tsx`: an elapsed-time gate on `performance.now()`, a
progress bar driven by that same clock, cancel on any release before completion,
keyboard parity (the browser synthesises a click for Space and Enter, so the
default must be suppressed), and an `Arming` record — who, when, how long held —
delivered to `onArm` *before* `onAct`. The gate must not be an animation or a
transition: `prefers-reduced-motion` kills both, and a safety mechanism that
switches off for the motion-sensitive is not one.

**The destructive control wears red, and the friction follows the action rather
than the layout.** Round 1 also found the destructive primary rendering `--amb2`
— byte-identical to the reversible gate's primary — and the compressed pin row
with no destructive variant at all, so compressing an item turned a two-second
hold into a one-click destruction. Use `--red3` as the fill with `--bg3` as the
label (7.47:1 light, 5.81:1 dark; `--red2` is 4.21:1 in dark, the same latent
bug recorded below for the glyphs).

## Motion

Three keyframes in the system, two of them live in v1:

- `gl-pulse` — 1.2s or 1.6s infinite, opacity 1 → .35. In-progress states. A pane
  that is continuously re-derived is in-progress, not live.
- `gl-rise` — .15s / .2s / .25s ease, a 2px translate plus fade. New rows entering
  the timeline (`.mrow`) and content appearing.
- `gl-blink` — 1s infinite, hard on/off. Live/recording indicators only, and
  therefore **not declared in v1**: Atrium v1 is human-only with no voice
  surface, so it goes where the call-era tokens went — it returns in Phase 4
  with the thing it indicates, alongside the `--live` token family kept
  unconsumed in `tokens.css`. Found unreferenced during #39; a keyframe nothing
  uses is a keyframe nobody notices has stopped working. #10 r6 measured the
  other half of the same defect on the prototype: `gl-blink` sat unused while
  the one animated dot on the page ran `gl-pulse` in verified green. A keyframe
  defined and never used is a rule nobody is holding. Define it when something
  is live; until then, don't.

Colour is decided by the glyph table, not by the animation: nothing wears `--grn`
unless it is `✓` verified, however alive it is.

**Declare an animation beside its keyframes, never inside a CSS Module.** A CSS
Module rewrites the `animation-name` it sees, including a reference to a
globally-declared keyframe, so `animation: gl-pulse` in a `.module.css` resolves
to a scoped name no keyframe has. Found in #39: the live indicator had been a
static dot since it was written, `getAnimations()` returned `[]`, and nothing
noticed because a static dot looks exactly like a dot. App-wide motion utilities
(`atr-rise`, `atr-rise-s`, `atr-pulse`) live in `globals.css` and are worn as
classes in markup; the module beside the component styles everything else.

Everything is short. Nothing in this system eases in over half a second; a feed
that animates slowly is a feed you cannot read while it moves.

**`prefers-reduced-motion` is respected globally**, with a blanket kill switch —
not per-component opt-in:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

Keep that rule. Any new animation is covered by it automatically, which is the
only version of this that stays true as the app grows.

## Hover affordances

Row-level actions (reply, forward, react, the row menu) are hidden at `opacity: 0`
and revealed on row hover over ~.12s. The row stays quiet until you are pointing
at it. Anything that must be discoverable without hovering — anything that owes
the user attention — is not a hover affordance.

**And a control you cannot see must not take the pointer.** `.mrow .acts` is
`position: absolute; z-index: 3` and was hit-testable at `opacity: 0`, clearing
`#unmarkSeen` by **1.4px** at 1440. A blind reviewer drove 18 randomised sessions of 40
real mouse clicks with pointer moves at three widths, plus a 12-width probe of all nine
hit-test points, and could not steal a single click — and measured the mechanism anyway.
It is environmental today and a row-spacing change makes it a repro. **Delete the
reachability, not the margin.** The rule is a pair, and both halves are checked:

- a control a reader **can** see must have a point that hit-tests to itself;
- a control a reader **cannot** see must have no such point;
- and a control that refuses the pointer while *visible* is its own defect — painted, in
  the tab order, and a click passes through it.

The one thing this rule may not do is ask either question of a control mid-transition: a
strip fading in is transparent for 120ms and is not a strip nobody can see. `effOpacity()`
returns `null` while any ancestor has a running animation, and an unsettled control is
skipped rather than reported. That caveat exists because the first cut of the rule fired
on eleven honest controls before it fired on the real one.

## What is deliberately not here

The call-era tokens (`--live`, `--strip`, `--stile`, `--stileac`, `--stbd`,
`--stx`, `--stxac`) are kept in `tokens.css` under a marked section but nothing in
v1 consumes them. Atrium v1 is human-only with no voice surface; those tokens
become live when calls return in Phase 4. They were kept rather than deleted
because the pine call strip is a settled piece of visual identity and re-deriving
it later would be pure waste.

## No synthesized speech (invariant)

Nothing the product renders as a person's words may be words that person did not write. A correction, receipt line, history entry, or summary either **quotes text the human actually typed** (with provenance) or **states a system fact in system voice** — rendered visually distinct from quotation: no `<q>`, no first person, no "X said" framing. Synthesized rationales (why-you lines, system summaries) are always system voice.

Found in the #10 round-3 gauntlet: the prototype invented a first-person sentence on every reopen and rendered it quoted under the actor's name and timestamp, inside the receipt — the artifact whose entire job is being the trustworthy record. It was also false in context. Fabricated attribution is the product's cardinal defect; a page that will invent one sentence cannot be trusted about any of them.

Enforcement: any quotation-context element must carry provenance proving its text came from user input or a seeded human message; the dev invariant checker asserts it.

**The rule covers what the quote is offered as evidence *for*, not only where the quote came from.** A receipt whose quotation is genuine, verbatim and correctly attributed still fabricates attribution if the sentence it is offered in support of is not that sentence. Found in the #21 round-3 gauntlet: the core bound a machine-minted claim to its evidence by counting shared content words, with `not` treated as noise — so quoting *"Bob will not deploy production Friday"* scored 100% support for *"Bob will deploy production Friday"*, and it auto-accepted. **A similarity score can never mean "this evidence supports this claim."** Any check that stands between a machine's reading and the record must state what it actually proves, treat polarity, quantifiers and modals as content rather than noise, and **refuse rather than accept when it cannot judge** — the two honest verdicts are "this is a word-for-word reduction of what was written" and "a person has to read this", and there is no third one where a threshold decides on the reader's behalf. Enforcement in `@atrium/core`: `statementBearing`, and the allowlist of tokens that may differ (`RECEIPT_POLICY.droppableTokens`) rather than a list of the tokens that may not.

**And the rule covers what surrounds the quote, not only the quote.** #21's round-4 gauntlet, and then round 5: closing the scissors *inside* a sentence leaves them open *between* sentences. *"We will deploy production Friday. Not."* quoted as its first sentence is verbatim, whole-sentence, correctly attributed, and bears its own statement word for word. Round 4 found this, wrote it into a comment as a residue no span rule could see, and auto-accepted it anyway — **which is the failure this entry is really about: a limitation stated in prose is not a disposition, and the program still does something with every input that lands inside it.** Whenever a check documents what it cannot see, the next question is what the code *does* with an input inside that limit, and the answer may not be "accept" or "silently discard". The compliant form here is allowlisted rather than defended against: a certifiable quote is the **whole of what its author wrote in the bearing message**, and no later message in the window restates it with anything added. Everything else is referred to a person. Enforcement: `quoteCoversOwnText`, `laterRevision`, and the `refer` severity that neither accepts nor destroys.

**Normalisation is a policy about what may differ, never a list of things to delete.** Same round: the matcher deleted backticks (so a sample its author displayed became an assertion its author made), collapsed a markdown link to its text (so a statement naming the safe URL certified against a record whose link went elsewhere — a security defect, not a fidelity one), and applied NFKC (so two distinct hostnames compared equal). Each deletion was individually defensible and together they compared two texts nobody wrote. `packages/ingest` had already answered the same question the other way for message bodies — stored verbatim, because "determinism does not need normalisation". Enforcement in `@atrium/core`: `normalizeForReceipt` admits five differences, each with the argument that admits it, and the lossy fold that decides which model reads a window (`normalizeForRouting`) is a different function that no receipt may call.

**The rule covers authorship, not just invention.** A message the interface authors on a person's behalf — the text of an option they clicked, a template filled with their name — may never be attributed to them as their words, and may never satisfy the quotation check. Found in the #10 round-4 gauntlet: one-click answers appended a message authored as the user containing the card's sentence, and the checker then validated the quotation against that page-fabricated message, passing on exactly the class it exists to prevent. Messages carry their origin (`typed` vs `chosen`); only typed text and seeded human messages can be quoted; chosen answers render in system voice ("chose: <option>"), never in quotation marks.

**A default branch may not name a person.** The same defect arrives through a missing `case` as readily as through a fabricated string. Found in the #10 round-5 gauntlet: `receiptState()` had no branch for an answered question, so it fell through to the claim branch and the receipt header read `CLAIM · unverified · claimant: priya` above a sentence priya had *asked*. Nobody wrote that attribution; the absence of a branch did. So: every fallback that renders a role — claimant, owner, verifier, asker — must be reachable only for kinds that actually have that role. When a kind has no branch, the fallback states what is missing, in words, and names nobody.

**A record of an answer contains the answer.** Recording that something was answered while dropping what the answer said is not a record. The same round: clicking `Answer — retention is 90 days` wrote a transition and stored none of the answer's content, so the string on the button appeared nowhere in the object, the history, the feed, the lens or the receipt. Whatever the control promised to record is recorded verbatim, with its authorship disclosed by the rules above.

**The rule covers the attribution, not just the words.** Found in the #39 round-1 gauntlet, independently by both lineages: the enforcement above governed *what was said* and left *who it was said by* as a free string beside it. The primary message path was `actor + body`, with the origin read once and discarded, so a page-authored answer rendered under a real person's name in the same slot as their own sentences — the cardinal defect, live in the demo. Separately, every name printed next to quoted text (the reply banner, the receipt's provenance rows, a correction's reason) was supplied alongside the quotation rather than derived from it, so nothing stopped priya's name sitting over lars's sentence.

Two structural rules follow, and they are what the enforcement now rests on:

- **A quotation is a CITATION, and the attribution is looked up from it.** Any component that renders a name beside quoted text takes the quotation, not a string. There is no `by` prop anywhere. From #39 r5 the quotation does not carry the name either — see "the field that moves" below.
- **The message-rendering path is discriminated on origin, and the arms have different fields.** The human-authored arm has an attribution and a body; the page-authored arm has neither, only a system-voice statement. A page-authored answer cannot reach a human-attributed row because the row shape that would render it does not exist.

**What the branded types actually buy.** `Quotation`, `SystemStatement`, `MessageEntry`, `Rationale` and `Slot` all carry phantom brands keyed by module-private `unique symbol`s. Those are `declare`-only: they exist in the type system and nowhere else. They stop a TypeScript author from writing the literal, which is the mistake a person makes at 2am. **They are not a guarantee about data from outside the compiler** — `JSON.parse`, a cast, `Object.assign` and any JavaScript caller all walk straight through. Describe them as a convention with teeth, never as a proof. Where untrusted data enters, use the runtime parsers (`parseQuotation`, `parseMessageRecord`, `parseSystemStatement`, `isRationale`, `maybe`) rather than a brand and a hope.

**A chokepoint is not a boundary: close the type, then re-derive at the render boundary.** Found in the #39 round-3 gauntlet, and it is the third address of one defect. r1 put a free actor string beside the words; r2 moved it into the body slot; r3 put the reconciliation inside `messageEntry` — and a caller obtained a genuine `Quotation` from the public `quotationFrom`, wrote the exported `AuthoredMessageEntry` literal, handed it to `TimelineRow`, and rendered a real person's name over words she did not write, with `tsc --noEmit` at exit 0. Each fix was correct about the path it guarded. None of them was the only path.

Two changes together, and a third check at a fourth site is not a substitute for either:

- **Close the type.** Brand the record so the only expression in the program with that type is a call to the constructor. A validated constructor beside an inhabitable interface is a suggestion.
- **Re-derive at the render boundary.** `TimelineRow` holds `entry.attribution.text` and `entry.body`, so it asserts they read the same before printing a name over them — and it throws rather than quietly correcting, because a silently corrected row is a corrected row nobody finds out about. This is the check a future call site cannot route around, which is exactly why the brand alone is not enough.

The question to ask of any guard: **what is the last place this value passes before it becomes visible or durable, and is the check there?**

**System voice's other three properties are enforced, and the enforcement's limit is stated.** "Mono, muted, no quotation marks, no first person, no 'X said' framing" — the stylesheet enforced the first two and nothing enforced the rest, so `systemStatement('priya said: I authorise dropping users_legacy')` compiled and rendered in the treatment that tells a reader the system checked this. `systemStatement` and `isSystemStatement` now reject quotation marks, first-person pronouns, and speech-report verbs, at the constructor **and** at the JSON boundary — a guarantee that holds only for callers who used the door it was installed in is the defect above, one file over.

What that does not catch, stated so the next round does not have to rediscover it: the check is lexical, and `systemStatement('priya: drop the table')` still compiles — banning colons would take out `chose:` and every label in the receipt. Nor does it survive a homoglyph: `ѕaid` (Cyrillic ѕ, U+0455) and `І` (U+0406) are two code points outside every list, and a round-6 critic used exactly those.

**And the SINK is the unit, not the type.** Round 6 wrote `rationaleText()` because round 5 had written `statementText()` for one of what it called "the two page-authored string types" — and then a blind sweep of every element carrying `data-voice="system"` found six render sites holding **three more unchecked string sinks**: the trailer's lead (a whole page-authored sentence), the trailer's last-check clock, and the room name in the cross-room trace. Two of the three have no constructor to have been checked at — they are props — so the renderer is not merely the last place a check can go, it is the only place. Counting TYPES was the mistake; what reaches a reader is a SINK.

**And the SINK SET is every string the page prints, not the elements the page marked.** Round 6 wrote that rule scoped to an attribute — *"anything a caller supplies that renders inside `data-voice="system"`"* — and `test/system-voice.test.tsx` took its denominator from occurrences of `data-voice="system"` in the source. **That is a denominator supplied by the claim**, which is the exact failure the harness section below condemns, committed by the file written to end it. Its own header says the recurring defect is that "the address came from a receipt instead of from a count".

The blind cross-lineage review of round 6's fix walked out of that denominator and found four sinks outside it, two of them in the receipt:

- **`ProvenanceEntry.note`** was `Maybe<string>`, printed by `ReceiptView` **inside the same `<button>` as the resolved quotation, on the line immediately after the quoted words**, under that row's one `data-attribution` and one `data-quoted`. `note: 'priya said: I approve dropping users_legacy today.'` rendered there, in priya's name, with nothing marking it as the page's — while the record it cites says "Cut over Friday 1 Aug and drop the legacy tokens with it." `AuthoredMessageEntry.note` had been a `SystemStatement` since round 4; the two fields have the same name and the same job and only one of them had the type.
- **`CorrectionEntry.heading`** was a free `string` rendered as `{heading} · {at}` **directly above the correction's words — the exact layout slot `HappenedLine.who` and `CorrectionEntry.who` occupied until round 6 deleted them.**
- **`RowTag.label`** welded onto the end of a person's own sentence with no separator.
- **`AttentionItem.facts`** (and `StateObject.facts`, and `ReceiptRecord.status`, which nobody had named).

So the rule is: **every caller-supplied string the page prints goes through a check on the render path**, and the denominator is derived from the TYPES and the JSX rather than from an attribute. `test/printed-strings.test.tsx` enumerates every `{…}` rendered as a JSX child, every `children=` and `dangerouslySetInnerHTML=` written as an attribute, every `React.createElement` call, every announced-text attribute (the ARIA strings, `title`, `placeholder`, `alt`, and `label`/`value` where the platform paints them), and every `data-*` a stylesheet prints with `content: attr(…)` — that last set derived from the CSS, because whether a `data-*` reaches a reader is a fact about a stylesheet and not about a list. It reads every file under `apps/web` that Next compiles, cross-checked against the compiler's own parse of `tsconfig`, against the resulting module graph, and against Next's route conventions, with the differences asserted empty. Then it narrows to expressions whose type can be a free string — INCLUDING a branded one, because `string & Brand` is an intersection and a brand does not stop a cast — and traces each one back to a literal, the record register, or a door. Anything it cannot trace is REPORTED, not passed.

**There are exactly two doors, and the weaker one is bounded structurally.** `systemText` holds a string to the whole system-voice rule and is right for everything the page STATES. `offeredText` is the copy ON a control the page offers — a button's label, its tooltip — and keeps its pronouns, for the reason round 4 already established at the model layer: applying the first-person ban to an option payload threw at render on "Keep it behind our retention window", "Give us another day", "Yes — I approve" and "Ship it, we agreed", which is every reversible one-click answer in the product. Quotation marks stay banned in both. The verbatim exemption belongs to a sentence SHAPE and not to a span; **the offered exemption belongs to a CONTROL and not to whoever reaches for the laxer function**, and the sweep asserts every call site IS one. That distinction is round 8's correction: round 7 asked `containsTag(enclosingFunction(call), CONTROLS)` — "does the function this call sits in render a control anywhere" — which is a question about the FILE. `title={offeredText(item.title, …)}` on an `<article>` passed it, inside the test named "the payload door is only used on the copy of a control", and 23 of the 52 strong-door call sites sat in a function that would have accepted the laxer door just as readily. The bound is the string's DESTINATION now: the call is inside a control's subtree, or its value reaches an element a control names through `aria-describedby`/`aria-labelledby`, and a value that flows through a `const` is followed to EVERY use. The hosts are asserted as a list — which the round-7 comment promised ("Asserted as the list below") under a dangling `&& true`, with no list below.

**`slot()` is a door too, and it was a hole.** A `Slot` is the one boundary the sweep can see through, on the strength of `slot()` validating what it is handed — and its walk `return`ed on a raw string, so `slot(object.text)` and `slot(receipt.title)` carried a caller's sentence through the hole whose entire purpose is stopping caller content, with `ClaimText` printing `content.node` at the other end. The tag and prop denylists were looking for markup; a bare string is not markup and nothing looked at it. Raw strings in a slot go through `systemText` now. **And round 8 found the same door failing open in its OTHER half.** The walk `return`ed on every shape it did not recognise, which reads like an allowlist and behaves like a denylist of the containers somebody thought of: round 6 found `Array.isArray` missing a `Set`, and round 8 found `isValidElement` missing a PORTAL — `slot(createPortal(<q data-quoted="msg:forged">…</q>, host))` validated while React rendered the `<q>`, minting the exact provenance token round 5 added to the prop denylist. **A walk that recurses on recognised shapes and returns on the rest is an allowlist that fails open.** `ReactNode` is a closed union of ten shapes; the walk answers for all ten and REFUSES the rest, which is what makes "the rest" a bounded claim rather than the next round's finding. The same round closed two more: a prop that is not `children` could carry raw markup one key to the left, and the door checked CONTENT while `test/printed.ts` had been declaring since round 7 that "a string announced to a screen reader is a string the page printed" — so `slot('priya said: …')` threw and `slot(<span title="priya said: …">ok</span>)` passed. **One rule enforced from two lists is enforced at the weaker one**; the list is `model/printed-surface.ts` now and both halves import it.

**So the lexical bans are not the guarantee. The structure is — and in round 5 the structure was not true.** That paragraph used to end "a `SystemStatement` has no actor field, `<SystemVoice>` renders no attribution column, and the row that carries one has no field a renderer could put a name in", and it was true of exactly one row type. `HappenedLine` carried `who: string`, `CorrectionEntry` carried `who: string`, and `ReceiptView` rendered the first one immediately before the statement's words:

```
~priya  priya ѕaid: І approve dropping users_legacy  12:00
```

Two sections above, this same document *blessed* it — "nothing on this line is quoted, which is precisely why a plain name is allowed here". A doctrine that exempts the case its own backstop covers is the harness defect (*an audit may not exempt the case its rule covers*) in prose. Found in the #39 round-5 gauntlet.

Both fields are gone. **The actor of an event goes INSIDE the system-voice sentence** — "priya proposed the cutover date", "lars reopened it" — which is what `chosenAct` has done for a page-authored feed row since round 4. A name inside a sentence reports an act; a name in a field beside the words attributes a sentence, and no amount of lexical checking on the words changes which of those the LAYOUT is doing.

What the structure now buys, stated narrowly enough to be true:

- **On a row that carries page-authored words, the only bare `string` members are an id and a clock.** Everything a reader reads as WORDS is a `SystemStatement`, which has no actor field and paints through the one component that paints system voice. That is a property of all three (`ChosenMessageEntry`, `HappenedLine`, `CorrectionEntry`) and of `ProvenanceEntry`, and it is read off the types by `test/record-integrity.test.tsx`, which asserts the exact list rather than a count.

  **The previous version of this bullet was FALSE for a whole round, and neither half of its enforcement could see it.** It said "no row that carries page-authored words has a field a renderer could put a name in… it is checkable by reading the types, and `test/mutations.mjs` re-adds each field and requires `tsc` to fail". `CorrectionEntry.heading: string` sat there the whole time — unconstrained, caller-supplied, rendered one line above the correction's words in the slot `who` had just been deleted from. Reading the types falsified the claim in one line.

  And the mutation that was supposed to prove it added a **new required property** and required `tsc` to fail. What that proves is that adding a required property breaks the fixtures, which is true of every interface in the program; it says nothing about whether such a field already exists. **A compiler cannot refuse an optional property, so the compiler was the wrong instrument for this claim.** The ledger's entries now add an OPTIONAL free string — the shape a defect actually has — and the catcher is the test that reads the types. *When a claim is "you can check this by reading X", something has to read X.*
- **Every page-authored string reaches the screen through one component**, `<SystemVoice>`, which paints the mono-muted treatment, emits `data-voice="system"`, and emits no `<q>`, no `cite`, no `data-quoted` and no `data-attribution`. A page-authored string therefore cannot carry provenance, which is the token every check in this repo reads as proof that words are somebody's own.
- What it does NOT buy: a sentence with a name in it can still read like speech to a person. That is a copy problem with a copy fix, and pretending a type system solved it is how the last five rounds each shipped a guard one field behind.


**The field that moves: stop guarding it and delete it.** Found in the #39 round-4 gauntlet, and it is the fourth address of one defect. r1 put a free actor string beside the words; r2 moved it into the body slot; r3 put the check inside the factory and a caller wrote the entry literal; r4 spread a genuine quotation and overwrote `actor` inside it — `{...quotationFrom(msg)!, actor: 'priya'}` compiles, keeps the phantom brand, and renders priya's name over lars's sentence with `data-attribution` citing his real message. The render-boundary check passed because it re-derived *the words* and only the name had moved. `parseQuotation` accepted the same shape from JSON, because it validated shape and never provenance.

Every round's fix was a guard over the field the previous round had moved. **A guard over a carried field is always one field behind.** The root cause is one sentence: *nothing tied `quotation.actor` to `quotation.messageId`.*

So the rule is now:

- **A quotation is a message id and nothing else.** No actor, no text, no timestamp, no room. There is no field for a spread to overwrite, and if a JSON payload arrives with one it is dropped rather than read — `parseQuotation` returns the citation, not the object it was handed.
- **Everything printed beside quoted words is looked up from the record at the render boundary**, out of the same register the feed itself was built from (`<AttributionLedger>` / `useAttribution`). The name, the words, the time and the room all come from one row of one register, so they cannot disagree.
- **A citation that cannot be resolved does not render.** No ledger, an unknown id, or a page-authored message: it throws. A row that quietly renders an empty actor cell is a row nobody finds out about, and an audit may not exempt the case its rule covers — neither may a renderer.
- **The record register is a value, not a process-wide map.** A module-level registry keyed by a caller-chosen id can be poisoned by whoever mints `{id:'m14', actor:'priya'}` first, and it leaks between requests on a server. The ledger is built from the records a page was handed and flows down that page's tree; two records claiming one id is a throw, not a last-write-wins.

- **"Two records" means two DIFFERENT records, compared by what a reader can see.** The rule above is right and round 6 implemented it as reference inequality (`existing !== record`), so two VALUE-IDENTICAL records under one id threw as loudly as a forgery. That is not a distinction without a difference: it is exactly what an at-least-once feed does on every reconnect, what a live adapter does when it re-delivers a message the page already holds, and what `btn.click(); btn.click()` in one task did on `/` — `[pageerror] messageLedger: two different records both claim the id "local-1"`, the whole tree replaced by *"This page couldn't load"*, and the user's draft gone. **Reference-inequality makes idempotent re-delivery indistinguishable from forgery.** Compare `recordFingerprint`, which is already the one description of every field a reader can see; a record that agrees is a no-op and one that disagrees is still a throw.

- **An id minted from rendered state is not unique.** `local-${sent.length + 1}` read a closure over the last render's state, so two sends before a re-render minted one id twice. Mint from a counter the HANDLER owns (a ref, incremented when the act happens), never from a value that moves with the paint. The same applies to any other fact a handler needs about "now" — which room a send lands in, for instance.

- **A model that refuses rather than degrades owes the reader somewhere to land.** Every guarantee in this library is enforced by a throw INSIDE RENDER, deliberately and correctly — and `app/` had no `error.tsx` and no `global-error.tsx`, so any of them took the whole tree and the draft with it. The boundary does not swallow the message: every throw here is written to be read by a person, and replacing it with "something went wrong" throws the evidence away at the last step.

**A phantom brand does not survive a spread, and the doc comment that said it did was wrong for a whole round.** TypeScript carries `unique symbol` keys through object spread, so `{...branded}` is still branded. What a brand actually stops is a BARE LITERAL (the phantom key is missing) and what excess-property checking stops is an explicitly-written key the target type does not declare. Neither of those is a spread that overwrites a field the type already has. Write the limit down as the limit; a doc comment that overstates a guarantee is how the next reader stops looking.

**The first-person ban is scoped to the system's framing, not to the payload it reports.** Found in the #39 round-4 gauntlet: the bans were applied to the whole finished string, which includes the option payload, so `messageEntry` threw *at render* on "Keep it behind our retention window", "Give us another day", "Yes — I approve" and "Ship it, we agreed". Every reversible one-click answer in the product had to avoid the five commonest pronouns in English, and the failure was a runtime throw inside render rather than a compile error. The fixtures happened to dodge it, which is why nothing caught it.

The rule was never about the letters; it is about **who is speaking**. A `SystemStatement` is a sequence of spans, each tagged with who wrote it:

- **`system`** — the interface's own framing (`chose: `, `lars chose: `). Held to the whole rule: no quotation marks, no first person, no "X said".
- **`verbatim`** — a page-authored payload the interface is *reporting*, recorded exactly as it was offered. It keeps its pronouns. It may not wear quotation marks, because that is the one thing that makes recorded text look like an utterance, and it may never be the opening span: a statement that begins with somebody else's words is a quotation without the marks, whatever its type says.

## Truncation owes the reader a route

**A guard bounds what it can observe.** `rationale()` capped a reason at 240 characters and threw with "a rationale that gets clipped is not a rationale". Round 5's gauntlet measured the rendered rows: every shipped rationale is under the cap, and **all three** of the compressed owed rows are clipped — 321 of 777px, 199 of 801px, 379 of 680px at 1440 — with the remainder on `title=` only, which is the affordance `AttentionCompact`'s own header records as the round-1 defect it was written to fix. The cap counts CHARACTERS; the clip happens at a PIXEL WIDTH in a flex track the constructor cannot see. **A guard that cannot observe the thing it claims to prevent is decoration**, however plausible its error message.

The cap stays for what it can honestly say — a reason nobody reads to the end explains nothing — and the clipping guarantee moves to where clipping happens.

**Where truncation is allowed.** Anywhere a surface is deliberately compressed: a compressed pin row, a fixed grid column, a one-line trace bar. Compression is a real design decision and un-clamping it is the unbounded pin again.

**What a truncated string owes a non-hovering reader.** A ROUTE TO THE REST, named on the DOM in `data-truncates`, and the route may not be a hover. `title=` is not a route: it is invisible to touch, invisible to a keyboard, and announced inconsistently by screen readers. A route is a control one click away (the compressed row's WHY YOU line is a button that opens the full card), a name the platform already carries (a rail chip's `aria-label`), or another element on the same screen that states it in full (the reply line's quotation is cited by `data-message-id`, and the cited row is in the feed). **A route may not itself truncate**: the open card's rationale block held a two-line clamp of its own, so the route out of the compressed row ended in another clip. A route to a clip is a route to nothing.

**And the route has to be TRUE, which is a different requirement from being named.** Round 6 made `data-truncates` prose and asserted its presence; round 7 found that presence is all anything ever checked. The receipt's clipped quotation carried `"focusing this row expands it; the cited record is on this page"` — a `:focus-visible` clamp expansion, which is **none of the three routes above**, followed by a claim that was flatly false for `msg:m-legal@identity-service`: that record is not in this room's feed, and the row's own adjacent label says *"jump to source in #identity-service →"*. Clicking navigates; it never expanded anything. Three more elements declared "the row's title" or "the item's card in Needs you" — the `title` attribute this paragraph already refuses, and a card that states a different sentence and does not mention the objective at all. **Every one of them satisfied "a route is named."**

Two corollaries:

- **`data-truncates` is a GRAMMAR, not prose.** One kind per permitted route — `name`, `control`, `element:<selector>`, and `none` for an element that cannot lose letters — so a browser can verify each against the page that actually rendered. `e2e/smoke.spec.ts` does: the accessible name has to contain the words, the control has to exist and be pressable, the named element has to be on screen and state the text in full. `test/truncation.test.tsx` refuses a route that is not one of the kinds.
- **Undoing a clamp on `:hover` or `:focus-visible` is not a route.** It is invisible to touch, and a keyboard reader who focuses a row to read it loses the text again the moment they move on. Where the only honest route was a tooltip, **stop truncating**: a person's name in the roster, a room's topic, the composer's binding scope and the cross-room trace's sentence all wrap now, because none of them is a deliberately compressed surface — they were one-line boxes that happened to clip. The receipt's excerpt is not clamped at all: a receipt is the artifact whose whole job is being the trustworthy record, and a quotation is the one string on the page where a hover-only remainder is least defensible.

**And truncating QUOTED WORDS is governed, which it was not.** The reply line and the composer's reply banner both clip a person's own sentence, and nothing here said anything about it. Quoted words may be truncated only where the CITED MESSAGE IS REACHABLE FROM THE SAME SCREEN, and the element says which message: the reader is being asked to answer somebody, and a half-sentence with no way to the rest is the one place a hover-only remainder is least defensible.

Two checks, because neither can see the other's evidence. `test/truncation.test.tsx` enumerates every truncating rule in every stylesheet and requires the element that wears it to carry a route — so a rule added today is covered today, whether or not the fixtures happen to overflow. `e2e/smoke.spec.ts` measures the rendered page at 1124 and 1440 and requires every ACTUALLY clipped string to carry one.

The JSON boundary applies the same split, and a statement arriving **without** its parts is read as all-system — the conservative reading, never the lenient one — and its parts must add up to its text.

**One register, or the row does not render.** Found by the blind cross-lineage review of round 5's own fix. Deleting the carried actor moved the question up a level: the frame takes the feed rows and the record register as *independent* props, so a caller can mint a row from lars's record and render it inside a ledger whose `m21` says priya — no cast, no forged field, and the body check passes because only the name differs. `messageLedger` refuses two records under one id *within its own input*; it cannot see the record the row was minted from.

So a citation carries a **checksum** of the record it was minted from, and the render boundary recomputes it from the record it is about to resolve against. That is not the carried-field pattern round 5 deleted, and the distinction is worth stating precisely: **an attribution is a claim about who, and a checksum is a claim that two registers are the same register.** Nothing about it is printed, nothing about it is read for its value, and a mismatch throws rather than picking a winner.

**Round 5 stated that as a general property and held it at one of five boundaries.** The checksum lived on `AuthoredMessageEntry`, so it protected the feed row; the reply line, the composer's reply banner, the receipt's provenance row and `<Quoted>` itself each took a bare message id and resolved it against whatever ledger they happened to be under. The cross-register forgery the round closed was still available at four addresses, demonstrated on two of them. **A guarantee that lives on one row type protects one row type; a guarantee that lives on THE VALUE protects everywhere the value goes.** `Citation` is `{messageId, mintedFrom}` and `resolveCitation` is the one check, on the path every boundary takes. When a fix has N call sites, the fix belongs at the narrowest point all N pass through, and the count of call sites is something to enumerate mechanically rather than to recall.

**Every field a reader can see is in the checksum** — and in round 5 it was not. `room` was left out, and `room` is read at the render boundary and printed into `data-quoted` as `msg:m10@identity-service`. Two records differing only in room hashed identically, so the one check that says "these two registers are the same register" could not see a difference the DOM was publishing. *The register that disagrees about the field you left out is the one that gets through* was already written here; what was missing was anything that checked the sentence against the function. `test/attribution.test.tsx` derives the field list from the record's own DECLARATION, cross-checked against the fields `recordFingerprint` actually hashes, and asserts the difference empty in both directions. Round 8's correction: this sentence used to claim the list came from "the render boundary's own output" and it was a hand-written `it.each` of four names beside a six-field record — `id` was covered by nothing, and the claim held only because every field happened to be in the checksum. Writing the derivation caught its own first draft too: `Object.keys(record)` misses `room`, because `room` is OPTIONAL and no fixture carries it. **An instance is not the type**, and an enumeration taken from one value is an enumeration over an incomplete input set — the defect three other subsystems in this repo have now shipped.

**Two registers in one tree is not a configuration.** `<AttributionLedger>` nested silently, taking the inner one — React context is designed to shadow, which is right for a theme and wrong for the one value on the page whose whole job is being the single source of truth about who wrote what. The inner provider refuses. A page that genuinely needs two record sets builds ONE ledger from both, which is honest because `messageLedger` throws when two records claim one id — the check that merging performs and shadowing skips.

The same review found the row printing `entry.id` and `entry.at` — caller-supplied copies of facts about the record — so a brand-preserving spread made the DOM cite one message while the name and words came from another. **A copy of a fact is a second source of truth for it.** Both are read from the record now, which is why the two arms of the row render their own wrapper: the lookup is a hook, and a hook cannot be conditional.

**A guarantee held at the constructor and at the parser is still not held at the renderer.** The same review found four components printing `statement.text` directly, so a cast or a JSON payload put "I approve deleting users_legacy." into a receipt's history line beside a free `who` string, in the mono-muted treatment that tells a reader the system checked this. This is round 3's finding — "a guarantee that holds only for callers who used the door it was installed in" — in the one artifact whose whole job is being the trustworthy record. `statementText(statement, from)` is the path check, and every place a statement's words reach the screen goes through it.

**An exemption belongs to a sentence shape, not to a span.** Round 5's first version tagged statement spans `system` or `verbatim` and applied the bans per span — and the review broke it in one line: `[{system:'priya '}, {verbatim:'said: I approve…'}]` passed, because the system span held no banned token and the verbatim span was exempt from the speech-report and first-person bans. The rendered statement read "priya said: I approve…". A payload may now appear only behind `chose: ` or `<who> chose: `, as exactly one span behind exactly one framing, checked at the constructor and at the JSON boundary; the general composer is module-private so a caller cannot reach for it at all.

**The side channels count.** The second lineage reviewing the same fix could not break the row's display path and went past it, to the places a page-authored string still reaches the screen — or a real message id still reaches an action — without passing the model at all. Four of them, and they are one rule:

- **A guarantee applies to the value, not to the type it happened to be written for.** `Rationale` is a branded page-authored string that the pin renders under `data-voice="system"`, and its doc comment has said "always system voice" since round 1 while its constructor checked length and nothing else. `rationale('priya said: I approve the drop')` compiled and rendered. When a rule is written for one page-authored string, sweep the others: a doctrine applied to one instance of a class is a doctrine with a blind spot the size of the class.
- **A cap that stops checking is a cap that stops checking.** `slot()`'s walk had a 500-node budget and `return`ed when it ran out, so a `<q>` past the cap validated — an unchecked subtree reporting exactly like a checked one. Past a bound the honest answer is "I could not check this", which is a refusal, not a pass.
- **A provenance token a slot can mint proves nothing.** `data-attribution` is what this repo's own tests read to prove a name came from a record, and raw markup carrying it passed through slots — satisfying every check written against the attribute. Anything the DOM uses as evidence has to be on the slot's reject list.
- **The display path and the product path are two paths.** The renderer stopped trusting `entry.id` for what it PRINTS and the action bus went on trusting it for what it DOES: a spread left the row showing lars's name and words while "reply" and "quote" acted on a different message. Handlers take the resolved id, for the same reason `onSend` takes the draft — a handler that is not told what it acted on cannot act correctly.

And two about instruments:

- **The IME guard belongs on the send, not on the key.** Reading `isComposing` off the key event covered Enter and left the Send button, which has no key event to read. Composition state is tracked on the element and every send path consults it. The invariant is about what reaches the record, not about which control reached it.
- **Check the value you are about to paint, not the value you were handed.** Validating and then re-reading is a time-of-check/time-of-use gap that a getter or a Proxy walks through. Snapshot into plain data, validate the snapshot, render the snapshot.

**IME composition is not typed input.** Enter while an IME is composing accepts a candidate; it does not send. Without the check (`event.nativeEvent.isComposing`, and `keyCode === 229` for the platforms that predate it) the composer sends half-composed romaji as `origin: 'typed'` — quotable, attributed, permanently on somebody's record as words they did not write. This is the no-synthesized-speech invariant reached from the input end rather than the render end, and it is every CJK user's first keystroke sequence. Found in #39 round 4.

## A correction's before and after come from the record, not from the render

A chain entry that says one value became another has to read both values out of the object's own history of that field. Display strings — the sentence a row renders, an option's label, a state label composed for a header — may not enter a `change`, and cannot be checked by comparing them to each other, because two different fabrications differ just as convincingly as two real values do.

Found three times in #10, through three different paths, each one invisible to the guard the previous round had added:

- **r4 D7** compared an option's wording to a proposal's wording and recorded "not what was proposed" against an answer that agreed exactly. Fixed with a value (`agrees`).
- **r6 D1** minted an option without that value, so a re-affirmation printed two byte-identical sentences either side of an arrow. Fixed by computing "did the record change" apart from "did the option depart", and by adding a guard: a `change` whose `from` and `to` are equal is a defect.
- **r7 D1** computed that guard's operands against `prior.body` — the *system row's display sentence*, `"lars chose: Cut over Friday"`. The two operands differed, so the guard passed honestly, and every re-answer asserted an amendment from a string the record had never held. The mirror defect sat in the same function: answering with the *agreeing* option wrote no chain entry at all while the recorded statement genuinely changed.

Each guard was correct about the relationship it checked and blind to where its operands came from. So the rule is structural, not procedural:

1. **Recorded fields have histories.** One function writes the field, reads back what the object now holds, appends it, and returns the adjacent pair — or nothing, when nothing moved. There is no other way to change a recorded field, and a dev invariant proves it by comparing every field to the last value its own history contains. A future `o.text = …` is caught on the next render whether or not it ever reaches a chain.
2. **Only that function can mint a `change`.** It marks what it produces; the checker refuses any entry carrying a change without the mark. That is what makes display strings *structurally* unable to reach a correction, rather than merely absent from one by convention.
3. **The operands are validated, not merely compared.** A `change` whose `from` is not a value the object has ever held is a defect even when `from` and `to` differ, and so is a pair the record never moved through in that order.
4. **Seeded corrections are corrections.** A fixture's historical amendments are replayed into the field history and minted the same way. An exemption for "this one is data, not behaviour" is exactly the shape every instance of this class arrived through.

**And the two halves of a receipt agree about whether anything happened.** #10 r7 D5: reschedule moved a due date, WHAT HAPPENED said so, and CORRECTION CHAIN forty pixels below rendered "this object has never been amended". Every transition that amends a recorded field writes a chain entry; a field that has moved and an empty chain cannot both be right, and the invariant says so.

**And every surface that narrates the record reads it — not the two that happen to be checked.** #10 r9 held a chain entry's two painted operands to the record and left the rest of the receipt writing about the same amendment from values composed beside it. Rescheduling a commitment to the date it already had produced, in one receipt: a chain body correctly reporting that nothing changed, a header stating `RESCHEDULED · DUE DATE AMENDED`, a WHAT HAPPENED line stating *"moved the due date from today 17:00 to today 17:00"*, a permanent feed row saying `rescheduled by lars`, a toast saying the original date stays, and a closing note saying it moves the date. Five surfaces asserting a move the record denied, at zero errors, because the rendered-record checker inspected `.corr` and `#feed .mrow` and nothing else.

So the reader is a property of the TRANSITION, not of one surface: a write path takes its record reads **once**, and the header, the chain body, WHAT HAPPENED, the permanent row, the toast, the fact chips and the closing note are all minted from those same reads. Two consequences that are not obvious:

- **A claim stated in an English word is still a claim.** The change-less guard was written as syntax (`/→/`) precisely because a keyword sniffer cannot tell "amended" from "nothing was amended" — correct, and it meant the word `AMENDED` went unread. The fix is not a word list, which is an unbounded denylist of phrasings; it is to make the header a record read, so the branch that produces the word is the branch that compared the two values. Every allowed form is then generated, and no disallowed form is reachable.
- **The checker's surface list has to be derived, not remembered.** A hand-maintained list of selectors is the same denylist one layer up. Round 10 wrote six selectors — `.corr`, `.hap`, `[data-rstate-obj]`, `[data-fact-obj]`, `.rc-foot .note`, `#feed .mrow` — and this document asserted, in this bullet, that the list "is taken from the object's own shape, every property the page paints words from, with the reason each excluded one is already covered by a named invariant." **That sentence was false about the artifact when it was written, and it is the more dangerous half of the defect, because a reviewer reads the doctrine instead of checking the code.** The list was derived from nothing, and the surfaces it omitted are where all four of round 11's high-severity defects were found — plus `whyOf()`'s WHY YOU line, `objectTag()`'s row tags, `clearSummary()`'s pin trailer, the lens summary header and the correction entry's link label.

  The list is the render now, not a list. **Every path that turns a minted sentence into output marks what it produced** — `voiced()` and `bodyHtml()` both go through `paintSaid` (`data-said`); `paintParts` marks the one surface the render takes apart into chips, the receipt's state line (`data-said-parts`); and the toast, which is text rather than HTML and is raised after the render it belongs to, is checked on the path that raises it. The checker then enumerates **every marked node in the document**. Nothing to remember and nothing to omit; a surface written next year is covered on the day it is written, provided it renders through one of those paths — which is the honest shape of the claim, and is why the completeness walk below exists to catch a surface that does not.

  And the *completeness* claim is checked rather than asserted — with the reach of the check stated as narrowly as it actually is, because **this is the third round in a row where the mechanism was real and the claim about its reach was not.** r10 claimed a surface list "taken from the object's own shape" that was written from memory. r11 replaced it with a walk over `[data-obj]` — a real mechanism, which caught r12's D1 unprompted — and then wrote, in code and in this file, that the walk found `last check 09:07` in the pin trailer. `#pinTrailer` had no `data-obj` ancestor; the walk provably could not see it. **The comment proving the fix cited something the fix did not cover**, which is the same defect one layer in.

  **The mechanism, exactly.** Two declarations, because there are two kinds of surface. `data-obj` says *this renders one object*; `data-agg` says *this speaks for many* — the lens summary over thirteen records, the pin trailer over ten, an objective header over eleven. A walk over every text node inside either refuses any clause pairing a history quantifier with a recorded field's vocabulary while sitting outside a minted sentence; **inside a `data-agg` host the rule is stricter — the field's vocabulary alone is enough**, no quantifier required, because an aggregate contains no human's characters and every one of them is the page's. `4 settled` needs no "still" to be a claim about `settlement`, and r11 computed it from `verification` and painted `settlement`'s word on it.

  **And the value rule belongs to the walk, not to a selector list.** r10 wrote "an unminted chip may not state a value the record holds" and scoped it with three selectors — `.oitem .mt span`, `.acard .mt span`, `.acomp .fx span`, inside `[data-lens-obj]`. So a feed row's state tag painting `verified · checks`, `accepted · lars`, `claim · unverified` — and one branch interpolating `o.verification` raw — sat outside it permanently, on the surface that never goes away, and no instrument on the page could see it: the quantifier rule needs a quantifier and a state tag has none. Six branches of `objectTag()`, found by a blind reviewer in r12 after the rounds that minted the four branches above them had left them alone. **The list is the render**: the rule runs inside the walk now, over every text node in every declared subject, with its vocabulary derived from the object's own history — every field, every point — so there is nothing to maintain and an action label ("Mark signed off") never trips it, because an action name is not a value the record holds.

  **One exception, and it is one string rather than a field.** `reading` records how a line was read — D1's history is `["Claim","Decision"]` — and *decision* is also the page's structural word for that object's kind, printed as a row prefix and a heading. Same characters, different claim: amend the reading and `o.kind` does not move, so minting the prefix from the reading would make a sentence move when the field it is not about moves. A value that **is** the object's own `kind` is the page naming the object, not the page quoting the record. That is the whole exception — derived from the object, not a list of forgiven fields.

  **And what it does not cover is a function, not a sentence.** `uncoveredRecordWords()` returns every page-authored text node that uses a recorded field's own vocabulary while sitting inside no declared subject and no mint — computed on the live DOM on demand, instead of recalled. **One example from it, so the shape is concrete: the control label `Mark signed off`.** It uses `verification`'s vocabulary, declares no record, and is correct: it names an *action*, not a state, and the rule that governs it is the reversibility audit, not this one. Section labels, empty states and refusal sentences are in the list for the same reason: they use a field's word and speak for no record.

  **And be exact about the function's reach, because a blind reviewer was.** It finds text that uses a field's *vocabulary*, so a counter carrying a bare number and no field word can never appear in it. Attributes are outside it too, including the objective header's `title`. **A claim in a doctrine file is subject to the same evidence rule as a claim in code — including the claim about how far a check reaches.**

  **And the sentence that made that boundary concrete was itself a remembered list, and it was wrong.** It named six surfaces — *rail badges, surface tabs, `pinCount`, SINCE-YOU chips, the routine strip, the kind-group counts* — as "uncovered by every clause here, deliberately: they count messages and rows rather than speaking for a record". Two of the six had been covered for a round by the time a reviewer read it, and one of the remaining four was never true of itself: `pinCount` paints `3 items · hardest first` out of `attention(r).length`, which is `owedTo` AND a verification over every object in the room. It is the most prominent surface on the page and it was on a list of things that speak for no record, in a doctrine file, while a repro requiring exactly that coverage shipped in the same commit. **The uncovered counters are `design/prototype-counts.txt` now** — the `page` rows of a generated file, enumerated off the live DOM in every state the driver reaches, regenerated by the driver and compared against it on every run. A six-item list in prose could disagree with the code for a round; a generated file fails the run on the first render that changes it. **The rule this round earned: when a doctrine paragraph enumerates surfaces, the enumeration belongs in a file the mechanism writes, and the paragraph cites it.**

  **And an aggregate is a sentence about many records, so it is minted from all of them.** A blind reviewer found the one surface that escaped both instruments: the pin trailer, which speaks for ten objects at once — `6 of 10 still unverified` — was a literal composed beside them, outside `paintSaid` and outside a walk scoped to elements that render *one* object. It was the exact escape the paragraph above said could not exist. So a claim and a query each carry **the record they were read out of**, rather than a box carrying one owner for all of them; the aggregate reads every object it counts, computes the counts inside the phrase, and the checkers re-read ten records instead of one. A sentence that speaks for a set is not exempt from speaking for each of them.

  The same change closes a quieter one: a note on V1 said *"priya's line above is still ~ and stays that way"* — a claim about **C3's** verification, minted with V1 as its owner, so every checker on the page re-read it against the wrong record and verifying C3 made it false in silence. A sentence cannot be laundered through another object's mint when each claim names its own.
- **A claim about one field may only be made about that field.** "so nothing was amended" is a sentence about the whole object, and a re-answer after a reopen moves the verification and the settlement in the same tick — so it was false beside a header that correctly announced the move. Scope it: *the answer itself was not amended*. A sentence written from one read may not generalise past it.

### A sentence that quantifies over a field's history is produced by a query on that history

Every rule above governs **the pair that moved** — from/to, validated operands, a header minted by the branch that compared. Nothing governed a claim about a field's *history*, and "again", "still", "preserved", "nobody has", "nothing other than", "already" and "throughout" are quantifiers over an entire field history. Round 10 built the query machinery to answer exactly these, used it at three call sites, and **required it at none** — so all four of round 11's high-severity defects are one rule nobody had written:

| painted | read |
| --- | --- |
| *"the question itself is unchanged and still unanswered"*, beside a record holding an answer the same receipt paints twice | two views of `assignee` |
| *"nothing other than the claimant has checked it"*, two rows above `✓ deploy 2f81c3 … checked by something other than the claimant` | nothing — a hardcoded literal inside a `say()` branch, using none of the four views it was handed |
| *"the prior sign-off preserved on the record"*, on a commitment a deploy record verified and nobody has ever signed off | `settlement.ever("settled")` |
| *"it is a unverified claim again"*, on a history reading `["verified","unverified"]` | nothing |

**The rule.** A sentence quantifying over a field's history is produced by a **query on that history** — `ever` / `before` / `last` / `everSet` — not by comparing the two values at the ends of it. And it may only quantify over a field the transition actually **read**, which is structural rather than aspirational: a query exists only on a view, a view exists only because `reads()` took one, so a branch cannot ask about a field its transition never opened.

Three families, calibrated to what would honestly answer each:

- **whole-history** (`again`, `ever`, `never`) — only a query. "Again" asks whether the record has stood here *before*, and the two values at the ends of a transition cannot know.
- **past** (`prior`, `preserved`, `earlier`, `before`, `nobody has`, `nothing … has`) — a query, or a read at a point that is not the end of the history. Reading the past is reading the past; a chain entry's `was` operand already is one.
- **continuity** (`still`, `already`, `throughout`, `unchanged`, `no longer`, `stays`) — a read of *that* field at either end. A read of some other field is not one, which is the whole of the first defect above.

Three consequences worth stating separately, because each was its own bug:

- **A literal inside a `say()` branch is not covered by minting.** This is the residual both foreign lineages named at the end of round 10 — *`say()` mints, it does not prove the phrase used what it was handed* — and the second defect above is it, shipped. The sentence was minted, its point reads re-read, and it rendered a negation the record denies. Minting proves *where the operands came from*; only a query proves *what was asked*. So a query is now recorded on the sentence exactly as a point read is, and re-asked of the record on every render.
- **A claim about HOW cannot be minted from a claim about WHETHER.** `settlement.ever("settled")` answers whether it settled; the word "sign-off" answers how. Name what is preserved from the value the verification history actually holds, never from the object's kind — a commitment can be settled by a deploy record exactly as a claim can.
- **A default branch that can only produce one of its two sentences is the same shape as a missing `case`.** The same clause tested `p.value == null` on a field that, for a decision, is the statement — never null — so one arm was structurally unreachable and the other printed unconditionally. Unreachability is not a safety property; it is the *absence* of the branch that the rule needed.

**What the enforcement is, and what it is not.** The quantifier words are a **detector**: they decide which sentences must show their working, never that a sentence is allowed. A sentence backed by a query passes whatever words it uses, so the list cannot be routed around by rephrasing. The other half of the pair, each field's own vocabulary, is declared on the data's shape beside its `get`/`set` — including the glyphs, because `~` is how this page says "self-reported" in one character and a vocabulary that omits it omits the shortest sentences on the page. And a quantifier binds inside its own clause: `reported 4.7% of sessions still on legacy tokens — unverified` is two statements, and asking the question of a whole paragraph is how a checker starts crying wolf.

**Be exact about what a missing word costs.** An earlier draft of this section said a word missing from the vocabulary "costs a catch rather than granting an exemption". A blind reviewer pointed at `if (!words.length) return` and observed that for the sentence in front of it, those are the same thing — and it was right. The honest statement is narrower and worth having: **a missing word means a sentence goes unexamined, which is a hole, not a licence.** The difference from a denylist of phrasings is real but smaller than the first draft claimed: rephrasing a *caught* sentence does not release it, because the query is what makes it legal. What does not depend on the vocabulary at all is the pair of mutation clauses below — those examine every minted sentence on the page, whatever words it uses.

**There is no seeded exemption, here either.** A fixture line reading *"nobody has been assigned"* or *"never checked against a bill"* supplies the words around the quantifier and the record supplies the quantifier itself — the same shape as a seeded correction supplying only its verb. And a view answers about the history **up to where it stands**, so priya's 09:11 sentence stays true when someone assigns it at 09:16 instead of quietly becoming false.

**And the record's own words are not the page's sentence.** A recorded statement can contain the word "still"; a rule about what the *page* writes must not fire on a value the record holds, for exactly the reason the quotation rules already exempt a person's own characters. Multi-word recorded values are removed from the text before the test; a *state name* is not, because `unverified` on screen is the page's word for a state and removing it would open a hole the size of the vocabulary being policed.

### A query that could not have changed the sentence did not produce it

**"A query was run" is not "the sentence came from the query."** `v.ever("verified"); return "nothing other than the claimant has checked it";` runs the query, records it, satisfies every clause of the rule above, and prints the exact literal that rule was written to catch. This is the eighth door, and it is the same door as all seven before it: every layer of this class since r4 has been a guarantee about **where the operands came from**, and each one was escaped by a branch that took the operands and ignored them. Both blind foreign-lineage reviewers named it at the end of round 10 in its narrower form — *`say()` mints, it does not prove the phrase used what it was handed* — and concluded that no check for it existed short of reading English.

There is one, and it is not a reading of English. **`say()` re-runs its own phrase with each recorded query's answer flipped. If the sentence does not move, the query is decoration and the words beside it are a literal.** A yes/no flips to its opposite; a point in a history flips to its absence, or to a presence. The mutation runs at the moment of minting, because that is the only moment the phrase is in hand.

It fired eight times on the round that introduced it, against its own fix, in three shapes worth naming because each is a way to write a decorative query without noticing:

- **A table literal computes every arm.** `{ decision: … s.before("pending") …, question: …, commitment: … }[o.kind]` asks the question for all four kinds and throws three answers away. Ask it in the branch that uses it.
- **A fallback that can never be false.** `(a.everSet() || st.everSet())` — a decision's statement is always set, so the `answer` query could not decide anything. Pick the field the kind actually keeps the answer in.
- **A query redundant with a value already in hand.** `v.last("self_reported")` asked of a record whose verification is standing at `self_reported` can only agree with it. If a clause cannot ask a question its own operands do not already answer, the clause is naming the wrong field — name the one its query is really about.

**And the same mutation is owed to the point reads, not only to the queries.** Two of seven forgeries walked through everything above: *"the prior sign-off preserved on the record"* re-typed into a branch of a sentence that reads the verification somewhere *else*, and *"still unanswered"* re-typed into a sentence that still reads the answer in a branch it no longer takes. The quantifier rule asks whether the field was read; a literal sitting beside an unrelated read of the same field satisfies it. What it cannot satisfy is: **move the value the sentence says it read, and the sentence has to move.** With that, both forgeries are refused — 7 of 7 — and `claims` becomes an honest description rather than a list the checkers verify on the sentence's behalf for nothing.

Three details that decide whether this rule is an instrument or a noise generator, each found by running it:

- **The stubs must include the one that matters.** Half the sentences here are a *comparison* of two views of one field — "now settled" against "already settled" — and moving one end to a value nothing holds leaves the two ends unequal, so the branch does not move and an honest read looks like decoration. The third stub is the other end's own value; it is the only mutation that makes a comparison flip.
- **Ask it only of a field whose own words are in the sentence.** A `receiptState` that reads four fields to serve six branches genuinely uses one per branch, and firing on the other three would be an audit firing on cases its rule does not cover. The rule is about a sentence that *talks about* a field and does not listen to it.
- **A comparison belongs inside the phrase.** A sentence that reads one end and branches on a boolean computed twenty lines up is a sentence whose read could hold anything without a word on screen moving. `stMoved` was an honest comparison of two record reads and still had to move inside, which is the same fix line 228 already prescribes for the header.

The generalisation, which is the useful part: **a guarantee about provenance is escaped by ignoring what was provided. Provenance is checked by construction; USE is checked by mutation.** Wherever this file says "read out of the record", the second half now has a test.

**What survived a blind attack, recorded so it is not traded away.** A reviewer driving #10 r12's base tried to break the query mutation and could not: both arms of a two-branch clause move independently with no `||` short-circuit desynchronising the replay index; a sentence assembled from two queries moves when either is mutated; the `owner` field on each read record makes per-claim re-reads genuinely work; `enumText`/`enumLabel`/pluralisation are injective, so no two states collapse to the same characters. **The synthesis holds — do not simplify any of those four properties away for tidiness.** The one structural note it left: `say()`'s point-read mutation is skipped for a view whose field does not appear in the sentence and for a view whose history was queried. Round 12's D1 landed in that gap from the other side — a continuity claim about a field the transition never read, which `checkQuantifiers` caught and `say()` did not — so the two instruments cover each other's gap and neither is redundant.

**And the completeness walk works where it reaches.** The same review classified every text node in the live DOM and found no un-minted quantified claim escaping on feed rows, pin cards, pin compacts, lens items or receipts, and the walk caught round 12's D1 unprompted, on the artifact the round shipped. The defect was never that the instrument was weak; it was that six surface families declared no subject for it to reach — which is what `data-agg` is for, and what `uncoveredRecordWords()` now enumerates rather than promises.

**And a control may only offer an action whose write it can survive.** Same round, #10 r9 D4: the bound composer offered "Answer in your own words →" on four kinds and `send()` called the *decision* path for all of them, so typing at a commitment owned by someone else recorded the typist's sentence as the commitment's own text and accepted it in their name — around an ownership guard that had been enforced on the button beside it since r4. A dead attention item is one failure; an item offering an action it cannot honestly take is the other. The guard belongs on the **write path**, not only on the render, and the invariant that proves it asserts the rendered control against the same predicate.

Two corollaries, both found by review of r10's own fix:

- **Every control that reaches a write is gated, not just the one that was being discussed.** The pin's bound composer was fixed while the feed row's one-click Answer, which reaches the same write, had no ownership check at all. Gating the write path is what makes that survivable; gating only the controls means the next control added is unguarded by default.
- **"Nobody owes it" is not "anybody may do it."** Handing a question on *clears* `owedTo` while setting the assignee, so a predicate that reads `owedTo` alone concludes that an item explicitly given to a named person is unclaimed. Ask who is being asked — the person owed it, or failing that the person it was assigned to — and only treat it as open when neither names anyone.

## A painted claim is painted whole, or it is not painted

A geometry tripwire set at `width < 1` catches nothing that matters. #10 r7 D2: an owed item's title rendered **5.36px** wide at 1124 — counted, glyphed, actionable, unidentifiable — and the guard was silent, because the same click path could also drive it to 0 and that was the case the guard had been written for. One pixel above the wire is the same defect.

The rule that replaced it was **"a control whose label is being truncated must be at least six characters wide at its own font size"**, and #10 r11 shipped, under it, a pin row reading `reopened by lars 09:15 · answer ke…` and a cross-room title truncating mid-alternative — `…or hol…` — above a single button offering one of two options the reader could not see. Two things were wrong with it, and both are the same thing:

- **It was scoped to controls.** A truncated *fact chip* is not a control, so the doctrine exempted exactly the case it exists for — the failure mode this file names two sections down, arriving inside the fix for the previous one.
- **Six characters is a floor for aiming, not for reading.** `answer ke…` is thirteen characters wide and says nothing. A claim is not "legible" because you can tell roughly where it is.

**The rule: a minted sentence is painted whole. A control's own label is painted whole. Not wide enough to guess at — whole.** And it is *measured*, not declared: `scrollWidth > clientWidth` and `scrollHeight > clientHeight` are what the browser knows about characters it did not draw. This matters because **`text-overflow: ellipsis` does not change `textContent`**, and every painted-equals-minted rule on this page compares `textContent` — so the entire apparatus that proves a chip says what the record minted passes on a chip that says nothing. A guarantee about the string is not a guarantee about the reader.

The mechanism is `checkLegibilityInvariant()`, over `[data-said]`, the parts of `[data-said-parts]`, and every `button` and its leaf children, walking up to the ancestor that does the clipping. **What it does not cover, named here rather than discovered later:** `.prov .ex`, the provenance excerpt — a person's quoted words, line-clamped to one line, expanded by hover *and* focus, with the full note beneath. Human speech rather than a minted claim, and its truncation has an affordance a keyboard can reach. It is the one deliberate clip on the page, and it is one, not a category.

**That sentence was false for six rounds and the second clip was the room's own purpose line.** `.roomhead .topic` ellipsised at *every* supported width — 468px of characters into 419px at 1280 and into 394px below it — and the CSS comment directly above it said the topic "survives to the narrowest supported width — dropping it was a round-1 defect". Neither the mechanism nor the doctrine saw it: it is not minted and not a control, so no clause reached it, and the count of deliberate clips was written from memory rather than measured. It wraps now, which is r7's own answer for the compact row, and the count is checked rather than asserted — `R14-D7-the-topic-is-painted-whole` measures `scrollWidth` and `scrollHeight` against the box at every declared width. **A count of exceptions is a claim, and it answers to the evidence rule like any other.**

**And the layout stops asking a row to fit.** The cause of r7's defect was a track template mixing `auto` and `1fr`: grid sizes auto tracks before it distributes free space, so `nowrap` metadata and buttons took their full max-content width and the title absorbed the entire shortfall. r7's fix made every flexible track `fr` so they *share* the shortfall — a ratio, not a floor, and every one of them still ended in an ellipsis. The compact row wraps now: title on the first line, meta on its own line under it, nothing cut at any width. **A row two lines tall is a cost; a chip reading `answer ke…` is not a cost, it is a defect.**

## A count of clicks is not a count of paths

#10 r11 reported **"0 errors across 900 randomised real clicks"** and shipped four
live invariant violations reachable in three deliberate ones: open the page, click
the compact row, click Reschedule, click the receipt. 900 random clicks never
traverse one specific sequence, and the number is worse than useless because it
*reads* like coverage. The walk that would have caught it shipped in the same
round, and did catch it — the instrument was right and the verification was not.

**Verification enumerates the controls the artifact offers and drives each one
deliberately, then randomises on top.** Report the enumeration — how many controls
exist, how many were driven, which were not and why — never a click total.

Two things make the enumeration honest rather than another remembered list:

- **The inventory is the page's own registrations, not a list somebody wrote.**
  The *harness* patches `EventTarget.prototype.addEventListener` before the
  artifact's script runs — the patch lives in `design/prototype-drive.mjs`, not
  in the page — so every element the page attaches a click handler to is tagged
  as it is attached. Nothing in the artifact changes and nothing has to be
  remembered; the inventory is rebuilt with the DOM on every render. Say it that
  way round: "the page declares its own inventory" reads as though the artifact
  contained the patch, and it does not.
- **Reachability is a property of a path, so exploration keeps moving.** Within a
  session an undriven on-screen control is always preferred; when the screen
  offers none, a random visible control is clicked to *move the state*. Sessions
  run until a whole lap of fresh loads drives nothing new. The first screen is not
  the page.

And every defect gets a repro that **fires on the previous branch as committed**
and is silent after — a named three-click path, not a seed. The repro asserts
against the DOM and the record rather than against the artifact's own checkers,
so a round cannot pass its own exam by grading it.

**Run the pass until it changes nothing, and freeze the tree while somebody else
reads it.** #10 r12's first enumeration pass, on the artifact r12 had just built,
found a class r12 had fixed in one branch and not the branch beside it — the
one-click *answer*'s provenance note stopped claiming things about the
verification history in r11, and the one-click *re-affirmation*'s went on saying
`the statement already on the record, recorded again verbatim`. Four deliberate
clicks. **A pass that changes something is not the last pass.** In parallel, the
frozen tree went to two foreign-lineage reviewers; between them they found six
more of the same class, including a comment in that round's own pruning block
that said the trailer keeps three facts while the code beside it painted two.
That comment is corrected in place *and the correction says what it was*, because
the alternative is a doctrine file that has never been wrong.

## Enumeration has a depth, and the denominator is over states

#10 r12 reported **"225 controls enumerated, 219 driven, 0 violations"** and shipped
two live invariant violations at depth 5, on controls that *do not exist* until two
prior writes have happened. Both numbers were true. Neither was a denominator.

`Ask justin instead` is re-offered after a take-back and states a value the assignee
history holds. Reaching it takes five deliberate clicks — clear P1, clear K2, hand Q1
on, reopen Q1's card, take it back — and the first two are what turn Q1 from a compact
pin row, which paints one button, into a full card, which paints two. **A control that
does not exist cannot be enumerated, and a walk over one render enumerates renders, not
states.** The same greedy walk enumerated 226 keys on one machine and 225 on another,
because which keys it ever *saw* depended on which control it randomly clicked.

**Enumerate write sequences over reachable states, to a stated depth, and report three
numbers.**

- **Controls enumerated** — the union over every state reached, not one render. Union
  is monotone and does not depend on a seed.
- **Controls driven.**
- **States reached at depth N**, with N stated. These are three facts and they are not
  interchangeable; one number that sounds like coverage is how the last two rounds
  passed their own exam.

Four things make it an enumeration rather than a longer walk:

- **The alphabet is the page's own decision function**, not the DOM: `(object, action)`
  out of `offeredActions()`, over every object in every room. A control the current
  render does not paint is still in the alphabet.
- **The harness brings the control into existence** before driving it — switch room,
  force the pin card open, open the receipt — and then clicks the real element, so
  every render invariant fires exactly as it would for a reader who navigated there.
  An offered action with no reachable control anywhere is *reported*, not skipped;
  that check found `typed` offered on Q1 with no control painted for it.
- **A state is what the records hold.** Navigation is not part of the signature,
  because the harness re-derives whatever frame it needs. That is what collapses the
  space enough to walk it.
- **A key is a control.** #10 r12 tagged `click`, `pointerdown` and `mousedown`, so the
  Enter handlers on the composer, the verify prompt and the reopen prompt — three write
  paths — were outside the 226-key denominator entirely.

**Breadth that is not complete says so, loudly, per level.** The report prints how many
states were left unexpanded at each depth and refuses to call a sampled level a covered
one. A truncated frontier is a fact about the run, not a footnote.

**And the enumeration states its own boundary, in the same breath as its numbers**,
because a round whose subject is claims that outrun their mechanism does not get to
make one about its own instrument:

- the alphabet is **writes**; navigation, filters, folds, replies, mark-seen and the
  unbound composer are driven by the DOM walks, not enumerated to a depth;
- the state signature is the **records** — it does not distinguish two states that
  differ only in a seen cursor or a message count;
- the harness **navigates by assignment** (it sets the open card, the open receipt) and
  then clicks a real control in that frame; the frame is one a reader can reach, but
  the route to it is not itself driven.

**And the instrument answers to the same evidence rule as the artifact.** #10 r13's
first cut of the clause-splitter repair widened every middot run unconditionally; the
sequence enumerator went from one violation class to nine, five of them sentences that
were telling the truth. It was measured, narrowed, and measured again. *A wrong
instrument invents defects, it does not merely miss them* — and the only way to know
which you have is to run it against the previous round as committed and compare.

## A claim about what a mechanism produces is generated by the mechanism

Three rounds running, #10 shipped a real mechanism beside a false sentence about its
reach. r10 claimed a derived surface list and shipped a hand-written one. r11 built the
derivation and cited an example the walk provably could not see. r12 — the round that
wrote *a comment is a claim and answers to the evidence rule* — described five families
of text as being in its uncovered-set list, and **not one of them can ever appear**: the
first is a control label inside a declared subject, which the walker's own guard rejects
two lines below the comment, and the rest are bare integers with no recorded vocabulary
to match.

Each round apologised. **An apology is not a mechanism.**

- **Print the actual output, commit it, and have the comment cite the file.** The page's
  uncovered set is `design/prototype-uncovered.txt`, generated by the driver over every
  state the enumeration reaches.
- **The driver fails when the committed artifact and the live mechanism disagree.** A
  generated file nobody regenerates is a remembered list with extra steps.
- **The driver fails when the comment names an example the mechanism does not produce.**
  Any hand-written "for example, this now catches X" is a claim awaiting falsification,
  and here it has been falsified three times running.

**And it happened a fourth time, in the round that wrote the three rules above.** r13's
page comment beside `COUNTED_CLAIMS` was honest that only eight *phrasings* were read;
`CONVENTIONS.md` said, unqualified, that "a number in a minted sentence is re-derived
from the records the sentence declares it read, on every paint". The gap between those
two sentences was the rail's owed badge, whose entire minted sentence was `3`. The fix
is the same one, applied to the second mechanism: `design/prototype-counts.txt` is every
numeral on screen with what read it, produced by the same function the checker calls,
regenerated by the driver and compared on every run. **Two mechanisms now, two generated
files, and the doctrine cites both rather than describing either.** The rule generalises:
*if a paragraph in this file would need editing when the code's reach changes, it is the
wrong place for the claim — put the claim in a file the mechanism writes.*

## A search that ranks its frontier reports whether the ranking chose anything

#10 r13's sequence enumerator ranked frontier states by how many control keys they
painted that no state had painted yet, and its comment called the alternative — "the
first N by signature" — *the weakest thing a bounded search can do*. Measured: frontier
novelty was **zero for 70 of 83 states at depth 3, 81 of 92 at depth 4 and 83 of 88 at
depth 5**. Past depth 2, where the budget does not yet bind, the tie-break *was* the
policy. The weakest thing a bounded search can do, arriving inside the fix for it.

r14 added a second key — offered-step novelty, since every control key exists by depth 3
but the set of `(object, action)` pairs the page offers keeps growing — and then measured
it: **117 of 184 states tied on controls at depth 3, and 117 still tied after steps.** The
key did not help. It is kept because it costs nothing and separates at shallower levels,
and **the honest artifact is the report line, not the key.**

- **Report whether the ranking separated the states either side of the CUT**, not whether
  it separated some states. The first version of this line asked whether *every* state on
  the level tied, printed "the ranking discriminates at every truncated level", and was
  false on the round's own first depth-3 run — the budget boundary sat in the middle of a
  117-state block the ranking could not tell apart, so signature order picked 83 of them.
- The rule generalises past search: **a tie-break that decides the outcome is the policy**,
  whatever the comment above it says, and the only way to know which one you have is to
  print how many candidates the ranking could still tell apart at the point it had to
  choose.

## The viewport is part of the denominator

#10 r13 reported controls enumerated, controls driven and states reached at a stated
depth — three numbers, three facts, and every one of them a fact about **1440×900**,
because `newPage()` in `prototype-drive.mjs` hard-coded it, as did `prototype-shot.mjs`,
`prototype-probe.mjs` and `prototype-smoke.mjs`. Thirteen rounds and six reviewers driving
the page never opened it anywhere else.

Live at 1279 and at every supported width below it: the rail painting `# users-migra…` —
a control's own label in an ellipsis, on the room you are standing in, and it truncates
**because you cleared your work**, since `· 40 unread` is wider than `◆3` and the name
was the only flexible track. The page's own legibility invariant caught it instantly at
1279. Nothing ever asked it at 1279.

- **Every environmental constant a harness fixes is part of what its numbers are about.**
  A viewport, a locale, a clock, a random seed, a colour scheme. Name them or vary them;
  a constant nobody named is a denominator nobody stated.
- **Vary the cheap ones.** The width set is declared (`--widths`, defaulting to a member
  on each side of each of the page's two breakpoints plus the narrowest supported width),
  the deliberate enumeration rotates through it, the random drive rotates through it, and
  **every scripted repro runs at every width and reports which ones it fired at**.
- **And "the narrowest supported width" was itself a phrase nobody had measured.** The CSS
  comment above the breakpoints uses it; the number is **1120**. Below that the grid stops
  shrinking and pushes the lens off the right edge — `documentElement.scrollWidth` stays at
  1120 in a 1024px window, on r13 and r12 too. Driving 1024 would be driving a viewport the
  page has never fitted. `checkViewportFitInvariant()` makes the floor a fact the page
  asserts on every paint, so raising it costs a console error rather than a screenshot
  three rounds later.
- **Declare the expensive ones.** The state enumeration still runs at one width, because
  a state walk at N widths is N times the work for the same states — so the report says
  which width, in the same line as the number it qualifies.

## Something reads the English

Every rule in this file governs where a string **came from**: minted, read, queried,
re-derived, measured for width. None of them reads what it **says**. A permanent divider
on the first screen ended mid-sentence — *"…the seen cursor sits at the end of
#users-migration, and only this room's"* — a dangling possessive introduced in **round 2**
and painted, unchanged, through twelve review rounds, six of them with a reviewer driving
the page. A sentence can be minted from thirteen honest reads and still not be a sentence.

`checkProseInvariant()` reads the last word of every page-authored run. **It is not a
denylist of ways to write badly** — that would be unbounded, which this file forbids two
sections down. English function words are a *closed* class, and the compliant form is
stated positively: a rendered run ends on a word that carries content.

- **Only the part of the class that cannot end a clause in any register**: determiners,
  coordinators, subordinators, and a possessive clitic with nothing possessed after it.
- **Prepositions and auxiliaries are deliberately out.** English strands them — *"not the
  clean week the proposal asked for"* is correct — and the first draft of this rule, which
  included them, cried wolf on a receipt line on its first run. That is the "a wrong
  instrument invents defects" failure arriving inside the fix for something else, caught
  by running the instrument before believing it.
- **What it does not cover**: it reads the last word and nothing else, so a run that is
  ungrammatical in the middle, or grammatical and false, is invisible to it. Human-authored
  text is exempt.

It found two more on its first run, on this round's own build.

## Focus goes somewhere usable after every interaction, not only after a write

A spec that covers writes will be enforced on writes and nowhere else. #10 r7 wrote "focus follows the record", implemented it for writes, and its checker returned early unless a write flag was set — so routine peek, mark and unmark seen, expanding an objective, opening a receipt, closing it, switching rooms and expanding a pin card, between them the core navigation of the product, all left focus on `BODY` and nothing could see it.

- **Every interaction that re-renders leaves focus somewhere a keyboard reader can act from** — a control, or a surface container that holds one. Never `BODY`, and never an element that survived the rebuild but is now hidden.
- **A control replaced by what it opened declares its successor.** Same-key restore structurally cannot cover that case: the key it would restore is the element the interaction removed.
- **A toggle that survives its own render carries a key**, so restore can find it, rather than relying on a declaration.
- **The checker learns about the interaction from the browser, not from the handler** — a capture-phase listener ahead of every handler on the page. A check that depends on each new interaction remembering to announce itself is a check with the same blind spot as the code it is watching.

## A machine's output is a record, not speech

CI runs, deploy records and parity checks are verbatim and correctly credited, so rendering them is not fabrication — but rendering them in quotation marks with a human voice marker says a person said this about a job, and exempts a machine's string from the page-integrity rules that exist to catch `undefined` in a record. Found in #10 r7 D6. A non-human source's line renders as a record: mono, unquoted, no human-voice marker, disclosure on screen at rest. **It keeps its citation** — the cited message must exist and must contain the text, checked on every render — minus the one clause of the quotation contract that is about people. Dropping the check along with the quotation marks trades a presentation defect for an attribution hole.

## Page-integrity rules are about the page's own text

The invariants that police rendered output — no quotation marks outside a checked quotation context, no `undefined`/`null`/`NaN` in a rendered record — are assertions about what the *interface* writes. Applied to a human's own sentence they are false alarms on that person's words, and a checker that cries wolf on ordinary input is a checker people learn to ignore. Every surface that renders human-authored characters marks them (`data-voice="human"`), per fragment, so a page sentence that quotes a person keeps the page's half checked and exempts only the half the person typed. Found twice: round 4 for the quote-mark rule (feed bodies only), round 5 for the record-text rule (feed bodies only again — the correction chain's quote, the receipt's excerpt, an object's own text after a bound answer, and the facts a verification note lands in were all still held to a rule about the page).

## Measured contrast exceptions

Verified against the tokens as extracted (not guesses — measured at the sizes actually used):

- **`--red2` fails AA in dark at glyph sizes** (4.21–4.26:1 on `--bg1`/`--bg3` at 10.5px). Use **`--red3`** for `■` and `✗` glyphs and any small red text: 7.03:1 light, 5.85:1 dark — one token that clears both themes. Found during #39; the token values are byte-identical to the source corpus, so this is a latent contrast bug inherited from it, corrected in *usage*. Never edit `design/tokens.css` values to fix contrast — change which token the usage picks.
- Measured floor across the shipped component set: 4.53:1 light / 5.37:1 dark (`--amb2` on `--ambbg`).

- **The focus ring is `--tx1`, and it is part of the contrast audit.** WCAG 1.4.11
  wants ≥3:1 against every adjacent colour. `--line3` — the obvious choice, and
  what shipped — measures 1.63:1 light and 1.17:1 dark at its worst surface, and
  since nothing else in this shell reacts to focus, the ring is the only keyboard
  wayfinding there is. `--tx1` measures 8.32:1 light and 7.82:1 dark against the
  19 surfaces the ring can land on, and it inverts with the theme for free. The
  ring sits outside the border box with a 1px offset, so a control's own fill is
  never adjacent to it — the offset gap shows the parent. Found in #39 round 1,
  where the contrast note in `globals.css` audited text in detail and never
  audited the ring; `test/token-contrast.test.ts` now reads the ring token out of
  the stylesheet and `e2e/gallery.spec.ts` tabs through the real controls.

- **Every focusable control paints that ring, including the ones that fill their
  own box.** WCAG 2.4.7 is a separate requirement from 1.4.11, and a control with
  no indicator at all is a worse failure than a weak one. `.cbox textarea {
  outline: none }` sat two classes deep and out-ranked the global
  `:focus-visible`, so 89 of the app's 90 controls painted the ring and the one
  that did not was the composer — the primary input, and the control whose
  keyboard contract its own footer advertises. Its only signal was a `--line3`
  border at 2.23:1 light / 1.81:1 dark, the token this file already rejected for
  the job. Found in #39 round 3. Where a control fills its container the ring is
  **inset** (`outline-offset: -1px`) rather than absent, so the adjacent colour
  is the container's own fill: `--tx1` on `--bg3` is 11.33:1 light / 12.13:1
  dark. Never `outline: none` without a replacement in the same rule.

- **A state cue may not be out-ranked by a hover or focus rule.**
  `.cbox:focus-within` (one class plus a pseudo-class) beat `.cboxBound` (one
  class), so focusing the composer replaced the amber ANSWERING border with grey
  — the cue that says "your next message resolves this item", destroyed by
  focusing the field you are meant to answer in. The interaction state is
  decoration for the resting state; the state the surface is *in* wins. Express
  it with genuine specificity (`.cbox.cboxBound:focus-within`), not source order,
  because source order is what made it fragile.

- **The claim underline is a meaningful non-text graphic, and redundancy is not
  an exemption.** This file's own words are that the dotted underline is "the
  visual difference between 'someone said it' and 'the system checked it'", which
  is a definition of a 1.4.11 graphic. It shipped as `--line3` at 1.32–2.23:1 for
  three rounds because the text audit measured text and the ring audit measured
  rings and neither had a category for it. It is `--tx2` now: 4.29:1 light /
  4.69:1 dark against the worst surface in the app (`--redbg3`), 6:1 / 6.61:1
  against the surfaces it actually lands on, and still quieter than the words
  above it by a token step and by being 1px dotted rather than solid. On many
  rows the `~` glyph carries the same meaning — but `ClaimText` renders the
  underline without a `~` for gate-proposals, and round 3 counted 9 elements
  beside ◆ and 6 beside ■ where the stroke was the sole carrier. **"Usually
  redundant" is what an exemption sounds like from the inside.** The rendered
  audit now carries an explicit registry of non-text graphics; anything that
  carries information belongs in it, and a hairline divider does not.

- **Do not fade a row to de-emphasise it.** The weakest thing a row can carry is
  an amber needs-you tag, which is the 4.53:1 floor above at *full* opacity — so
  any opacity below 1 puts it under AA. There is no fade that is both visible and
  legible. Where a filter needs to distinguish rows, LIFT what matches onto a
  different surface and leave everything else at 100% of its contrast. Found in
  #39: `opacity: .3` put a filtered row's text at 1.48–1.71:1 while the frame's
  own caption said "a row you cannot see is a row you cannot check."

## Animation fill mode

Entrance animations use `animation: gl-rise … backwards`, never `both`. An animated fill outranks a normal declaration, so `both` pins the element at the keyframe's final `opacity: 1` and a later state change (a filter dimming the row) can never take effect. Found during #39; guarded by an e2e assertion on computed opacity.

## De-emphasis must stay readable

A filtered-out or de-emphasised row keeps its text, so it must keep its legibility: **dimming may not drop any text below AA at the size it renders.** `opacity: .3` on a feed row measures 1.47–1.69:1 in both themes — a third of the stated floor, and below the contrast this file already rejects `--tx4` for. If the affordance's own copy claims a dimmed row is still checkable, the measurement has to back it; otherwise hide the row and say so.

Found independently in two artifacts by two critics (#10 r6 and #39 r1) — the same `opacity: .3` decision, wrong in both.

**And doctrine written from one artifact has to be swept across the others.** These two rules were written from #39's findings and then not applied to `design/prototype-frame.html`, which had shipped the exact defects they describe: `.surf[disabled] { opacity: .55 }` measured **2.49:1 light / 2.43:1 dark** and `✗` glyphs wore `--red2` at **4.21:1 dark** — the same three numbers this file already quoted, sitting unfixed one directory away for three review rounds, while `.cnt[disabled]` in the same stylesheet implemented the correct pattern. Corrected in #10 r10 (measured after: 6.79:1 light / 7.44:1 dark for the inactive control, 7.47:1 / 5.81:1 for the glyphs, **0 of 342 text elements below AA across 5 states × 2 themes**). Writing a rule down is half the work; the other half is running it against every artifact already in the tree, on the day it is written.

**There is no inactive-state exemption. This paragraph used to grant one** — "a genuinely inactive control (a disabled button at ~2.5:1) is an inactive-state exemption, not body text" — and #39 r2 shipped `.surf[disabled] { opacity: .55 }` at 2.49:1 light / 2.99:1 dark behind it, with the audit harness written to skip anything under `opacity 0.999` and citing "a disabled chip" as its reason. The rule had been narrowed until it could not see its own counterexample, in the doctrine and in the harness at once. A control that is disabled still has to be *read* — that is how a person finds out why they cannot use it — and "0 items" at 2.5:1 is a sentence with no reader.

**Inactive is said with a token step and a shape, never with alpha.** Drop the label one step down the text ramp (`--tx1` → `--tx2`, still 6.79:1 light / 7.44:1 dark at 10px), make the chip's border dashed, stop responding to hover, and set `cursor: default`. The state reads as inactive because it is a different *treatment*, not a weaker one.

Corollary for harnesses, which is the half that let this ship: **an audit may not exempt the case its rule covers.** A contrast check may skip what is not rendered (`display: none`, `visibility: hidden`, `opacity: 0`); anything partially faded gets its alpha composited into the measurement and measured. Any skip list that names a component ("a disabled chip", "the sticky footer") is the invariant being narrowed to fit the code rather than the code to the invariant — the same failure as the prototype's sticky-footer whitelist.

**And its twin: an audit may not fire on cases its rule does not cover.** Found in #10 r11: the chip checker asked `text.indexOf(normText(enumText(v))) >= 0`, and `"reopened".indexOf("open")` is 2, so the console errored on every render for the whole window between answering a question and reassigning it — during ordinary use, on a chip that was telling the truth. It also flagged `no longer settled` against a record whose settlement is `settled`. The same single design choice was blind in the mirror direction: it compared each field's **last** value only, so a surface stating an *earlier* recorded value — the half of that class the page had actually shipped — was invisible to it. One decision, a false positive and a false negative.

The two corollaries are one rule with two signs, and the second is not the lesser half. This file already names the failure mode: **a checker that cries wolf on ordinary input is a checker people learn to ignore**, and noise is what masks a real firing. So a value match is a **token** test, over the **whole** history — a word is matched as a word, and the record is the whole record.

**Measured consequence (#39 r2, theme-corrected in r3): with this token set, no fade clears AA at all.** The weakest thing a row can legitimately carry (`--amb2` on `--ambbg`) is **4.53:1 in light** at *full* opacity — the shell's own floor — so any opacity reduction drops it below. (The dark value is 9.65:1; earlier receipts quoting ~5.37:1 for dark came from a contrast harness whose block parser matched selector names inside `tokens.css`'s provenance comment and re-measured the light theme, fixed in #39 r3. The practical conclusion is unchanged and was independently confirmed by compositing measurements of real rendered rows in both themes: `opacity:.3` yields 1.47–1.75:1 light and 1.12–2.14:1 dark.) Therefore **de-emphasis is expressed by lifting the matches, not by dimming the rest**, and the affordance's copy says so. Do not reintroduce a fade with a gentler alpha; the arithmetic does not work at any value.

The binding measurement is the **light** theme: `--amb2` on `--ambbg` is 4.53:1 there and 9.65:1 in dark, and one stylesheet serves both, so a fade has to clear AA in the worse of them. Dark-theme headroom is not licence (#39 r3 — the dark number had never actually been measured; see RETRO on the parametrised test that ran the same case twice).

**Independently confirmed in #10 r7, on the prototype's own feed** — arrived at before that consequence was written down, and agreeing with it. Measured on the painted rows: `opacity: .3` gives 1.48–1.75:1 light and 1.12–2.14:1 dark, 57 of 57 text elements failing. Solved for the alpha that would clear 4.5:1 and there isn't a usable one — `--tx0` body text needs α ≥ .84 (not a dim, a rounding error) and `--tx2` at 10px, which every row's time/glyph/actor columns use, fails at *every* α below 1. Lifting the matches instead: 0 of 57 failing, 4.76–10.66:1 light and 6.46–12.27:1 dark.

**And lift by BRIGHTENING, not by darkening.** A first pass gave matches a `--bg5` band, which reads as emphasis on paper — and took `--amb2` on the `◆` glyph from 4.84:1 to 3.99:1. A fix for a contrast defect that introduces a contrast defect is not a fix. The band is one step *brighter* than the row in both themes (`--bg3` light, `--bg5` dark), so every token on a highlighted row is on more contrast than it had unfiltered, not less. Emphasis that can only raise ratios cannot fail this rule.

## The harness may not exclude what its rule includes

The corollary in *De-emphasis must stay readable* — "an audit may not exempt the case its rule covers" — has now been broken five more ways, all found in the #39 round-4 gauntlet, all of which happened to be **clean when run without the exclusion**. That is exactly why they are worth writing down: a blind spot that is clean today is a blind spot, and "somebody else ran it once" is not a property of a repo.

- **A rule that says "every" may not stop at a constant.** The focus-ring sweep pressed Tab ninety times against a page holding 337 focusable controls — a cap chosen when the page was smaller and never revisited, invisible because ninety measurements look thorough. Run to exhaustion (mark each element as it is focused, stop when the tab order repeats) and assert **which** controls were never reached, by name, rather than how many were. A count can be satisfied by reaching different ones.
- **A filter whose second clause subsumes its first is a filter with dead code in it.** `.filter(a !== 'none' || t !== 'all').filter(a !== 'none')` meant transitions were never tested under `prefers-reduced-motion`. Measure the two things separately and report them separately, and pair a suppression check with a check that there is something to suppress — a kill switch tested against a page with no motion passes for free.
- **A DOM property is not the definition of a state.** `.disabled === true` exists only on form controls, so every `aria-disabled` control was invisible to a sweep named "a disabled control is legible". And reading `querySelector('span')` reads the *first* of a control's spans, which is how a count chip shipped at 2.43:1 with nobody measuring it. Measure every text-bearing part; compare "reads as inactive" at the control.
- **A route is not the app.** An audit that runs on the gallery is a claim about six stills. Run it on every route the product serves, including the one driven by a live consumer and the ones under load.
- **A node walk cannot see generated content.** `::before`, `::after` and `::placeholder` are rendered strings that no `childNodes` traversal reaches, so three whole categories of text sat outside the contrast and type-size floors. Measure them, and report how many were found, so a run that measures none of them says so.
- **A bound must be swept along the axis it bounds.** `.pinList`'s belt was a constant `340px` competing with a `100vh` frame, and every viewport in the harness hard-coded height 900 — so the one dimension the bound was written against was the one dimension nothing varied. Sweep it, down to the shortest viewport the product claims.

Two more general shapes, both of which passed against their own mutation before being tightened:

- **A coverage guard must not be satisfiable by one subject.** `graphicsChecked > 10` was met by a single registered graphic's own fifty instances, so a registry of one reported a thorough sweep. Count **distinct kinds**, and separately assert that every registered kind was actually found somewhere — a selector that matches nothing reports exactly like one that passes.
- **A source-grep assertion fails by matching the wrong occurrence, not only by matching nothing.** Two checks here grepped for an identifier that also appeared in a `console.info` beside the assertion, and passed with the assertion gutted. Anchor on the construct (`expect(\n audit.graphicKinds.length,`), not on the word.

- **A source-grep that ENUMERATES a construct must be able to see every spelling of the construct it enumerates.** This is a third failure mode beyond the two above, and it is the one that let a real 1.36:1 string go unreported behind 51 green unit tests and 32 green e2e assertions. `test/token-contrast.test.ts` enumerated the audit's skip guards with `/if\s*\([^)]*\)\s*continue/g`; `[^)]*` cannot cross a `)`, so **any guard whose condition contains a call was invisible**, and `guards.length > 0` was satisfied by the legitimate guard elsewhere. Inserting `if (effectiveOpacity(el) < 0.999) continue;` — round 2's exact defect, wearing a function call — passed everything. Found in the #39 round-5 gauntlet.

  A line scan is the same hole one step out: a guard wrapped across two lines has no single line carrying both its condition and its body, and the ring-audit check had adopted exactly that after the regex version was found stopping at an inner paren in round 5. **Where the thing being enumerated is a LANGUAGE construct, parse it.** `typescript` is already a dependency; `ts.createSourceFile` reads the audit's program (it is a template string, so unescape it first) and `ts.isIfStatement` / `ts.isContinueStatement` see every spelling. And **an enumerator gets a self-test**: `test/token-contrast.test.ts` feeds `guardsIn` a synthetic source carrying a call, a nested paren, a ternary, a line break mid-condition and a braced body, and asserts the exact list that comes back. An instrument with no self-test is a claim, not a measurement.

  The general form: **when a check's subject is "every X", the first question is what enumerates X, and the second is what proves the enumerator is complete.**

  Round 6 wrote three new enumerators and the blind review of its own fix found a hole in each — which is the honest yield of pointing a critic at the ENUMERATION rather than at the fixes: the enumerators are the round's product, so they are where its defects are. The CSS truncation scan knew two of the three ways this stylesheet clips text (`max-height` + `overflow: hidden` was the third, and it was clipping the OPEN CARD's rationale — the surface a compressed row's clamp routes the reader to). The component-edge list inside the frame-forwarding test was **written by hand**, in a test whose entire purpose is to replace a hand-maintained claim with a count, and it was missing four edges. And the overflow denominator compared two loops one of which contains the other by construction, so the inequality held for every possible page. Each is the same sentence one level in: **an enumerator is a claim about a set, and a claim about a set needs a denominator that does not come from the claim.**

  **An enumerator has TWO halves — the edges and the nodes — and deriving one is not deriving it.** Round 6 fixed the edge list and left `COMPONENT_FILES`, the 24-path NODE set, written out by hand in the same file; `test/harness-integrity.test.ts` asserted the edges were derived and never asked where the nodes came from. It matched the filesystem on the day it was written, which is what *latent* means, and `test/system-voice.test.tsx` read its directories with `readdirSync` in the same commit — the repo held both answers at once. Every enumerator's input set is read off the filesystem now, and the harness test asserts that it is.

  **And a component reached through an OPAQUE VALUE has no edge for a JSX derivation to find, so enumerate it from the TYPE OF THE HOLE.** Found in the #39 round-7 gauntlet, and it is the reason `ReceiptView` was in neither of round 6's lists AND COULD NOT BE: `StateLens` renders `receipt.node`, so no `<ReceiptView>` JSX exists anywhere the scan looked, and the two files that construct one were outside the scan set. Its `onBack`, `onReopen` and `onJump` were therefore required by nothing — deleting `onJump` from the consumer's `<ReceiptView>` took the receipt's only outbound navigation, five visible controls, dead with `tsc` at 0, 675 unit tests green and 73 e2e green. The same blindness applies to a render prop, `cloneElement` and a dynamic import.

  Two things follow. Every `Slot`-typed prop in the library is enumerated as a HOLE and every `slot(<X …/>)` in the app as something FILLING one, with the filler owing `X` every handler `X` declares. And structurally: **the frame constructs the receipt**, so it is an ordinary child with an ordinary prop table, and `RoomFrameHandlers`' three receipt seams — declared since round 6 and wired to nothing — are live.

  **A browser backstop is a claim about the page STATE it ran in.** The control sweep that would otherwise have caught the dead `onJump` ran on `/` in its initial state, where no receipt is open, and reported "71 visible · 0 dead" while six receipt controls were not among them. It also ran 70 of its 71 controls in DARK, because the theme toggle is control #1 and flipping it counts as a change — while the binding measurement here is LIGHT. Sweep every state the product can be in, pin the binding theme, and restore it after any control that moves it.

- **A DOM id minted from a caller-supplied value is not unique, and nothing was requiring it to be.** `HoldToAct` built `${actionId}-hold-progress` and `-hold-describe` from a prop that repeats: on `/gallery` the same five action ids render in five frames, so **four of the five destructive hold controls had `aria-describedby` pointing at another frame's nodes**, and a screen-reader user pressing one heard a frozen progress meter belonging to a different button — on the one control in the product whose entire job is being a safety mechanism. `getElementById` does not error on a duplicate; it returns the first match and resolves somewhere else. The aria-snapshot test checked NAMES, not DESCRIPTIONS, so nothing saw it. Found in the #39 round-5 gauntlet.

  **An `id` is minted per instance (`useId`), never from a value a caller chose.** What a caller-supplied identifier is for is a `data-` attribute, which is what selectors actually want and what an `id` was being abused for. The counting test asserts uniqueness AND that every `aria-describedby` resolves to a node inside its own control, because uniqueness is necessary and not sufficient: what a screen reader announces is whatever the lookup returns.

- **A parser may not launder provenance.** Found by the blind cross-lineage review of round 6's own fix, and it is the round's own defect committed by the round's own fix. `parseQuotation`/`parseCitation` discarded the incoming checksum and minted a fresh one from the DESTINATION ledger, on the reasoning that data crossing a process boundary is being adopted into this page's register. The consequence is the exact cross-register forgery the checksum exists to refuse, reachable through the documented door: mint a citation against a register whose `m10` is priya, parse it against a register whose `m10` is lars, and it resolves to lars with no complaint. **A laundering step in front of a checksum is worse than no checksum, because the checksum is what everything downstream then trusts.** A reference that ARRIVES WITH a fingerprint must match; one that arrives without ever having had a register may be adopted, and the adoption happens at the boundary whose job it is.

- **A checksum covers the fields it hashes, and a second field carrying the same fact is outside it.** The same review found `ChosenMessageEntry` carrying `statement` — the words — beside the citation whose checksum proves the register. The checksum says nothing about `statement`, so `{...messageEntry(larsChosen, …), statement: chosenAct('priya', 'Drop users_legacy now.')}` rendered *priya chose: Drop users_legacy now.* over lars's record with every other check green. That is round 2's body-slot defect, on the arm round 6 had just rebuilt: the authored arm has reconciled its body against the record since round 2, and the page-authored arm was rebuilt without the equivalent. **When one arm of a union gets a check, the question is what the other arm's version of that check is** — not whether it needs one.

- **A frame that composes the library forwards every handler the library exposes, and that is a counting test rather than a comment.** `RoomFrame` has carried the sentence "EVERY HANDLER THE LIBRARY EXPOSES IS FORWARDED" as a comment since round 2, when the gauntlet found `/` rendering the whole component library and wiring none of it. Round 2's fix added the handlers round 2 named. Round 5's critic clicked all 53 visible controls on `/` and found **17 still dead** — four rail room chips, both objective disclosure triangles (the collapsed one could never be opened, hiding four objects, two of which needed the viewer), all ten state-object rows and the trailer's failure count — because `Rail` declares `onSelectRoom`, `StateLens` declares `onToggleObjective` and `onOpenReceipt`, `ObjectRow` declares `onOpenReceipt`, and `RoomFrameHandlers` declared none of the three.

  **Round 2 was recorded here as history, and history does not fail a build.** `test/frame-handlers.test.tsx` enumerates every `on*` member of every `*Props` type in every composed component from the TypeScript AST and requires the frame to pass each — and does the same for the second hop, because a frame that forwards to `StateLens` and a `StateLens` that drops the prop on the way to `ObjectRow` is a dead control with a live prop table. Written on the day it was added, the enumeration immediately found two more the receipt had not named (`CrossRoomJump`'s `onBack` and `onDismiss`), which is the argument for enumerating rather than listing.

  **And a control wired to a LABEL is worse than a control wired to nothing.** Found in the #39 round-7 gauntlet. Round 6 wired the rail's room chips; clicking `#design` changed the room head to `# design` and left the eight feed rows, the four owed items, the ten lens objects and the composer binding byte-identical to `#users-migration`'s — while the rail went on marking `#users-migration` current. **Two sources of truth about which room you are in, disagreeing on screen, in the product whose entire doctrine is that they must not be able to.** A dead control is visibly dead; a lying one is not, and every check written against "did something change" passes it. A footer note disclosing that another ticket owns the real behaviour is not a state. Either the control delivers what it names or it renders as unavailable — and the facts a control switches between belong in ONE VALUE, because handing them back separately is precisely how the head ends up in one room and the feed in another.

  And the corollary for the demo itself: **a check named "the controls do something" has to know how many controls there are.** `e2e/smoke.spec.ts` clicked four. It now enumerates every visible control, clicks each, requires an observable change, and requires anything genuinely inert to be listed with a reason — with the exemption list checked exhaustive in BOTH directions, because an entry that matches nothing is a carve-out that outlived its subject and reports exactly like one that is doing its job.

## Non-text graphics are registered, and the registry is measured

Anything whose **colour or shape carries state or identity** is a non-text graphic under WCAG 1.4.11 and belongs in `e2e/audit.ts`'s registry: the claim underline, the presence dot, the composer's binding border, the attention card's state border, the disabled count chip's dashed border. Things that **separate, frame or decorate** — hairline dividers, group rules, avatar rings, a border around a label that already says the same thing in the same box — do not, and flagging them trains the check to be ignored. Write the reason for each exclusion next to the registry, so the next reader argues with a decision rather than with an oversight.

Two measurement rules, both learned the hard way in #39 r5:

- **A graphic has more than one adjacent colour.** A border is adjacent to the fill it encloses *and* to the surface it sits on; measure both and take the worse. Measuring the friendlier side is how `--ambbd` survived on the attention card through four rounds of contrast passes.
- **A fill is not measured against itself.** Compositing the element's own background into the backdrop makes a filled dot report 1.00:1 — a number that cannot fail in one direction and therefore cannot pass in the other. Composite a fill against its parent.

Found in #39 round 4: the registry held one entry, its coverage guard counted that entry's instances, and an independent sweep immediately turned up the AWAY presence ring at 1.93:1 light / 1.84:1 dark (`--line3` again, the third place that token survived) and the composer's ANSWERING border at 1.76:1 / 2.70:1.

**A graphic distinguished by hue and shape needs a text equivalent.** The presence dot was `aria-hidden` with a `title` — which no screen reader announces — and `here`/`idle`/`away` differed only by fill-versus-ring and hue. The state is words on the row now; the dot is the glanceable shorthand for something that is also written down.

## The pin pages; it never scrolls

BRIEF concept 3, verbatim: "owed attention never hides… the pin folds rather than scrolls." Both halves bind, and #39 broke them in turn — r1 by not bounding the pin at all (the composer left the viewport at 19 owed items, unreachable), r2 by bounding it and then shipping an idempotent way out of the bound (`showAll` raised the row budget once, stranding 50 of 60 owed items behind a live-looking "50 more owed").

**And the budget moves with the room there is, not with a constant.** Found in #39 round 4: `.pinList`'s belt was `max-height: 340px` while the frame is `height: 100vh`, so at 1124x500 the pin kept its full height out of a 500px frame, the feed collapsed to 22px, and the composer's bottom edge sat at 511 in a 500px viewport with `scrollHeight === clientHeight` — round 1's exact signature, at a short viewport instead of a long list. Making the belt relative on its own turns the pin back into the round-2 defect (a box holding more than it can show), so the COUNT bound is derived from the same arithmetic the belt does, the component measures the viewport rather than being told, and where there is no room for even one compressed row the page advances the CARD so the way out of the fold never goes inert. Two numbers that must agree, with an e2e assertion at five viewport heights that says they do.

The settled shape: **a row budget derived from the space in every state, and an affordance that advances a window through the owed items.** The budget never moves, so the pixel bound that keeps the composer on screen is measured once and holds everywhere; the control's label is rendered from the page it is about to show, so it cannot promise more than one click delivers; and the last page wraps back to the hardest rather than becoming inert. A scrolling pin is the unbounded pin with a scrollbar. A cap that rises when you ask for more is a bound with an exception, and the exception is where the owed items go to disappear.

Generally: **an affordance whose label states a quantity must deliver that quantity when used.** This is the same defect class as r1's `data-hold="2000"` — a control whose copy described behaviour the code did not implement. Assert it by clicking through every page and counting distinct items reached, not by checking that the affordance exists.

**And a reachability bound is not a cost bound.** Found in the #39 round-5 gauntlet: the rule above is satisfied, honestly and completely, by `show the next 1 · page 1 of 60`. Sixty clicks to see sixty items, each click delivering exactly the one it promised. Every word of the label is true and the control is useless — which is round 2's stranding defect with the strandedness moved from *impossible* to *not worth it*. A rule that only asks "can the reader get there" is a rule a control can pass while making sure nobody does.

So the rule has a second half:

- **The price is bounded by the room there is, not by the length of the list.** A page carries as many rows as the measured budget allows; a page that carries less than the pin can hold is a cost the room does not justify. Asserted at `pages ≤ ⌈items ÷ budget⌉ + 1` in `e2e/pin-bound.spec.ts`, against the budget the component actually measured rather than against a constant.
- **The price is stated before it is paid.** `page N of M` is on the control at rest, so a reader knows what the whole list costs up front instead of discovering it one click at a time. A control that reveals its own cost incrementally is a control that has decided the reader would not have started.

The general form, for the next affordance: **state the quantity, deliver the quantity, and bound the number of times a person has to ask.**
