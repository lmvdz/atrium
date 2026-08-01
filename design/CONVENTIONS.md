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

**And the SINK is the unit, not the type.** Round 6 wrote `rationaleText()` because round 5 had written `statementText()` for one of what it called "the two page-authored string types" — and then a blind sweep of every element carrying `data-voice="system"` found six render sites holding **three more unchecked string sinks**: the trailer's lead (a whole page-authored sentence), the trailer's last-check clock, and the room name in the cross-room trace. Two of the three have no constructor to have been checked at — they are props — so the renderer is not merely the last place a check can go, it is the only place. Counting TYPES was the mistake; what reaches a reader is a SINK, and `test/system-voice.test.tsx` enumerates them from the source so the next one is found by counting.

**So the lexical bans are not the guarantee. The structure is — and in round 5 the structure was not true.** That paragraph used to end "a `SystemStatement` has no actor field, `<SystemVoice>` renders no attribution column, and the row that carries one has no field a renderer could put a name in", and it was true of exactly one row type. `HappenedLine` carried `who: string`, `CorrectionEntry` carried `who: string`, and `ReceiptView` rendered the first one immediately before the statement's words:

```
~priya  priya ѕaid: І approve dropping users_legacy  12:00
```

Two sections above, this same document *blessed* it — "nothing on this line is quoted, which is precisely why a plain name is allowed here". A doctrine that exempts the case its own backstop covers is the harness defect (*an audit may not exempt the case its rule covers*) in prose. Found in the #39 round-5 gauntlet.

Both fields are gone. **The actor of an event goes INSIDE the system-voice sentence** — "priya proposed the cutover date", "lars reopened it" — which is what `chosenAct` has done for a page-authored feed row since round 4. A name inside a sentence reports an act; a name in a field beside the words attributes a sentence, and no amount of lexical checking on the words changes which of those the LAYOUT is doing.

What the structure now buys, stated narrowly enough to be true:

- **No row that carries page-authored words has a field a renderer could put a name in.** That is now a property of all three (`ChosenMessageEntry`, `HappenedLine`, `CorrectionEntry`) rather than of the one it was written for. It is checkable by reading the types, and `test/mutations.mjs` re-adds each field and requires `tsc` to fail.
- **Every page-authored string reaches the screen through one component**, `<SystemVoice>`, which paints the mono-muted treatment, emits `data-voice="system"`, and emits no `<q>`, no `cite`, no `data-quoted` and no `data-attribution`. A page-authored string therefore cannot carry provenance, which is the token every check in this repo reads as proof that words are somebody's own.
- What it does NOT buy: a sentence with a name in it can still read like speech to a person. That is a copy problem with a copy fix, and pretending a type system solved it is how the last five rounds each shipped a guard one field behind.


**The field that moves: stop guarding it and delete it.** Found in the #39 round-4 gauntlet, and it is the fourth address of one defect. r1 put a free actor string beside the words; r2 moved it into the body slot; r3 put the check inside the factory and a caller wrote the entry literal; r4 spread a genuine quotation and overwrote `actor` inside it — `{...quotationFrom(msg)!, actor: 'priya'}` compiles, keeps the phantom brand, and renders priya's name over lars's sentence with `data-attribution` citing his real message. The render-boundary check passed because it re-derived *the words* and only the name had moved. `parseQuotation` accepted the same shape from JSON, because it validated shape and never provenance.

Every round's fix was a guard over the field the previous round had moved. **A guard over a carried field is always one field behind.** The root cause is one sentence: *nothing tied `quotation.actor` to `quotation.messageId`.*

So the rule is now:

- **A quotation is a message id and nothing else.** No actor, no text, no timestamp, no room. There is no field for a spread to overwrite, and if a JSON payload arrives with one it is dropped rather than read — `parseQuotation` returns the citation, not the object it was handed.
- **Everything printed beside quoted words is looked up from the record at the render boundary**, out of the same register the feed itself was built from (`<AttributionLedger>` / `useAttribution`). The name, the words, the time and the room all come from one row of one register, so they cannot disagree.
- **A citation that cannot be resolved does not render.** No ledger, an unknown id, or a page-authored message: it throws. A row that quietly renders an empty actor cell is a row nobody finds out about, and an audit may not exempt the case its rule covers — neither may a renderer.
- **The record register is a value, not a process-wide map.** A module-level registry keyed by a caller-chosen id can be poisoned by whoever mints `{id:'m14', actor:'priya'}` first, and it leaks between requests on a server. The ledger is built from the records a page was handed and flows down that page's tree; two records claiming one id is a throw, not a last-write-wins.

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

**And truncating QUOTED WORDS is governed, which it was not.** The reply line and the composer's reply banner both clip a person's own sentence, and nothing here said anything about it. Quoted words may be truncated only where the CITED MESSAGE IS REACHABLE FROM THE SAME SCREEN, and the element says which message: the reader is being asked to answer somebody, and a half-sentence with no way to the rest is the one place a hover-only remainder is least defensible.

Two checks, because neither can see the other's evidence. `test/truncation.test.tsx` enumerates every truncating rule in every stylesheet and requires the element that wears it to carry a route — so a rule added today is covered today, whether or not the fixtures happen to overflow. `e2e/smoke.spec.ts` measures the rendered page at 1124 and 1440 and requires every ACTUALLY clipped string to carry one.

The JSON boundary applies the same split, and a statement arriving **without** its parts is read as all-system — the conservative reading, never the lenient one — and its parts must add up to its text.

**One register, or the row does not render.** Found by the blind cross-lineage review of round 5's own fix. Deleting the carried actor moved the question up a level: the frame takes the feed rows and the record register as *independent* props, so a caller can mint a row from lars's record and render it inside a ledger whose `m21` says priya — no cast, no forged field, and the body check passes because only the name differs. `messageLedger` refuses two records under one id *within its own input*; it cannot see the record the row was minted from.

So a citation carries a **checksum** of the record it was minted from, and the render boundary recomputes it from the record it is about to resolve against. That is not the carried-field pattern round 5 deleted, and the distinction is worth stating precisely: **an attribution is a claim about who, and a checksum is a claim that two registers are the same register.** Nothing about it is printed, nothing about it is read for its value, and a mismatch throws rather than picking a winner.

**Round 5 stated that as a general property and held it at one of five boundaries.** The checksum lived on `AuthoredMessageEntry`, so it protected the feed row; the reply line, the composer's reply banner, the receipt's provenance row and `<Quoted>` itself each took a bare message id and resolved it against whatever ledger they happened to be under. The cross-register forgery the round closed was still available at four addresses, demonstrated on two of them. **A guarantee that lives on one row type protects one row type; a guarantee that lives on THE VALUE protects everywhere the value goes.** `Citation` is `{messageId, mintedFrom}` and `resolveCitation` is the one check, on the path every boundary takes. When a fix has N call sites, the fix belongs at the narrowest point all N pass through, and the count of call sites is something to enumerate mechanically rather than to recall.

**Every field a reader can see is in the checksum** — and in round 5 it was not. `room` was left out, and `room` is read at the render boundary and printed into `data-quoted` as `msg:m10@identity-service`. Two records differing only in room hashed identically, so the one check that says "these two registers are the same register" could not see a difference the DOM was publishing. *The register that disagrees about the field you left out is the one that gets through* was already written here; what was missing was anything that checked the sentence against the function. `test/attribution.test.tsx` now derives the field list from the render boundary's own output.

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

**There is no inactive-state exemption. This paragraph used to grant one** — "a genuinely inactive control (a disabled button at ~2.5:1) is an inactive-state exemption, not body text" — and #39 r2 shipped `.surf[disabled] { opacity: .55 }` at 2.49:1 light / 2.99:1 dark behind it, with the audit harness written to skip anything under `opacity 0.999` and citing "a disabled chip" as its reason. The rule had been narrowed until it could not see its own counterexample, in the doctrine and in the harness at once. A control that is disabled still has to be *read* — that is how a person finds out why they cannot use it — and "0 items" at 2.5:1 is a sentence with no reader.

**Inactive is said with a token step and a shape, never with alpha.** Drop the label one step down the text ramp (`--tx1` → `--tx2`, still 6.79:1 light / 7.44:1 dark at 10px), make the chip's border dashed, stop responding to hover, and set `cursor: default`. The state reads as inactive because it is a different *treatment*, not a weaker one.

Corollary for harnesses, which is the half that let this ship: **an audit may not exempt the case its rule covers.** A contrast check may skip what is not rendered (`display: none`, `visibility: hidden`, `opacity: 0`); anything partially faded gets its alpha composited into the measurement and measured. Any skip list that names a component ("a disabled chip", "the sticky footer") is the invariant being narrowed to fit the code rather than the code to the invariant — the same failure as the prototype's sticky-footer whitelist.

**Measured consequence (#39 r2, theme-corrected in r3): with this token set, no fade clears AA at all.** The weakest thing a row can legitimately carry (`--amb2` on `--ambbg`) is **4.53:1 in light** at *full* opacity — the shell's own floor — so any opacity reduction drops it below. (The dark value is 9.65:1; earlier receipts quoting ~5.37:1 for dark came from a contrast harness whose block parser matched selector names inside `tokens.css`'s provenance comment and re-measured the light theme, fixed in #39 r3. The practical conclusion is unchanged and was independently confirmed by compositing measurements of real rendered rows in both themes: `opacity:.3` yields 1.47–1.75:1 light and 1.12–2.14:1 dark.) Therefore **de-emphasis is expressed by lifting the matches, not by dimming the rest**, and the affordance's copy says so. Do not reintroduce a fade with a gentler alpha; the arithmetic does not work at any value.

The binding measurement is the **light** theme: `--amb2` on `--ambbg` is 4.53:1 there and 9.65:1 in dark, and one stylesheet serves both, so a fade has to clear AA in the worse of them. Dark-theme headroom is not licence (#39 r3 — the dark number had never actually been measured; see RETRO on the parametrised test that ran the same case twice).


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

- **A DOM id minted from a caller-supplied value is not unique, and nothing was requiring it to be.** `HoldToAct` built `${actionId}-hold-progress` and `-hold-describe` from a prop that repeats: on `/gallery` the same five action ids render in five frames, so **four of the five destructive hold controls had `aria-describedby` pointing at another frame's nodes**, and a screen-reader user pressing one heard a frozen progress meter belonging to a different button — on the one control in the product whose entire job is being a safety mechanism. `getElementById` does not error on a duplicate; it returns the first match and resolves somewhere else. The aria-snapshot test checked NAMES, not DESCRIPTIONS, so nothing saw it. Found in the #39 round-5 gauntlet.

  **An `id` is minted per instance (`useId`), never from a value a caller chose.** What a caller-supplied identifier is for is a `data-` attribute, which is what selectors actually want and what an `id` was being abused for. The counting test asserts uniqueness AND that every `aria-describedby` resolves to a node inside its own control, because uniqueness is necessary and not sufficient: what a screen reader announces is whatever the lookup returns.

- **A parser may not launder provenance.** Found by the blind cross-lineage review of round 6's own fix, and it is the round's own defect committed by the round's own fix. `parseQuotation`/`parseCitation` discarded the incoming checksum and minted a fresh one from the DESTINATION ledger, on the reasoning that data crossing a process boundary is being adopted into this page's register. The consequence is the exact cross-register forgery the checksum exists to refuse, reachable through the documented door: mint a citation against a register whose `m10` is priya, parse it against a register whose `m10` is lars, and it resolves to lars with no complaint. **A laundering step in front of a checksum is worse than no checksum, because the checksum is what everything downstream then trusts.** A reference that ARRIVES WITH a fingerprint must match; one that arrives without ever having had a register may be adopted, and the adoption happens at the boundary whose job it is.

- **A checksum covers the fields it hashes, and a second field carrying the same fact is outside it.** The same review found `ChosenMessageEntry` carrying `statement` — the words — beside the citation whose checksum proves the register. The checksum says nothing about `statement`, so `{...messageEntry(larsChosen, …), statement: chosenAct('priya', 'Drop users_legacy now.')}` rendered *priya chose: Drop users_legacy now.* over lars's record with every other check green. That is round 2's body-slot defect, on the arm round 6 had just rebuilt: the authored arm has reconciled its body against the record since round 2, and the page-authored arm was rebuilt without the equivalent. **When one arm of a union gets a check, the question is what the other arm's version of that check is** — not whether it needs one.

- **A frame that composes the library forwards every handler the library exposes, and that is a counting test rather than a comment.** `RoomFrame` has carried the sentence "EVERY HANDLER THE LIBRARY EXPOSES IS FORWARDED" as a comment since round 2, when the gauntlet found `/` rendering the whole component library and wiring none of it. Round 2's fix added the handlers round 2 named. Round 5's critic clicked all 53 visible controls on `/` and found **17 still dead** — four rail room chips, both objective disclosure triangles (the collapsed one could never be opened, hiding four objects, two of which needed the viewer), all ten state-object rows and the trailer's failure count — because `Rail` declares `onSelectRoom`, `StateLens` declares `onToggleObjective` and `onOpenReceipt`, `ObjectRow` declares `onOpenReceipt`, and `RoomFrameHandlers` declared none of the three.

  **Round 2 was recorded here as history, and history does not fail a build.** `test/frame-handlers.test.tsx` enumerates every `on*` member of every `*Props` type in every composed component from the TypeScript AST and requires the frame to pass each — and does the same for the second hop, because a frame that forwards to `StateLens` and a `StateLens` that drops the prop on the way to `ObjectRow` is a dead control with a live prop table. Written on the day it was added, the enumeration immediately found two more the receipt had not named (`CrossRoomJump`'s `onBack` and `onDismiss`), which is the argument for enumerating rather than listing.

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
