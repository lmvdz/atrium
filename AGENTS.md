# Working on Atrium

Orientation for anyone — human or model — picking this up cold. Read this, then `init.md`.

**This file is derived prose and it lags. The code is the source of truth.** Where it disagrees with the tree, the tree is right and this file is a bug. That is not boilerplate: a paragraph in `README.md` describing what runs was accurate when written, went stale at a merge, and was then quoted as current fact for a full day of work by someone who should have read the code instead.

---

## What the product is

A room's conversation, plus a second surface holding what the group actually decided, claimed, asked and committed to — each line pointing back at the messages it came from. A machine may **draft** that list; a machine may never **certify** it. Every line says which of the two it is: `~` is a reading nothing has checked, `✓` is the same sentence after a person accepted it.

`init.md` is the product bible — the twelve semantic concepts, the build/reuse/defer boundary, the five-phase sequence. Every ticket orients to it.

## State of play

Work is **not on `main`.** `main` carries only `RETRO.md` and this file.

| branch | what it holds | gate |
|---|---|---|
| `merge/foundation` | six lanes assembled: core, realtime, auth, UI, prototype, README | 2,909 unit · 134/135 integration |
| `fix/receipt-window` | the merge blocker closed, based on foundation | 2,927 unit · **139/139** integration · ledgers 172/172 and 96/96 |
| `build/interpret-worker` | the interpretation worker, based on foundation | 2,944 unit · 148/149 integration |

**`fix/receipt-window` and `build/interpret-worker` have never met.** Merging them and running the worker's integration suite is the next action, and it is one merge and one command. A single assertion flips — `objectsAccepted` becomes 1 and `rejected` empties — and that flip is the cheapest available proof the engine works end to end.

### What is built and adversarially verified

`packages/core` (the semantic engine), `packages/db` (11 migrations, append-only ledger with SQL-level guards), `packages/auth`, `apps/server` (wired to core through `ledger`, `commands`, `projections`, `room-events`, `protocol` — and driven end to end on the production build against real Postgres), `apps/web/src/components` (the component library), `apps/web/src/lib/realtime.ts` (durable client, survives socket kill, reload and flood with nothing lost or misattributed), `packages/ingest`.

### What is not built

**Two working surfaces that have never met.** `/` renders the three-surface product from the component library **against fixtures** — no data layer. `/app/[workspace]/[room]` is a real authenticated route with live presence that renders **its own markup** and references the component library zero times.

Joining them is the remaining work: the replay app and live multiplayer. Those are the open build tickets on the tracker.

## Where the decisions live

`github.com/lmvdz/atrium/issues/1` is the map — destination, methodology, model routing, every resolved decision indexed. **Read it before starting.** It is private; `gh issue view 1` works if authenticated.

Each build ticket carries `## Question`, `## Context`, `## Touches`, `## Acceptance test`, `## Verification gate`, `## Scope boundary` and `## Gauntlet`. A ticket you cannot pick up cold is a defect — say so rather than guessing.

**Ticket bodies can be stale against later decisions.** One specified a prompt structure that a measurement had already removed, and listed triggers that a spike measured firing 0 of 6. Check the decision ticket a build ticket cites before treating its body as spec.

## How work is verified here

The bar is higher than green tests, and it is the point of the project.

- **A verdict is a claim; the fold is the fact.** Judge on what is in the database and on what reached other participants' sockets, never on what a command returned. A worker once reported an object accepted while `accepted_objects` held zero rows.
- **Name the mutation, not the assertion.** Every test states the source change it now catches. When you rewrite a test, state what the old one caught — a fix round routinely deletes coverage a bad test pretended to have, invisibly in the diff.
- **Read tests, matrices and docblocks as claims, not coverage.** A passing test is evidence the code does what the test says, never that what the test says is right. Five defects here were found sitting beside an artifact asserting they were correct, including a test pinning one as a feature.
- **Allowlist the compliant form; never denylist violations.** Derive the assertion from the same computation that authorizes it, so no list exists.
- **A stated limit is not a disposition.** Documenting what you cannot prove does not change what the program does with an input inside it.
- **Anchor a guard to text the adversary did not write.** Two rounds built guards comparing two caller-supplied fields to each other, which proves nothing.
- **No synthesized speech.** Nothing rendered as a person's words may be words they did not write. Quote actual text with provenance, or state system facts in system voice, visually distinct.

## Traps that have cost real time

- **`packages/core/mutants/run.mjs` mutates `src/` in place.** Run it in a `cp -a` copy, never your checkout. `git status` reports a restored mutant **backwards** — it shows the restoration as the change and the defect as nothing. Audit by reading.
- **There are two mutation ledgers**: `packages/core/mutants/` and root `mutants/`. They never share a path.
- **Ledger anchors go stale as code moves**, and a stale anchor reads as `ESCAPED`. Five needed repointing in one week. Three had a restore step pointing at a superseded migration, which would have re-deployed the old behaviour mid-run while every later verdict still read `CAUGHT`.
- **The refusal convention is `ack` with a non-empty `issues` array, not `nack`.** `nack` is for malformed or rejected appends. An `ack` whose `issues` are non-empty and whose write did not land is a refusal.
- **This is a 4-core box.** Do not run heavy things concurrently. Browser suites need `--workers=2` or fewer; under load they emit `Protocol error (Runtime.evaluate)`, which is browsers dying, not a product defect. A full state walk has starved and timed out mid-run — suspect the machine before the page, and say which you concluded.
- **`biome check design/` has never passed** — 63 errors in harness `.mjs` files. Not a gate this repo holds. Do not reformat to fix it; biome's own `--unsafe` fix for `noConsole` **deletes the console call**, which would turn four reporters into programs that compute an answer and throw it away.
- **`pnpm` monorepo.** `pnpm install`, `pnpm -r build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration` (needs a real Postgres via `ATRIUM_TEST_DATABASE_URL`).

## Conventions

`design/CONVENTIONS.md` is binding on anything rendered — the glyph vocabulary, hover affordances, what a count may claim, what a sentence may assert about position. It is long because every rule in it was bought by a defect.

`RETRO.md` is the process record: every closed build ticket appends an entry, and it carries the reasoning behind the rules above. It is 900+ lines of chronological notes — useful to search, not to read front to back.

## If you are a model working autonomously

State the defect precisely and the remedy tentatively. Briefs written here specified fixes three rounds running and were wrong each time, with the better answer already in the file being quoted. If you drive something and conclude the instruction is wrong, **say so with the reasoning** — that is worth more than a faithful implementation of a bad idea.

And leave a receipt: what you built, what you measured, what you could not resolve, and what you deliberately did not do.
