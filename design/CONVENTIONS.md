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

- `gl-pulse` — 1.2s or 1.6s infinite, opacity 1 → .35. In-progress states.
- `gl-rise` — .15s / .2s / .25s ease, a 2px translate plus fade. New rows entering
  the timeline (`.mrow`) and content appearing.
- `gl-blink` — 1s infinite, hard on/off. Live/recording indicators only, and
  therefore **not declared in v1**: Atrium v1 is human-only with no voice
  surface, so it goes where the call-era tokens went — it returns in Phase 4
  with the thing it indicates. Found unreferenced during #39; a keyframe nothing
  uses is a keyframe nobody notices has stopped working.

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

**The rule covers the attribution, not just the words.** Found in the #39 round-1 gauntlet, independently by both lineages: the enforcement above governed *what was said* and left *who it was said by* as a free string beside it. The primary message path was `actor + body`, with the origin read once and discarded, so a page-authored answer rendered under a real person's name in the same slot as their own sentences — the cardinal defect, live in the demo. Separately, every name printed next to quoted text (the reply banner, the receipt's provenance rows, a correction's reason) was supplied alongside the quotation rather than derived from it, so nothing stopped priya's name sitting over lars's sentence.

Two structural rules follow, and they are what the enforcement now rests on:

- **A quotation carries the actor and the moment it was minted from.** Any component that renders a name beside quoted text takes the quotation, not a string. There is no `by` prop anywhere.
- **The message-rendering path is discriminated on origin, and the arms have different fields.** The human-authored arm has an attribution and a body; the page-authored arm has neither, only a system-voice statement. A page-authored answer cannot reach a human-attributed row because the row shape that would render it does not exist.

**What the branded types actually buy.** `Quotation`, `SystemStatement`, `Rationale` and `Slot` all carry phantom brands keyed by module-private `unique symbol`s. Those are `declare`-only: they exist in the type system and nowhere else. They stop a TypeScript author from writing the literal, which is the mistake a person makes at 2am. **They are not a guarantee about data from outside the compiler** — `JSON.parse`, a cast, `Object.assign` and any JavaScript caller all walk straight through. Describe them as a convention with teeth, never as a proof. Where untrusted data enters, use the runtime parsers (`parseQuotation`, `parseMessageRecord`, `parseSystemStatement`, `isRationale`, `maybe`) rather than a brand and a hope.

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

- **Do not fade a row to de-emphasise it.** The weakest thing a row can carry is
  an amber needs-you tag, which is the 4.53:1 floor above at *full* opacity — so
  any opacity below 1 puts it under AA. There is no fade that is both visible and
  legible. Where a filter needs to distinguish rows, LIFT what matches onto a
  different surface and leave everything else at 100% of its contrast. Found in
  #39: `opacity: .3` put a filtered row's text at 1.48–1.71:1 while the frame's
  own caption said "a row you cannot see is a row you cannot check."

## Animation fill mode

Entrance animations use `animation: gl-rise … backwards`, never `both`. An animated fill outranks a normal declaration, so `both` pins the element at the keyframe's final `opacity: 1` and a later state change (a filter dimming the row) can never take effect. Found during #39; guarded by an e2e assertion on computed opacity.
