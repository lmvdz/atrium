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

The other half of the invariant is the ledger's, and
[#22](https://github.com/lmvdz/atrium/issues/22) ships it: the durable log
contains only events accepted in canonical order, because an out-of-order event
is rejected at the command layer and never persisted. Rejected events enter
neither state nor log, so the two sides are folding the same sequence rather
than being reconciled after the fact. See **The durable ledger** below.

`CoreState.watermarks` still records each room's last consumed position — that
is what `core_events.room_seq` maps onto — but the gate is the global `cursor`,
because `issues`, `corrections` and `consumedEventIds` are global ordered lists
and a per-room gate would let two rooms interleave them one way live and another
way on replay.

### The durable ledger

`core_events` is the append-only spine, and everything in the semantic layer —
messages, accepted objects, relations, attention, corrections — is a projection
of it, written in the same transaction as the append.

It carries **two** sequences, which is how #22 resolved the design point #19's
gauntlet left open:

- **`seq`** — `bigserial`, primary key, a total order **across rooms**. Core
  state gates on a global cursor, so the ledger owes it a global order. The
  alternative was sharding core state per room; that was rejected because it
  would split `corrections` and `issues` into per-room lists to buy an
  independence the product does not have.
- **`room_seq`** — the per-room client protocol. `UNIQUE(room_id, room_seq)`
  plus serialized assignment makes it gap-free and duplicate-free, which is what
  lets `since(room, room_seq)` recover a byte-identical history after a dropped
  socket.

Appends serialize on a transaction-scoped Postgres advisory lock, so `seq` order
and the canonical `(at, id)` order are the same order by construction rather
than by luck. There is no status column and no quarantine table: a refused event
aborts the transaction and leaves no row, no sequence number, and no gap.

**`seq` may gap; `room_seq` may not.** `seq` is a `bigserial` and a sequence does
not roll back, so an aborted append burns its number forever. That is fine, and
it is deliberately not claimed otherwise — `seq` is a total *order*, not a
census, and nothing counts it. `room_seq` is minted `max + 1` under the append
lock inside the same transaction, so an aborted append gives its number straight
back. Only the per-room sequence is advertised as gap-free, and only it is what
`since(room, room_seq)` walks.

**Nothing appends by convention.** `atrium_append_core_event(...)` is the only
way a row reaches `core_events`: it takes the lock, mints `room_seq` under it,
and inserts. A `BEFORE INSERT` trigger reads its own plpgsql call stack and
refuses any insert that did not come through that function, then refuses again
if the lock is not actually held. A `REVOKE` alone would not do — the app role
owns the table, and under the compose Postgres image it is also a superuser, and
neither is bound by one. The revoke is there too, for a deployment that runs the
app under a dedicated unprivileged role: that role needs `EXECUTE` on the
function and nothing else. The integration suite proves the trigger by trying a
direct insert *as the superuser owner* and being refused, and it appends through
the same procedure the server does — there is no test-only write path.

The honest limit: a role with `CREATE` privilege could define a function with
the same name and satisfy the stack check. It would still be refused by the lock
assertion, and anyone with that privilege can drop the trigger anyway. The guard
is aimed at the accident — the migration, the fix-up script, the well-meant
backfill — not at a DBA determined to lie to the log.

A command validates membership, folds through `appendEvent` **inside** the
transaction that inserts, writes its projections there too, and only then
broadcasts `(room, room_seq)`. Membership is re-read inside that transaction
with the row locked: the check before it is a cheap early refusal, but a
membership revoked in between must not be able to write durable history.
Presence and typing skip all of it — they are transient frames, never rows, and
an integration test floods them and asserts the ledger gained nothing.

Rooms are the isolation boundary, so every reference that could cross one is a
composite `(room_id, id)` foreign key rather than a bare-id one. A plain FK
checks that a row exists; only the composite one checks that it exists *in this
room*. `attention_items` is the polymorphic case: its subject is an accepted
object *or* a proposal (a `needs_decision` item names the proposal nobody has
ruled on yet), so `subject_kind` is projected into two generated columns, each
carrying its own composite FK. Exactly one is non-null per row, and it is the
one the discriminator names — by construction, not by a check to keep in step.

### Catch-up, and what is multi-instance-safe

A client's only cursor is `room_seq`. On reconnect — or on any gap in live
delivery — it asks `since(room, room_seq)` and applies what it is given, in
order, never twice.

Catch-up is a **loop**, not a call. The server answers with the page *and* the
head it was read against, from one snapshot, and says `more` exactly when
`to < head`. The client keeps asking while its own cursor is behind the head it
was told about, treating `more` as a hint on top of its own arithmetic rather
than as the authority. (Page fullness is not the question and never was: during
concurrent writes a page comes back short of the limit while the head has
already moved.)

Delivery across processes is Postgres `LISTEN`/`NOTIFY` — no Redis, per init.md.
A commit is announced on a channel; every instance folds the rows it has not
seen, into its own `CoreState`, and fans them out to its own subscribers. The
notification is a doorbell and never a payload: the rows come from the ledger,
which is where the receiver has to read them anyway.

**And the doorbell is an optimization, never the delivery path.** `NOTIFY` is
at-most-once — it is lost on a listener disconnect and on a rolled-back
transaction — so an instance that only ever acted on notifications would strand
its subscribers the first time one went missing, with no gap for a client to
notice and therefore no reason for it to ask. So the doorbell decides *when*
delivery happens and never *whether*:

- **The bell rings from inside the database.** `pg_notify` is emitted by
  `atrium_append_core_event`, not by the application, so no writer can insert a
  row silently — including one that is not this application.
- **Every instance reconciles on a timer** (`apps/server/src/reconciler.ts`),
  folding and fanning out anything durable it has not seen, and telling each
  subscribed room its head when that head moves past what its subscribers were
  told. The second half covers a different loss: a row this instance *did* fold
  and broadcast, whose frame one particular socket dropped.
- **A resubscribe reconciles immediately.** postgres-js re-establishes `LISTEN`
  after a dropped connection; everything that landed while this process was deaf
  produced a notification nobody received, so the only correct response is to go
  and look.

What that does and does not buy, stated plainly:

| | multi-instance safe? |
| --- | --- |
| Durable history and ordering | **Yes.** The advisory lock is taken in Postgres and asserted by a trigger, so appends serialize across every process on the database, not just within one. |
| Live event delivery | **Yes.** A second instance's commits reach the first instance's subscribers, and each instance folds them into its own core state. |
| Catch-up and recovery | **Yes.** `since(room, room_seq)` reads the ledger; any instance can answer it. |
| Presence and typing | **Yes, as a relay.** Frames are forwarded on a second channel. There is no shared presence *registry*: each instance knows who is connected to it, and learns about everyone else only from the updates they send. An instance that starts mid-session sees nobody until they next say something. |
| Notification delivery | **Best-effort, and nothing depends on it.** An instance disconnected when a NOTIFY fires never sees it; the reconciler folds and fans out those rows on its next pass, and on the listener's resubscribe. A lost doorbell costs latency, never delivery — `integration/server/reconcile.test.ts` severs a listener mid-run and asserts convergence with no client command at all. |
| Writing around the app | **Refused.** `atrium_append_core_event` is the only way a row reaches `core_events`; `EXECUTE` on it is granted to the application role and revoked from `PUBLIC`, it authorizes a human actor's membership inside the transaction, and it refuses anything that does not sort strictly after the ledger's canonical cursor. A privileged operator who disables triggers (`session_replication_role`, `pg_restore --disable-triggers`) is out of scope and the migration says so. |
| Throughput | **Bounded by the global append lock**, deliberately. Appends serialize instance-wide *and* across instances, because core state is global. init.md prescribes one application server; if that stops being true, the fix is to shard core state per room, not to weaken the lock while the state stays global. |

`docker-compose.yml` still runs exactly one `server`. That is a capacity
decision now, not a correctness one — which is the change this round made.

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
| `pnpm test` | Vitest unit suite across `packages/*` and `apps/*` (no database needed) |
| `pnpm test:integration` | Real-Postgres suite: brings up the compose service, applies migrations, runs, tears down |
| `node mutants/run.mjs` | Run the realtime layer's mutant ledger and rewrite `mutants/RESULTS.md` |
| `pnpm ingest <source>` | Fetch a conversation into `corpora/` (see Replay ingest) |
| `pnpm test:e2e` | Playwright smoke test in `apps/web` |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome with safe fixes applied |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm infra:up` / `infra:down` | Postgres + MinIO only |

`pnpm test:integration` needs Docker and nothing else — it starts the
`postgres-test` service from `docker-compose.test.yml` under its own compose
project (so it can never touch the database `pnpm dev` is using), applies the
real migrations from `packages/db/drizzle`, runs the suite, and tears the
container down. `--keep` leaves it running; `ATRIUM_TEST_DATABASE_URL=...` points
it at a database you already have and skips compose entirely. There is
deliberately no in-suite skip: without a database it exits non-zero, because a
test that goes green when its dependency is missing turns a verification gate
into decoration.

`pnpm lint` used to have a gotcha worth knowing about, and it is fixed: Biome's
ignore list said `!**/.claude`, which Biome matches against the *absolute* path,
so a checkout made inside `.claude/worktrees/` reported "no files were
processed" and exited successfully having linted nothing. It now says
`!.claude`, which matches the repo-root directory only, and lint runs for real
inside a worktree checkout.

### Mutation evidence

Both `packages/core/mutants/` and `mutants/` hold a committed, re-runnable
mutant ledger, because of a standing rule this campaign adopted after #21's
round-2 gauntlet: **a mutation claim ships with a runnable mutant list and its
results, or it is not evidence.** A number in a write-up that nobody can execute
is a number, not a receipt.

```
node mutants/run.mjs                # run all, rewrite RESULTS.md
node mutants/run.mjs --check        # …and exit 1 if any mutant survives
node mutants/run.mjs --suite unit   # skip the half that needs a database
```

The integration mutants need `ATRIUM_TEST_DATABASE_URL` pointing at a migrated
Postgres — `./scripts/integration-test.sh --keep` leaves one running. There is no
skip: a run that quietly covered half the ledger would be the same class of
false receipt the ledger exists to prevent.

Half of what #22 fixed lives in SQL, so half the mutants are SQL, applied to the
live database and undone by re-executing statements **extracted from the
migration file itself**. Migrations are journalled, so editing an applied one
demonstrates nothing; and a restore built from a copied string could re-deploy
something this repo does not ship.

`mutants/ledger.test.ts` runs in the ordinary suite and fails if a mutant's
`find` has drifted out of the code, or if a `catches` entry names a test that
does not exist — the two ways a ledger like this goes on printing ticks for
substitutions that describe nothing.

Playwright needs its browser once: `pnpm --filter @atrium/web exec playwright
install chromium`. Without it the smoke test skips with a reason instead of
failing — a red e2e run should mean "the app is broken", never "no browser
here".

## Notes for the next change

- `design/tokens.css` is a placeholder transcribed from the settled Atrium token
  system recorded in `plans/research-live-call-design-system/`. When the
  `design/tokens` branch lands, replace the file wholesale; the app reads only
  the variables and hardcodes no colour.
- `interpret-message` is registered as a no-op worker. Its idempotency contract
  is already in place: dedup key `${messageId}:${interpretationVersion}` with an
  explicit singleton window, backed by the `(message_id, interpretation_version)`
  unique constraint on `interpretations` (issue #16).
- The WebSocket protocol is real (#22): `subscribe` / `since` / `command`
  in, `(room, room_seq)`-tagged events out. Identity at the upgrade is the #26
  stub in `apps/server/src/session.ts` — the *seam* is real and membership is
  checked against the database per command; only the "who is this socket"
  half is placeholder.
- The client's WebSocket URL is resolved at runtime, never baked. Same-origin
  `/ws` by default; `ATRIUM_WS_URL` is read per request by the `force-dynamic`
  route at `apps/web/app/api/runtime-config/route.ts`. A unit test asserts that
  nothing under `apps/web/src` ever reads a `NEXT_PUBLIC_*` variable again.
- Adapter seams (`ConversationSource`, `ExecutionProvider`) are type-only ports
  in `packages/core/src/ports.ts`. No integration ships in v1; the door stays
  open.
