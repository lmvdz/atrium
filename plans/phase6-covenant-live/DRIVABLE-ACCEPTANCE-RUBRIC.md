# Covenant Demo — Drivable Acceptance Rubric

> The fixed pass/fail bar for the Phase 6b thin drivable slice. Extracted ONCE (2026-08-18)
> in an isolated subagent from the destination scenario + the three papers + the ratified
> digest model, so the loop drives against this rubric instead of re-loading the papers every
> round. Blind A/B critics judge the demo against THIS file. Do not silently soften a MUST;
> reopen with Lars if a criterion is wrong.
>
> Authority: map #162 (destination + settled inputs); digest model ratified by Lars 2026-08-17
> (a ✓ means "current content == exactly what I signed"; content-addressed, re-validates on
> exact revert; machine only ever drafts ~, never mints ✓).

*Each criterion: a driver performs the action, observes the result within the stated window.
MUST = demo fails without it. SHOULD = polish, non-blocking. "Render tick" = the next paint
after the CRDT update applies, ≤1 s on the driving browser.*

1. **(MUST) Happy certify.** Driver selects a contiguous span of existing content and invokes certify. The span visibly renders a `✓` marker within a render tick, and the marker's extent covers exactly the selected span (no more, no fewer characters). PASS only if the ✓ appears and is bound to that content.

2. **(MUST) Certify is human-only in provenance.** The `✓` produced in (1) is attributable to the acting human identity (visible on inspect/hover or in the ledger row). The system exposes no code path, API, or UI by which a non-human peer can produce a `✓`. FAIL if any agent action can mint `✓`.

3. **(MUST) Drift → de-certify on single-character edit.** With a live `✓` span from (1), an agent-peer edits one character inside the certified span. The `✓` visibly flips to `~` (machine-draft) in front of the driver within a render tick. FAIL if it remains `✓` for any observable interval after the edit renders.

4. **(MUST) Drift on non-text mutation of the certified span.** Repeat (3) but the agent-peer changes only a mark/format (bold, link target retarget, or an embed/attachment swap) on the certified span without changing visible characters. The `✓` still flips to `~` within a render tick. FAIL if a format/link/embed change leaves `✓` standing — the digest is over rendered content, not plaintext only.

5. **(MUST) No collateral de-certification.** An agent-peer edits content *outside* any certified span. Every `✓` on untouched spans remains `✓` (does not flip). FAIL if an unrelated edit stales a span whose signed content is unchanged.

6. **(MUST) Exact UNDO → re-validate (undo-only, #213).** After a drift-induced `~` from (3), re-validation is by **restoring the original Yjs items** — an undo of the drift-causing edit (e.g. deleting the exact character that was inserted), so the certified span's *live CRDT item identity* is the one that was signed, not merely the same bytes. The mark returns to `✓` within a render tick, with no re-certify action by the human. A **re-type of identical characters STAYS `~`**: delete-then-reinsert of the same plaintext produces NEW Yjs items, which the anchor's snapshot verification (state vector + delete set + span item identity) correctly rejects — the digest is revert-stable but authorship/identity is not, so byte-equality alone does not re-validate. FAIL if it stays `~` after the original items are restored, or if a re-typed (new-item) span re-validates to `✓`.

7. **(MUST) Fail-closed on unverifiable state.** Force a condition where the signed snapshot cannot be verified (snapshot unavailable / GC'd / parse or hash error). The mark resolves to `~`/drift, never `✓`. FAIL if any such ambiguity yields or preserves a `✓`.

8. **(MUST — CARDINAL) No false ✓, ever.** Across the entire session there is no observable moment in which the system renders `✓` over content the certifying human did not sign. This is checked as an invariant over all other criteria: any single false `✓` observed anywhere fails the whole demo, overriding all other passes.

9. **(MUST — adversarial) Forged certification is inert.** A hostile agent-peer writes a CRDT row/attribute that asserts a `✓` (or human authorship/identity) it did not earn — a fabricated mark, spoofed signer, or copied digest attached to different content. The system renders this as `~` (or nothing), never as a human `✓`. FAIL if forged provenance renders as a genuine human certification.

10. **(MUST — adversarial) Digest cannot be satisfied by look-alike content.** A hostile peer replaces the certified span with content that is visually similar but not identical (homoglyph, whitespace, zero-width, or trailing-char variant). The mark is `~`, not `✓`. FAIL if near-identical-but-not-signed content validates.

11. **(MUST) Convergence — two browsers agree on content.** Two browsers (A drives, B observes) are in the same room. An edit in either converges so both render identical span content within a render tick of each other. FAIL on divergence or a lost update.

12. **(MUST) Convergence — two browsers agree on covenant state.** After the drift in (3), both A and B render `~` for that span; after the revert in (6), both render `✓`. The covenant mark converges, not merely the text. FAIL if A and B disagree on `✓`/`~` for the same span once quiescent. (This is the "green twice under concurrency" bar.)

13. **(MUST) Concurrent-edit honesty.** While a `✓` span is live, A and B edit concurrently such that the CRDT merges cleanly (no conflict marker) but the certified span's merged content differs from the signed content. The mark is `~` on both. FAIL if a clean merge that changed signed content leaves `✓` standing — this is the clean-merge-broken-meaning case the demo must defeat.

14. **(SHOULD) De-certification is legible.** The `✓→~` transition is visually distinguishable at a glance (color/glyph/animation), and hovering a `~` that was formerly `✓` indicates it drifted from a prior certification. Note if absent; non-blocking.

15. **(SHOULD) Re-certify after drift is one action.** From a `~` span, the human can re-certify the current content in a single action, yielding a fresh `✓` bound to the new content. Note if absent; non-blocking.

16. **(SHOULD) Recovery after transport interruption.** If B disconnects, an agent-peer edits a certified span, and B reconnects, B converges to the correct `~`/`✓` state without a stale `✓` appearing during reconciliation. Note any transient false `✓` during resync — a transient false `✓` escalates this to a MUST failure under (8).
