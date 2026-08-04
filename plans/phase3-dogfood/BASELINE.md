# Phase 3 baseline receipt

Recorded: 2026-08-03

Source tree: `5cd9efe` (`build/live-multiplayer`)

Status: historical calibration only; not a Phase 3 observation

## Reorientation calibration

The authoritative measurement is `docs/PHASE2-RECEIPT.md`, under **Blind reorientation validation**.

| Property | Atrium replay | Raw chronological thread |
| --- | --- | --- |
| Corpus | Same 111 persisted messages | Same 111 persisted messages |
| Surface | 1440×900 browser | 1440×900 browser |
| Additional capabilities | None | None; loopback server supplied chronological HTML only |
| Fixed questions | Current decisions; open questions; who owes what; current objective | Identical |
| Duration | 31,118 ms | 128,685 ms |
| Recorded outcome | Exact answers; draft readings remained distinct from accepted facts | Objective and questions broadly found; decisions over-included and obligations inferred |

Derived ratio: `128685 / 31118 = 4.1354…`, reported in the Phase 2 receipt as **4.14× faster**.

The raw surface remains reproducible through `scripts/validation/raw-thread-server.mjs`. The discarded earlier run is excluded because its raw-thread judge had filesystem search while the Atrium judge had only a browser.

## What this baseline does not establish

It is one replay, not longitudinal use. It supplies no baseline for:

- repeated questions;
- forgotten commitments;
- missed decisions during ordinary work;
- incorrect interpretations over a live stream;
- attention-item usefulness;
- manual organization time.

Those six gaps are why Phase 3 exists. A zero must not be backfilled for any of them. The live protocol records their first honest baseline as observations accumulate.

## Measurement start receipt

- The project under observation is the Atrium campaign itself.
- Protocol v1 was preregistered before any Phase 3 return session was counted.
- Observation count at registration: **0**.
- Paid interpretation models: **not enabled by this lane**.
- Product changes made to obtain the baseline: **none**; this lane adds only measurement artifacts.
- Runtime services started by this lane: **none**.
- First eligible receipt: an ordinary return after at least four hours away during which the project changed.
