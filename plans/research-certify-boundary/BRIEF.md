# Every path by which a non-human write can land as certified state

**Date** 2026-08-11 · **Base** `fix/live-v8-fidelity` @ `927ca7eda40d68baf0f2ef8e245db23619c0f3b5` · **Branch** `research/certify-boundary` · **Ticket** #90 (map #89)

**Method.** Read-only. Started at `packages/core/src/authority.ts`, `epistemic.ts`, `policy.ts`, `reduce.ts`, then walked outward to every writer: `apps/server/src/{commands,ledger,projections,room-events,protocol,jobs/interpret,jobs/extraction}.ts`, `packages/db/drizzle/00{03,08,11}*.sql`, and the two read surfaces (`apps/web/lib/{live-room-view,replay-view}.ts`, `apps/web/src/components/model/glyph.ts`). Enumerated *writers* rather than grepping `isHuman`: the question "what can set `acceptedBy` to a human or move `humanTouchedAt` off `null`" has a finite answer, and the answer is two functions and two call sites. Both mutation ledgers (`packages/core/mutants/mutants.json`, 172 entries; root `mutants/mutants.json`, 96) were read as the existing claim set. One test file was executed (`packages/core/test/corrections.test.ts`, 47 passed, 455 ms) to confirm the epistemic assertions are live; nothing else was run, nothing was spawned, nothing needed tearing down. No product code was edited.

Note on the base: this worktree could not check out `fix/live-v8-fidelity` (held by the main worktree), so the branch was created and hard-reset to that branch's tip, `927ca7e`. The tree audited is byte-identical to `fix/live-v8-fidelity`.

---

## 0. The finding in one paragraph

The covenant holds in core and is **discarded at the projection boundary**. `packages/core` computes exactly one certification predicate — `epistemicStateOf` = `isHuman(acceptedBy) || humanTouchedAt !== null` — and **no product code anywhere reads it.** `humanTouchedAt` has no column, no wire field and no consumer outside `packages/core/src/state.ts`; `accepted_objects.accepted_by` is written and read by nothing; and the ✓ the user actually sees is derived by `apps/web/lib/replay-view.ts:783` from *row existence and the payload's own `verification` field*, never from who accepted. So there are two independent certification predicates in this repo, the enforced one is not the rendered one, and today they agree only by the accident that `modelMintingGate` happens to restrict a machine to the two types whose UI branches do not read `accepted`.

Second: no server path bypasses a core gate — the server is strictly *narrower* than core everywhere. The reachable-today risk is not a bypass but a single unasserted literal: the interpretation worker's `actor: { kind: 'model', … }` at `apps/server/src/jobs/interpret.ts:473`. Change that one object to a human member's id and every gate in `authority.ts` opens — no receipt, no θ floor, no type certification, no minting gate — and **not one test in this repository fails.**

---

## 1. Inventory: every write path that can produce or move certified state

Certified state = `epistemicStateOf === 'confirmed'` (✓), plus the three adjacent assertions the covenant covers: `claim.verification = 'verified'`, an `answers` edge (a question declared settled), and a `supersedes` edge (a certified object retired).

| # | Write path | Server entry | Certifies? | Status |
|---|---|---|---|---|
| 1 | `object_accepted`, human actor, cites a proposal | socket `accept_proposal` → `commands.ts:807` | yes — `acceptedBy` human ⇒ ✓ at birth (`reduce.ts:946`) | **enforced-in-core** (`selfStagedReadingRefusal`, `reduce.ts:889`) + server narrowing (`objectFromProposal` rebuilds the payload from the stored proposal, so the wire cannot supply one) |
| 2 | `object_accepted`, human actor, **no** proposal (direct/answer-binding) | none — unreachable from the wire | yes | **enforced-in-core** (`direct_acceptance` gate, `reduce.ts:738`; `selfStagedReadingRefusal` clause 2 covers it since r10) |
| 3 | `object_accepted`, model actor, own proposal | `interpret.ts:471` | **no** — `humanTouchedAt` stays `null`, `acceptedBy` is the model | **enforced-in-core** (`modelMintingGate` 714, `claim_verification` 724, `actorMatchesProposer` 778, `acceptanceReceiptRefusal` 824, θ floor, `typeCertifiableFromText`) |
| 4 | `object_corrected`, any verb | socket `correct` → `commands.ts:827` | yes — promotes `~`→`✓` (`commitPlan`, `reduce.ts:1635`) | **enforced-in-core** (blanket human-only, `reduce.ts:1043`; `correctionAttributionRefusal` 1077) |
| 5 | `claim.verification = 'verified'` arriving **in the accepted payload** | `record_proposal` (arbitrary `ProposalDraft.payload`) then `accept_proposal` | yes — mints a born-verified claim | **enforced only against non-humans** (`reduce.ts:724` reads the *actor*, never the *stager*). Any member can do this to their own claim in two commands. **#68** |
| 6 | `claim.verification = 'verified'` via `amend` | socket `correct` | yes | **enforced only against non-humans.** Changing only `verification` moves no name and no text, so `correctionAttributionRefusal` has nothing to say: any member may verify **any** member's claim. **#68** |
| 7 | `relation_added` kind `answers` | socket `answer_bind` / `answer_message` | yes — declares a question settled | **enforced-in-core** (`reduce.ts:1696`) + server (human-only command layer) |
| 8 | `relation_added` kind `supersedes` retiring a `claim` / `open_question` | none — no server path emits a relation under a non-human actor | retires a ✓ | **enforced-only-by-unreachability.** `decideSupersession` keys on the retired *type*, never on whether a human confirmed the object. **#60** |
| 9 | Human accepting another's staged reading with a **modified payload** | none — `objectFromProposal` forbids it on the wire | yes, under a third party's name | **enforced-only-in-the-command-layer.** `acceptanceReceiptRefusal`'s payload binding runs only when `!isHuman(actor)` (`reduce.ts:811`). **#81** |
| 10 | Projection of an acceptance into `accepted_objects` | `projections.ts:271` | — | **unenforced.** `humanId(actor)` (`projections.ts:107`) collapses model and system to `NULL`, the same value `ON DELETE SET NULL` writes for a deleted human. There is no `accepted_by_kind` and no `human_touched_at` column: **the read model cannot answer "did a person certify this".** |
| 11 | Read model → glyph | `replay-view.ts:757` `stateForObject` | renders ✓ | **unenforced / second predicate.** `verification: accepted ? 'accepted' : 'proposed'` — ✓ from the row existing. `accepted_by` is selected by nothing in `apps/web`. |
| 12 | Direct `INSERT` into `core_events` | out of band | anything | **enforced-in-DB, partially.** `atrium_core_events_invariants` (drizzle/0008:168) requires a `human` actor id to be a uuid *holding a membership in that room*, and re-derives `trusted_messages` itself. It does not bind an operator who disables triggers (0003 says so). |
| 13 | In-process `ledger.append({ actor })` | `commands.ts:478`, `interpret.ts:414/442/471` | anything | **unenforced.** `actor` is an ordinary parameter of a public method. Core's `TrustedContext` brand stops at `packages/core`; there is no equivalent one layer out, so nothing types the difference between "derived from a session" and "written by hand". This is hole **H1**. |

Actor provenance, for the record: there are exactly **two** places in the tree that construct an `Actor` for a write — `commands.ts:460` (`actorOf(session)`, always `human`) and `interpret.ts:416/442/473` (always `model`) — plus `ledger.ts:460` reconstructing one from the row's own columns on replay. `{ kind: 'system' }` is never constructed at write time. `CoreEvent` refuses at parse time to accept a payload carrying an `actor` (`events.ts`, mutant `payload_actor_guard_disabled`), so the r1 forgery class is genuinely closed.

---

## 2. Per hole: the minimal server-side check, and where it belongs

**H1 — the worker's actor is an unbranded literal.** *(highest severity; reachable today by a one-line change, defended by nothing)*
Flip `interpret.ts:473` to `{ kind: 'human', userId: <any author in the window> }` — the worker already holds those ids — and the acceptance skips `acceptanceReceiptRefusal`, the θ floor, `typeCertifiableFromText` and `modelMintingGate` entirely, sets `humanTouchedAt`, and satisfies the DB trigger (that author *is* a member). `selfStagedReadingRefusal` catches it only if the *staging* append is flipped to the same user id; flipping the acceptance alone leaves `stagedBy.kind === 'model'`, and the gate returns `null` on its first line.
*Minimal check:* mirror core's brand one layer out. `Ledger.append` should take `actor: SessionActor | MachineActor` where the human variant is constructible only from a `Session` — one function in `apps/server/src/session.ts`, one in `jobs/`, and `grep` finds every producer, exactly as `trustedContext()` does for the context. **Belongs in `apps/server/src/ledger.ts`** (the append boundary), not in core: core cannot see a session and correctly says so.
*Second half, and it is the cheap half:* assert the fold. `core_events.actor_kind = 'model'` and `accepted_objects.accepted_by IS NULL` after a worker auto-acceptance. Zero tests assert either today (§4, M1).

**H2 — verification is gated on species, not on relation (#68).**
`reduce.ts:724` asks *is the actor human*. Nothing asks *who, relative to the claimant*, or *on what evidence*. Two reachable shapes: a member mints a born-verified claim about themselves in two commands (path 5), and a member verifies anyone's claim with one `amend` (path 6).
*Minimal check:* one predicate in `authority.ts` — `verificationRefusal({ actor, claimant, before, after })` — refusing (a) a `verification` transition to `verified` by the claimant, and (b) `verification: 'verified'` present in **any** payload at acceptance, on the grounds that a proposal is a reading and a verification is a judgement about the world, so verification may only arrive through a correction whose actor the record names. Called from both `applyObjectAccepted` and `applyObjectCorrected`. **Core**, because the same rule has to hold for the interpretation pipeline's future model-staging seam, which the command layer will not be on the path of.

**H3 — a human acceptance may mint a different sentence under a third party's name (#81).**
`reduce.ts:811` runs payload binding only for `!isHuman(actor)`.
*Minimal check:* an `acceptanceAttributionRefusal` beside `selfStagedReadingRefusal`, running on the human path, applying r11's clause two one act earlier — the *text* may change (that is what acceptance is for) only when every name on the object after is the accepter's own. Derive names from `payloadAttributions` and text from `objectStatement`, never at the call site (r10's lesson). **Core reducer** — the command layer already forbids it, and #81's own argument is the right one: a guarantee that holds because one caller is well-behaved is a guarantee about that caller.

**H4 — supersession authority keys on the retired type, never on whether a person confirmed it (#60).**
*Minimal check:* `decideSupersession` takes the retired **record**, not its type, and refuses a non-human actor retiring anything with `epistemicStateOf(record) === 'confirmed'`. **Core (`policy.ts` signature + `reduce.ts:1764`).** This also gives `epistemic.ts` its first consumer in product code, which is worth as much as the fix — see H6.

**H5 — the read model cannot represent the distinction it exists to show.**
*Minimal check, three files:* a migration adding `accepted_objects.accepted_by_kind` (`actor_kind`) and `human_touched_at`; `projections.ts` writing both from the fold on `object_accepted` **and** `object_corrected` (the correction projection at :320 already omits every field it does not think changed — #56's general audit); and `replay-view.ts:757` deriving `verification` from those columns instead of from row existence. Until this lands, "a machine may never certify" is unobservable in the product: a ✓ on screen is not evidence that a person made it.

**H6 — two certification predicates, one of them dead.** `epistemicStateOf`/`epistemicGlyph`/`confirmedAt` are called by exactly one file in the repository, `packages/core/test/corrections.test.ts`. `apps/web/src/components/model/glyph.ts` is an independent vocabulary (`Verification` = `proposed | unverified | self_reported | verified | accepted | open | failed | routine`) with its own ✓ rule (`SETTLED`). Neither derivation knows the other exists. *Minimal check:* H5 makes core's predicate the source of the web's `verification`, deleting the second answer rather than testing it.

**#67 is not a hole**, it is an open design question (any human other than the stager may confirm a third-party commitment). It is correctly documented in `authority.ts`'s own "what stays open, deliberately". Left as filed.

---

## 3. Is `humanTouchedAt` reachable by a non-human write path?

**No, not in-process — and the guarantee is thinner than it looks.**

`humanTouchedAt` is written in exactly two places, `reduce.ts:946` (acceptance) and `reduce.ts:1635` (`commitPlan`, the single writer for every correction verb), both gated on `isHuman(actor)`. `actor` reaches the reducer only through the branded `TrustedContext`, whose only producers are `trustedContext()` and `authored()` — four call sites, all in `apps/server/src/ledger.ts`. The event schema has nowhere to put an actor and refuses one at parse. On replay the actor comes from the row's own immutable columns. There is no path from a payload, a wire frame, or a client to `actor.kind === 'human'`.

Three qualifications, in descending order of how much they should worry the campaign:

1. **`kind: 'human'` means "an authenticated account", not "a person".** `actorOf(session)` returns `human` unconditionally for any Better Auth session; there is no machine principal, no service token and no bot flag anywhere in `packages/auth`. An agent driving a member account is a human to every gate in the file. Nothing in the code can detect that, and nothing states the assumption — the covenant's floor is an operational claim about who owns accounts.
2. **H1**: the boundary between "human" and "model" is a literal in one worker file, asserted by no test.
3. **The value is write-only.** It is not projected, not sent on the wire, and read by no product code. A regression that set it wrongly would be invisible outside `packages/core`'s own suite — which is what makes H5 a certification hole and not merely a missing column.

---

## 4. The mutation-test target set

**Already anchored** (verdicts in the two `RESULTS.md` ledgers; these are the gates whose deletion a named mutant already catches): `claim_verification_gate_disabled`, `decision_never_auto_disabled`, `direct_acceptance_gate_disabled`, `answers_human_gate_disabled`, `supersession_policy_narrowed`, `corrections_human_gate_disabled`, `receipt_skipped_entirely`, `confidence_floor_disabled`, `payload_binding_disabled`, `provenance_binding_disabled`, `proposer_binding_disabled`, `commitment_model_mintable`, `objective_model_mintable`, `reducer_type_certification_removed`, `payload_actor_guard_disabled`, `the_mint_gate_is_inside_the_proposal_block_again`, `a_human_acceptance_is_always_the_receipt`, `the_stager_is_whatever_the_reading_claims`, `the_socket_chooses_the_proposer`, `the_attribution_gate_is_per_verb_again`, `the_gate_never_refuses_on_the_sentence[_over_the_wire]`, `answers_edge_ignores_retraction`, `answers_edge_ignores_already_answered`. The certification perimeter inside `packages/core` is genuinely well pinned.

**Missing — the answer to "which assertion fails when this gate is deleted?" is "none".**

| id | mutation | today's answer | the assertion that must exist |
|---|---|---|---|
| **M1** `the_worker_accepts_as_a_human` | `interpret.ts:473` `actor` → `{kind:'human', userId: <window author>}` | **ESCAPED.** No test in the tree reads `core_events.actor_kind` or `accepted_objects.accepted_by` for a worker append (grep-verified across `integration/`, `apps/server/test/`). `integration/server/interpret.test.ts:782` and `:1063` assert an auto-acceptance landed and check only its payload and count. | after a worker auto-acceptance: `actor_kind = 'model'`, `accepted_by IS NULL`, and (post-H5) `human_touched_at IS NULL` |
| **M2** `the_worker_stages_as_a_human` | `interpret.ts:416` same flip | partially caught — and only through `selfStagedReadingRefusal`, and only if M1 is applied with the *same* user id. Alone, it silently relabels `proposals.proposer_kind`. | `proposals.proposer_kind = 'model'` and `proposer_user_id IS NULL` for every worker-staged row |
| **M3** `the_human_touch_lands_on_a_machine_acceptance` | `reduce.ts:946` → `humanTouchedAt: event.at` | caught, by one test only — `corrections.test.ts` "is unconfirmed for a model-accepted object". No ledger anchor. | add the anchor; the assertion exists |
| **M4** `the_correction_touch_is_unconditional` | delete `isHuman(actor)` at `reduce.ts:1635` | **no test fails, and no behaviour changes** — corrections are already human-only at :1043, so the guard is unreachable defence-in-depth. This is a *dead gate*, not a hole; recorded so a future round that hands a model a correction verb knows the second gate is untested | a test that reaches `commitPlan` under a model actor, which needs :1043 relaxed — i.e. this one waits |
| **M5** `the_predicate_always_confirms` | `epistemic.ts:36` → `return 'confirmed'` | caught only inside `corrections.test.ts`; **invisible to the product**, because nothing else calls it | after H5: a projection/read-model assertion, so the predicate's mutation moves a rendered glyph |
| **M6** `the_read_model_forgets_who_accepted` | `projections.ts:107` `humanId` → return a fixed uuid | **ESCAPED** on the model branch. `integration/server/interpret.test.ts:867` pins `accepted_by = owner` on the *human* path only | `accepted_by IS NULL` after a model acceptance (same row as M1) |
| **M7** `the_glyph_certifies_from_existence` | `replay-view.ts:783` → `verification: 'accepted'` unconditionally | unverified — `apps/web/test/replay-view.test.ts` may catch the claim branch, not checked in this pass | a read-model test asserting a model-accepted object renders `~` |
| **M8** `verification_rides_in_on_a_proposal` | delete the (not yet existing) H2 check | n/a — the gate does not exist | `record_proposal` with `verification: 'verified'` then `accept_proposal` must be refused |
| **M9** `supersession_ignores_who_confirmed` | delete the (not yet existing) H4 clause | n/a | a model actor may not retire a claim with `humanTouchedAt !== null` |

The denominator lesson from #60 applies to the whole set: the existing matrices vary the *actor kind* and the *object type*, and never the **relation** between the actor and the object (its stager, its claimant, its accepter). Every hole in §2 lives in that missing dimension.

---

## 5. Status of the cited findings on this tree

| # | filed as | on `927ca7e` | note |
|---|---|---|---|
| **#68** | `claim_verification` gated only on `isHuman` — any member may verify any claim | **OPEN, unchanged, and one step worse than filed.** `reduce.ts:724` and `:1043` both read only the actor's kind. The ticket describes the `amend` route; the *acceptance* route is also open — `ProposalDraft.payload` is an unconstrained `ClaimPayload`, so `record_proposal { verification: 'verified' }` + `accept_proposal` mints a born-verified claim in two commands, and `selfStagedReadingRefusal` permits it because the claimant is the accepter. | add the acceptance route to the ticket |
| **#67** | any human may confirm a third-party commitment they did not stage | **OPEN, unchanged, correctly a design question.** Verified: `acceptanceReceiptRefusal`'s `third_party_confirm` runs only for non-human actors; `authority.ts` documents the position explicitly ("the answer today is *any human other than the stager*"). | no code change proposed |
| **#81** | a human accepting another's staged reading may mint a different sentence under a third party's name | **OPEN, unchanged, still unreachable from the wire.** `reduce.ts:811` gates all payload binding on `!isHuman(actor)`; `commands.ts:807` still builds the object with `objectFromProposal` from the stored proposal, so the socket offers no seam. Core-open, server-closed. | ticket body remains accurate |
| **#60** | a model can retire a human-confirmed claim using an object it had no part in | **OPEN in core; unreachable from any server path on this tree.** `decideSupersession('claim'/'open_question') = auto_accept` (`policy.ts:709/715`) and `reduce.ts:1764` gates on that alone. New fact for the ticket: **no server code path emits `relation_added` under a non-human actor at all** — the worker emits only `proposal_recorded`, `proposal_superseded` and `object_accepted`; the two relation commands are on the human socket. So this is a reducer-boundary defect with no live exploit, the same shape as #81. | add the reachability note |

None of the four is fixed. None is worse in kind. Two (#81, #60) are core-open/server-unreachable — which is precisely the disposition the campaign has decided twice already (r10's `decidedBy`, r11's clause two) means *fix it at the reducer anyway*.

---

## 6. Contradictions found in the ticket body

Checked every factual claim in #90 against the tree. **The file-and-line claims are all correct**, which is worth saying plainly because the ticket asks to be doubted:

- `authority.ts` `isHuman` "line ~226" → **exactly 226**. ✓
- `reduce.ts` gates "at ~715, ~724, ~738, ~811, ~946" → **exactly** the minting gate (714–715), the claim-verification gate (724), the direct-acceptance gate (738), the non-human receipt block (811) and the `humanTouchedAt` assignment (946). ✓
- `epistemic.ts` "confirmed = `isHuman(acceptedBy) || humanTouchedAt !== null`" → verbatim, `epistemic.ts:36`. ✓
- The four cited findings are all still open and all still describe real code. ✓

Three framing corrections, none of them a factual error:

1. **"a gate in core that the server can bypass is a hole" — the direction is inverted on this tree.** No server path bypasses a core gate; `apps/server` is strictly narrower than `packages/core` at every certification site (no non-human relation writer, no caller-chosen payload at acceptance, no caller-chosen proposer, no caller-chosen receipt window). The live risk is the opposite shape: the server *discards* a core verdict (H5/§0) and the server's own actor derivation is the thing core cannot check and no test asserts (H1). A brief that only looked for bypasses would have found nothing and reported green.
2. **The ticket lists `epistemic.ts` as "the enforcement machinery".** It is not machinery, it is a derivation nothing in the product calls. The enforcement is entirely in `reduce.ts`'s two `humanTouchedAt` writes and `authority.ts`'s gates; `epistemic.ts` is the *reader* the product never wired up.
3. **#68 as summarised ("any member can mark a claim verified") understates it** — see §5.

---

## 7. What should graduate from this brief

In severity order, as build tickets: **H1** (brand the ledger's actor + assert the worker's fold — the only reachable-today item, and cheap), **H5/H6** (project and render the predicate; without it the covenant is unobservable), **H2** (#68, needs #4's authority table to answer *who may verify*), **H4** (#60, one predicate, reuses `epistemicStateOf`), **H3** (#81). **M1, M2, M6** are three assertions in one existing integration test and should ride with H1 rather than waiting for a mutation round.
