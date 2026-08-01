# Research brief — block/buzz, read for Atrium

## Provenance

- **Date**: 2026-08-01
- **Question**: what does Buzz — the closest live analog to Atrium — get right that we should take, and what has it gotten wrong that we can refuse to repeat?
- **Target**: github.com/block/buzz, HEAD `19d57b0d46baa55814ac737041a36d0b405c9f64` (2026-08-01), default branch `main`, Apache-2.0, ~19.7k stars, ~2,046 commits since 2026-03-06, ~2,005 forks.
- **Method**: read-only. Three parallel scouts — artifact axis (`buzz-architecture.md`), failure diary (`buzz-failures.md`), practice axis (`buzz-practice.md`), all in this directory. Nothing was written to block/buzz: no issues, comments, forks, branches, or PRs.
- **Confidence**: HIGH on code and tracker claims (each cross-checked against source at a pinned SHA; where a doc asserted an invariant the scouts opened the code that would enforce it). MEDIUM on adoption narrative — GitHub Discussions is empty, so first-person user language comes only from issue text, and no maintainer "we use this daily" quote exists beyond the README's internal-build carve-out.

## What Buzz is, in one paragraph

A self-hosted team communication platform built directly on the Nostr wire protocol: every action — message, reaction, workflow step, canvas edit, agent job — is a signed Nostr event dispatched by a `kind` integer, persisted by a single relay (Postgres + Redis), fanned out over WebSocket. ~27 Rust crates; humans and agents are both just keypairs; a "community" is the tenant. Five months old, releasing roughly daily, three humans carrying two-thirds of the commits.

## The finding that matters most

**Buzz's documentation is better than Atrium's and its enforcement is worse — and every serious bug lives in that gap.**

Their multi-tenancy spec (`docs/multi-tenant-relay.md`, 1,110 lines) includes TLA+ and Tamarin models, 32/32 lemmas green, and axioms A-RLS-1..5 requiring Postgres row-level security as a fail-closed backstop *with a startup/CI assertion suite that rejects the deployment on failure*. A `grep` for `ENABLE ROW LEVEL` / `CREATE POLICY` / `SET LOCAL app.community_id` across all migrations and crates returns **zero matches**. Their own tracker says so (#4060). Tenant isolation today rests entirely on every query author remembering a `community_id` predicate by hand — which the sampled queries do, but that is discipline, not a boundary.

The consequences are visible in the tracker as a recurring pattern rather than isolated bugs: workflow execution keyed `(community_id, id)` in the schema but looked up by bare id, so colliding UUIDs let community B drive community A's workflow (fixed, `c81b89355`); a ban enforced at the WebSocket auth handshake but not on the HTTP path reaching the same privileged operations (fixed, `e2e007910` — and the fix notes this was *the same class* as a prior fix that was never extended to the sibling kind range); a community write-fence assert silently dropped during an unrelated refactor (fixed, `3dc8606bc`).

**Atrium's differentiator should not be better specs. It should be that the enforcement is structural and asserted at boot.** This directly validates the demand our own realtime gauntlet made — revoke direct INSERT, append only through a procedure — and it adds a requirement we did not have: a conformance assertion that runs at startup and in CI and refuses to come up if the backstop is missing.

## Mistakes to refuse — nine defect classes, mapped

Ranked by how likely Atrium is to make the same one.

1. **A documented fail-closed gate never wired into CI or startup** (#4060). → Implement RLS on Atrium's tenant/room-scoped tables *and* a conformance assertion at boot + in CI (extends #40's job and #22's DB enforcement). Owning tickets: **#22, #40**.
2. **Composite keys in schema, bare-id lookups in code** (`c81b89355`). → We already have composite `(room_id, id)` FKs from #22's round-1 gauntlet; the lesson is that the schema having them proves nothing. Add a test/lint that fails on a tenant-scoped query missing its room predicate. Owning ticket: **#22**.
3. **The same authorization check at one entry point but not another** (#3020 — WS enforced, HTTP not; and the fix explicitly did not close the class). → Atrium's `authorize(command, membership)` must be the single choke point for every transport we ever add; today ws is the only one, which is exactly when to write the rule down. Owning ticket: **#26**.
4. **Second-resolution timestamps as ordering/uniqueness keys** (#3468 and #3848 — same root cause, two subsystems, silent write loss). → Atrium hit this class and closed it: canonical `(at, id)` ordering with strict inequality, and monotonic minting `max(now, lastAt+1ms)` in the ledger. **Keep it; this is independent confirmation the design was necessary, not paranoid.**
5. **Stale "not yet implemented" guards outliving the feature** (#3525 — the approval gate is ~90% built end to end, but `finalize_run` still hits a comment-era guard and marks runs Failed). → Add to the weekly staleness sweep (#29): grep for not-implemented guards referencing tickets that have since closed.
6. **Expected-error carve-outs that swallow an unrelated failure sharing the same error code** (#4033 — a `42P17` carve-out silently and permanently stops monthly partitioning, "no error, no metric, no operator-visible signal"). → Narrow every catch to an exact condition; our pg-boss DLQ and ledger error paths are the exposure. Owning tickets: **#22, #23**.
7. **Shared mutable store keyed by machine rather than tenant** (#4038, #3371: one on-disk agent nest per install, so `RESEARCH/`, `OUTBOX/` and auto-injected `MEMORY.md` pool across communities — *"Relay membership separates what agents can say; it does not separate what they know"*). → Phase 4+ requirement: agent memory and workspace keyed by `(workspace, agent)`, never by host filesystem. Record in the map's fog.
8. **Presence that reflects transport, not capability** (#3831, #2062, #3969 — agents show "online" for a day after their credentials expire, or after the runtime dies). → Atrium's presence is ephemeral ws state, so we inherit the hazard the moment agents exist: "online" must mean *can do the thing*, not *socket is open*.
9. **Turn-based agents with no intermediate signal read as total silence** (#4065, self-reported by the agent: a six-minute turn, owner sending "why no answer????????"). → The agent-era Conversation surface must show work in progress, and a concurrent mention must surface "already busy" rather than merging silently.

## Accomplishments to take — ranked

1. **Prove catch-up completeness, don't assume it.** NIP-RS's Full-State Load procedure establishes that a client has seen *all* of its own read-state against a relay that silently caps query results — descending-cursor enumeration, a derived cap lower bound, a proven floor of L=2, and a live subscription established *before* enumeration as a fence. It terminates as "potentially incomplete" rather than silently wrong, and is backed by a bounded exhaustive model with a **9-mutant harness** (`docs/formal/nip-rs-unread/`). Atrium just fixed the analogous defect (`more` computed from page fullness rather than `to < head`, plus a doorbell as the only delivery path). **Take: apply our mutant-ledger rule to the catch-up primitive specifically, and adopt the "terminate as incomplete rather than claim complete" posture.** Owning ticket: **#22**.
2. **Authorization without impersonation.** NIP-OA: an owner signs an attestation authorizing an agent's own-authored events under conditions, and *"an event that includes a valid auth tag remains authored by `event.pubkey`."* Explicitly not delegation. → This is the right shape for Atrium's agent era: a model acting under human authority must never *become* the human. It generalizes the actor-out-of-payload work already landed in `packages/core`.
3. **Derived, auto-revoking agent access.** NIP-AA: an agent whose owner is a member gains virtual access; when the owner's membership is revoked, the agent's next connection fails. Structurally solves "the operator forgot to remove the agent" — the exact class our auth rounds fought as revocation propagation. → Phase 4 design input.
4. **Tenant resolved server-side from the connection, never from a client-supplied tag** — they name the alternative a confused-deputy vulnerability. Independent convergence with Atrium's trusted-actor decision (actor from the authenticated session, never from the payload). **Take the vocabulary**; it makes the rule teachable.
5. **Forward compatibility by construction.** New capability = new `kind` integer; unknown kinds are ignored by old clients; the registry has collision checking. No breaking wire changes by design rather than by discipline. → Atrium's event-type union should have the same property, and our `satisfies Record<CoreEventType, true>` exhaustiveness check is the TypeScript analog.
6. **An activity-feed doctrine worth stealing wholesale** (`VISION_ACTIVITY.md`): every item renders as **verb, object, outcome**; twelve render classes in three tiers by read frequency; and four rules — *never go dark* (idle/waiting/timeout are rendered states, never silence: "if you didn't show it, it didn't happen"); *failures rise, reads recede*; *resolve references* (show `#design` or a filename, never a raw id); *polished by default, raw on demand* (the raw rail is a zoom level on the same truth, not a second feed). → Directly applicable to Atrium's Conversation surface now and the agent feed later. Owning tickets: **#39, #25**.
7. **Test the release machinery, not just the release.** CI runs unit tests *of its own scripts* (`test-release-ref-contract.sh`, a file-size ratchet with its own `node --test` suite). → We built a self-testing policy engine in #28 independently; this validates the direction and suggests extending it to the release path.
8. **The diagnostic tool must not be gated by what it diagnoses.** `buzz doctor` dispatches before the credential gate, so a broken key doesn't block the tool that tells you the key is broken. → Cheap, obviously right, worth copying whenever Atrium grows a doctor command.
9. **Publish an honest capability table.** Their README has a "Works today / Being wired up / Not yet real" table, with push notifications and reputation explicitly marked unbuilt. → A public commitment not to overclaim, and a cheap credibility win.

## Market read

Buzz's memory model declines Atrium's product in writing. NIP-AE is a flat, pairwise-encrypted key-value store, and the spec says so: *"Richer taxonomies (provenance, trust levels, attention/working sets, structured links, owner-to-agent directives) are intentionally out of scope for this NIP and belong in companion NIPs."* Its security section adds: *"Memory poisoning. Encryption protects confidentiality, not the truthfulness of what the agent decides to remember. Admission control is the implementer's problem."*

That is Atrium's entire thesis — typed semantic objects with provenance, epistemic marking, acceptance rules, and correction — named as out of scope by the closest analog in the market. Buzz's trust model is *everything is signed, so there is no unverified tier to show*; there is no UI affordance distinguishing verified fact from claim. Atrium's `✓` / `~` / `?` grammar has no counterpart there.

Two things to respect, though: their unread/catch-up primitive is more rigorously specified than ours (see #1 above), and their agent permissioning is more mature than anything Atrium has designed for Phase 4.

## Verdict

Nothing here changes Atrium's direction; several things sharpen it. The single highest-value transfer is the conformance-assertion discipline — implement the isolation backstop *and* refuse to boot without it — because Buzz demonstrates that a beautifully specified, formally verified boundary still ships unenforced. Second is the catch-up completeness posture. Third is the activity-feed doctrine, which is free and immediately usable by #39.

Everything here is borrow-the-pattern. There is no dependency to adopt: Buzz is Rust on Nostr, Atrium is TypeScript on Postgres, and the wire protocols do not meet.
