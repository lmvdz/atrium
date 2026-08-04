# Interaction improvements — implementation receipt

**Branch:** `fix/live-v8-fidelity`  
**Implemented:** 2026-08-04  
**Scope:** keyboard-first typed references, attachment inspection, contextual human-reference attention, and removal of the empty product-route attention monument.

## Components and projection boundaries

- `Composer` owns only draft-local completion state. It retains the selected typed target ID and authored UTF-16 span; it does not infer a reference from the visible label.
- `AttachmentPreview`, `TimelineRow`, and the live/replay session handlers share one preview/download component boundary. Durable attachment records contain identity and metadata, never an expiring authorization URL.
- `contextualReferenceAttention` projects pending human message-attention from persisted `attention_items`, `object_sources`, `proposal_sources`, proposals, and accepted objects. `replayView` is the common projection used by both replay and `liveRoomView`.
- `ReferenceMarkers`, `StateLens`, `ObjectiveGroup`, and `ObjectRow` render the typed projection. Direct references are removed from the generic Pin presentation only after their contextual replacement exists.
- `RoomFrame` can omit the whole empty Pin on product routes. Other genuinely owed attention continues through the existing `needsViewer` fold.
- The live frame no longer imposes a 720px minimum height. Its existing bounded grid now keeps the composer reachable at short viewport heights.

## Keyboard and accessibility behavior

- Typing `@` opens a vertical `combobox`/`listbox` with one active `option` when results exist.
- Arrow keys wrap and keep the active option visible. Tab and Enter autocomplete the active option; Enter returns to send behavior after completion. Escape closes without changing the draft.
- Pointer hover updates the keyboard-active option and pointer click selects it.
- Shift+Enter, both modern and legacy IME composition guards, attachment controls, and stable reference span shifting/invalidation remain intact.
- Duplicate labels retain the selected stable ID and expose type/context rather than relying on display-name lookup.
- The preview is an `aria-modal` dialog. Focus begins on Close, Tab is trapped inside it, Escape and backdrop click close it, and unmount restores focus to the exact opener.

## Preview and download behavior

- Clicking an image thumbnail or filename opens the in-app preview; it no longer downloads implicitly.
- The dialog shows filename, media type, byte size, fit/actual-size control, a separately named download icon, and a close icon.
- Non-images receive an honest no-inline-preview state and explicit download action.
- Opening, retrying after an image error, and downloading each acquire a fresh presigned URL. An expired URL is retried once automatically; authorization is never written into the attachment record.
- Timeline thumbnails request their URL only when an intersection observer reports that they are near the viewport and retry after an image-load failure.
- Live and replay sessions wire the same `RoomFrame` and `AttachmentPreview` behavior.

## Contextual attention rules

1. Only a pending `mention` attention whose subject is a message and whose `user_id` exactly matches the authenticated viewer is projected. No viewer, an unknown viewer, resolved attention, dismissed attention, and another participant's attention project nothing.
2. An `object_sources` edge places the source on the referenced accepted objective or object.
3. A `proposal_sources` edge places an unaccepted proposal on its objective/object row. If accepted, the accepted object is the location.
4. If no durable source edge exists, the marker is explicitly filed under conversation rather than attached by words, time, order, proximity, or display name.
5. Markers group only references sharing the exact source message. Their accessible label and visible numeral state the actual count.
6. Activating a live marker sends the existing durable attention-resolution command and navigates to/focuses/highlights the exact message. Replay uses the same placement and exact-message navigation while folding locally acted-on replay attention.

## Durable database and socket evidence

The focused two-browser Playwright scenario uses the production live route and real Postgres. It proves:

- the authored message, attachment claim, two typed reference rows, exact UTF-16 surfaces, and recipient `attention_items` row commit together;
- the recipient sees the sender's exact authored text and stable human/attachment IDs;
- an unfiled marker survives a forced recipient socket close and reconnect without duplication or loss;
- inserting the durable `object_sources` edge and replaying the route moves that same attention from conversation to the exact objective row;
- activating the marker highlights the exact source message, changes the database fold from `pending` to `resolved`, and removes the marker;
- the preview shows persisted metadata, closes by keyboard, and restores focus;
- after the attention clears, the empty Needs-you region is absent and the composer remains inside a 1440×500 viewport.

The real-Postgres integration suite remains green at 189/189. Command acknowledgement alone is not used as evidence for the attention write or its resolution.

## Named mutations caught

New and rewritten tests carry `CATCHES:` comments for these source mutations:

- opening completion only from the icon, leaving it pointer-only, allowing Tab to blur, sending before Enter selects, or changing the draft on Escape;
- resolving duplicate targets by label, discarding stable IDs, retaining an edited-through span, or flattening multiline/IME input;
- making the attachment card's only action a download, caching an expired presigned URL, eagerly signing every historical image, treating every file as an image, or omitting focus restoration;
- declaring a modal while allowing Tab to reach obscured room controls, or painting a backdrop that does not close;
- collapsing all references into a generic global card, associating them by wording/proximity, leaking another viewer's attention, or guessing a viewer on anonymous replay;
- rendering a cosmetic marker that neither reaches the exact message nor changes the durable attention fold;
- retaining conversation placement after a durable objective source edge exists;
- hiding real obligations along with the empty Pin, or recovering space with a 720px frame floor that strands the composer on short windows.

## Gates run

- `pnpm install` — passed; lockfile already current.
- `pnpm -r build` — passed, including the Next production build.
- `pnpm typecheck` — passed.
- `pnpm lint` — reached the documented pre-existing `design/*.mjs`/mutation-ledger baseline: 51 informational diagnostics and 15 warnings. Targeted Biome over every touched file passed.
- `pnpm test` — 3,099/3,101 passed in the aggregate run; two five-second auth source-graph tests timed out under full-suite load. The affected auth package then passed 409/409 in isolation in seven seconds, classifying machine pressure rather than a source failure.
- Web unit suite after the changes — 34 files, 738/738 passed.
- `pnpm test:integration` — 10 files, 189/189 passed against the harness-managed real Postgres; its compose stack was removed.
- Focused typed-reference browser scenario, direct Playwright with `--workers=2` — 1/1 passed.
- Focused pin/short-viewport browser suite, `--workers=2` — 16/16 passed across five heights, four widths, both themes, and loads up to 60 owed items.
- Full browser sweep, direct Playwright with `--workers=2` — started 170 tests and reproduced two unrelated `agreement.spec.ts` prototype failures at 1024px: hidden legacy rail controls timed out while the page itself states a 1340px width floor. The sweep was stopped after classification rather than repeating known one-minute failures. The production-route acceptance specs above are green.

## Unresolved findings

- Repository-wide lint remains non-green only in the documented untouched harness baseline. It was not auto-fixed because `AGENTS.md` explicitly warns that unsafe formatting changes those reporters' behavior.
- The broad browser suite remains non-green in the pre-existing gallery/agreement viewport matrix. The failing 1024px scenarios attempt to click a hidden legacy rail beneath a page that declares a 1340px floor; this ticket neither introduced that fixture architecture nor expands scope to redesign it.
- The root `pnpm test:e2e -- --workers=2` wrapper forwards the separator into Playwright and can launch the default worker count. Verification used the equivalent direct Playwright invocation so the two-worker safety cap was real.

## Deliberately excluded

No agent identities or `@agent`, assignment, orchestration, tool execution, capability grants, delegation, distributed infrastructure, semantic acceptance-policy changes, automatic objective inference, attachment schema redesign, or broad visual redesign were introduced.
