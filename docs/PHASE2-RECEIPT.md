# Phase 2 delivery receipt

Date: 2026-08-03  
Branch: `build/live-multiplayer`  
Range: `78d0b8b..HEAD`

This receipt covers build tickets #25 (three-surface replay) and #27 (live
multiplayer). It records the current tree, not an acknowledgement returned by a
command. The live tracker was read before the build; `docs/TRACKER.md` is cited
below only as the repository copy of the requirements.

## What changed

### #25 — persisted replay

- `/replay/[workspace]/[room]` requires a verified room member, then loads the persisted `ts9998` corpus and its
  reconciled worker output through the real replay data layer. The rail,
  Conversation, Needs-you and Current-state surfaces use the verified component
  library rather than a parallel page implementation.
- Replay position is addressable and step-able. Divider counts, filters,
  routine collapse and the read-through boundary derive from the rows at the
  selected sequence; they are not fixture labels.
- Answer, correction, retype and reopen controls are deliberately read-only
  browser simulations on the historical replay route. They retain citations
  and prior history while a database fingerprint assertion proves that browsing
  history does not rewrite it. Durable acceptance and correction folds are
  verified separately through the command/integration suites.
- Oversized authored records remain byte-for-byte available in a native
  disclosure but no longer consume the returning reader's initial viewport.
  The disclosure label is system voice.

### #27 — live multiplayer

- The authenticated room route now mounts the same product surfaces against
  shared live state. It supports live messages, replies, answer binding,
  explicit structured mentions, attention, presence, attachment grants/uploads,
  objective filing and object supersession.
- Ordered socket updates, reconnect/catch-up, frozen missed-message windows and
  projection refresh after interpreted bursts are wired through the production
  realtime protocol. Authorization is rechecked for commands and listeners;
  membership revocation evicts the passive listener.
- Attachment grants bind room, member, message metadata, object key, media type
  and size. A send and its bound semantic answer commit atomically.
- The five-participant acceptance drives 200 messages across two objectives,
  removes one participant for the middle 60%, reconnects during the run, and
  checks the returned participant's exact missed sequence and attention state.
  The same browser test accepts objectives through their real attention actions,
  files decisions and a commitment through the receipt UI, and proves the exact
  objective ids and mention recipient in the database fold.
- The compose stack serves Postgres, MinIO, server, Next app and Caddy. SMTP is
  fail-closed in production and can be exercised with the Mailpit overlay.
  Next boot fails when production runtime configuration is incomplete.

## Acceptance evidence

The acceptance assertions name the source mutation they catch. The broad
counts below are supporting evidence; the ticket-specific witnesses are the
named Playwright and integration cases.

| Requirement | Authoritative witness | Result |
| --- | --- | --- |
| Full persisted corpus and honest worker boundary | `apps/web/e2e/replay.spec.ts` | pass |
| Divider counts equal the class-filtered rows | `apps/web/e2e/replay.spec.ts` | pass |
| Replay answer simulation preserves source and leaves persisted history unchanged | `apps/web/e2e/replay.spec.ts` plus its database fingerprint | pass |
| Replay decision→claim simulation retains its chain without mutating history | `apps/web/e2e/replay.spec.ts` | pass |
| Replay reopen simulation restores pending and retains the prior answer without mutating history | `apps/web/e2e/replay.spec.ts` | pass |
| Light/dark contrast and reduced motion | replay browser tests | pass |
| Five participants, two objectives, 200 messages, middle-60% absence and reconnect | `apps/web/e2e/multiplayer.spec.ts` | pass under the final two-worker gate; timing recorded below |
| Human acceptance files decision/commitment readings under the authored objectives | multiplayer browser actions plus exact `accepted_objects.objective_id` fold assertions | pass |
| Structured mention reaches exactly the absent recipient without changing authored speech | composer selection, exact persisted body plus `mention_user_ids`, and exact attention fold assertion | pass |
| Replay cannot be read anonymously or by a workspace member outside the room | authenticated replay browser cases and user-scoped loaders | pass |
| No lost or misordered realtime state | multiplayer test, reconnect/catch-up integration tests, participant sockets | pass |
| Live interpretation reaches the database fold and refreshed surfaces | interpretation/command integration tests and multiplayer manifest | pass |
| Revoked member stops receiving | websocket authorization browser test | pass |
| Cold stack boot | production Docker build and clean `docker compose up --wait` through public Caddy TLS | pass; every persistent service was healthy, fixture-backed `/` proved app/proxy serving, `/api/runtime-config` proved same-origin `/ws` configuration, and `/health` proved the server |

Final combined-tree gates:

- `pnpm lint`: exit 0; 15 warnings and 51 infos are the repository's known
  design-harness diagnostics, not new errors.
- `pnpm typecheck`: pass.
- `pnpm test --maxWorkers=2`: 3,027/3,027.
- `pnpm test:integration`: 170/170 against compose-managed real Postgres; the
  harness removed its container and network.
- Playwright at `--workers=2`: 167/167 in 3.8 minutes, including replay
  authorization, exact structured-mention persistence and the five-participant
  multiplayer run.
- `pnpm -r build`: pass, including the optimized Next production build.

## Blind reorientation validation

Question set, fixed before either judge ran:

1. What are the current decisions?
2. What questions remain open?
3. Who owes what?
4. What is the current objective?

The first attempted comparison was discarded: the raw-thread judge was allowed
filesystem search while the Atrium judge used a browser, so its timing could not
support a comparative claim.

The valid run gave both fresh judges only a 1440×900 browser. One saw the Atrium
replay; one saw the same 111 persisted messages oldest-first through
`scripts/validation/raw-thread-server.mjs`, with no search, summary or derived
state.

| Surface | Time | Answer quality |
| --- | ---: | --- |
| Atrium | 31,118 ms | Exact four answers; distinguished two `~` readings from accepted facts, identified the one open question, reported that nobody owed an action, and named the objective. |
| Raw chronological thread | 128,685 ms | Broadly found objective and questions, but over-included per-pattern fixes/workarounds as decisions and inferred maintainer obligations not present as commitments. |

Atrium was 4.14× faster and more precise on the fixed reorientation task.

The independent taste critic initially failed the replay because the transport
overlaid the reading area and the first long message consumed about 83% of the
visible history. After reserving layout space and collapsing oversized authored
records, a fresh rendered-only critic passed: five complete rows plus one
partial row were initially scan-visible, the first post-return row occupied
about 40% of available history, and no transport/composer collision remained.

After the user identified WIRE v8 as the current design authority, the product
frame, bundled mono font, tokens, rail, timeline, pin, composer and state pane
were converged on that reference. A fresh rendered-only critic passed the
resulting frame as a coherent WIRE interpretation; its only caveat was that the
rail remained slightly wider than the canonical reference to preserve readable
room and presence text.

## Deliberately excluded

- No voice/video, agents, integrations, mobile client, distributed runtime,
  Iroh transport or storage federation was added. Those are outside Phase 2.
- No paid interpretation model was enabled. Acceptance used the guarded,
  deterministic no-network provider; the known escalation-cost risk was not
  incurred.
- No completed core, realtime, auth, UI, prototype or deployment lane was sent
  through another open-ended hardening campaign. Changes there are only Phase 2
  assembly seams or cold-boot requirements.
- No branch was pushed and no live tracker state was changed.

## Unresolved external verification

Ticket #27 requires both a Codex and a Grok full-diff review before merge. An
initial fresh Codex full-diff review found the missing real UI paths for
objective filing and mentions plus stale receipt claims. A later fresh review
found two further blockers: public replay access and a mention protocol that
serialized routing metadata into a person's words. Replay is now user-scoped,
and mentions are persisted as structured UUID metadata while the authored body
remains byte-for-byte unchanged. Those remedies are awaiting the final fresh
verdict. No Grok runtime or
credential is available in this environment, and spending or external account
use was not authorized. Therefore this branch must not be described as ready to
merge or ticket #27 as closed until an actual Grok review is attached (and any
material finding is resolved). This is missing external evidence, not a waived
gate.

## Cleanup receipt

Generate this last, from an actual final container and process scan. Intermediate
E2E Postgres/MinIO containers and their Next/server/browser processes have been
removed after each diagnostic run; no final-cleanup claim is made while the
remaining gates are still running.
