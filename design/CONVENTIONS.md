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

## Motion

Three keyframes, and no others without a reason:

- `gl-blink` — 1s infinite, hard on/off. Live/recording indicators only. **v1 has
  no live surface, so v1 defines no `gl-blink`** — it arrives in Phase 4 with the
  call strip, alongside the `--live` token family kept unconsumed in `tokens.css`.
  A keyframe defined and never used is a rule nobody is holding, and #10 r6 proved
  it: `gl-blink` sat unused while the one animated dot on the page ran `gl-pulse`
  in verified green. Define it when something is live; until then, don't.
- `gl-pulse` — 1.2s or 1.6s infinite, opacity 1 → .35. In-progress states. A pane
  that is continuously re-derived is in-progress, not live.
- `gl-rise` — .15s / .2s / .25s ease, a 2px translate plus fade. New rows entering
  the timeline (`.mrow`) and content appearing.

Colour is decided by the glyph table, not by the animation: nothing wears `--grn`
unless it is `✓` verified, however alive it is.

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

**The rule covers authorship, not just invention.** A message the interface authors on a person's behalf — the text of an option they clicked, a template filled with their name — may never be attributed to them as their words, and may never satisfy the quotation check. Found in the #10 round-4 gauntlet: one-click answers appended a message authored as the user containing the card's sentence, and the checker then validated the quotation against that page-fabricated message, passing on exactly the class it exists to prevent. Messages carry their origin (`typed` vs `chosen`); only typed text and seeded human messages can be quoted; chosen answers render in system voice ("chose: <option>"), never in quotation marks.

**A default branch may not name a person.** The same defect arrives through a missing `case` as readily as through a fabricated string. Found in the #10 round-5 gauntlet: `receiptState()` had no branch for an answered question, so it fell through to the claim branch and the receipt header read `CLAIM · unverified · claimant: priya` above a sentence priya had *asked*. Nobody wrote that attribution; the absence of a branch did. So: every fallback that renders a role — claimant, owner, verifier, asker — must be reachable only for kinds that actually have that role. When a kind has no branch, the fallback states what is missing, in words, and names nobody.

**A record of an answer contains the answer.** Recording that something was answered while dropping what the answer said is not a record. The same round: clicking `Answer — retention is 90 days` wrote a transition and stored none of the answer's content, so the string on the button appeared nowhere in the object, the history, the feed, the lens or the receipt. Whatever the control promised to record is recorded verbatim, with its authorship disclosed by the rules above.

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

## Animation fill mode

Entrance animations use `animation: gl-rise … backwards`, never `both`. An animated fill outranks a normal declaration, so `both` pins the element at the keyframe's final `opacity: 1` and a later state change (a filter dimming the row) can never take effect. Found during #39; guarded by an e2e assertion on computed opacity.

## De-emphasis must stay readable

A filtered-out or de-emphasised row keeps its text, so it must keep its legibility: **dimming may not drop any text below AA at the size it renders.** `opacity: .3` on a feed row measures 1.47–1.69:1 in both themes — a third of the stated floor, and below the contrast this file already rejects `--tx4` for. If the affordance's own copy claims a dimmed row is still checkable, the measurement has to back it; otherwise hide the row and say so.

Found independently in two artifacts by two critics (#10 r6 and #39 r1) — the same `opacity: .3` decision, wrong in both.

**And doctrine written from one artifact has to be swept across the others.** These two rules were written from #39's findings and then not applied to `design/prototype-frame.html`, which had shipped the exact defects they describe: `.surf[disabled] { opacity: .55 }` measured **2.49:1 light / 2.43:1 dark** and `✗` glyphs wore `--red2` at **4.21:1 dark** — the same three numbers this file already quoted, sitting unfixed one directory away for three review rounds, while `.cnt[disabled]` in the same stylesheet implemented the correct pattern. Corrected in #10 r10 (measured after: 6.79:1 light / 7.44:1 dark for the inactive control, 7.47:1 / 5.81:1 for the glyphs, **0 of 342 text elements below AA across 5 states × 2 themes**). Writing a rule down is half the work; the other half is running it against every artifact already in the tree, on the day it is written.

**No exemption for inactive controls.** An earlier version of this rule exempted "a genuinely inactive control (a disabled button at ~2.5:1)". That exemption was wrong and was implemented faithfully by the audit harness, which is exactly how a disabled indicator at 2.49:1 and a count chip at 2.43:1 survived two review rounds (#39 r2/r3). **General corollary: an audit may not exempt the case its rule covers.** Express inactive state with a token step and a shape change (dashed chip, altered border), never with alpha.

**And its twin: an audit may not fire on cases its rule does not cover.** Found in #10 r11: the chip checker asked `text.indexOf(normText(enumText(v))) >= 0`, and `"reopened".indexOf("open")` is 2, so the console errored on every render for the whole window between answering a question and reassigning it — during ordinary use, on a chip that was telling the truth. It also flagged `no longer settled` against a record whose settlement is `settled`. The same single design choice was blind in the mirror direction: it compared each field's **last** value only, so a surface stating an *earlier* recorded value — the half of that class the page had actually shipped — was invisible to it. One decision, a false positive and a false negative.

The two corollaries are one rule with two signs, and the second is not the lesser half. This file already names the failure mode: **a checker that cries wolf on ordinary input is a checker people learn to ignore**, and noise is what masks a real firing. So a value match is a **token** test, over the **whole** history — a word is matched as a word, and the record is the whole record.

**Measured consequence (#39 r2, theme-corrected in r3): no fade clears AA.** The weakest thing a row can legitimately carry (`--amb2` on `--ambbg`) is **4.53:1 in light** at *full* opacity — the shell's own floor — so any opacity reduction drops it below. (The dark value is 9.65:1; earlier receipts quoting ~5.37:1 for dark came from a contrast harness whose block parser matched selector names inside `tokens.css`'s provenance comment and re-measured the light theme, fixed in #39 r3. The practical conclusion is unchanged.) Therefore **de-emphasis is expressed by lifting the matches, not by dimming the rest**, and the affordance's copy says so. Do not reintroduce a fade with a gentler alpha; the arithmetic does not work at any value.

**Independently confirmed in #10 r7, on the prototype's own feed** — arrived at before that consequence was written down, and agreeing with it. Measured on the painted rows: `opacity: .3` gives 1.48–1.75:1 light and 1.12–2.14:1 dark, 57 of 57 text elements failing. Solved for the alpha that would clear 4.5:1 and there isn't a usable one — `--tx0` body text needs α ≥ .84 (not a dim, a rounding error) and `--tx2` at 10px, which every row's time/glyph/actor columns use, fails at *every* α below 1. Lifting the matches instead: 0 of 57 failing, 4.76–10.66:1 light and 6.46–12.27:1 dark.

**And lift by BRIGHTENING, not by darkening.** A first pass gave matches a `--bg5` band, which reads as emphasis on paper — and took `--amb2` on the `◆` glyph from 4.84:1 to 3.99:1. A fix for a contrast defect that introduces a contrast defect is not a fix. The band is one step *brighter* than the row in both themes (`--bg3` light, `--bg5` dark), so every token on a highlighted row is on more contrast than it had unfiltered, not less. Emphasis that can only raise ratios cannot fail this rule.
