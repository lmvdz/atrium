# Durable typed room references — implementation receipt

**Branch:** `fix/live-v8-fidelity`  
**Implemented:** 2026-08-04  
**Scope:** the first reference slice only: current humans, attachments, staged proposals, and accepted objects.

## Shipped shape

- `MessageReference` carries an ordered `ordinal`, allowlisted `kind`, stable `targetId`, UTF-16 `start`/`end`, and the exact authored `surface`.
- Upload grants now bind a server-minted attachment UUID to its room, storage key, filename, media type, size, and capability signature. Committed claims are normalized in `attachments`.
- Migrations `0015_typed_reference_vocabulary.sql` and `0016_durable_typed_references.sql` add the exhaustive kind vocabulary, normalized attachments and references, message-subject attention, UTF-16 slicing, exact-surface/overlap checks, and same-room target validation.
- `send_message` validates every reference and attachment grant inside the ledger transaction, then commits message, claims, references, immediate human attention, and realtime projection as one operation. Missing, unauthorized, and cross-room targets share the public `reference is unavailable` refusal.
- Realtime and replay expose the same persisted reference shape. Message text always comes from the stored body/surface; current human or semantic metadata is resolution, never replacement speech.
- The V8 composer keeps stable selected IDs, updates spans across edits before/after them, invalidates edited spans, and offers current humans, current draft attachments, staged proposals, and accepted objects.

## Legacy behavior

Existing `MessagePosted.mentionUserIds` remains readable as an explicit degraded legacy signal. Migration does not search historical bodies, mint spans, or create `message_references` rows for it. Replay renders the authored body unchanged and distinguishes the legacy signal from validated span-backed references.

## Acceptance evidence

1. **Human reference and attention.** `typed-references.spec.ts` observes the recipient browser and reads the exact human target ID, UTF-16 span/surface, and one pending message-subject attention row from Postgres. `commands.test.ts` additionally proves an acknowledgement-lost retry leaves one reference and one attention row with no worker installed.
2. **Rename without rewritten speech.** The two-browser spec changes the resolved human name, then proves the historical authored token remains byte-for-byte the message body while current resolution changes.
3. **Attachment identity and replay.** The browser spec uploads and references an image, then checks the server-minted ID in the normalized attachment claim and reference row and observes its thumbnail after replay.
4. **Proposal/object state.** The browser spec selects both stable IDs, reads them back from Postgres, and observes current semantic state while the authored surfaces remain unchanged. Replay unit coverage also keeps resolution separate from body segmentation.
5. **Duplicate names.** Composer tests select by stable target ID rather than label; selection and serialized reference retain the chosen ID when labels collide.
6. **Departure/deletion.** Server membership validation excludes removed humans from new references. Replay resolution tests retain historical body/surface and render unavailable/no-longer-in-room metadata rather than inventing a participant.
7. **Unavailable target atomicity.** Server validation uses one public refusal for missing, unauthorized, and cross-room targets. Direct Postgres conformance covers all four kinds. Transaction tests judge database rows and event delivery: a refusal leaves no message, reference, claim, attention, or committed realtime event.
8. **Malformed references.** Web, server, and direct-Postgres tests cover out-of-range and UTF-16 errors, overlap, surface mismatch, duplicate ordinal, unknown kind, target-column mismatch, and exhaustive kind dispatch.
9. **Reconnect.** The focused two-browser spec closes the recipient socket, sends while disconnected, reconnects, and observes both the durable reference and attention signal exactly once.
10. **Worker independence.** The focused integration server installs no interpretation worker or model settings. Normal send/retry/replay and immediate human attention still pass.

The database conformance suites insert invalid rows directly for every kind. The trigger derives the target table from an explicit allowlist; schema/conformance assertions fail if a kind is added without its validation arm.

## Named mutations caught

Every new or rewritten assertion carries a `CATCHES:` receipt. The principal source mutations are:

- counting Unicode code points rather than JavaScript UTF-16 units;
- shifting all spans with one delta, retaining a reference edited through, or leaving ordinal gaps after invalidation;
- matching a visible label rather than retaining the selected stable ID;
- reconstructing authored text from renamed/current target metadata;
- validating individual spans without overlap or exact-surface enforcement;
- resolving targets globally, trusting a caller room, or extending the kind vocabulary without extending the SQL validator;
- fabricating typed spans from legacy `mentionUserIds`;
- validating membership outside the authenticated transaction boundary;
- leaving human attention behind the optional interpretation hook;
- replaying an uncertain send into duplicate references or attention;
- flattening plain non-Markdown references so their typed DOM metadata disappears.

## Gates and measurements

- `pnpm install` — passed with Node 22.22.2 / pnpm 10.x (the repo pins 10.13.1).
- `pnpm -r build` — passed, including the Next production build.
- `pnpm typecheck` — passed before the final integration-only assertion; rerun at handoff.
- `pnpm exec vitest run --maxWorkers=8` — passed: 95 files, 3,079 unit tests.
- `pnpm test:integration` — passed against real Postgres: 10 files, 189 tests; compose database removed by the script.
- Focused direct-Postgres conformance — passed: 6/6.
- Focused `integration/server/commands.test.ts` after the final assertion — passed: 40/40.
- Focused typed-reference Playwright spec with two browsers and `--workers=2` — passed: 1/1.
- Biome over all touched implementation/test files — passed.

## Unresolved and baseline findings

- The repository-wide `pnpm lint` remains red in the pre-existing `design/` harness baseline. `AGENTS.md` records 63 known errors there and explicitly forbids reformatting that harness as a repair; touched files are clean.
- The full browser suite remains red in unrelated pre-existing gallery/agreement checks (fixture navigation, contrast, overflow, and non-text registry). The root wrapper also forwards the requested argument as `-- --workers=2`, causing Playwright to use eight workers. The affected typed-reference spec was rerun directly with two workers and is green.
- These baseline failures are not classified as typed-reference product defects; they are reported rather than hidden or expanded into this ticket.

## Deliberately excluded

No agent identity or `@agent`, assignment, tool execution, capability grant/delegation, autonomous orchestration, distributed infrastructure, semantic acceptance-policy change, model auto-acceptance fix, or visual redesign was introduced.
