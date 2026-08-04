# Build: durable typed room references

**Status:** proposed — awaiting architecture review. Do not implement until approved.

## Question

Can a message durably reference a current human member, one of its room attachments, or a proposal/accepted semantic object by stable identity—while preserving the exact text the author typed and refusing every missing, unauthorized, or cross-room target?

## Context

The architecture awaiting review is proposed in `ARCHITECTURE.md`. Today `send_message` carries `mentionUserIds: uuid[]`; it validates current human membership but records neither the authored span nor another target kind. Attachments are JSON keyed by storage path, and the composer inserts `@attachment-name` as untyped text. Proposals and accepted objects already have stable room-scoped IDs.

This slice establishes addressability, not agents or capabilities. It must leave ordinary conversation operational with no interpreter or model configuration.

## Touches

- `packages/db`: attachment identity, normalized message references, exhaustive target-kind/same-room enforcement, migrations, schema tests.
- `apps/server/src/attachments.ts`: mint and sign a stable attachment ID with its room-bound upload capability.
- `apps/server/src/commands.ts`, `room-events.ts`, projections, attention projection, replay: validate and persist typed references atomically with the message; derive human attention only from committed human references.
- `apps/web`: composer selection retains target ID and authored UTF-16 span; message rendering uses exact body text and resolves current target metadata separately.
- Realtime protocol and fixtures: versioned typed reference shape and explicit legacy behavior for existing `mentionUserIds` rows.

The implementation may adjust exact file names after tracing the current route, but it may not replace these boundaries with client-only markup.

## Acceptance test

A two-browser Playwright scenario and production-build integration test prove the following from database rows and both participants' sockets:

1. Alice selects Bob from `@`, sends a message, and Bob receives one durable attention item. The reference row names Bob's stable user ID and a span whose `surface === body.slice(start,end)`.
2. Bob is renamed after send. Live rerender and fresh replay preserve Alice's exact authored token while resolution shows Bob's current identity. No body text changes.
3. Alice uploads an image, references it in the same message, and replay resolves the same server-minted attachment ID with its thumbnail/metadata.
4. Alice references one staged proposal and one accepted object. Replay resolves both exact stable IDs and exposes their current semantic state without rewriting the message.
5. Duplicate display names resolve to the selected ID, not the first matching string.
6. A removed member cannot be newly mentioned. An old mention remains historical and renders its authored surface with unavailable/tombstone resolution.
7. Missing, unauthorized, cross-room human, attachment, proposal, and object targets all refuse the entire message with the same external error. No message, reference, attachment claim, attention item, or realtime event lands.
8. Malformed, overlapping, out-of-range, mismatched-surface, duplicate-ordinal, and unknown-kind references refuse atomically.
9. Killing the recipient socket and reconnecting loses neither the message reference nor its attention signal.
10. With interpretation models unset and the worker absent, all valid cases still send and replay.

Every assertion reads the fold/database or recipient socket; command `ack` alone is not proof.

## Verification gate

```sh
pnpm install
pnpm -r build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:e2e -- --workers=2
```

Also run a migration/conformance test against real Postgres that attempts direct invalid inserts for every target kind and proves the database rejects cross-room and kind/column mismatches. Name the mutation each new test catches. If browser workers die under load, rerun the affected spec alone before classifying it as a product failure.

## Scope boundary

- No agent principal, agent mention, model enablement, worker change, assignment, tool execution, capability grant, delegation, orchestration, or distributed infrastructure.
- No change to semantic acceptance, correction, or supersession policy. The existing model auto-accept conflict is a separate reviewed slice.
- No parsing arbitrary `@display-name` on the server. A reference exists only through a selected stable target and validated authored span.
- No generic polymorphic JSON reference without exhaustive SQL-level target and room enforcement.
- No rewriting legacy message bodies or synthesizing spans for old `mentionUserIds`. Legacy rows must have an honest degraded representation.
- No visual redesign beyond the existing V8 composer and message vocabulary.

## Gauntlet

Give a blind critic:

- two users with the same display name;
- a renamed then removed user;
- two rooms containing colliding-looking labels;
- an attachment whose filename changes;
- a retracted proposal and superseded object;
- a forged client payload with valid IDs from the other room;
- a replay captured before and after all mutations.

The critic must identify the target of every historical reference from stable receipts, see exactly the words the author typed, and be unable to make any cross-room reference land or distinguish “missing” from “exists but unauthorized” through the protocol. A second critic audits the migration and trigger/function as an allowlist: adding a target kind without its validation branch must fail a test or boot assertion.

## Required receipt

The completion receipt must list schema/protocol changes, migration behavior for old mentions, database rows and socket observations proving each acceptance case, named mutants caught, commands run, unresolved findings, and deliberately excluded agent/capability work.
