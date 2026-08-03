# Tracker snapshot — 2026-08-03 

**The issue tracker is private and unreachable from a sandboxed shell** (`gh` returns
`error connecting to api.github.com`). This file is a point-in-time copy so work can
continue without it. **It is a snapshot, not the source of truth** — if you can reach
github.com/lmvdz/atrium, use the live tickets and ignore this file.

## Open tickets

- #1 — Wayfinder map: Atrium through Phase 2
- #8 — Decide the interpretation pipeline architecture
- #10 — Prototype the three-surface app frame
- #21 — Build: semantic core engine
- #22 — Build: realtime layer
- #23 — Build: interpretation worker
- #24 — Build: eval golden set and runner
- #25 — Build: three-surface replay app
- #26 — Build: auth and workspaces
- #27 — Build: live multiplayer
- #28 — Build: CI workflow
- #29 — Build: weekly staleness sweep
- #39 — Build: UI component library and app frame
- #40 — Build: the deployment must actually serve
- #44 — Build: README as the vision document
- #45 — README's "Notes for the next change" calls design/tokens.css a placeholder; it isn't
- #46 — A malformed payload permanently bricks a room's hydration
- #47 — Post-merge: split README into a 2,200-word essay and CONTRIBUTING.md
- #48 — The autoformatter silently falsified a verified byte-identity claim
- #49 — A GRANT SELECT on core_events also grants the append boundary
- #50 — .env.example is actively false about what enables the credential fallback
- #51 — docker-compose publishes Postgres and MinIO on every interface
- #52 — The stub session authenticator is wired into the production entrypoint unconditionally
- #53 — Measure revocation-to-silence once one commit has both room content and a sweep
- #54 — The CI gate's remaining defects need a different control, not another round
- #55 — mutants/run.mjs should refuse to run outside a dedicated worktree
- #56 — retype changes the object's type in the fold and never in the read model
- #57 — Catch-up stall detector fires 67 false alarms while the cursor is advancing
- #58 — answer_bind's refusal names the room a foreign object lives in
- #59 — retype launders attribution through the types that have no attribution field
- #60 — A model can retire a human-confirmed claim using an object it had no part in
- #61 — Two visible buttons labelled Reopen; one silently discards a typed reason
- #62 — Prototype: five claims the page makes that nothing on the page can read
- #63 — AttentionRefusal has no machine-readable kind, so refusals cannot be routed or counted
- #64 — The attention panel structurally cannot observe duplicate_of_accepted, and nothing says so
- #65 — The since-you-left chip counts rows while the pin counts items
- #66 — A refusal that reaches the wire may be invisible to the person who caused it
- #67 — Any human may confirm a third-party commitment they did not stage
- #68 — claim_verification is gated only on isHuman, so any member can mark a claim verified
- #69 — The occlusion rule is blind to a pointer-events:none overlay covering text
- #71 — sinceCursorCounts counts items that round 10 correctly stopped auto-resolving
- #72 — fix/ci-r6 is an orphan history and was merged into the deploy lane with unrelated histories
- #73 — An item citing a permanently deleted message is owed forever
- #74 — attention_items is three rounds behind core and would break the producer derivation
- #75 — Four seeded durations sit outside the derivation the new check enumerates from
- #76 — Fact chips mint once and never re-mint, so no chip can carry a live value
- #77 — A proposal can name a uuid belonging to no user, and a second member can accept it
- #78 — A refused frame still carries its payload to every subscriber
- #79 — nack echoes raw SQL, including table and column names, to the client
- #80 — consumedEventIds is an unbounded array scanned with includes(), making hydrate O(N²)
- #81 — A human accepting another's staged reading may mint a different sentence under a third party's name
- #82 — Retyping to a nameless type strips the owner and unguards the sentence
- #83 — · is both the seventh glyph and the corpus separator, so the glyph ban covers four of seven
- #84 — facts registers are static prose restating state that no act can move
- #85 — An enumeration check fired once and could not be reproduced in fourteen runs
- #86 — BLOCKING: receipt-window contradiction between core and realtime kills the model path on merge/foundation
- #87 — packages/auth's boundary reports rows[0] after a raw query as a computed-key violation
- #88 — README update: bring the 'none of that runs yet' paragraph in line with the merged tree

---

## The map (#1) — destination, methodology, decisions

## Destination

**Phase 2 of init.md reached, fully featured** — not just decided but built: (1) the Phase 1 replay app — a real historical conversation rendered through the three surfaces (Conversation / Current state / Needs you) — and (2) minimal native multiplayer on top of it (org/workspace, participants, live messages, presence, attachments, ordered realtime updates, semantic analysis after each message), each surface at the quality bar of its real-world reference.

**Execution override** (per wayfinder's Notes escape hatch): this map carries execution, not just decisions. Build tickets graduate from the fog as their blocking decisions clear, and are worked through this same map.

## Notes

- **Product bible**: `init.md` at the repo root — the standalone-Atrium verdict, the twelve semantic concepts, the build/reuse/defer boundary, the five-phase sequence. Every ticket orients to it.
- **Terminal-multiplexing intel**: `plans/research-terminal-multiplexing/BRIEF.md` — herdr (a native TUI, not a web terminal: nothing to adopt, but its decisions are paid for) plus the August-2026 browser-terminal landscape. Feasible with xterm.js 6 + a musl-aware PTY; deferred to Phase 4 by #43. Headline: **every collaborative terminal in the field resolves concurrent input by access control, never by merge** — which is the break-glass rule the design corpus already reached.
- **Competitor/analog intel**: `plans/research-buzz/BRIEF.md` — read-only research on block/buzz (the closest live analog: humans + agents in shared channels, multi-tenant, 19.7k stars, 5 months old). Nine defect classes to refuse (headline: a formally-verified isolation boundary shipped with its fail-closed backstop unimplemented — spec without enforcement is where all their serious bugs live) and nine patterns to take (headline: prove catch-up completeness rather than assume it; authorization without impersonation; an activity-feed doctrine). Routed items are noted on #22, #26, #29, #39, #40.
- **Pre-mapped design landscape**: `plans/research-live-call-design-system/BRIEF.md` — ranked, already-validated design patterns from six versions of prior Atrium prototyping (since-you-left digest, epistemic glyph grammar, attention-first IA, answer-binding composer, correction/reopen, receipt schema, warm-paper/near-black token system). Treat its concepts as settled inputs, not open questions.
- **Methodology — graph engineering with a blind gauntlet loop**: this map's dependency graph drives execution. Every build ticket is decomposed to the smallest independently-judgeable artifact and names a **real-world reference** (e.g. Conversation surface vs Slack/Discord; Needs-you vs Linear's inbox; catch-up vs Slack's unreads). A specialist builder produces the artifact; **blind critics with fresh context** (no builder conversation visible) judge it against the reference; the largest meaningful gap goes back for another round. A ticket closes only when the artifact beats its reference or improvement stops paying.
- **Model routing**: orchestration, thinking, arbitration, gauntlet adjudication — **fable-5** (fallback opus when rate-limited). Implementation — **opus-5** native subagents for iterative in-repo work, **codex `gpt-5.6-terra` at high reasoning effort** (`codex exec`) for self-contained specs. Blind critics draw from foreign lineages (codex, grok-4.5) plus Claude models so verdicts decorrelate.
- **Skill adaptations for this repo**: research tickets resolve via `/research`-style subagents (findings on throwaway `research/<name>` branches, linked from the ticket). Grilling tickets resolve via direct one-question-at-a-time exchange with Lars. Prototype tickets use the WIRE/warm-paper tokens once "Extract the design tokens from Atrium v6" closes.
- Blocking uses GitHub's native relationships (sub-issues of this map; blocked-by dependencies). **Every ticket filed against this campaign is wired as a sub-issue at birth** — three filed on 2026-08-01 (#45, #46, #47) were orphaned for hours because that step was skipped, which makes them invisible to the frontier without making anything look wrong.
- ~~Never resolve more than one ticket per session, research tickets excepted.~~ **Pruned 2026-08-01** — superseded by the execution override above, and contradicted in practice by seven concurrent lanes all session. Kept struck rather than deleted so the change is visible; the youthfulness rule requires pruning a process rule at each phase boundary, and this is the first.
- **The critical path to the destination, and the gate that checks against it.** The destination is two artifacts — the replay app (#25) and multiplayer (#27). Everything else is an input. **Current path: #86 ✔ → #23 (built, unmerged) → #25 → #27.** Before dispatching any round, name which of those it unblocks; *"none directly"* is a legal answer and **must be written in the dispatch's receipt**. Count consecutive rounds whose answer is "none" — that count is the only drift signal this process produces, and it is a number a human has to look at, not a check that runs. **Measured cost of not having it: twelve consecutive rounds across five lanes, every one finding a real defect, while #25 and #27 sat at zero comments and zero branches.** The blind gauntlet's exit rule stops a *lane* escalating; it cannot see the frontier move, because it only ever looks at one ticket. **The gauntlet loop is a quality mechanism, not a scheduler — this map is the scheduler.**
- **Merge continuously; divergence compounds.** Lanes rebase onto a shared integration branch daily and the **integration** suite runs on the merged tree. Measured: six lanes diverged for two days and produced a contradiction that killed the entire model path — one lane defining the receipt window as exactly the cited messages, the other refusing any window ending there — with **zero git conflict markers**, because the two rules lived in different files and different languages. It surfaced as **one red integration test out of 135** on a tree where typecheck, lint and 2,909 unit tests were green (#86). A green typecheck proves nothing about a producer and its checker disagreeing, and the defect rate of this class **rises with time apart**, so more verification without merging makes the whole worse while making each part better.
- **Concurrency is the orchestrator's gate, not a line in a builder's brief.** Cap concurrent heavy agents at cores/2 and read load before dispatching. Writing *"nothing heavy concurrently"* into a brief moves the obligation to an agent that cannot see the other three — only the orchestrator knows what else is running. Measured cost: load to 21.94 on four cores, **ninety minutes of state walk lost** to a starved page load, and #85 filed against the machine rather than the code. Tally each completion's reported token count per lane; a campaign that cannot say what a lane cost cannot notice a lane costing more than the destination is worth.
- **State the defect precisely and the remedy tentatively.** Measured three rounds running: the orchestrator's proposed fix was wrong each time and the better answer was already in the file being quoted — once in a comment the brief itself cited. Mark every proposed remedy as a hypothesis, say what would falsify it, and tell the builder explicitly that finding it wrong is worth more than implementing it faithfully.
- **Read tests, matrices and docblocks as claims, not coverage.** Five instances in two days of the artifact establishing correctness sitting beside the defect — including an authority-matrix cell marked *allowed* that **was** the bug, and a passing test asserting the defect was correct. A passing test is evidence the code does what the test says, never that what the test says is right.
- **Record a refutation as "not reachable by X", and name X.** A measurement bounds only the dimension it varied. A positional claim was refuted here because *scrolling* could not falsify it; expanding a collapsed group falsified it three clicks from boot, and the refutation had already been carried into a fix round as "do not fix this".
- **Standing design rules discovered in the field** (detail and evidence in `RETRO.md`; critics are expected to check both):
  - **Allowlist the compliant form; never denylist the violations.** Arrived independently three times in one day in three subsystems — a CI launcher policy that missed `setsid`, a UI narrating a change through a denylist of phrasings, a tokenizer whose character class deleted non-Latin script. Every guard, parser, normalizer, narrow `catch` and "safe list" is in scope. Best form: derive the assertion from the same computation that authorizes it, so no list exists.
  - **A stated limit is not a disposition.** Documenting in a comment what you cannot prove does not change what the program does with an input that lands inside it. Ask of every written-down limitation: *what happens to an input in that class?*
  - **Prose that names its authority is not thereby correct.** Three instances in one day — a code comment citing a migration that says the opposite, a doctrine file asserting a derivation it never built, a README citing tickets that do not contain the reasoning. Open the citation.
- **Merge topology (measured 2026-08-01).** 37 branches have no merge base with `main` — all first-generation `build/*`, early `fix/*` rounds, research spikes and scratch. They are history, not pending work. Every live lane *is* connected and `git merge-tree` reports zero conflicts **against `main` individually** — which is **not** the same as the merge train being clean, and reading it that way was an error I made and corrected. Measured pairwise, **9 of 10 lane pairs conflict**. The cause is benign: each lane carries a different, stale merge base (`252de7c`, `2e03422`, `3cc85b8`, `4c31746`, `d7fa2fb`), so a pairwise comparison reads `main`'s own evolution as conflict. Only `fix/prototype-frame-r10` (81+/3-) and `fix/core-engine-r4` (2+/0-) genuinely edit `design/CONVENTIONS.md`, the file that appears in 7 of the 10 pairs. **Procedure: rebase each lane onto current `main` immediately before merging it, one at a time, verifying `git diff main..HEAD` touches only that lane's files.** A round that skipped this was 10 commits behind and its merge would have reverted 30 lines of `RETRO.md`. `fix/ci-r6` looked like it needed the disconnected-history replay procedure and does not: `fix/deploy-serves-r4` is strictly ahead of it (see the decision comment on #28). **When histories are disconnected, compare trees, not histories** — running the replay would have resurrected superseded content, which is how a renamed migration reappeared earlier in this campaign.
- **Retro + anti-staleness (standing rule)**: `RETRO.md` at repo root governs. Every closed build ticket appends its retro entry (no entry, no close). A weekly automated sweep checks for staleness (idle tickets, unmerged branches, fog entries whose named blocker closed, missing retro entries) and comments findings on this map; a missing sweep comment for >10 days is itself the top finding. Phase-boundary retros must also prune one process rule and fund one divergent exploration pass (see RETRO.md "Staying youthful").

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Decide: terminal multiplexing in the Atrium UI](https://github.com/lmvdz/atrium/issues/43) — feasible, stack decided, deferred to Phase 4; herdr is a native TUI with nothing to adopt; the field resolves concurrent terminal input by access control, matching the corpus's break-glass rule.

- [Extract the design tokens from Atrium v6](https://github.com/lmvdz/atrium/issues/9) — design/tokens.css + CONVENTIONS.md landed; 102 tokens verified byte-identical to source (negative-controlled checker); merged to main.

- [Define proposal acceptance rules](https://github.com/lmvdz/atrium/issues/4) — per-type: claims/questions auto-accept as `~`; self-stated commitments auto, third-party need owner confirm; decisions never auto-accept (answer-binding or explicit accept only).
- [Design the correction and supersession model](https://github.com/lmvdz/atrium/issues/5) — corrections as events (retype/amend/reattribute/reject/reopen), reducer replays, chains visible; recent corrections feed the prompt as counterexamples.
- [Specify attention computation v1](https://github.com/lmvdz/atrium/issues/6) — four classes (needs_decision, owned_commitment, blocking_question, mention) with required why-you rationale; owed sorts above all, never folds away.
- [Model events, persistence, and realtime protocol](https://github.com/lmvdz/atrium/issues/12) — append-only events with per-room seq as the spine; projections recomputable; ws pushes (room,seq), reconnect via since(seq); seen_seq drives since-you-left.
- [Decide the interpretation pipeline architecture](https://github.com/lmvdz/atrium/issues/8) — async pg-boss, singletonKey=room ~10s coalescing, Luna default + escalation tier routed by deterministic pre-call text triggers (amended per spike: model confidence carries no signal; accepted-state context removed from the prompt — dedup lives in core), acceptance applied in-job, DLQ for failures.
- [Design the interpretation quality eval harness](https://github.com/lmvdz/atrium/issues/17) — hand-annotated golden set on the holdout thread, per-type precision/recall, CI-gated; live metric = correction rate.
- [Define presence and ordering semantics](https://github.com/lmvdz/atrium/issues/14) — presence/typing ephemeral ws-only, never evented; last-seen = seen_seq cursor.
- [Choose attachment storage](https://github.com/lmvdz/atrium/issues/15) — presigned PUT/GET against MinIO/S3, 25MB cap, no bytes through the server.

- [Pick the deploy target](https://github.com/lmvdz/atrium/issues/18) — single-VPS Docker Compose (app, server, Postgres 16, S3-compatible storage); serverless would split the WS/worker core off-platform.
- [Lock the v1 tech stack](https://github.com/lmvdz/atrium/issues/11) — pnpm workspace: apps/web (Next 16), apps/server (Node 22, ws + pg-boss), packages/db (Drizzle), packages/core (pure-TS Semantic Core); Vitest + Playwright, Biome.
- [Choose the Phase 1 replay corpus](https://github.com/lmvdz/atrium/issues/2) — canonical JSONL ingest; demo corpus TypeScript #9998, eval holdout a Next.js RFC thread; private-data swap-in stays trivial.
- [Fix the v1 semantic object schema](https://github.com/lmvdz/atrium/issues/3) — five accepted objects (Decision, Commitment, OpenQuestion, Claim, Objective) + typed relations + Proposal staging + AttentionItem projection + corrections-as-events.

- [Research: Postgres-backed job queue](https://github.com/lmvdz/atrium/issues/16) — pg-boss (Drizzle-transaction enqueue, backoff + DLQ, cron), idempotency via explicit `singletonKey` window + unique `(message_id, interpretation_version)` constraint. Detail on the `research/job-queue` branch.

- [Research: LLM provider and structured-output stack](https://github.com/lmvdz/atrium/issues/7) — Vercel AI SDK `generateObject` (Zod) via AI Gateway; default pass GPT-5.6 Luna (~$1.00/1k msgs), escalation pass Claude Sonnet 5; bursts coalesced into queued background jobs. Detail on the `research/llm-stack` branch.

- [Research: authentication for Phase 2](https://github.com/lmvdz/atrium/issues/13) — Better Auth as primary (self-hosted, Drizzle/Postgres-native, first-party orgs/invitations/MFA, low lock-in); WorkOS AuthKit as fallback. Detail on the `research/auth` branch.

## Not yet specified

- **Gauntlet reference set** — the definitive per-surface reference list and the pass bar phrasing. Hangs on the app-frame prototype.
- **Composer semantics** beyond answer-binding — mentions, replies, threading model. Hangs on the prototype and the schema.
- **Branch/objective UX** — creation, association, supersession in the UI. Hangs on the schema and replay learnings.
- **Workspace/org model detail** — invitations, membership, roles. Hangs on the auth research.
- **Compression tuning** — routine vs meaningful-change thresholds; retention/quotas for attachments. Hangs on eval results and Phase 3 dogfooding.
- **Terminal multiplexing (Phase 4)** — decided and stacked in #43: xterm.js 6 + WebGL with the DOM fallback for Safari; a PTY chosen against the shipped base image (no musl prebuilds for `node-pty`); the ~50MB client ceiling treated as a server-side ring-buffer requirement; herdr's coalesce-and-diff render tick over byte streaming; resize as an explicit sized control message; many observers / one driver / explicit handoff with read-only as an authenticated capability. Hangs on the `ExecutionProvider` seam existing and on #26 closing.
- **Phase 3 dogfood protocol** — which real project runs inside Atrium, reorientation metrics. Hangs on Phase 1 shipping. Leading candidate (2026-08-01): the Atrium campaign itself — the /campaign + /theater workflow is Atrium’s domain model enacted on GitHub issues (gauntlet receipts ↔ receipts, attention queue ↔ Needs-you, Decisions-so-far ↔ Current state, blocking edges ↔ relations), so migrating campaign supervision into Atrium is the highest-signal dogfood and exercises the ConversationSource/ExecutionProvider seams.
- **Adapter seam validation** — ConversationSource/ExecutionProvider vs the real schema. Hangs on the schema ticket.
- **Responsive/mobile posture** — hangs on the app-frame prototype.

## Out of scope

- Phase 4 agent participation and Phase 5 execution runtime (Coven/QM integration, harnesses, terminals, sandboxing) — init.md defers them; agent-era design intel parked in `plans/research-live-call-design-system/scout-glance.md`.
- Voice/video calls and the live-call UI from the prototype corpus — excluded from v1 by init.md.
- External chat imports (Slack/QM sources) — adapter-era work behind the seams.
- Enterprise features, retention controls, integrations marketplace — init.md's "definitely no" list.
















---

## #25 — Build: three-surface replay app

## Question
Execute Phase 1: the three-surface replay app.

## Context
Map #1 · init.md Phase 1 · frame prototype [#10](https://github.com/lmvdz/atrium/issues/10) (visual + interaction spec once gauntleted) · research brief concepts 1–8 · schema/acceptance/correction/attention resolutions (#3–#6).

## Touches
`apps/web/src/app/` — the real app frame from the #10 prototype as React components on the token system: rail (rooms+humans), Conversation timeline (IRC columns, epistemic glyphs, since-you-left divider with live counts + class filters, rich routine collapse), attention pin (hardest-first, rationale lines, inline answer), Current-state lens (objectives → accepted objects, receipt detail with provenance jump + correction chain + reopen), answer-binding composer. Replay mode: load corpus + a pre-computed interpretation run from the DB (worker #23 output over `corpora/ts9998.jsonl`), scrub/step through time.

## Acceptance test
Playwright: full corpus loads; divider counts equal the class-filtered item counts; answering a pinned decision moves it to Current state as ✓ answer-bound with receipt; correcting decision→claim retypes with chain visible; reopen restores pending with prior answer on record; both themes pass a contrast spot-check; reduced-motion respected.

## Verification gate
`pnpm lint && pnpm test && pnpm test:e2e && pnpm build` green.

## Scope boundary
Read-only replay — no live send, no auth, no multiplayer (those are #22/#26/#27). No new visual language beyond the gauntleted prototype.

## Gauntlet
Reference bar (the Phase 1 thesis): a blind judge given the raw thread in chronological form vs Atrium replay must answer reorientation questions (current decisions, open questions, who owes what) faster/more accurately in Atrium. Protocol: fixed question set, two blind judge agents, timed. Plus one taste critic on craft.


## Standing invariant (from #10 r3 gauntlet)
- **No synthesized speech**: nothing rendered as a person's words may be words they did not write. Quote actual typed text with provenance, or state system facts in system voice, visually distinct from quotation. Applies to every derived surface this ticket builds (receipts, correction chains, catch-up summaries, attention rationales). See design/CONVENTIONS.md.


---

## #27 — Build: live multiplayer

## Question
Execute Phase 2 assembly: live multiplayer Atrium.

## Context
Map #1 · init.md Phase 2 + its validation test · everything above: realtime (#22), worker (#23), replay surfaces (#25), auth (#26), presence (#14), attachments (#15).

## Touches
`apps/web` + `apps/server`: live rooms on the realtime layer with the three surfaces running on live state; composer full semantics (mentions, replies, answer-binding, attachment presigned flow per #15); presence indicators; interpretation running per live burst; since-you-left across real absence (seen_seq); attention items delivered live. Compose stack boots the whole product one-command.

## Acceptance test
Scripted five-participant simulation (Playwright, 5 contexts) across ≥2 objectives and ≥200 messages with decisions, third-party commitments (owner-confirm flow), corrections, supersession, attachments; one participant absent for the middle 60% returns and the divider/attention state must exactly match ground truth of what they missed; kill-and-reconnect mid-run loses nothing.

## Verification gate
Full suite green + the simulation in CI + `docker compose up` cold-boot to working product on a clean checkout.

## Scope boundary
This is Phase 2 per init.md's "needs" list — no voice/video, no agents, no integrations, no mobile.

## Gauntlet
The init.md validation, run blind: judges receive (a) the raw transcript and (b) Atrium access for the same conversation, answer the reorientation question set for the returning participant; Atrium must win decisively. Plus codex + grok full-diff review before merge. This ticket closing = the map's destination reached.


## Standing invariant (from #10 r3 gauntlet)
- **No synthesized speech**: nothing rendered as a person's words may be words they did not write. Quote actual typed text with provenance, or state system facts in system voice, visually distinct from quotation. Applies to every derived surface this ticket builds (receipts, correction chains, catch-up summaries, attention rationales). See design/CONVENTIONS.md.


## Routed from #26 r6 delta (cross-branch, assemble here)
- **Evict sockets on membership revocation.** A socket joined before removal keeps receiving room presence until the next sweep (default 15s), because the roster broadcast has no per-recipient membership re-check. Accepted as a bounded presence-only exposure in #26 because the clean fix needs #22's LISTEN/NOTIFY + reconciler, which lives on another branch. When both are merged here: emit a post-commit revocation signal and evict/close affected sockets, and assert a removed member stops RECEIVING (not merely that their next command is denied).


---

## #23 — Build: interpretation worker

## Question
Execute #8: the interpretation worker.

## Context
Map #1 · pipeline [#8](https://github.com/lmvdz/atrium/issues/8) · LLM stack [#7](https://github.com/lmvdz/atrium/issues/7) · queue [#16](https://github.com/lmvdz/atrium/issues/16) · acceptance [#4](https://github.com/lmvdz/atrium/issues/4) · corrections [#5](https://github.com/lmvdz/atrium/issues/5).

## Touches
`apps/server/src/jobs/interpret.ts`: pg-boss job (`singletonKey=room`, ~10s window) draining uninterpreted messages per room; prompt assembly (recent messages + compressed accepted-state view + recent corrections as counterexamples); AI SDK `generateObject` with Zod proposal schema; two-tier routing (gpt-5.6-luna default → claude-sonnet-5 on supersession/third-party-commitment/contradiction/θ-band confidence); acceptance rules applied in-job via `packages/core`; events appended + broadcast; `interpretations` bookkeeping with `(message_id, interpretation_version)` unique; DLQ on poison. Model ids/config via env, never hardcoded.

> **Correction (2026-08-02, after the build).** Two clauses in **Touches** above are stale against #8's own amendments and must not be read as spec:
> - **"compressed accepted-state view" in the prompt** — removed by #8's second amendment, on measurement: including it dropped recall 19→11 in the spike. **Dedup lives in `packages/core`, not in the prompt.**
> - **the trigger list "supersession/third-party-commitment/contradiction/θ-band confidence"** — pre-amendment. The spike measured all four firing **0 of 6**. The shipped triggers are deterministic pre-call text triggers: `reply_blockquote`, `concession_marker`, `named_person_future`, `accepted_decision_overlap`.
>
> Also note **#16's idempotency recipe conflicts with #8's coalescing decision** and the two are not one design: `singletonKey = room` is the queue key for coalescing; `(message_id, interpretation_version)` is the dedup constraint.

## Acceptance test
Mocked-provider integration tests: a 12-message burst → exactly one provider call; job retry after simulated crash creates zero duplicate proposals (constraint exercised); a supersession-shaped output routes to the escalation tier; malformed model output retries then lands in DLQ without corrupting state; edit bumps interpretation_version and supersedes prior proposals.

## Verification gate
`pnpm lint && pnpm test && pnpm build` green; one recorded smoke run against the real default model on 20 corpus messages with cost logged on this ticket.

## Scope boundary
No prompt-quality tuning beyond a functional baseline — quality iteration is gated by the eval harness (#24). No UI.

## Gauntlet
Reference: replayed corpus burst. Bar: one coalesced call per burst, zero duplicates across retries. Judges: codex + grok blind (concurrency/idempotency path → both lineages).


## Routed from #19 gauntlet round 1
- pg-boss semantics: `batchSize` is not concurrency — use `localConcurrency` with per-job settlement; today's stub processes batches serially and all-or-nothing.
- `enqueueInterpretation` currently has no call site — enqueue must happen in the same transaction as the message insert.



---

## #8 — Decide the interpretation pipeline architecture

## Question

Sync-per-message vs async worker for semantic analysis; re-interpretation on edit; batching across rapid messages; where proposals queue before acceptance. Depends on the schema, the LLM stack research, and the job-queue research.

---

