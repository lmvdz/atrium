# Research: Postgres-backed job queue (ticket #16)

Resolves the "custom job queue: No" / "A PostgreSQL-backed job queue" line items in `init.md`
(Infrastructure orchestration, and the recommended greenfield stack). Scope: pick a library (or
confirm hand-rolling) for two workloads — an interpretation job per chat message (LLM call,
seconds-long, retryable) and periodic projection rebuilds — at modest scale (5 humans, hundreds
of messages), where correctness (at-least-once + idempotency, backoff, no lost jobs, observable
failures) matters more than raw throughput.

## Sources

- [graphile-worker README](https://raw.githubusercontent.com/graphile/worker/main/README.md) (npm `graphile-worker`, current version 0.17.3, published ~22 days before 2026-07-31)
- [Graphile Worker docs — Requirements](https://worker.graphile.org/docs/requirements)
- [Graphile Worker docs — Job key](https://worker.graphile.org/docs/job-key)
- [Graphile Worker docs — Exponential backoff](https://worker.graphile.org/docs/exponential-backoff)
- [Graphile Worker docs — Performance](https://worker.graphile.org/docs/performance) / [website/docs/performance.md](https://github.com/graphile/worker/blob/main/website/docs/performance.md)
- [Graphile Worker docs — Database schema](https://worker.graphile.org/docs/schema)
- GitHub API: `api.github.com/repos/graphile/worker` — 2,350 stars, 44 open issues, last push 2026-07-08, not archived (fetched 2026-07-31)
- [pg-boss docs site](https://timgit.github.io/pg-boss/)
- [pg-boss README](https://raw.githubusercontent.com/timgit/pg-boss/master/README.md) (npm `pg-boss`, current version 12.26.3, released 2026-07-24)
- GitHub API: `api.github.com/repos/timgit/pg-boss` — 3,817 stars, 28 open issues, last push 2026-07-29, not archived (fetched 2026-07-31)
- [timgit/pg-boss releases](https://github.com/timgit/pg-boss/releases)
- [pg-boss in production: footguns we hit and how to avoid them — AGLedger](https://agledger.ai/blog/pg-boss-production-lessons/)
- [PGMQ (Tembo) GitHub](https://github.com/pgmq/pgmq) — Rust Postgres extension, latest 1.11.1 (2026-04-19)
- [Absurd Workflows — Armin Ronacher, Nov 2025 announcement, April 2026 hardening update](https://lucumr.pocoo.org/) (via search; TypeScript SDK still marked "early experiment, not production-ready" as of the sources found)
- [Durable Queue Workers With Just Postgres — mfyz.com](https://mfyz.com/durable-queue-workers-with-just-postgres/)
- [I Removed Redis From My Stack and Used PostgreSQL for Job Queues Instead — dev.to](https://dev.to/aws-builders/i-removed-redis-from-my-stack-and-used-postgresql-for-job-queues-instead-2lp5)
- npm/registry summaries for `graphile-worker` and `pg-boss` weekly download counts (pg-boss ~754k/week, graphile-worker ~260k/week, per npmtrends/debricked comparisons surfaced 2026-07-31)

All facts below were cross-checked against at least two of the above where the search tool's
summary was ambiguous; version/date/star numbers came directly from the GitHub API or npm, not
from a summarizer.

## Candidates evaluated

### 1. graphile-worker

- **What it is**: A Node.js worker that polls/subscribes to a jobs table it owns inside its own
  `graphile_worker` Postgres schema. SQL-centric API — you can `SELECT graphile_worker.add_job(...)`
  directly from triggers/functions, or call `addJob()` from Node.
- **Throughput**: Uses `SELECT ... FOR UPDATE SKIP LOCKED` plus `LISTEN/NOTIFY` so a newly queued
  trivial job can be claimed and start executing in roughly 2-3ms. Reported benchmarks vary
  widely by hardware/config — from the low hundreds of jobs/sec on constrained postgres before
  lock contention, up to ~11,850 jobs/sec on a 12-core box with 4 worker processes and
  concurrency 10; raw job insertion from a single client was measured around 172,000/sec. For
  this workload (hundreds of messages, one interpretation job each) any of these numbers are
  wildly over-provisioned — throughput is not a differentiator here.
- **Retry/backoff**: Exponential backoff built in, formula `exp(least(10, attempt))` seconds,
  default max 25 attempts spread over roughly 3 days, capping at retries every ~6 hours after
  the 10th attempt. Configurable per-task.
- **Scheduled/delayed jobs**: `runAt` for delayed jobs; a `graphile-worker` cron-like scheduling
  file (crontab-style) for periodic jobs — a natural fit for periodic projection rebuilds.
- **Batching**: Native batch jobs (aggregate multiple queued items into a single execution) added
  in 0.14, plus a "local queue" mode that can raise high-throughput scenarios by an order of
  magnitude by reducing round trips — irrelevant at this scale but free if scale grows.
- **Idempotency/dedup primitive**: First-class `job_key` (a string you supply) with
  `job_key_mode`:
  - `replace` (default) — overwrites an unlocked job with the same key; used for
    reschedule/debounce.
  - `preserve_run_at` — overwrites but keeps the original `run_at`; used for throttling.
  - `unsafe_dedupe` — if a job with that key exists (even locked/permanently failed), the new
    add is a no-op; single-job-at-a-time only (not in `add_jobs` batch form).
  This is a genuine "insert a job with this natural key or no-op" primitive, not just a
  post-hoc uniqueness constraint bolted on by the caller.
- **Observability**: Structured logging via a pluggable logger; an official plugin/events system;
  a paid "Pro" tier adds crash recovery and a live dashboard, but the free core exposes enough
  hooks (task success/failure events, `run_at`, `attempts`, `last_error` columns queryable via
  plain SQL) to build alerting directly against Postgres.
- **Drizzle/schema coexistence**: Deliberately isolates itself in the `graphile_worker` schema
  and self-manages its own migrations (creates/upgrades on startup based on whether its
  migrations table exists). Drizzle continues to own the app schema and its own migration
  history; the two do not intersect. If you don't want the worker's Postgres role to have
  `CREATE SCHEMA` rights, you can pre-create the schema yourself.
- **Maintenance**: Actively maintained — last push 2026-07-08, healthy but smaller community
  (2,350 stars, ~260k weekly downloads) than pg-boss. SQL-first API is a better fit for teams
  that want to reason about the queue as Postgres state (matches Atrium's "PostgreSQL as system
  of record" posture from init.md) but has a steeper API for a small TypeScript-only team since
  a meaningful share of its surface is exposed as SQL functions rather than a JS-first client.

### 2. pg-boss

- **What it is**: A JS/TS-native client library on top of a `pgboss` schema it creates and
  migrates automatically on first connect — no separate binary/daemon, just an npm dependency
  used from the same Node process (or a dedicated worker process).
- **Throughput**: Polling workers with backpressure, with optional `LISTEN/NOTIFY` to cut
  dispatch latency for low-volume cases without paying full poll-interval latency. No official
  headline benchmark as prominent as graphile-worker's, but `SKIP LOCKED` gives the same
  no-lock-contention claiming guarantee. Entirely sufficient for hundreds of messages/day.
- **Retry/backoff**: Native "automatic retries with exponential backoff," configurable
  `retryLimit`, `retryDelay`, and `retryBackoff` per queue, plus dead-letter queues with a
  redrive (re-run) mechanism — directly useful for "observable failures" since failed jobs land
  somewhere durable and inspectable rather than just being logged and dropped.
- **Scheduled/delayed jobs**: `startAfter` for one-off delays; a built-in `schedule()` API using
  cron syntax for recurring jobs — again a direct fit for periodic projection rebuilds.
- **Batching**: `work()`/`fetch()` support a `batchSize` option to pull and hand off multiple
  jobs per invocation (note: pg-boss's batch semantics fail the *whole* batch if any one job
  throws, so batches are best used for homogeneous, cheaply-retryable work rather than mixed
  job types).
- **Idempotency/dedup primitive**: `singletonKey` restricts a queue to at most one queued/active
  job per key; combined with `singletonSeconds`/`singletonMinutes`/`singletonHours` (or
  `useSingletonQueue`) it becomes a dedup/debounce window. Caveat found in production
  write-ups: if you call `send()` with a `singletonKey` against a policy that doesn't set a
  window, dedup silently does not happen and you get a duplicate job back with no error — the
  dedup contract has to be configured deliberately, it isn't automatic just by passing a key.
  This is a real footgun to design around explicitly (see recommendation below).
- **Observability**: Emits Node `EventEmitter`-style events (`error`, state-change events);
  ships an official `@pg-boss/dashboard` package for a web UI over queues/jobs/schedules, plus
  a `pgboss.job` table and job-state history queryable directly via SQL/Drizzle for custom
  dashboards or alerts.
- **Drizzle/schema coexistence**: Manages its own `pgboss` schema (name configurable) and runs
  its own migrations transparently on startup; ships first-party adapters for Drizzle, Knex,
  Kysely, and Prisma so a job can be enqueued *inside the same transaction* as the Drizzle write
  that created the triggering row (e.g., insert the chat message and enqueue its interpretation
  job atomically) — this is a meaningfully stronger coexistence story than "just don't collide
  schemas," because it closes the classic "committed the row but the enqueue call failed/crashed"
  gap without needing an outbox pattern.
- **Maintenance**: Most actively maintained option found — last push 2026-07-29 (yesterday
  relative to this research), release 12.26.3 six days prior, 3,817 stars, ~754k weekly npm
  downloads (roughly 3x graphile-worker's), Node 22.12+ / Postgres 13+ required. Larger
  community, more Stack Overflow/blog coverage of production footguns (a maturity signal, not
  a red flag).

### 3. PGMQ (Tembo)

- **What it is**: A Rust Postgres *extension* (not a pure-SQL/Node library) implementing an
  SQS-like primitive: `send`, `read` (with visibility timeout), `delete`/`archive`, batch
  read. Latest release 1.11.1 (2026-04-19), actively maintained, no background worker of its
  own required to run.
- **Why it's not a fit here**: It's a low-level message-queue primitive, not a job runner — no
  built-in retry/backoff policy, no cron/scheduled jobs, no job-key dedup, and it requires the
  extension to be installed and enabled on the Postgres instance (a hosting-provider dependency
  most managed Postgres providers support, but it's an extra deployment constraint Atrium's
  "practical initial stack" doesn't need to take on). You'd end up hand-building the retry,
  backoff, and idempotency layer on top of it anyway — at which point it's not meaningfully less
  work than the hand-rolled baseline below, minus the LISTEN/NOTIFY low-latency dispatch. Ruled
  out for this ticket.

### 4. Absurd (Armin Ronacher) — noted, not evaluated further

Surfaced in research as a newer (announced Nov 2025) Postgres-only durable-execution/workflow
engine with a TypeScript SDK, actively hardened through April 2026 (claim handling, watchdogs,
leases, a dashboard). Every source found still describes its TS SDK as an early experiment, not
production-ready as of mid-2026. Worth revisiting later if Atrium ever needs true multi-step
durable workflows (not just single retryable jobs), but it fails the "credible, current, active"
bar for a production dependency today. Not recommended.

### 5. Hand-rolled LISTEN/NOTIFY + SKIP LOCKED (build-it-yourself baseline)

The pattern: a `jobs` table with `status`/`run_at`/`attempts` columns; workers
`SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` inside a transaction to claim rows without blocking
each other, process, then update status; `LISTEN`/`NOTIFY` on a channel to wake idle workers
immediately instead of relying purely on a poll interval.

This is a legitimate, well-understood pattern (both graphile-worker and pg-boss are built on
exactly this primitive under the hood) — but "build it yourself" means re-deriving, by hand, all
of the following that the two libraries already give for free:

- Crash recovery: a worker that claims a row and then dies (process crash, OOM, deploy) leaves
  the row `FOR UPDATE`-locked only for the duration of that transaction — if you commit "claimed"
  as a status change and then crash before finishing, that job is stuck forever unless you also
  build a stale-claim sweeper with a timeout. Both libraries implement this already.
- Exponential backoff with jitter, and a cap on total attempts before dead-lettering.
- A `NOTIFY` payload size limit (8000 bytes) and reconnect/backpressure handling for the
  `LISTEN` connection when it drops.
- A migration story for the jobs table itself as requirements evolve (new columns, indexes for
  the `run_at`/`status` polling query as volume grows).
- Idempotency/dedup primitives (natural-key uniqueness with correct locked-row semantics) —
  easy to get subtly wrong (e.g., a naive `ON CONFLICT DO NOTHING` on an active/queued unique
  index does not compose cleanly with "retry this job" without careful state-machine design).
- Observability: job history, failure reasons, a way to see what's stuck without hand-writing
  every query.

None of this is exotic, but it is exactly the "difficult security and systems-engineering
problem you re-derive instead of adopt" pattern init.md explicitly warns against for
authentication, realtime transport, etc. — the same logic applies here. For a 5-person, hundreds-
of-messages-scale product where correctness (no lost jobs, retried failures, observable state) is
the explicit priority over raw throughput, hand-rolling buys nothing but risk: it is more
error-prone in exactly the dimensions (crash recovery, backoff correctness, dedup semantics) that
matter most, for zero performance upside at this scale. **Rejected as the primary implementation**,
though understanding it is what lets you read and trust what pg-boss is doing under the hood.

## Comparison summary

| | graphile-worker | pg-boss | PGMQ | hand-rolled |
|---|---|---|---|---|
| API style | SQL-first, Node wrapper | JS/TS-native client | SQL extension primitive | fully custom |
| Retry/backoff | built-in, exponential, configurable | built-in, exponential, configurable, DLQ+redrive | none (build yourself) | build yourself |
| Cron/scheduled jobs | yes (crontab-style file) | yes (`schedule()`, cron syntax) | no | build yourself |
| Batching | yes (batch jobs, local-queue mode) | yes (`batchSize`, all-or-nothing failure) | yes (batch read) | build yourself |
| Dedup/idempotency primitive | `job_key` + `job_key_mode` (incl. `unsafe_dedupe`) | `singletonKey` + time window (silent no-op footgun if misconfigured) | none | build yourself |
| Transactional enqueue w/ Drizzle | via SQL function call, same tx possible | first-party Drizzle adapter, same-tx enqueue | possible via raw SQL, same tx | build yourself |
| Schema coexistence | own `graphile_worker` schema, self-migrating | own `pgboss` schema (configurable), self-migrating | requires extension install | you design it |
| Observability | logger hooks, SQL-queryable state, paid dashboard | events + SQL-queryable state + free `@pg-boss/dashboard` | SQL-queryable only | build yourself |
| Last push (as of 2026-07-31) | 2026-07-08 | 2026-07-29 | 2026-04-19 (extension release) | n/a |
| Stars / weekly downloads | 2,350 / ~260k | 3,817 / ~754k | n/a (extension) | n/a |
| Requires extra Postgres extension | no | no | yes | no |

## Recommendation

**Adopt pg-boss.**

Rationale, weighted against the stated priorities (correctness, at-least-once + idempotency,
retry/backoff, no lost jobs, observable failures) over raw throughput, at 5-human/hundreds-of-
messages scale:

1. **JS/TS-native fits the stack better than SQL-first.** graphile-worker's SQL-function-centric
   API is a fine choice for a Postgres-heavy team, but Atrium's stack (init.md: TypeScript, Node,
   Drizzle) is application-code-first. pg-boss's client is idiomatic TS with first-party Drizzle
   transaction adapters — enqueuing a message's interpretation job in the *same Drizzle
   transaction* that inserts the message row is the cleanest way to guarantee "no lost jobs" (no
   separate enqueue step that can fail after the message commits).
2. **More actively maintained by every signal checked**: last push one day before this research
   (vs. three weeks for graphile-worker), ~3x the weekly downloads, more stars, larger issue/PR
   volume indicating a bigger user base finding and reporting edge cases (which is what surfaced
   the `singletonKey` footgun documented below — better to inherit a known, documented gotcha than
   an unknown one).
3. **Dead-letter queues with redrive** give a concrete, built-in answer to "observable failures":
   a permanently-failed interpretation job doesn't just get logged and forgotten, it lands in a
   durable, queryable, re-runnable state.
4. **No extra Postgres extension required** (unlike PGMQ), so no dependency on managed-Postgres
   provider extension allowlists — matches init.md's "one database, no exotic infra" mandate.
5. **Cron-based `schedule()`** covers the periodic projection-rebuild workload with no extra
   moving parts (no separate cron daemon).

graphile-worker remains a credible second choice — its `job_key_mode: unsafe_dedupe` is arguably
a cleaner, less footgun-prone dedup primitive than pg-boss's `singletonKey` + window combination,
and its SQL-first design means jobs can be enqueued directly from Postgres triggers if the
projection-rebuild trigger ever needs to originate from a DB-level event rather than app code.
If pg-boss's dedup behavior proves too easy to misconfigure in practice, revisit graphile-worker;
don't hand-roll a replacement.

### Idempotency pattern for per-message interpretation jobs

Dedup key: `message_id + interpretation_version` (matches the ticket's stated key). Recommended
implementation, layering pg-boss's primitive under an explicit application-level guarantee rather
than relying on `singletonKey` alone (given the documented silent-no-op footgun when the window
isn't set deliberately):

1. **Enqueue inside the same Drizzle transaction as the message write.** After inserting the
   chat message row, call `pgBoss.send()` (via the Drizzle transaction adapter) with:
   - `queue: 'interpret-message'`
   - `data: { messageId, interpretationVersion }`
   - `singletonKey: \`${messageId}:${interpretationVersion}\``
   - an explicit `singletonSeconds` (or `useSingletonQueue: true`) set large enough to cover the
     job's full queued+retrying lifetime (e.g., a few hours, comfortably longer than the retry
     window) — this closes the silent-no-op gap: with an explicit window configured, a duplicate
     `send()` for the same message+version reliably returns "already queued/active" instead of
     silently creating a second job under a misconfigured default.
   Committing the enqueue in the same transaction as the message insert means a crash between
   "message written" and "job enqueued" is impossible — either both happen or neither does.
2. **Belt-and-suspenders application-level idempotency**, independent of the queue library, so
   correctness doesn't depend solely on pg-boss's dedup config being right forever:
   - The `interpretations` (or equivalent semantic-proposal) table carries a **unique constraint
     on `(message_id, interpretation_version)`**. The job handler always upserts
     (`INSERT ... ON CONFLICT (message_id, interpretation_version) DO NOTHING` or `DO UPDATE`
     with a monotonic-write guard) rather than assuming it's the only writer for that key. This
     is what actually delivers "at-least-once with idempotency" per the ticket's requirement —
     the queue guarantees the job *runs*, the DB constraint guarantees running it twice (retry
     after partial failure, redrive from the DLQ, a future duplicate enqueue from a code bug)
     produces the same end state, not duplicate rows or duplicate side effects.
   - If the interpretation step calls an LLM and then performs a *side-effecting* write (e.g.,
     applying accepted state to the semantic core), gate that write behind the same
     `(message_id, interpretation_version)` uniqueness check inside a single DB transaction, so a
     retried job that re-runs the LLM call (unavoidable — LLM calls aren't idempotent to retry
     mid-flight) still only ever commits its result once.
   - `interpretation_version` should be bumped explicitly whenever the interpretation logic
     changes in a way that should reprocess history (matches init.md's "avoid repeatedly making
     the same interpretation error" correction requirement) — old `(message_id, old_version)`
     rows stay as provenance rather than being overwritten, and a new version is a new dedup key,
     not a conflict with the old one.
3. **Retry/backoff config**: set pg-boss's `retryLimit`/`retryBackoff` per queue to a small number
   of attempts (LLM calls are the failure-prone step; a stuck provider outage shouldn't retry
   forever) with a short exponential backoff, and route exhausted retries to the dead-letter queue
   for human/alert visibility — satisfies "observable failures" directly without extra tooling.
4. **Projection rebuilds**: a separate `schedule()`-driven queue (own retry/backoff policy, since
   a failed rebuild is lower-urgency than a failed interpretation) reading from the same durable
   `interpretations`/accepted-state tables — no coordination needed with the per-message queue
   beyond both being ordinary Postgres readers/writers.
