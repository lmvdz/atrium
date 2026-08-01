# Atrium

Understanding-first multiplayer conversation. Three synchronized surfaces —
**Conversation** (what people are saying), **Current state** (what the group now
understands and is committed to), **Needs you** (what specifically requires this
person) — over a semantic core that turns messages into typed, correctable,
provenance-carrying state.

The thesis being tested, from `init.md`: after being absent for several hours,
can a participant understand the situation, the changes, the open questions and
their own responsibilities substantially faster than in Slack?

## What goes wrong now

You step away for four hours. You come back to two hundred messages.

You can read every one of them and still not be able to answer three questions:
what got decided, what is owed and by whom, and what is waiting on you. A
transcript is a record of what was *said*. It has no position on what is *true*.
Nothing in it separates a decision from someone thinking out loud, and nothing
marks the message where last week's decision was quietly reversed.

So you re-read, or you ask, and someone answers a question they already
answered. Every person on the thread pays that cost, every time any of them is
away.

The bet here is that the durable artifact of a conversation should not be the
transcript. It should be a structured, correctable statement of what the group
currently understands and is committed to, with every part of it linked back to
the messages it came from.

**What Atrium is not:** not a Slack replacement, not a bot platform, no voice or
video, and no agent execution in v1. `init.md` draws that boundary deliberately —
v1 is a handful of humans, a few hundred messages, and no autonomous agents.

The nearest familiar thing to this is a memory store: save what was said,
retrieve it later. That is a different product. A store has no opinion about
whether what it saved is true, who is accountable for it, or whether it still
holds — and the moment you need those, deciding what is allowed into the record
stops being an implementation detail and becomes the entire design.

## A claim is not a fact

This is the hard part, and it is why "AI summaries" is the wrong description.

Someone writes: *"yeah that sounds fine, let's go with Postgres."*

Was that a decision? A machine reading says probably. Atrium's answer is to
record the reading and mark what it is. The grammar renders like this:

```
~  decision   Use Postgres for the event log            alex, 14:02  →
```

The `~`, which the design carries as a dotted underline, says: someone said this,
nothing has checked it. The reading is *in* the state, not hidden, but it does
not get to look settled. The arrow is the provenance link — every derived object
points back at the messages it was read from.

It becomes this:

```
✓  decision   Use Postgres for the event log            alex, 14:02  →
```

only when a person accepts it. Not when a confidence score crosses a threshold.
`✓` means checked by something other than whoever claimed it, so a model
reporting its own success can never earn one.

That rule is not a UI convention. `packages/core/src/authority.ts` refuses to
fold an acceptance of a decision by a model actor, and the refusal happens in the
reducer rather than in the layer above it — a boundary enforced only above the
reducer is one that a second writer, or a replay, can walk around. Four more
acts sit at the same floor and are human-only: superseding an accepted decision,
marking a claim verified, every correction, and accepting anything that cites no
proposal at all.

What is left open is as deliberate as what is closed. A model may accept its own
claim and open-question readings, and may withdraw a reading it staged —
throwing away an unaccepted guess destroys nothing.

**Corrections are events, not erasures.** Saying *"that was only a suggestion,
not a decision"* does not delete the decision. It writes a correction that
supersedes it; both stay on the record, and the chain between them is something
you can read. Replay the log and you get the same state back, correction
included.

That is the structural difference from a summary. A summary is regenerated, so a
correction to one lasts exactly until the next generation. Here the correction is
the durable thing.

The full glyph vocabulary — `✓` verified, `~` claim, `?` explicitly unverified,
`·` routine, `◆` needs you — is in
[`design/CONVENTIONS.md`](design/CONVENTIONS.md), along with the invariant it
exists to serve: **a claim never dresses as a fact.**

That is the design. How much of it runs today is the next section, and the
answer is: the enforcement does, the reading that would feed it does not.

## What is actually built

Read this section as the answer to "what could I run today", not "what is
planned".

**On `main`.** `packages/core` is the semantic core: pure TypeScript with no
I/O and no clock, holding five accepted object types (decision, commitment, open
question, claim, objective), typed relations, proposal staging,
corrections-as-events, and a deterministic reducer whose live-and-replay
equivalence is checked property-style over generated logs. The human-only floor
described above is enforced there. `packages/db` has the Drizzle schema and its
first migration. `packages/ingest` turns a real conversation into canonical
JSONL, byte-identically on a rerun; three corpora are committed, the largest 454
messages with 368 reply edges. `design/` holds the token system (51 tokens per
theme, lifted verbatim from the last of six prototype versions) and the rules for
using it. `apps/web` is a Next.js shell that lays out the three regions over
hardcoded fixtures. `apps/server` is one Node process whose WebSocket server is a
heartbeat-and-echo placeholder and whose job queue is real but registers
`interpret-message` as a no-op.

**On branches, under review, not merged.** The realtime ledger
([#22](https://github.com/lmvdz/atrium/issues/22)), auth and workspaces
([#26](https://github.com/lmvdz/atrium/issues/26)), CI
([#28](https://github.com/lmvdz/atrium/issues/28)), a deployment that actually
serves a page ([#40](https://github.com/lmvdz/atrium/issues/40)), the UI
component library and app frame
([#39](https://github.com/lmvdz/atrium/issues/39)), the three-surface
interaction prototype ([#10](https://github.com/lmvdz/atrium/issues/10)), and the
next round of the core engine
([#21](https://github.com/lmvdz/atrium/issues/21)). Each is a branch with an open
ticket and an unfinished review round. None of it is shipped, and there is no
continuous integration on `main` yet — the workflow that would provide it is
itself on a branch.

**Not built at all.** No product code here calls a language model — not on
`main`, not on any branch under review. There is no interpretation job that does
anything, no eval run, no live multiplayer, and no attention computation over
real data. The only model work that has happened is a throwaway spike on a
`research/` branch, which measured how the reading would behave and settled the
pipeline decision; nothing from it ships. The `~`/`✓` grammar above is enforced
in the core and rendered against fixtures — it has never yet marked a machine
reading of a real conversation.

Which means the thesis at the top of this file is still a thesis. It has not been
tested.

## Why it is built this way

**Humans before agents.** If a handful of people and a few hundred messages do
not reorient faster in Atrium than in Slack, agents will not rescue that; they
will only add volume. Agents arrive in phase 4, after the thing they would
accelerate is known to work.

**Postgres, not a custom event store.** Append-only events with recomputable
projections, in an ordinary database. A graph store, an embedding-native store
and a bespoke event log were all considered and rejected: none of them is where
this product's difficulty lives
([#12](https://github.com/lmvdz/atrium/issues/12),
[#11](https://github.com/lmvdz/atrium/issues/11)).

**Server-authoritative WebSockets, not CRDTs.** Messages are append-only and
semantic state changes through server commands, so there is nothing to merge.
Who may change shared understanding is an access-control question, not a
convergence question — and the terminal-multiplexing research found the same
answer in a different field, where every collaborative terminal resolves
concurrent input by access control rather than by merging.

**Borrow the pattern, not the dependency.** The design system, the epistemic
grammar and the attention rules come from six versions of earlier prototyping;
several architectural rules come from reading a comparable system's source and
issue tracker. Both were taken as patterns. Neither was taken as a dependency.

## How the work gets reviewed

The work is charted as a decision graph on
[issue #1](https://github.com/lmvdz/atrium/issues/1): one ticket per open
question, blocking edges between them, and a running list of settled decisions
with the reasoning attached. Nothing gets built from a decision that is not
written there.

Every build ticket then passes a blind review before its branch merges. Critics
get the artifact and the repository but never the builder's conversation, and
they are drawn from different model lineages so their blind spots do not line up.
The largest real gap goes back for another round. Some tickets are on their
tenth.

Two examples of what that catches, because they explain why the tree above is as
unfinished as it is.

A guard was written to check that a machine-minted commitment was supported by
the message it cited, by measuring word overlap between the two. `not` was on the
stopword list. The quote *"Bob will not deploy production Friday"* scored 100%
support for the commitment *"Bob will deploy production Friday"* — long, verbatim,
correctly attributed, auto-accepted, every check reporting success.

In the interaction prototype, the composer affordance labelled *"your next
message resolves it — nothing is inferred"* recorded the opposite of what the
user typed. A critic reading the source missed it. A critic who actually clicked
through the page found it in three clicks.

A critic's finding is a hypothesis, not a verdict, and each one is checked
against the code before it is acted on; the log records one that was wrong, whose
suggested fix would itself have broken a working healthcheck. Every closed ticket
appends what its rounds caught to [`RETRO.md`](RETRO.md) — no entry, no close.
That file is this project's record of its own errors, and it is the most useful
thing in the repository for deciding whether to believe the rest of it.

## Where the decisions are written down

- [`init.md`](init.md) — the product bible: what to build from scratch, what to
  reuse, what to defer, and the five-phase sequence.
- [Issue #1](https://github.com/lmvdz/atrium/issues/1) — the map. Every settled
  decision, one line each, linked to the ticket that argued it. Start here for
  *why* rather than *what*.
- [`RETRO.md`](RETRO.md) — what the process got wrong, per ticket, kept so
  decisions are made against evidence rather than memory.
- [`design/CONVENTIONS.md`](design/CONVENTIONS.md) — the token system, the
  epistemic glyphs, and the measured contrast floors, as an operating manual.
- [`plans/`](plans/) — the research briefs the decisions were made from: the
  design lineage, a competitive read, and the terminal-multiplexing landscape.

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
| `pnpm test` | Vitest across `packages/*` |
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
