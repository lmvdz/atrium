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
- An outbound send whose acknowledgement is lost remains visibly retryable.
  The retry reuses the original authenticated author-scoped key and a cloned
  snapshot of its reply, mention and attachment metadata; a durable command
  receipt recovers a committed send without duplicating or revalidating an
  expired upload grant.
- Attention reconciliation retains one complete provider window behind the
  claimed slice. This lets a reading minted at a slice boundary reach people on
  the next pass without exposing the model to extra prompt context or letting
  unrelated later conversation reclassify the reading.
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
- `pnpm test --maxWorkers=2`: 3,031/3,031 after the final boundary regression.
  An uncapped run made two repository source scanners exceed their fixed
  five-second timeout; the controlled run proves the same assertions without
  weakening or changing them.
- `pnpm test:integration`: 173/173 against compose-managed real Postgres; the
  harness removed its container and network.
- Playwright at `--workers=2`: 169/169 in 4.1 minutes, including replay
  authorization, both uncertain-send outcomes, exact structured-mention
  persistence and the five-participant multiplayer run.
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
rail remained wider than the canonical folded rail to preserve readable room
and presence text. A second fresh critic inspected isolated replay captures at
1340×820 and 1440×900 in both themes and passed them without overflow, clipping,
composer collision or replay-control collision. It measured the Current-state
surface as dominant, the Needs-you surface at 752–826 pixels, and the docked
Conversation surface at 359–379 pixels with readable message lines.

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
- The worker currently logs bounded-window refusals for some proposals outside
  the active room because the in-memory attention fold is global while the job
  reconciles one room. The refusals do not write a disposition, alter the room's
  persisted result or fail the acceptance witnesses. Redesigning that fold was
  deliberately excluded from this Phase 2 remedy rather than inferred from log
  volume alone.

## Independent full-diff verification

Ticket #27 requires both a Codex and a Grok full-diff review before merge. An
initial fresh Codex full-diff review found the missing real UI paths for
objective filing and mentions plus stale receipt claims. A later fresh review
found two further blockers: public replay access and a mention protocol that
serialized routing metadata into a person's words. Replay is now user-scoped,
and mentions are persisted as structured UUID metadata while the authored body
remains byte-for-byte unchanged. A final fresh review then found that mention
attention lost its proposal discriminator and lacked dismissal, and that both
live and replay consumers trimmed authored whitespace. Mention subjects now
retain `proposal`/`object` identity through core and Postgres, one-click dismiss
lands as `dismissed`, nonblank authored bodies cross unchanged, and an accepted
proposal mention remains owed and actionable until the recipient dismisses it.
The final independent Codex review passed commit `978fbee` with no concrete code
merge blockers after 52/52 focused tests, web typecheck, and the five-participant
multiplayer acceptance. After the remaining replay-attention, WIRE and worker
boundary commits landed, Grok Build 0.2.118 independently inspected the complete
`78d0b8b..e3b9888` range in read-only mode. It returned **PASS** with no material
merge blocker. Its three non-blocking observations concern test-driving shape
and a stale comment rather than product behavior; the complete verdict and
caveats are preserved in `docs/PHASE2-GROK-REVIEW.md`.

A later fresh Codex review found that socket loss after commit still had no
exact outbound retry, then found two defects in the first remedy: caller-mutable
attachment metadata and a room-global projection key disagreeing with
actor-scoped receipts. After those closed, another fresh pass caught migration
0014's generated timestamp being older than 0013, which would make upgraded
databases silently skip it. The final head `c372f8d` snapshots retry metadata,
aligns uniqueness with the authenticated author, and pins the newest migration
timestamp above every predecessor. Codex returned **PASS** on that head. Grok
then reviewed the complete later increment `e3b9888..c372f8d` in read-only mode,
combined it with its prior full-range pass, and returned **PASS**. The dual-review
gate therefore covers the exact delivered tree rather than the pre-remedy range.

## Cleanup receipt

Final cleanup was performed after every gate and critic completed. The two
Atrium E2E service containers were removed, and a final process scan found no
Atrium Next, server, Playwright or Vitest process. No unrelated container or
process was touched.
