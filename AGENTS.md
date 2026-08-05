# Working on Atrium

Orientation for anyone — human or model — picking this up cold. Read this, then `init.md`.

**This file is derived prose and it lags. The code is the source of truth.** Where it disagrees with the tree, the tree is right and this file is a bug. That is not boilerplate: a paragraph in `README.md` describing what runs was accurate when written, went stale at a merge, and was then quoted as current fact for a full day of work by someone who should have read the code instead.

---

## What the product is

A room's conversation, plus a second surface holding what the group actually decided, claimed, asked and committed to — each line pointing back at the messages it came from. A machine may **draft** that list; a machine may never **certify** it. Every line says which of the two it is: `~` is a reading nothing has checked, `✓` is the same sentence after a person accepted it.

`init.md` is the product bible — the twelve semantic concepts, the build/reuse/defer boundary, the five-phase sequence. Every ticket orients to it.

## State of play

**Phase 1 and Phase 2 are built, and `main` carries them** as of 2026-08-05. Before that date `main` held only `RETRO.md`, this file and `docs/skills/`, and the whole product existed as local branches on one machine with no remote copy. Everything below is now on `origin`.

| branch | what it holds | browser gate |
|---|---|---|
| `main` | Phase 1 replay + Phase 2 live multiplayer, assembled | 160/169 |
| `fix/live-v8-fidelity` | WIRE v8 frame, rich composer, typed references, attachments, conversation follow | **101/177 — red** |

`build/live-multiplayer` (what `main` merged), `build/replay-app`, `join/worker-on-fixed-window` and `phase3/dogfood-protocol` are all strictly contained in `fix/live-v8-fidelity`. They are history on `origin`, not pending work. The pre-UI lanes named in earlier revisions of this file — `merge/foundation`, `fix/receipt-window`, `build/interpret-worker` — are ancestors of all of it.

Measured on `main`, 2026-08-05, on a 16-core machine:

- `pnpm -r build`, `pnpm typecheck` — pass
- `pnpm lint` — **exits 1**, and always has. The errors are `design/*.mjs` and `scripts/mutation-ledger.mjs`, the harness files this file's own "Traps" section records as never having passed; no `apps/` or `packages/` source is among them. The Phase 2 receipt records this gate as "exit 0"; that reading came from a pipeline whose last stage was `tail`, so it measured `tail`. Run it as `pnpm lint >/dev/null; echo $?` if you want the real number. **This is not a green gate. It is a known-red one with a known boundary**, and the honest form is to say so rather than to keep quoting a zero nothing produced.
- `pnpm test --maxWorkers=2` — 3,107/3,107
- `pnpm test:integration` — 189/189 against the compose-managed database
- `pnpm test:e2e` at 8 workers — 160/169; the nine failures are timeouts and auth-flow content in the flaky auth/mail set, with zero product-shaped assertion failures

### What is built and adversarially verified

`packages/core` (the semantic engine), `packages/db` (append-only ledger with SQL-level guards), `packages/auth`, `apps/server` (wired to core through `ledger`, `commands`, `projections`, `room-events`, `protocol` — and driven end to end on the production build against real Postgres), `apps/web/src/components` (the component library), `apps/web/src/lib/realtime.ts` (durable client, survives socket kill, reload and flood with nothing lost or misattributed), `packages/ingest`.

**The two surfaces have met.** `/replay/[workspace]/[room]` renders the component library against the persisted corpus and worker output for a verified room member; `/app/[workspace]/[room]` renders the same surfaces against live shared state. `docs/PHASE2-RECEIPT.md` is the delivery receipt, including the blind reorientation comparison and both independent full-diff reviews.

### What is not built

- **A browser gate over the WIRE v8 frame.** `fix/live-v8-fidelity` raised the frame's minimum width from 1024 to 1340 and hid the room rail pending a fold affordance that does not exist yet, without updating the runner viewport or the specs that pin the old information architecture. 76 of 177 browser tests fail there. That branch's `HANDOFF.md` has the triage.
- **Phase 3.** The dogfood protocol is preregistered and its validator self-tests in `plans/phase3-dogfood/`, with zero observations recorded. Its stop rule is a fourteen-day window that does not start until the first receipt exists.

## Where the decisions live

`github.com/lmvdz/atrium/issues/1` is the map — destination, methodology, model routing, every resolved decision indexed. **Read it before starting.**

The repo is private and **`gh` may or may not reach GitHub from your shell** — sandboxed shells have returned `error connecting to api.github.com`, while an ordinary authenticated shell on this machine reached it fine on 2026-08-05. Try it. If it fails, read **`docs/TRACKER.md`**, a point-in-time snapshot of the open tickets, the map, and the four load-bearing build tickets. It is a copy and it will drift; the live tracker wins whenever you can reach it. Note that #25 and #27 are delivered on this tree and still open on the tracker — nothing has been written back to GitHub.

Each build ticket carries `## Question`, `## Context`, `## Touches`, `## Acceptance test`, `## Verification gate`, `## Scope boundary` and `## Gauntlet`. A ticket you cannot pick up cold is a defect — say so rather than guessing.

**Ticket bodies can be stale against later decisions.** One specified a prompt structure that a measurement had already removed, and listed triggers that a spike measured firing 0 of 6. Check the decision ticket a build ticket cites before treating its body as spec.

## Setting up from a fresh clone

Node **>= 22.12**, pnpm **10.13.1** (the repo pins `packageManager`, so `corepack enable` is the least surprising route).

```
pnpm install
pnpm -r build          # packages must build before apps typecheck
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test` needs no services. **Integration tests need a real Postgres, and the script brings its own** — `pnpm test:integration` runs up → migrate → vitest → down against `docker-compose.test.yml`, so Docker is the only prerequisite:

```
pnpm test:integration            # brings the database up and tears it down
pnpm test:integration --keep     # leave it running afterwards
ATRIUM_TEST_DATABASE_URL=... pnpm test:integration   # use your own; touches compose not at all
```

There is deliberately **no in-suite skip**: if the database cannot be reached the run exits non-zero, because a test that quietly passes without its database keeps reporting green on the gate it guards.

**Both mutation ledgers** — `packages/core/mutants/run.mjs` and root `mutants/` — need `ATRIUM_TEST_DATABASE_URL` pointing at an already-migrated database; they do not manage one for you.

`docker-compose.yml` (the full stack, distinct from the test one) also defines `minio`, `server`, `app` and `proxy`; you do not need them for the suites. Two known issues are in the tracker: compose publishes Postgres and MinIO on every interface, and `.env.example` is inaccurate about what enables a credential fallback.

**`gh` needs its own auth on a new machine.** If it is not authenticated, or the shell is sandboxed, GitHub is unreachable and `docs/TRACKER.md` is your fallback — see below.

## Methodology

`docs/skills/campaign.md` is the working method this repository was built with: a decision graph on the tracker, work decomposed to the smallest independently-judgeable artifact, and **blind critics with fresh context** judging each one against a real-world reference. It is not required reading to fix a bug; it is required reading before starting a new lane, and every rule in it was bought by a defect recorded in `RETRO.md`.

The parts that matter even for a one-off change are in **How work is verified here**, below.

## Before you spend money

`INTERPRET_MODEL_DEFAULT` and `INTERPRET_MODEL_ESCALATION` have no defaults; unset, the server logs an error and installs neither the worker nor its enqueue hook, so nothing accumulates. That is deliberate.

**The escalation tier is miscalibrated and it is expensive.** Measured against the real corpus, the routing trigger fires on 35% of individual messages, 91% of five-message windows and **100% of ten- and twenty-message windows** — and it is evaluated per window at a window size of 10–20. So the cheap tier never runs and every burst pays the escalation model's price. Nothing is broken; it just costs several times what the pipeline's cost model assumed. Know that before adding an `AI_GATEWAY_API_KEY` and running the smoke script. The rate is pinned as a test carrying the numbers, and each pass logs `tier`, `triggers` and `costUsd`.

## Do not re-do this work

Six subsystems have already been through repeated blind adversarial review — core, realtime, auth, the UI component library, the prototype, and deployment. **They are done being verified.** Facing 58 open tickets and a 900-line retrospective, the tempting move is to start hardening `packages/core` again. That is exactly the drift that cost this campaign a day: twelve consecutive rounds, every one finding a real defect, while the two tickets that constitute the actual goal sat untouched.

The deployment lane is **deliberately stopped**, not abandoned — its remaining findings all required editing the gate's own source, and hardening a gate against its own author has no terminal state.

**The join is done.** The component library and the server meet on both the replay and the live routes, and Phase 2's own acceptance drove it. The work now is, in order:

1. **Make the browser gate honest again** on `fix/live-v8-fidelity`, so the shipped frame is covered by something. A UI change that moves the product's minimum width and removes its navigation column, verified by unit tests alone, is how 76 browser tests went red without anyone noticing.
2. **Start the Phase 3 dogfood clock.** It is preregistered, its validator self-tests, and it has zero observations. Nothing about it gets more true by waiting.

Everything else is a distraction with a good excuse. That includes another round on the six verified subsystems, and it includes inferring a sixth scrolling algorithm from a defect nobody has yet instrumented.

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
- **Check your core count and cap concurrency at half of it.** These suites are heavy. Browser suites want `--workers=2` or fewer on a small machine; under load they emit `Protocol error (Runtime.evaluate)`, which is browsers dying rather than a product defect — re-run the affected tests in isolation before believing them, and say which you concluded. A full state walk has starved and timed out mid-run on a four-core machine, costing ninety minutes. Suspect the machine before the page.
- **`biome check design/` has never passed** — 63 errors in harness `.mjs` files. Not a gate this repo holds. Do not reformat to fix it; biome's own `--unsafe` fix for `noConsole` **deletes the console call**, which would turn four reporters into programs that compute an answer and throw it away.
- **`pnpm` monorepo.** `pnpm install`, `pnpm -r build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration` (needs a real Postgres via `ATRIUM_TEST_DATABASE_URL`).

## Conventions

`design/CONVENTIONS.md` is binding on anything rendered — the glyph vocabulary, hover affordances, what a count may claim, what a sentence may assert about position. It is long because every rule in it was bought by a defect.

`RETRO.md` is the process record: every closed build ticket appends an entry, and it carries the reasoning behind the rules above. It is 900+ lines of chronological notes — useful to search, not to read front to back.

## If you are a model working autonomously

State the defect precisely and the remedy tentatively. Briefs written here specified fixes three rounds running and were wrong each time, with the better answer already in the file being quoted. If you drive something and conclude the instruction is wrong, **say so with the reasoning** — that is worth more than a faithful implementation of a bad idea.

And leave a receipt: what you built, what you measured, what you could not resolve, and what you deliberately did not do.
