# Covenant predicate partition (SL-5 PREDICATE-CARVE, #192)

**Purpose.** #181 (SL-6) migrates the display readers that emit `✓`/`~` to compute the
glyph through the covenant read authority `resolveCovenant(doc, anchor)` — "does the
certified **content** still resolve to the exact certified fragment." But some
`epistemicStateOf` / `epistemicStateFromAcceptance` callers do **not** ask that question.
They ask a **provenance** question — "did a *human* take responsibility in the ledger" —
and `resolveCovenant` *deliberately does not answer it* (see the docblock on
`resolveCovenant` in `covenant.ts`: `objectId`, `roomId`, `certifier`, `certifiedAt` are
"PROVENANCE / receipt identity … it intentionally does NOT read those four fields").

A blind grep-migrate typechecks green and **silently changes which supersession refusal a
room hears**, or whether a machine-signed landing renders certified. This doc is the
canonical partition that prevents that semantic-merge disaster; the pins in
`test/authority-matrix.test.ts` (`describe('SL-5 predicate-carve …')`) lock the current
provenance behavior byte-for-byte so a wrong move fails the suite.

## The carve rule (one line)

- **KEEP** = the caller answers *provenance* — "is this principal a human / did a human
  take responsibility." Structurally these read the predicate to select a **refusal
  reason** or as a **`!isHuman` gate** (`humanTouchedAt` passed as `null`, so the call
  reduces to `isHuman(kind)`). `resolveCovenant` cannot answer this; migrating them is a
  category error.
- **MIGRATE** = the caller emits the **content glyph** for an object — "has a human touched
  *this object's content*." Under #181 the *meaning* of that glyph migrates to "the anchor
  still resolves." These route through `resolveCovenant` in SL-6.

## The actual call sites

Enumerated from the tree (grep of `epistemicStateOf` / `epistemicStateFromAcceptance`,
non-comment, non-definition). There are **six** real call sites — two KEEP in core/server,
two KEEP in web, two MIGRATE in web. Several sites the Plan hypothesis named are **not
callers at all** (see corrections).

### KEEP — provenance / reason-selection / `!isHuman` gate

| # | Site | What it reads | The question it answers | Verdict |
|---|------|---------------|--------------------------|---------|
| 1 | `packages/core/src/reduce.ts:2031` | `epistemicStateOf(target) === 'confirmed'` under `!isHuman(actor)` | Selects the refusal **reason** (`confirmed_supersession` vs `unconfirmed_supersession`) when a non-human tries to supersede an accepted `auto_accept` object. Not "does content resolve." | **KEEP** |
| 2 | `apps/server/src/commands.ts:2293` | `epistemicStateOf(retired) === 'confirmed'` under `!isHuman(actorOf(session))` | Selects the `CommandError` **message text** for the same non-human supersession refusal at the command layer. Provenance. | **KEEP** |
| 3 | `apps/web/src/components/control/state.ts:120` | `epistemicStateFromAcceptance(session.certifiedByKind, null) !== 'confirmed'` | **`humanTouchedAt = null` → pure `isHuman(certifiedByKind)`.** "Was this landing's signature performed by a *human* kind?" A session signature has **no content anchor**; `resolveCovenant` has nothing to resolve here. Provenance. | **KEEP** *(hypothesis said MIGRATE — corrected)* |
| 4 | `apps/web/src/components/control/state.ts:135` | `epistemicStateFromAcceptance(session.certifyArmedByKind, null) !== 'confirmed'` | Same as #3 for the **armer** of the certify-hold. "Was the arm performed by a human?" Provenance `!isHuman` gate. | **KEEP** *(hypothesis said MIGRATE — corrected)* |

### MIGRATE — content-certification display readers (SL-6 routes through `resolveCovenant`)

| # | Site | What it reads | The question it answers | Verdict |
|---|------|---------------|--------------------------|---------|
| 5 | `apps/web/lib/replay-view.ts:932` (`certified()`) | `epistemicStateFromAcceptance(acceptance.acceptedByKind, acceptance.humanTouchedAt)` with the **real** persisted `humanTouchedAt` | The object's `~`/`✓` certification glyph at replay — "has a human touched *this object's content*." This is exactly the glyph whose meaning #181 migrates. | **MIGRATE** |
| 6 | `apps/web/lib/replay-transitions.ts:65` | `epistemicStateFromAcceptance('human', at) === 'confirmed'` → `verification: 'accepted'` | The **optimistic** display tick for a human retype (a display-side glyph derivation on the certification axis). Emits the glyph; migrates with the other display readers. | **MIGRATE** |

## Hypothesis corrections (Contract item 1)

The Plan's KEEP/MIGRATE hypothesis was **materially wrong on five points**. Evidence:

1. **`authority.ts:178/206/303` are NOT `epistemicStateOf` callers.** They are **docstring
   references** (prose that names the predicate). `authority.ts` imports no `epistemic`
   symbol; grep for `import … epistemic` in it is empty. What `authority.ts` actually
   *defines* is `isHuman` (line 307) — the gate the KEEP sites rest on. So the KEEP set in
   core/server is `reduce.ts:2031` + `commands.ts:2293`, plus the `isHuman` **definition**
   in `authority.ts` (not three call sites).

2. **`commands.ts` is `apps/server/src/commands.ts`, not `packages/core/src/commands.ts`.**
   The hypothesis wrote a bare `commands.ts:2293`; the file lives under `apps/server`.

3. **`control/state.ts:120/135` are KEEP, not MIGRATE.** Both pass `humanTouchedAt = null`,
   so they are pure `isHuman` provenance gates on the certifier / armer of a *session
   signature receipt* — "was this landing signed/armed by a human?" There is no document /
   content anchor for a session signature, and `resolveCovenant` explicitly refuses the
   provenance question (its own docblock). Migrating them to the content authority would be
   a category error that changes whether a machine-signed landing can render certified.
   **This is the exact semantic-merge hazard this lane exists to catch — flagged for
   orchestrator adjudication because #181's body lists `control/state.ts` as a reader to
   migrate; the covenant contract (provenance ≠ content) decides KEEP.** Either way the
   pins lock the current provenance outcome.

4. **`projections.ts` is not a predicate caller — it is a column *writer*.** It writes the
   `accepted_by_kind` / `human_touched_at` read-model columns (migration 0019); it never
   reads `epistemicStateOf`. It is the data *source* the MIGRATE readers consume, not a
   partition member. (No behavior change here; note for SL-6.)

5. **`glyph.ts` and `yjs-conversation.ts` are not predicate callers either.**
   `glyph.ts`'s `glyphFor(state)` consumes a *richer composite* `EpistemicState` (carrying
   a `.verification` axis), not `epistemic.ts`'s `'confirmed'|'unconfirmed'` predicate — it
   never calls `epistemicStateOf`. `apps/web/app/prototype/yjs-conversation.ts` contains no
   `epistemicState*` call at all.

**Net:** the true partition is 6 call sites (4 KEEP, 2 MIGRATE), not the ~11 the hypothesis
enumerated. The over-enumeration is itself a hazard: a migrator told "these are the readers"
would touch `control/state.ts` (a KEEP provenance gate) and `authority.ts` (which has no
call to touch).

## What the pins lock

`test/authority-matrix.test.ts` → `describe('SL-5 predicate-carve — provenance is
byte-frozen at the KEEP sites (#192)')`:

- **Predicate provenance truth table** — `epistemicStateOf` / `epistemicStateFromAcceptance`
  across every `Actor['kind']` × `humanTouchedAt ∈ {null, set}`. Locks the `!isHuman`
  outcome that KEEP sites #1–#4 all rest on (`humanTouchedAt=null` reduces the predicate to
  `isHuman`).
- **`confirmed_supersession` reason, byte-identical** — drives the reducer (a `model`
  actor superseding a *human-accepted* claim) and asserts `issue.reason` equals the exact
  current string. Locks `reduce.ts:2031`'s reason-selection (KEEP #1).
- **`unconfirmed_supersession` reason, byte-identical** — a `model` actor superseding a
  *model-accepted* claim. Locks the other branch of `reduce.ts:2031`.

If SL-6 accidentally routes a KEEP site's predicate through the content authority, the
`confirmed` selection flips (an in-memory object has no resolvable anchor → would read
`drift`/unconfirmed) and these pins go red. Proven to bite: flipping `reduce.ts:2031` to
`const confirmed = false` fails the `confirmed_supersession` pin.
