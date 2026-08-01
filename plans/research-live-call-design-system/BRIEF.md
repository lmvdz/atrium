# Research brief — prior Atrium design lineage ("Design system for live call interface")

## Provenance

- **Date**: 2026-07-31
- **Question**: which settled design patterns from the prior Atrium/Glance design exploration transfer to Atrium v1 as specified in `init.md` — the understanding-first, human-only, three-surface (Conversation / Current state / Needs you) multiplayer conversation product?
- **Target project**: Atrium (`/home/lars/atrium`, greenfield — `init.md` is the only artifact; architecture per init.md: Web → Server → Semantic Core → PostgreSQL).
- **Sources** (local, no VCS — all files dated 2026-07-31 on disk):
  - `C:\Users\Lars\Downloads\Design system for live call interface\` — 12 `.dc.html` interactive design-canvas prototypes (custom `<x-dc>` + `support.js` runtime), a folder-local `CLAUDE.md` of settled design decisions, and `uploads/` with 111 annotated screenshots (red-pen feedback passes over full app frames).
  - Two lineages: **Atrium** (Prototype → Variants → v2 → v3 → v3 Canvas → v4 → v5 → v6; fleet-ops/live-call product, light-default warm-paper theme) and **Glance** (Explorations → Object Model → Room Prototype → Process Tree; voice-agent branch, dark-only mono "WIRE" theme).
- **Full scout briefs** (in this directory): `scout-early.md`, `scout-mid.md`, `scout-late.md`, `scout-glance.md`. Concept cross-reference: `comparator.md`.
- **Confidence**: HIGH — all primary sources read directly; interactive prototypes dissected at markup/state-machine level, including version-to-version diffs. Not exhaustively read: ~50 individual mocks inside Glance Explorations (turn titles + annotations extracted verbatim), the 111 screenshots (2 sampled, both consistent with the briefs).

## Context: what this corpus is

This is **prior design work for Atrium itself**, done when the product thesis was "many agents, many paths, one shared context" — a multi-agent fleet-ops interface with live voice calls. init.md has since re-scoped v1 to a human-only, understanding-first conversation product (agents deferred to Phase 4+, voice/calls excluded). So this corpus is not a competitor or a library: it is six versions of dogfooded-by-iteration design intelligence for the same product, with the agent-era parts now mapping to init.md's Phases 4–5 and the trust/attention/reorientation parts mapping directly to v1.

The corpus's practice axis is unusually strong: strictly-additive refinement passes after the shell settled (only the earliest breadth phase has real deletions), a legible investment arc (v2: trust/receipts → v4: hierarchy/addressability → v6: explainability/correction), and two independent lineages converging on the same epistemic vocabulary.

## Ranked transferable concepts

Ranked against the target project's named bottleneck: **proving the reorientation thesis in Phase 1** — "after being absent for several hours, can a participant understand the current situation, important changes, unresolved questions, and their responsibilities substantially faster than in Slack?" (init.md). Secondary weight: init.md §5's make-or-break trust/correction requirement. No other bottleneck is on record (there is no CURRENT-STATE doc yet; init.md is the record).

### 1. The since-you-left digest

- **Pattern**: the feed carries a per-person divider at the first unseen event, rolling up what happened while away as counts by attention class: `SINCE YOU LEFT · 2 NEED YOU · 3 CHANGES · 24 ROUTINE HIDDEN`. Counts are computed live from state, not hardcoded; the divider fades from accent to muted once acknowledged; "seen" is per-group/per-thread, never one global mark-all-read ("no fake mark-all-read lie").
- **Mechanism**: every event is classified into needs-you / meaningful-change / routine at ingest; the digest is a query over (events since last-seen cursor × classification × current user). Clicking a count filters the view to that class (v6's `attnFilter`).
- **Value for Atrium**: this is the Phase 1 validation metric rendered as a component. It is the literal UI of init.md §4's compression model (hundreds of messages → a handful of meaningful changes → perhaps one attention item).
- **Where it applies**: the Conversation surface and the attention-projection tables (init.md's `attention projections` in Postgres); Phase 1 replay must render this divider over historical data.
- **Build vs buy**: borrow the pattern (it's a projection query + a divider component).

### 2. Epistemic provenance marking on every fact

- **Pattern**: every rendered fact carries one of three visual classes — system/human-verified (✓, green), someone's own claim (~, dotted underline, quoted), explicitly unverified (?) — with the written invariant *"a claim never dresses as a fact."*
- **Mechanism**: provenance is a first-class field on every event/derived object; the glyph is derived, never hand-set; claims render in the claimant's voice ("charm said it; the system checked it — this receipt is the difference between the two").
- **Value for Atrium**: init.md's semantic proposals have confidence + provenance + acceptance rules; this grammar is how that model stays honest in the UI. An LLM-derived "decision" is a *claim* until a human accepts it — visibly, everywhere. This is the single strongest defense against becoming "an unreliable AI summary layer" (init.md §5).
- **Where it applies**: Semantic Core output rendering across all three surfaces; the `semantic proposals` vs `accepted semantic objects` distinction in the schema maps 1:1 onto ~ vs ✓.
- **Build vs buy**: borrow the pattern and the glyph vocabulary verbatim.

### 3. Attention-first IA: owed attention never hides

- **Pattern**: what needs the current human is pinned above the feed, sorted hardest-first (failures > gates > decisions); everything clean compresses to counts; folding hides noise but never signals; the pin folds rather than scrolls; the strip ends with the reassurance trailer "everything else is green."
- **Mechanism**: attention items are objects with a required-human field, not messages; escalation climbs the containment hierarchy (in v1 terms: claim → objective/branch → room pin) and surfaces as a badge at each level; answered items leave the pin and enter the record.
- **Value for Atrium**: this *is* the Needs-you surface (init.md §3), with three settled sort/fold rules the prototypes converged on under load (8 units, 2 orchestrators — turn 17). Also settles the IA tension in Atrium's favor: the corpus A/B'd state-in-conversation vs state-as-separate-lens (v3 Canvas 1a/1b) and shipped the separate lens — init.md's three-surface split is the already-validated answer.
- **Where it applies**: Needs-you surface; attention computation in the Semantic Core; room-level pin in the Conversation surface.
- **Build vs buy**: borrow the pattern including the sort/fold rules.

### 4. Answer-binding composer

- **Pattern**: when a human replies to a pending question/decision, the composer shows a binding banner — *"your next message resolves it — nothing is inferred"* — scoped to the specific item ("in: auth refactor"). The answer is recorded as an explicit resolution, not an interpretation.
- **Mechanism**: replying from an attention item enters a bound-composer mode; the resulting message carries a resolution reference; the state reducer consumes it deterministically instead of running interpretation.
- **Value for Atrium**: directly attacks the hardest part of the conversation-to-state engine ("That sounds good" — was something approved?). Explicit binding turns the highest-stakes interpretations into zero-inference facts, shrinking the surface where the LLM can be wrong. Cheap to build, huge trust payoff.
- **Where it applies**: composer + Semantic Core acceptance rules; the deterministic reducer path in init.md's Semantic Core box.
- **Build vs buy**: borrow the pattern.

### 5. Correction, reopen, and inspectable inference

- **Pattern**: every machine judgment is labeled as such ("· inferred", tooltip: "inferred by the loop — click to inspect or correct"); answered/accepted items carry a reopen affordance that resets them to pending while preserving the prior answer on record; corrections are events, not erasures.
- **Mechanism**: derived state links to its source interpretation; a correction writes a superseding event; the original interpretation and the correction both persist (provenance chain).
- **Value for Atrium**: init.md §5 verbatim ("That was only a suggestion, not a decision" → reverse, preserve, retain source, don't repeat the error). The corpus's investment arc is the telling evidence: explainability/correction is what the *final* version invested in — the problem that stayed felt longest. Atrium already knows this from init.md; the prototypes confirm it's load-bearing and supply the affordances.
- **Where it applies**: Semantic Core corrections + supersession; every rendered derived object gets inspect/correct affordances from day one, not as polish.
- **Build vs buy**: borrow the pattern.

### 6. Receipts: the settled-record schema

- **Pattern**: every settled unit of work/decision leaves a structured receipt: what happened (each line epistemic-tagged), verification checklist, artifacts, who approved, linked parent/sibling receipts. Failures keep their history too. "The claims nobody ever checked — kept, not buried."
- **Mechanism**: a receipt is a typed object generated at settle-time, linked into a provenance graph (a decision's receipt indexes the claims and evidence it rested on).
- **Value for Atrium**: init.md's Decision/Commitment/Evidence objects need exactly this shape — the receipt schema (verified/claimed/unverified lines + linked evidence + approver) is a ready-made design for "accepted semantic objects" and their audit trail.
- **Where it applies**: Postgres `accepted semantic objects` + `provenance` tables; a receipt-view component in the Current-state surface.
- **Build vs buy**: borrow the schema shape.

### 7. Rich routine-collapse summaries

- **Pattern**: collapsed noise identifies itself: `31 routine · 11:50–11:57 · backfill, tests, hexi · click to peek` — count + time range + actors + peek affordance, never a bare "N hidden."
- **Value for Atrium**: the compression model must be reversible and legible or users won't trust the fold; this is the cheap version of trust-in-compression.
- **Where it applies**: Conversation surface feed; classification output of the Semantic Core.
- **Build vs buy**: borrow.

### 8. "Why does this need you" rationale on every attention item

- **Pattern**: every needs-you item carries a machine-stated reason naming the person and the authority gap: "needs lars specifically — you gave the original instruction"; "no agent has authority to choose between your steer and legal's rule."
- **Value for Atrium**: attention routing is only trusted if it can justify itself; this doubles as training signal capture when the user disagrees with the routing.
- **Where it applies**: attention computation output; Needs-you surface item rendering.
- **Build vs buy**: borrow; the rationale is generated at attention-item creation, not on render.

### 9. The design system itself (tokens, type, glyphs, themes)

- **Pattern**: a complete, six-versions-stable token system: warm-paper light default (`--bg0:#E6E2DA` … pine `--strip:#173A32`) + near-black dark (`--bg0:#0a0b0c`) behind one variable set; 3-step semantic ramps (green=verified, amber=needs-you, red=destructive/failed, blue=human); 7-step bg / 5-step text / 3-step line neutrals; mono (IBM Plex Mono) for machine/timeline rows, sans (Inter) for human chrome; the settled glyph vocabulary; asymmetric friction (one-click reversible vs 2s hold-to-arm irreversible); `prefers-reduced-motion` respected.
- **Value for Atrium**: this is Alex's own prior art, byte-stable across four versions — adopting it wholesale skips the entire visual-language bake-off (the corpus already ran it twice: five Variants directions and Glance's four founding languages, both converging). The mono/sans "machine chrome vs human prose" split was *stated* on the Glance branch but *implemented* on the Atrium branch — the light-default Atrium system is the one to carry.
- **Where it applies**: the Next.js app's root stylesheet; copy the `:root`/`html.atr-dark` blocks out of `Atrium v6.dc.html` nearly verbatim (drop the unused Sora import — vestigial across four versions; drop call-specific tokens like `--live` until Phase 4).
- **Build vs buy**: literal reuse — it's owned prior work, no dependency.

### 10. Wayfinding for open questions (fog → chart → clear)

- **Pattern**: before work is plannable, open questions live on a map: "fog" (not yet stateable) graduates to the frontier "the moment its question can be stated precisely"; resolving a frontier card clears fog behind it; when nothing is left to decide, the map becomes the plan's receipt trail.
- **Value for Atrium**: a ready-made lifecycle for init.md's Open-question objects and their relation to Decisions — including the non-obvious rule that a question's *stateability* is itself a tracked transition. Medium rank: valuable for the Current-state surface, not required for Phase 1 replay.
- **Where it applies**: Open question / Decision object lifecycle in the Semantic Core; a map-ish projection in Current state (as a projection, per init.md — see anti-pattern below).
- **Build vs buy**: borrow the lifecycle; skip the dedicated planning-agent framing until Phase 4.

### 11. Empty states as results, not absences

- **Pattern**: day-one state admits it's new and offers three first moves ("no fake data, no dashboard cosplay"); a quiet room presents silence as a result ("nothing needs you") rather than an absence.
- **Value for Atrium**: Phase 2/3 onboarding credibility; cheap.
- **Build vs buy**: borrow.

## Negative intelligence (tried and dropped — don't rebuild these)

- **Graph/map as primary navigation** — tried twice (canopy tree sidebar, node-edge process map), dropped twice, never returned. Confirms init.md: the semantic map is a projection, not the product. Build list/tree first; map view is a later lens.
- **Caption-dominant / voice-first primary layout** — tried independently on both branches (Variant 1d, Glance DECK), dropped on both.
- **Dedicated servers rail section** — dropped for per-entity metadata.
- **Collapsible rail** — built in v3, removed in v4 (fold affordance wasn't worth the instability).
- **Fully merging state into the conversation stream** (v3 Canvas 1b) — lost to the separate state-lens; only its guardrail copy survived.
- **"Crew" / sub-agent identities** — retired on both branches for the flat three-noun model. Relevant the day Atrium adds agents (Phase 4-5): sessions of a plan, no recursive spawning, no sub-identities.

## Deferred intel (agent-era; maps to init.md Phases 4–5 and the adapter seams)

Recorded, not ranked — these become live when agents/execution arrive: the fixed-depth agent → plan → session model and its OS/process-tree analogy (human = init, the only authority for destructive syscalls); escalation climbing session → plan → agent channel → room pin; per-noun number ownership (ctx% per session never aggregated, usage% per agent, spend rolled up per plan); voice-cannot-approve boundary + hold-to-arm; terminal as break-glass; the `ExecutionProvider` seam in init.md is where all of this will attach. The full specification is in `scout-glance.md` (Object Model) — the single best document in the corpus for that future phase.

## Verdict

Nine of eleven ranked concepts attack the Phase 1 bottleneck (reorientation) or the §5 trust requirement directly, and the design system is free to adopt wholesale. The corpus effectively de-risks Atrium v1's two hardest UI questions — "how do you render derived state without lying" (epistemic grammar + receipts + correction) and "how do you make absence recoverable" (since-you-left + attention-first + rich collapse) — with patterns that survived six versions of iteration. Everything is borrow-the-pattern; there is no dependency to adopt.
