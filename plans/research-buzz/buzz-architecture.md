# block/buzz — Artifact Axis Research Brief

**Source anchors.** Default branch `main`. HEAD inspected: `19d57b0d46baa55814ac737041a36d0b405c9f64`, committed 2026-08-01 07:36:56 +0500 (last log entry: "docs: add one-click Railway deploy for a hosted relay (#2733)"). Stars: 19,721. License: Apache-2.0. Cloned shallow (`--depth 1`) to `/tmp/buzz-clone`. Read-only throughout — no issues/PRs/branches created on block/buzz.

---

## 1. What it is and how it's structured

Buzz is a self-hosted team communication platform built directly on the **Nostr wire protocol** (NIP-01), where every action — chat message, reaction, workflow step, canvas update, huddle event, agent job — is a cryptographically signed Nostr event dispatched purely by its `kind` integer. New feature = new `kind` constant; old clients ignore what they don't recognize.

**Runtime topology:** relay-centric, not peer-to-peer. "There is no peer-to-peer event exchange, no gossip, no replication — just clients connecting to one relay over WebSocket, and the relay enforcing auth, verifying signatures, persisting events, fanning out to subscribers, indexing for search, and triggering automation" (`ARCHITECTURE.md:7`). Clients: Nostr apps, web, desktop (Tauri), mobile (Flutter, `mobile/`), and agent CLI tools. A **community** is the tenant-visible workspace selected by request host — single-host/single-community is the default; multi-community is a documented, largely-implemented extension (see §5).

**Cargo workspace** (`Cargo.toml`), ~27 crates plus one example member:
- `buzz-core` — zero-I/O shared types, event verification, kind registry, filter matching, tenant types, engram (agent-memory) crypto primitives. Explicitly bans tokio/sqlx/redis/axum in its own `Cargo.toml`.
- `buzz-db` — Postgres access layer (events, channels, tokens, workflows, audit); uses runtime `sqlx::query()`, no compile-time query macros.
- `buzz-auth` — NIP-42/NIP-98 auth, scopes, (unimplemented) rate limiting.
- `buzz-pubsub` — Redis pub/sub fan-out, presence, typing indicators.
- `buzz-search` — Postgres FTS over a generated `tsvector` column.
- `buzz-audit` — SHA-256 hash-chain tamper-evident log.
- `buzz-workflow` — YAML automation engine (triggers/actions/approvals).
- `buzz-relay` — Axum WebSocket server; the only crate that imports and orchestrates all the above ("Key architectural principle," `ARCHITECTURE.md:97`); subsystems are siblings and never call each other directly.
- `buzz-acp` — standalone binary bridging relay `@mention` events to AI-agent subprocesses via ACP/JSON-RPC over stdio.
- `buzz-agent` — Buzz's own minimal ACP-compliant LLM agent (stdio-only, no persistence).
- `buzz-sdk` — typed Nostr event builders shared by `buzz-acp`/`buzz-cli`.
- `buzz-persona` — Persona Pack parsing/merge/validation (agent identity bundles).
- `buzz-relay-mesh` — inter-relay QUIC mesh (iroh-based) for horizontal scaling across relay *pods* of the *same* deployment (membership gossip, tunnel routing) — distinct from the community-facing "Buzz Mesh" GPU-compute-sharing product described in `VISION_MESH.md`.
- `buzz-pair-relay` — ephemeral, unauthenticated, no-persistence sidecar for NIP-AB device-pairing handshakes (loopback-only, must sit behind a reverse proxy).
- `buzz-media`, `buzz-push-gateway`, `buzz-voice`, `buzz-admin`, `buzz-cli`, `buzz-pairing-cli`, `buzz-dev-mcp`, `buzz-conformance`, `buzz-test-client`, `buzz-ws-client`, `git-credential-nostr`, `git-sign-nostr` round out the workspace.

**Message data flow (send → delivery)**, per `ARCHITECTURE.md:221-268` (`buzz-relay/src/handlers/event.rs`):
1. Auth check (must be `Authenticated` with `MessagesWrite` scope) → 2. pubkey-matches-signer check → 3. reject `kind:22242` (AUTH events never stored) → 4. ephemeral kinds (20000-29999) branch to a lighter sub-pipeline → 5. `spawn_blocking(verify_event)` (Schnorr sig + SHA-256 id) → 6. channel-membership check → 7. `db.insert_event` (`ON CONFLICT DO NOTHING`, idempotent) → 8. Redis `PUBLISH` if channel-scoped → 9. in-process fan-out via `SubscriptionRegistry` → conn_manager → 10. fire-and-forget search-index enqueue (bounded queue, capacity 1000) → 11. fire-and-forget audit-chain append → 12. fire-and-forget workflow-trigger evaluation (excludes workflow-execution kinds 46001-46012 to prevent loops). The client's `["OK", id, true, ""]` ack is sent only after the full pipeline runs, not right after the DB insert.

Fan-out uses a three-tier DashMap index (`(channel_id, kind)` → conns; `channel_id` → conns; global linear scan) and **deliberately excludes global (no-channel-filter) subscriptions from channel-scoped events** as a named security boundary (`ARCHITECTURE.md:242,304`). The REQ handler checks channel access *before* registering a subscription to close a race window.

Cross-node fan-out for a multi-replica deployment: a dedicated (non-pooled) `redis::aio::PubSub` connection PSUBSCRIBEs `buzz:channel:*`, feeds a `broadcast::channel(4096)`, and a consumer task re-runs local fan-out; local-echo dedup via a `moka` cache keyed on locally-originated event ids (`AppState.local_event_ids`).

---

## 2. The protocol(s) — ACP and the Nostr kind taxonomy

Buzz layers two protocols: **Nostr NIP-01** as the durable message wire format, and **ACP (Agent Client Protocol, agentclientprotocol.com)** as the ephemeral agent-runtime interface between `buzz-acp`/any ACP client and an agent subprocess.

### Nostr kind taxonomy (`crates/buzz-core/src/kind.rs`, 128 `pub const KIND_*: u32` items; `ARCHITECTURE.md` says 81 are exported via `ALL_KINDS` — the store-eligible subset, `KIND_AUTH` and ephemerals excluded from some counts)
Kind ranges: 0-9999 standard NIPs; 10000-19999 replaceable; 20000-29999 ephemeral (never stored/audited); 30000-39999 parameterized-replaceable; 40000-49999 Buzz-custom. Selected concrete kinds actually read from source (not just docs):
- `KIND_STREAM_MESSAGE=9` (chat, NIP-29-shaped), `KIND_STREAM_MESSAGE_V2=40002`, edits `40003`, diffs `40008`, pinned `40004`, bookmarked `40005`, scheduled `40006`.
- `KIND_AGENT_PROFILE=10100`, `KIND_PERSONA=30175`, `KIND_TEAM=30176`, `KIND_MANAGED_AGENT=30177`, `KIND_TEAM_CATALOG=30178` — agent identity/roster layer.
- `KIND_AGENT_ENGRAM=30174` — durable agent memory (see §4).
- `KIND_JOB_REQUEST=43001` through `KIND_JOB_ERROR=43006` — agent job lifecycle events.
- `KIND_WORKFLOW_TRIGGER=46020`, `KIND_APPROVAL_GRANT=46030`, `KIND_APPROVAL_DENY=46031` — human-in-the-loop workflow gates.
- `KIND_FORUM_POST=45001` / `VOTE=45002` / `COMMENT=45003` — async/forum channel type distinct from stream chat.
- `KIND_NIP43_MEMBERSHIP_LIST=13534`, `MEMBER_ADDED=8000`/`REMOVED=8001` — relay/community membership roster.
- `KIND_CANVAS=40100`, `KIND_SYSTEM_MESSAGE=40099`, `KIND_AGENT_TURN_METRIC=44200`, `KIND_AGENT_OBSERVER_FRAME=24200`, `KIND_PRESENCE_UPDATE=20001` (ephemeral), `KIND_TYPING_INDICATOR=20002` (ephemeral), `KIND_PAIRING=24134`.
- Moderation: `KIND_MODERATION_BAN/UNBAN/TIMEOUT/UNTIMEOUT/RESOLVE_REPORT = 9040-9044`.

### Custom NIPs (`docs/nips/`) — Buzz's own protocol extensions on top of vanilla Nostr
- **NIP-AA — Agent Authentication** (depends on NIP-OA, NIP-43, NIP-42): lets an agent whose *owner* is a relay member gain **implicit, virtual** relay access via a NIP-OA `auth` tag presented during the NIP-42 AUTH handshake, without a separate membership record. If the owner's membership is revoked, the agent's next connection attempt fails automatically — closing the "operator forgot to remove the agent" hazard.
- **NIP-OA — Owner Attestation** (`docs/nips/NIP-OA.md`): a reusable, NIP-26-inspired `["auth", "<owner-pubkey-hex>", "<conditions>", "<sig-hex>"]` tag an owner signs to authorize an agent's *own-authored* events (this is explicitly **not** delegation/impersonation — "An event that includes a valid `auth` tag remains authored by `event.pubkey`"). Conditions are `&`-separated clauses restricted to `kind=<n>` / `created_at<t>` / `created_at>t`; malformed or self-referential (`owner == agent`) tags are rejected. Signing preimage: `SHA256("nostr:agent-auth:" || event.pubkey || ":" || conditions)`.
- **NIP-AE — Agent Engrams**: the durable-memory spec (§4).
- **NIP-AB** — device pairing (`crates/buzz-core/src/pairing/NIP-AB.md`); served by the standalone `buzz-pair-relay` sidecar.
- Others present but not deep-dived: NIP-AM, NIP-AO, NIP-AP, NIP-CW, NIP-DV, NIP-ER, NIP-GS, NIP-IA (identity archival), NIP-MP (git/projects), NIP-PL, NIP-RS, NIP-WP.

### ACP — capability negotiation and permission model (from `buzz-agent/README.md`, which documents its own hand-rolled server, and `buzz-acp/README.md`)
Handshake: `initialize` (client sends `protocolVersion`+`clientCapabilities`; agent replies with `agentCapabilities` — `loadSession`, `promptCapabilities.{image,audio,embeddedContext}`, `mcpCapabilities.{http,sse}` — all false in `buzz-agent`'s case, since it's **stdio-only**, no session persistence). `session/new` passes an array of `mcpServers` (`name`, `command`, `args`, `env`) the client wants spawned; agent replies `sessionId`. `session/prompt` carries the prompt content array and streams `session/update` notifications (`agent_message_chunk`, `tool_call`, `tool_call_update` with `status: pending|in_progress|completed`) before resolving with a `stopReason` (`end_turn`, `cancelled`, `max_tokens`). One inbound notification, `session/cancel`. That's the entire wire surface — "Three request methods... one inbound notification... three outbound update variants... The full server is hand-rolled in `main.rs`."

MCP tool namespacing is `server__tool` (double underscore); bare names containing `__` are rejected at registration. Transport is stdio-only in both directions (agent↔client ACP, agent↔tool MCP) — no HTTP/SSE anywhere, which the agent advertises truthfully in its capabilities rather than lying about unsupported transports.

**Permission model is trust-boundary-based, not capability-token-based**: "The trust boundary is the operator who launched the agent. The harness, MCP server binaries, and API keys are all trusted. Untrusted input — model output, tool results, prompts — is bounded" (`buzz-agent/README.md:293`). Concretely enforced: MCP child processes get an env whitelist (`PATH,HOME,TERM,LANG,LC_ALL,TMPDIR` + client-supplied), run in their own process group (`setpgid`) killed with `SIGKILL` on transport break, and every buffer/frame/response/tool-result size is hard-capped (table of 14 named limits in the README, e.g. 4 MiB inbound JSON-RPC line, 16 MiB LLM response, 128 tools/session, 64 tool calls/turn).

`buzz-acp` (the relay-facing harness, distinct from `buzz-agent` the LLM loop) layers an **author gate** on top: `--respond-to {owner-only|allowlist|anyone|nobody}` (default `owner-only`) filters *which humans'* @mentions/DMs reach the agent at all, checked before any subscription-rule filtering. Owner-issued in-band commands (`!shutdown`, `!cancel`, `!rotate`) are consumed by the harness, never forwarded to the model, and bypass the author gate so an owner can always regain control.

---

## 3. Persistence and state

**Durable (Postgres):** `events` (all stored Nostr events, monthly range-partitioned on `created_at`), `channels`, `channel_members` (soft-delete via `removed_at`), `workflows`/`workflow_runs`/`workflow_approvals`, `audit_log` (hash-chain), `delivery_log`, `communities` (multi-tenant root), `api_tokens`, plus 26 forward migrations (`migrations/0001_initial_schema.sql` … `migrations/0026_replica_heartbeat.sql`) covering moderation, push gateway leases, community archival, relay invites, replica heartbeats. `buzz-search`'s full-text index is a **generated column** (`search_tsv`, GIN-indexed) on `events` itself — "no separate search service or out-of-band indexer" — populated at insert via `to_tsvector`, with privacy-sensitive kinds (`1059` gift-wrap DMs, `30300`, `30622`) forced to `NULL` (storage-level unsearchable).

**In-memory / ephemeral:** kinds 20000-29999 (presence, typing) never touch Postgres, never enter the audit chain, never satisfy REQ historical queries — they exist only as Redis keys (`SET buzz:presence:{pubkey} EX 180`, `ZADD buzz:typing:{channel} …` with a 5s activity window / 60s key TTL) and local WebSocket fan-out. `ConnectionState` (per-connection auth state, active subscriptions) is in-process only.

**Event log / CRDT:** there is no CRDT. The append-only Postgres `events` table *is* the canonical log — Nostr's own idempotent-append model (`ON CONFLICT DO NOTHING` on the composite key) substitutes for CRDT merge semantics; conflict resolution for the one genuinely mutable structure (agent memory, see NIP-AE §4) is last-write-wins by `created_at` with an explicit **best-effort conflict-detection** step on write (re-read the head after publish; if it isn't the event you just wrote, surface a conflict rather than silently retry).

**History/sync/catch-up:** REQ subscriptions get up to `MAX_HISTORICAL_LIMIT=500` matching stored rows replayed before `EOSE`, then live fan-out for anything after. `buzz-acp` explicitly reconnects "with a `since` filter to avoid missing events" on relay disconnect, and replays all unprocessed `@mention`s on startup (documented as a deliberate "expect a burst of activity" tradeoff, not silently swallowed). `buzz-agent` itself has **no** persistence or session reload (`loadSession: false` advertised, honestly) — on context overflow it self-summarizes ("context handoff," capped at `BUZZ_AGENT_MAX_HANDOFFS=10` before falling back to truncation) rather than paging state anywhere durable.

---

## 4. The agent model

**Identity.** Every agent is a first-class Nostr keypair (`buzz-admin generate-key`), registered as a relay member via a `kind:13534` roster event (`buzz-admin add-member`). Multiple concurrent `buzz-acp` subprocesses can share one bot identity — "All N agents authenticate as the same Nostr bot identity... The same channel is never processed by two agents simultaneously (the queue enforces this)."

**Scoping/permissioning.**
- *Relay-level*: NIP-AA lets an agent inherit access transitively from its owner's membership (virtual membership, revoked automatically when the owner is) rather than requiring separate enrollment — see §2.
- *Event-provenance level*: NIP-OA's `auth` tag cryptographically proves "owner X authorized agent Y to publish, subject to conditions," without conflating authorship (agent Y still signs and is still the author).
- *Inbound-event level* (`buzz-acp`): the `--respond-to` author gate (§2) — the harness will silently drop events from non-permitted authors before the agent ever sees them.
- *MCP-tool level* (`buzz-agent`): tool count/schema/description size caps, per-tool timeout (660s default), max 8 concurrent tool calls per session's parallel budget, `_Stop`/`_PostCompact` MCP-driven hooks that are explicitly "advisory, fail-open, and budget-bounded — not a plugin system" (`docs/MCP_DRIVEN_HOOKS.md` referenced from `buzz-agent/README.md:331`).

**Memory — NIP-AE "Agent Engrams" (`docs/nips/NIP-AE.md`, primitives in `crates/buzz-core/src/engram.rs`, 1049 lines).** This is the closest analog to Atrium's "durable shared understanding" concept, worth reading closely:
- Memory is `kind:30174` addressable events, **encrypted with NIP-44** using the symmetric conversation key between one agent and one owner (`K_c = nip44_conversation_key(seckey_a, pubkey_o)`) — so memory is pairwise-scoped `(agent, owner)`, not channel- or community-scoped, and the owner can always decrypt everything the agent remembers (no agent-side secrecy from its own owner).
- Two record types sharing one envelope: `core` (exactly one per pair — identity/rules/goals, the bootstrap doc) and `mem/<slug>` (zero or more discrete entries), addressed by `d = HMAC-SHA256(K_c, "agent-memory/v1/d-tag" || 0x00 || slug)` so the slug itself never leaks in cleartext tags.
- Write protocol: monotonic `created_at` (`max(now, prior_head+1)`) to defeat same-second ties under NIP-44's randomized nonces; a `value: null` body is an in-band tombstone; best-effort conflict detection by re-reading the head post-publish.
- Explicit non-goals in the spec text itself: "Richer taxonomies (provenance, trust levels, attention/working sets, structured links, owner-to-agent directives) are intentionally out of scope for this NIP and belong in companion NIPs" — i.e., Buzz's memory primitive is deliberately a flat encrypted KV, not a typed/provenance-aware object model; anything Atrium-shaped (decisions/commitments/claims as first-class typed objects) would be a layer Buzz hasn't built.
- A non-normative `[[slug]]` wiki-link convention gives a reachability graph rooted at `core.profile` for orphan-detection, but this is presentational, not enforced.
- Security considerations section is unusually candid: agent-key compromise = full read+forge of that agent's memory; "**Memory poisoning.** Encryption protects confidentiality, not the truthfulness of what the agent decides to remember. Admission control is the implementer's problem" — i.e. no built-in defense against an agent writing false memories.

**Human-in-the-loop gates.** `buzz-workflow`'s `request_approval` action (kinds `KIND_APPROVAL_GRANT=46030`/`DENY=46031`) is the designed gate, but **`ARCHITECTURE.md`'s own "Known Limitations" table admits it is not wired end-to-end**: "the engine intercepts before creating `WaitingApproval` rows — runs that hit an approval gate are marked as Failed" (limitation #5, tagged `🚧 WF-08` — an open internal tracking marker, not a finished feature). The `Reply Guard` in `buzz-agent` (`BUZZ_AGENT_REQUIRE_REPLY`, on-by-default for mesh/shared-compute agents) is a different kind of gate — not permission but *visibility*: it nudges a turn that's about to end silently to actually post something, because "a Buzz agent's reasoning and tool output are not shown to anyone" otherwise. It is explicitly "advisory, never a trap" — at most two reminders, then the turn ends regardless.

**What an agent can/cannot do without a human, concretely:** an agent with `MessagesWrite` scope can post/react/react/create channels/run workflow steps unattended; it cannot get *approval-gated* workflow steps to actually pause-and-resume today (broken, per above); it cannot act on communities its owner isn't admitted to (NIP-AA ties agent access to current owner membership, checked on every connection).

---

## 5. Multi-tenancy ("communities")

Buzz's multi-tenancy design is the single most rigorously documented subsystem in the repo, and it's important to separate **what is proven/specified** from **what is actually enforced in shipped code** — the docs are explicit that this is a `draft` in progress.

**Model** (`docs/multi-tenant-relay.md`, 1110 lines, a from-scratch formal spec with TLA+ and Tamarin models): a **community** is the tenant/security boundary — owns channels, membership, a signing keypair, token namespace, workflows, and an independent audit hash-chain. The **relay process is stateless compute**; any process can serve any community; N processes share one Postgres. `TenantContext{community, host}` (`crates/buzz-core/src/tenant.rs:68`) is resolved **once, server-side, from the connection's host** (`resolve_host(connection.host)`), *before* any handler observes tenant data — never from a client-supplied `#h` tag or claimed community. This resolved value is the sole tenant authority; the doc frames the alternative (trusting a client-supplied tag) explicitly as a **confused-deputy vulnerability** (citing Hardy 1988) and proves (Tamarin, `MultiTenantAuth.spthy`) that an "A-host presenting a B-channel event" is rejected fail-closed on both the channel-resolution axis (S6) and the token-stamp axis (S1/S5), with 32/32 lemmas green in ~12s per the doc's own verification run.

**Where isolation is actually enforced in code, verified by direct inspection (not doc-trust):**
- `communities` table exists (`migrations/0001_initial_schema.sql:53`), with `community_id UUID NOT NULL REFERENCES communities(id)` on `channels`, `events`, `event_mentions`, and other scoped tables (confirmed by grep across `migrations/*.sql`).
- `buzz-db`'s actual queries do carry `community_id` predicates: e.g. `crates/buzz-db/src/event.rs:237` (`AND community_id = $1`), `:295-300` (insert binds `community_id`), `:378-392` and `:648-651` (mention/feed queries join and filter on `community_id` on both sides of the join). This is real, load-bearing application-level filtering, not aspirational.
- **However: the formal spec's "fail-closed backstop" — Postgres Row-Level Security (axioms A-RLS-1 through A-RLS-5, e.g. "every queryable tenant-bearing table has RLS enabled with a restrictive policy") — is NOT implemented.** `grep -rn "ENABLE ROW LEVEL\|CREATE POLICY\|FORCE ROW LEVEL"` across `migrations/` and `crates/` returns **zero matches**. There is also no `SET LOCAL app.community_id` anywhere in the codebase (searched `crates/` and `migrations/`). So isolation today rests entirely on every `buzz-db` query author remembering to add a `community_id` predicate by hand (which the sampled queries do, but this is discipline, not a database-enforced backstop) — precisely the class of defense the doc's own §Axioms section says the proof is *relative to* and calls "the fail-closed backstop." The doc is honest about this being a target state ("admitted by a startup/CI assertion suite" — i.e., a planned conformance gate, not a demonstrated one) rather than claiming RLS is live; but a reader taking `ARCHITECTURE.md`'s "In multi-community mode..." prose at face value without checking migrations would over-credit the isolation guarantee.
- `docs/multi-tenant-conformance.md` (74 lines) is the source-vs-model checklist enumerating every surface (tokens, users/NIP-05, channel-less events/DMs, channels, workflows, search, Redis keys, media, git hosting, mesh/ACP/CLI, audit) with three columns per row: today's single-tenant behavior, the tenant source, and required DB/RLS scope — itself an admission that not all rows are done ("Open decision/test" column is populated for most rows, e.g. Redis key scoping is spec'd as `buzz:{community}:channel:{uuid}` but plain `buzz:channel:{uuid}` is still the docstring's "single-community form").

**Isolation boundary explicitly *not* claimed:** the spec names two carve-outs rather than hiding them — (C1) timing/bandwidth side-channels (buffer cache, autovacuum, connection-pool tail latency: "we do not claim timing non-interference") and (C3) historical writes surviving membership revocation (revoking a member removes future capability but does not retroactively delete/relabel past writes).

**Compute/memory isolation across communities:** agent state (profile, presence, DMs, memories/engrams, channel memberships, audit trail) is explicitly community-scoped per `VISION_AGENT.md:19-24`: "The same npub can join another community and repost a profile there, but no agent state is inherited across hosts." Buzz Mesh (the GPU-compute-sharing feature, `VISION_MESH.md`) gates compute-sharing on the *same* community-membership relation used for channel access — "the mesh's admission gate and your community's membership gate are the same gate... a co-tenant community can't find it, join it, or serve to it" — but this is a **vision document**, not something confirmed built in the crates read (the actual mesh-transport crate found, `buzz-relay-mesh`, is inter-*relay* QUIC transport for horizontal scaling of a single deployment's pods, a different concern from inter-*community* compute sharing; I did not find a compute-marketplace crate matching `VISION_MESH.md`'s description in the crate list — this vision may be unbuilt or built elsewhere not surfaced by the top-level crate scan).

---

## 6. Design docs in-repo — load-bearing decisions, quoted

- **`ARCHITECTURE.md`** (827 lines) — "Known Limitations" section (§9) is unusually candid for a project doc: no sqlx offline query cache, no rate limiting implementation beyond a test stub, no typing-indicator REST endpoint, huddle recording/tracks unbuilt (kinds reserved, no producer), **approval gates not wired end-to-end** (workflow runs hitting `request_approval` are marked Failed, not suspended — tagged `🚧 WF-08`), and two workflow actions (`send_dm`, `set_channel_topic`) present in the schema but returning `NotImplemented` (`🚧 WF-07`).
- **`docs/multi-tenant-relay.md`** — quoted above; key sentence: *"The `h` tag on a wire event is a routing hint a client asserts; it is never the commit point of tenancy."*
- **`docs/multi-tenant-conformance.md`** — the practical checklist companion to the formal spec; explicitly states the compatibility invariant: *"today's Buzz is one implicit community selected by its relay URL. Multi-tenant Buzz makes that selector explicit at the backend boundary while preserving [everything] when N = 1."*
- **`VISION_AGENT.md`** — states the design goal behind `buzz-agent`/`buzz-dev-mcp`: *"A coding agent should be small enough to hold in your head. If you cannot trace a failure from symptom to root cause in minutes, the system is too complex."* Confirms per-community scoping of all agent state (quoted §5).
- **`VISION_MESH.md`** — GPU-compute-sharing product vision; *"The boundary is the community, never the deployment... Non-members see none of this."* Marked as vision-tier prose, not verified as shipped in the crates inspected.
- **`docs/nips/NIP-AE.md`** — memory spec; load-bearing sentence on scope: *"Memory is scoped to a single `(pubkey_a, pubkey_o)` pair. An agent serving multiple owners holds an independent memory per pair."*
- **`crates/buzz-agent/README.md`** — the trust-boundary statement in §2 above, and the blunt "What This Is NOT" list (9 items: not a framework, not streaming, not persistent, not an SDK, not a UI, not authenticated [by itself], not networked-MCP, not load-able, not a router/orchestrator).
- Other VISION docs present but not deep-read for this brief: `VISION.md`, `VISION_ACTIVITY.md`, `VISION_MODERATION.md`, `VISION_PROJECTS.md`, `VISION_REMOTE_AGENTS.md`, `VISION_SOVEREIGN.md`.
- `docs/formal/STATEFUL_GATEWAY.md`, `docs/formal/nip-pl/NOTE.md`, `docs/formal/nip-rs-unread/NOTE.md` exist (further formal-methods artifacts) but were not opened for this pass.

---

## 7. Notes on method / confidence

- Every architectural claim above about the event pipeline, ACP wire format, engram crypto, and multi-tenancy code seams was cross-checked against source (`.rs` files, `migrations/*.sql`) rather than taken solely from `ARCHITECTURE.md`/`VISION_*.md` prose, per the brief's instruction to prefer source over README claims. The one place a documented invariant (Postgres RLS as isolation backstop) was checked against code and found **not present**, this is flagged explicitly in §5 rather than silently repeating the doc's claim.
- Not independently verified in this pass (time-boxed): the TLA+/Tamarin model files themselves (`MultiTenantRelay.tla`, `MultiTenantAuth.spthy` — referenced extensively in `docs/multi-tenant-relay.md` but not located/opened); `buzz-relay-mesh`'s wire/gossip internals beyond the crate-doc summary; `buzz-workflow`'s executor source for the approval-gate gap (relied on `ARCHITECTURE.md`'s own limitations table, itself a primary-source admission from the maintainers); the desktop/mobile client code paths; `examples/meadow-core` (a worked example of a multi-persona agent team in one Buzz instance) was located but not read in depth.
