# Atrium

Understanding-first multiplayer conversation. Three synchronized surfaces —
**Conversation** (what people are saying), **Current state** (what the group now
understands and is committed to), **Needs you** (what specifically requires this
person) — over a semantic core that turns messages into typed, correctable,
provenance-carrying state.

The thesis being tested, from `init.md`: after being absent for several hours,
can a participant understand the situation, the changes, the open questions and
their own responsibilities substantially faster than in Slack?

## Boot it

Requires Node 22.12+, pnpm 10, and Docker.

```bash
cp .env.example .env      # required first — compose has no default secrets
pnpm install
pnpm infra:up             # postgres:16 + minio, via docker compose
pnpm db:migrate           # apply the drizzle migrations
pnpm dev                  # web on :3000, server on :4000
```

`pnpm dev` builds `packages/*` once, then runs both apps in watch mode.

Everything in containers instead:

```bash
docker compose up --build   # postgres, minio, migrate, server, app
```

Same compose file locally and on the VPS (issue #18) — only `.env` differs.

### The credentials in this repo are development-only

`.env.example` ships postgres `atrium:atrium` and MinIO
`atrium:atrium-dev-secret`. **They are development credentials, published in a
public repository.** They exist so a laptop boots with no setup, and for nothing
else. Never run this stack on a public VPS with those values.

Three things enforce that rather than merely asking:

- The three secrets in `docker-compose.yml` — `POSTGRES_PASSWORD`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — are each `${VAR:?...}` with **no
  default**. Compose refuses to start when one is unset instead of reusing a
  known password. That is why `cp .env.example .env` is the first step above.
  The non-secret settings (`POSTGRES_USER`, `POSTGRES_DB`, `S3_BUCKET`,
  `S3_REGION`, ports, log level) do keep defaults.
- `apps/server/src/env.ts` applies its dev fallback for `S3_ACCESS_KEY_ID` /
  `S3_SECRET_ACCESS_KEY` **only** when `NODE_ENV` is explicitly `development`.
  An **unset `NODE_ENV` is treated as production** — "nobody said" on a bare
  host is a host on the internet — so `docker run atrium-server` with no
  environment at all fails at boot with a named error rather than reaching for
  a public secret. `pnpm dev` sets `NODE_ENV=development` itself; that is the
  opt-in. **`NODE_ENV` is read from the process environment only.** A `.env`
  found on disk may supply a value nobody set, but it may never say what
  environment this process is in — a file ships in a repo and gets copied into
  images, so if a file could turn the fallback back on, the strict default
  would be decoration. `apps/server/test/entrypoint-env.test.ts` boots the real
  entrypoint in a scratch directory with a planted `.env` to prove it.
- Every value is trimmed before it is validated, so a secret pasted with the
  newline that came with it still authenticates, and a variable set to nothing
  but whitespace fails as empty instead of passing a length check.

Before exposing anything: set real values in `.env` (or the deployment's own
secret store), and do not publish 5432 / 9000 / 9001 at all unless you mean to.
Only 3000 and 4000 need to face the internet.

## Layout

```
apps/web        Next.js 16 App Router, React 19. The three-region shell.
apps/server     Node 22. ws WebSocket server + pg-boss workers. One process.
packages/core   The Semantic Core. Pure TypeScript, zero I/O.
packages/db     Drizzle schema, migrations, postgres-js client.
packages/ingest Replay ingest. Conversations in, canonical JSONL out.
corpora/        Committed replay corpora (see below).
design/         Design tokens (light default, dark via `html.atr-dark`).
```

The dependency arrow only ever points one way: `web`/`server` → `db` → `core`.
`packages/core` imports nothing from `node:*`, no driver, no clock — that purity
is what makes interpretation replayable and unit-testable in isolation.

### The semantic model

Five first-class accepted object types share one table with a `type`
discriminator and a typed jsonb payload: **decision**, **commitment**,
**open_question**, **claim**, **objective**. Supersession, dependency, blocking,
answering and evidence are typed edges in `relations`, not objects. Proposals
are pre-acceptance staging and never render as facts. Corrections are events, so
nothing is ever erased. Attention items are a recomputable projection and every
one of them must say why it needs *this* person. (Issue #3.)

`reduce(events) → state` in `packages/core` is deterministic and total: events
are canonically ordered by `(at, id)`, a malformed event is recorded in
`state.issues` rather than thrown, and the same log always serializes
byte-identically.

The reducer is also where the trust boundary is enforced, not merely described.
A recorded proposal is always `proposed` — an interpreter cannot hand itself an
`accepted` one, and the record is the only place a proposal's status lives, so
acceptance cannot leave a stale copy behind. An acceptance that cites a proposal
must cite one that exists, is still open, has not already been spent on another
object, and matches the object's type.

### The actor floor

[#4](https://github.com/lmvdz/atrium/issues/4) settled acceptance per type. Most
of that matrix is policy (confidence thresholds, commitment attribution) and
belongs to the θ engine in
[#21](https://github.com/lmvdz/atrium/issues/21). Five rows of it are not
policy — they are the trust boundary itself, and a boundary enforced only above
the reducer is one a second writer or a replay can walk around. Those are
enforced in `packages/core/src/authority.ts`, and the reducer refuses to fold an
event that breaks them:

| what | who |
| --- | --- |
| Accepting an object with **no proposal** cited | human only |
| Accepting a **decision**, proposal or not | human only |
| Any transition of a claim to `verification: 'verified'` | human only |
| **Superseding an accepted decision** | human only |
| **Corrections** — amend, retract, restore | human only |

What stays open is as deliberate as what is closed: a model may accept its own
**claim** and **open_question** proposals (that is #4's auto-accept path, and
the epistemic field carries truth status separately), may supersede a claim or a
question, and may reject a proposal — withdrawing a staged reading destroys
nothing. Refusals are recorded in `state.issues` with the route that stays open,
and every gate is tested in both directions.

### Consumed, or rejected

Live folding is a command, not a fold. `appendEvent(state, event)` returns a
typed outcome:

- **applied** — consumed and applied.
- **applied with issue** — consumed, and a business problem was recorded in
  `state.issues` (a coerced proposal, an amendment to an object that does not
  exist, a relation that fails its type signature). It happened, in order; a
  replay of the log reproduces it exactly.
- **rejected** — *not* consumed, for one of two reasons. `out_of_order`: it does
  not sort **strictly after** `state.cursor` in the canonical `(at, id)` order —
  strictly, because one position holds one event, so anything landing on the
  cursor is a redelivery or a forged id. `duplicate`: its id was consumed
  already, and it arrived *ahead* of the cursor, which is the one case position
  cannot see (a redelivery that re-minted its timestamp). Rejection leaves
  nothing behind: no issue, no cursor movement, no `consumedEventIds` entry. The
  state handed back is the state handed in, the same object.

Position is checked first. Both branches reject and neither touches the state,
so the order cannot change what the state becomes — it decides which reason is
reported, and position is the stronger fact: it holds on the log's terms alone,
so the ordering guarantee never becomes a property of the id set.

An id is spent by being **consumed**, not by succeeding. An event that failed
its business checks still took its position, and letting it back in later would
let a redelivery retry against a state that had moved on — the same id flipping
failure into success once its missing object finally arrived.

So consumption only ever moves forward, and the consumed sequence is in
canonical order by construction. For any log `L` of consumed events, folding
`L` one event at a time in arrival order and replaying `L` in one `reduce` call
produce byte-identical states — `issues` and `consumedEventIds` included. That
is the entire live≡replay claim, and it is checked property-style over generated
logs (`packages/core/test/replay.test.ts`): two rooms with deliberate same-`at`
cross-room ties, verbatim redeliveries, redeliveries that re-minted their
timestamp, model actors reaching for every gate above, and both shuffled and
near-in-order delivery. The replay side does not ask the reducer what it
consumed — it reconstructs that from the input stream with an independent filter
written in the test, so a defect shared by both paths cannot cancel out.

The other half of the invariant is the ledger's, and it is recorded on
[#22](https://github.com/lmvdz/atrium/issues/22): the durable log must contain
only events accepted in canonical order, because an out-of-order event is
rejected at the command layer and never persisted. Rejected events enter
neither state nor log, so the two sides are folding the same sequence rather
than being reconciled after the fact.

`CoreState.watermarks` still records each room's last consumed position — that
is what `core_events.room_seq` will map onto — but the gate is the global
`cursor`, because `issues`, `corrections` and `consumedEventIds` are global
ordered lists and a per-room gate would let two rooms interleave them one way
live and another way on replay.
### Replay ingest

`packages/ingest` turns a real conversation into the canonical replay format
(issue #2) — JSONL, one message per line:

```json
{"id":"github:vercel/next.js#11552/c2632","author":"timneutkens","ts":"2020-04-01T15:43:13.000Z","text":"Only if your code changes. In cases of data it can just be re-rendered.","reply_to":"github:vercel/next.js#11552/c2631"}
```

`{id, author, ts, text, reply_to?, attachments?[]}` — small on purpose, so a
Slack or Discord export adapter is a field rename and pasted markdown converts
with a tiny parser. Files in, files out: no database, no interpretation, no UI.

```bash
pnpm ingest list                      # registered sources
pnpm ingest nextjs-isr                # → corpora/nextjs-isr.jsonl
pnpm ingest all                       # every registered source
pnpm ingest nextjs-isr --check        # fail if a refetch would change the file
pnpm ingest markdown notes.md         # pasted transcript → JSONL on stdout
pnpm ingest validate                  # re-validate the committed corpora
```

Three corpora are committed:

| File | Source | Role | Why |
| --- | --- | --- | --- |
| `corpora/nextjs-isr.jsonl` | Next.js discussion #11552, *RFC: Incremental Static Regeneration* | **demo** | 454 messages, 368 reply edges, 184 participants. A two-year RFC-to-shipped-feature argument with real threading — which is what the replay UI has to render. |
| `corpora/ts9998.jsonl` | TypeScript #9998, *Trade-offs in Control Flow Analysis* | sample | A decade-long design argument, and the only corpus on the REST path. Flat: GitHub *issues* carry no threading, so it has zero reply edges — which is why it is no longer the demo. |
| `corpora/holdout-nextjs-rfc.jsonl` | Next.js discussion #37136, *RFC: Layouts* | eval holdout | Reserved for the interpretation-quality golden set, so prompts are never tuned on the corpus they are scored against. Never demoed. |

A rerun is byte-identical. Ids are derived from the source, messages are sorted
by `(ts, id)`, keys are written in a fixed order, message bodies are stored
verbatim, and nothing records when the fetch happened — so `pnpm ingest all`
twice leaves `git diff` empty and any real change to the upstream thread shows
up as a readable diff.

**Bodies are verbatim.** No NFC composition, no line-ending rewriting, no
trailing-whitespace strip — two trailing spaces are a Markdown hard break, and
stripping them would silently reflow what someone wrote. Determinism comes from
stable source bytes plus canonical *serialisation*, not from normalising the
text; JSON escaping carries CR, LF, tabs and combining marks through unchanged.

**A partial corpus is unwritable.** A truncated fetch is the dangerous failure
because its output looks perfect — schema-clean, canonically ordered, stable
across reruns, and missing half the conversation. So the fetchers throw rather
than return short: on a stalled cursor (`hasNextPage` with no `endCursor`), on
the page-count guard being hit with pages outstanding, on the same item arriving
twice, and on the fetched count disagreeing with the API's own `totalCount`
(GraphQL) or `comments` count (REST). The failure paths are covered by
transport-mock tests, not just by the committed corpora.

**A corpus is a snapshot at fetch time — by design.** It records the thread as
the API described it during that one run, reconciled against the API's own
counts so it is a coherent single moment rather than a smear across a mid-run
edit. Edits, deletions and new messages *after* that run are out of scope:
replay is about what was said, and a refetch is how you move the snapshot
forward. When upstream really has changed, the rerun's `git diff` is the record
of what changed — which is the point of committing the corpora at all. There is
no attempt to reconcile a stored corpus against later upstream history, and
`--check` deliberately reports drift as a failure rather than absorbing it.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Build packages, then web + server in watch mode |
| `pnpm build` | Build packages, then both apps |
| `pnpm test` | Vitest across `packages/*` and `apps/server` |
| `pnpm ingest <source>` | Fetch a conversation into `corpora/` (see Replay ingest) |
| `pnpm test:e2e` | Playwright smoke test in `apps/web` |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome with safe fixes applied |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm infra:up` / `infra:down` | Postgres + MinIO only |

Playwright needs its browser once: `pnpm --filter @atrium/web exec playwright
install chromium`. Without it the smoke test skips with a reason instead of
failing — a red e2e run should mean "the app is broken", never "no browser
here".

## CI

`.github/workflows/ci.yml` runs on every pull request, every merge-queue entry,
and every push to `main`. Three jobs: `verify` (lint, typecheck, migrations
against a real Postgres, unit tests, build), `e2e` (Playwright on chromium), and
`gate`.

**What this defends against: accident and drift.** A step deleted during a
rebase, a floor lowered to make a red build go green, an action tag that moved
under us, a workspace that stopped contributing tests, a suite that skipped its
way to silence. Every rule below is aimed at the mistake nobody meant to make.

It does **not** defend against a malicious author with write access, and it
cannot. The policy engine, its self-test, the reporters, the gates and the
floors all execute from the revision under test: whoever can edit those files
can edit what they check. The presence rules and the ratchet make that expensive
and loud — they do not make it impossible. **Adversarial closure is the
governance trigger below**, not anything in the workflow: required-check
rulesets, pull requests, and code-owner review. Reading any part of this CI as
protection against a hostile contributor is reading it wrong.

Precisely where that line falls, because "not against a malicious author" is too
vague to act on: the presence rules pin the **invocation shape** of every gate —
that the script is named, invoked as a command rather than mentioned, in the
right job, and after the steps it depends on. They say nothing about what the
script does once it starts. `echo node scripts/ci/assert-tables.mjs` no longer
satisfies them; replacing `assert-tables.mjs`'s body with `process.exit(0)`
satisfies all of them and always will, because the rule and the script are read
out of the same commit. That is malicious editing rather than drift, and it
belongs to the governance trigger. A green policy run is a claim about the
workflow's shape, never about its gates' semantics.

**`gate` is the only check that should ever be marked required.** GitHub scores
a *skipped* required check as a *successful* one, so marking `verify` required
means a pull request can bypass it wholesale by adding `if: ${{ false }}` to the
job. `gate` needs every other job, runs `if: always()`, and fails unless each
one reported literally `success` — skipped, cancelled and failed are all red
there. One required check, and it cannot be skipped into a pass.

The gates count rather than trust an exit code, because a runner that collected
zero tests exits 0 just like one that passed 315:

- Per-project floors live in `.github/ci-manifest.json`. Every workspace pnpm
  resolves must be enrolled there with a floor, or exempted with a written
  reason; a new package that has no tests fails the build instead of hiding
  inside a global count. Adding tests means raising a floor — a deliberate,
  reviewable edit.
- **Floors ratchet up.** `assert-floor-ratchet.mjs` reads the same manifest from
  `origin/main` and fails if any floor here is lower, including the quiet
  version where an enrolled workspace is demoted to `exempt`. A decrease needs a
  written justification keyed to exactly what came down, and a justification
  that matches no actual decrease fails too — nobody pre-authorises next month's
  cut. Until a manifest exists on `main` the script says `no baseline` out loud
  and checks only that every floor is at least 1.
- Skipped, todo and *expected-failure* tests all fail the gate. That last one is
  invisible in the stock reports: Vitest records `it.fails()` as `passed` with an
  empty `failureMessages`, and Playwright records `test.fail()` as `expected`,
  i.e. green. Because the stock Vitest report genuinely cannot witness `fails` at
  any level of effort, `scan-expected-failures.mjs` provides a second witness
  from outside the reporting path: it parses the test sources and counts the
  annotations itself. A reporter that lied about the flag while keeping every
  total honest is caught by the two witnesses disagreeing.
- That scanner **parses**, and it starts from the test glob rather than from the
  report. Both matter. A line-oriented matcher cannot see
  `test.each([...]).fails(...)`, `it['fails']`, `it?.fails`, a chain spread over
  three lines, or an annotation aliased into a helper — and it fires on
  `it('rejects it.fails', …)`, which is prose. Reading the TypeScript AST fixes
  both directions at once: `.fails` counts when it is a member access rooted at a
  test runner, however it is spelled, and a string that merely contains the text
  is not one. And because the scan starts from every `*.{test,spec}.*` on disk
  and follows relative imports transitively, an annotation living in a helper —
  a file no report will ever name — is still read. Fifteen spellings and four
  lookalikes are fixtures in `gate-selftest.mjs`.
- **Prerequisites are enforced as pairs.** A gate can be present, named, invoked
  and useless because the step it depends on is gone. `assert-floor-ratchet.mjs`
  is the case: without the `git fetch` of `origin/main` before it, the shallow
  clone has no baseline, so the ratchet reports "no baseline" and exits 0 — a
  floor lowered in the same pull request sails through. So required steps declare
  their setup, and `required-step-prerequisites` fails the build unless the
  prerequisite is in the same job *and earlier*. Nine pairs across eight steps:
  the ratchet's fetch of `origin/main`; both report resets, before the runs they
  reset for; both report gates, after those runs; the migration's wait for
  Postgres and the schema assertion's migration; and the browser install and
  browser check the Playwright suite needs. The count is derived —
  `PREREQUISITE_PAIRS.length`, printed by the self-test — because a hand-counted
  number in a receipt is how round 2 claimed 15 rules over an engine with 18.
- The two Vitest reports must describe the same run — every status, the file
  count, and the identity of every individual test, not just the total. Matching
  totals prove little; a gutted reporter cannot invent 315 test names that agree
  file for file with Vitest's own.
- The database is proven by set equality against the schema, derived from
  `@atrium/db`'s built export — a missing table and an unexpected extra one both
  fail.
- Reports are deleted immediately before each runner starts and rejected unless
  their mtime post-dates that moment, so a leftover file cannot stand in for a
  run.
- `scripts/ci/workflow-policy.mjs` enforces 22 house rules over the parsed
  workflow: no `continue-on-error`, no job conditions, no step conditions beyond
  `failure()` on an artifact upload, no shell overrides, no step timeouts, every
  action pinned to a commit SHA, no reusable workflows (a job body that is not in
  the file cannot be checked by anything in the file), `gate.needs` covering every
  job, and — self-referentially — `verify` and `e2e` still *containing* the steps
  that do the checking, each assert script named and each one's setup ordered
  before it. `actionlint` runs alongside it.
- Both self-tests run in CI. `workflow-policy-selftest.mjs` feeds the policy 46
  mutated copies of the real workflow and additionally asserts that every one of
  the 22 declared rules has a mutation proving it fires — coverage derived from
  the engine's own rule list rather than counted by hand, which is how four rules
  went unexercised through round 2. `gate-selftest.mjs` runs 58 cases, including
  extracting the `gate` job's verdict script from the workflow and **executing
  it** against synthetic `needs` payloads: a parser reads shapes, and a shape can
  be right while the logic is wrong.

### Governance trigger (recorded)

Branch rulesets are deliberately **not** enabled while this is a solo repo:
merges happen from the campaign's own train and there is nobody to review a pull
request. `.github/CODEOWNERS` is committed now so the rule has something to
point at.

**Before a second contributor gets write access, or before this repository goes
public — whichever comes first — turn on a ruleset for `main` that requires the
`gate` check, requires a pull request, and requires review from code owners.**
Until then, a workflow edit is validated by the very revision that proposes it,
which is a trust boundary a solo repo can hold and a shared one cannot.

## Notes for the next change

- `design/tokens.css` is a placeholder transcribed from the settled Atrium token
  system recorded in `plans/research-live-call-design-system/`. When the
  `design/tokens` branch lands, replace the file wholesale; the app reads only
  the variables and hardcodes no colour.
- `interpret-message` is registered as a no-op worker. Its idempotency contract
  is already in place: dedup key `${messageId}:${interpretationVersion}` with an
  explicit singleton window, backed by the `(message_id, interpretation_version)`
  unique constraint on `interpretations` (issue #16).
- The WebSocket protocol is a heartbeat + echo placeholder. The real command and
  event contract slots into `handleFrame` without the transport changing.
- Adapter seams (`ConversationSource`, `ExecutionProvider`) are type-only ports
  in `packages/core/src/ports.ts`. No integration ships in v1; the door stays
  open.
