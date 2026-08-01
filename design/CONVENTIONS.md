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
| `■` | destructive decision pending | `--red` |
| `✗` | failed | `--red` |

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

- **Reversible** (amber `◆` gates): **one click.** A yes/no answer, immediate, no
  confirmation dialog. Making these fast is the whole reason the attention surface
  is usable.
- **Irreversible** (red `■` decisions — merges, deletions, anything destructive):
  **press-and-hold for 2 seconds**, with a progress bar filling during the hold.
  Click-only; the action records who armed it and when.

Do not add a confirmation modal to a reversible action, and do not let an
irreversible one through on a single click. The hold is the confirmation — it is
cheaper to explain and impossible to muscle-memory through.

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

## A control has to be legible, not merely non-zero

A geometry tripwire set at `width < 1` catches nothing that matters. #10 r7 D2: an owed item's title rendered **5.36px** wide at 1124 — counted, glyphed, actionable, unidentifiable — and the guard was silent, because the same click path could also drive it to 0 and that was the case the guard had been written for. One pixel above the wire is the same defect.

So the floor is legibility, expressed in the control's own type size rather than a constant: **a control whose label is being truncated must be at least six characters wide at its own font size.** A control showing all of its text is legible at whatever width its text needs; a control with no text only has to be aimable.

**And the layout gives the identifying text priority.** The cause was a track template mixing `auto` and `1fr`: grid sizes auto tracks before it distributes free space, so `nowrap` metadata and buttons took their full max-content width at every viewport and the title absorbed the entire shortfall. Where several things on a row must flex, they are all `fr` so they share the shortfall in a fixed ratio — and controls do not flex at all, because a control whose label you cannot read is not one click to act.

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

Found independently in two artifacts by two critics (#10 r6 and #39 r1) — the same `opacity: .3` decision, wrong in both. Legitimate exemption: a genuinely inactive control (a disabled button at ~2.5:1) is an inactive-state exemption, not body text.

**Measured consequence (#39 r2): with this token set, no fade clears AA at all.** The weakest thing a row can legitimately carry (`--amb2` on `--ambbg`) is 4.53:1 at *full* opacity — the shell's own floor — so any opacity reduction drops it below. Therefore **de-emphasis is expressed by lifting the matches, not by dimming the rest**, and the affordance's copy says so. Do not reintroduce a fade with a gentler alpha; the arithmetic does not work at any value.

**Independently confirmed in #10 r7, on the prototype's own feed** — arrived at before that consequence was written down, and agreeing with it. Measured on the painted rows: `opacity: .3` gives 1.48–1.75:1 light and 1.12–2.14:1 dark, 57 of 57 text elements failing. Solved for the alpha that would clear 4.5:1 and there isn't a usable one — `--tx0` body text needs α ≥ .84 (not a dim, a rounding error) and `--tx2` at 10px, which every row's time/glyph/actor columns use, fails at *every* α below 1. Lifting the matches instead: 0 of 57 failing, 4.76–10.66:1 light and 6.46–12.27:1 dark.

**And lift by BRIGHTENING, not by darkening.** A first pass gave matches a `--bg5` band, which reads as emphasis on paper — and took `--amb2` on the `◆` glyph from 4.84:1 to 3.99:1. A fix for a contrast defect that introduces a contrast defect is not a fix. The band is one step *brighter* than the row in both themes (`--bg3` light, `--bg5` dark), so every token on a highlighted row is on more contrast than it had unfiltered, not less. Emphasis that can only raise ratios cannot fail this rule.
