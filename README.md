# Atrium

You step away for four hours. You come back to two hundred messages.

You can read every one of them and still not answer three questions: what got
decided, what is owed and by whom, and what is waiting on you.

Atrium's bet is that the durable artifact of a conversation should not be the
transcript. It should be a structured, correctable statement of what the group
currently understands and is committed to, with every part of it linked back to
the messages it came from — and that a machine may *draft* that statement but
may never be the thing that certifies it. So every line of it carries a mark
saying which of the two it is:

```
~  decision   Use Postgres for the event log            alex, 14:02  →
✓  decision   Use Postgres for the event log            alex, 14:02  →
```

`~` is a *reading*: something in the transcript looked like a decision, and
nothing has checked it. `✓` is the same sentence after a person accepted it. The
arrow is the provenance link back to the messages it was read from. That
difference is not styling — it is the product, and where exactly it is enforced
is [the actor floor](#the-actor-floor).

Three surfaces render that state: **Conversation** (what people are saying),
**Current state** (what the group now understands and is committed to) and
**Needs you** (what specifically requires this person, and why).

**Most of that does not run yet.** The rules are enforced and tested in
`packages/core`; the machine reading that would feed them does not exist, and no
running process is wired to the core at all. [What is actually
built](#what-is-actually-built) says exactly how much — it is the section to
read before believing anything above it.

The thesis being tested, from [`init.md`](init.md): after being absent for
several hours, can a participant understand the situation, the changes, the open
questions and their own responsibilities substantially faster than in Slack?

## What goes wrong now

A transcript is a record of what was *said*. It has no position on what is
*true*. Nothing in it separates a decision from someone thinking out loud, and
nothing marks the message where last week's decision was quietly reversed.

So you re-read, or you ask, and someone answers a question they already
answered. Every person on the thread pays that cost, every time any of them is
away.

The nearest familiar thing to this is a memory store: save what was said,
retrieve it later. That is a different product. A store has no opinion about
whether what it saved is true, who is accountable for it, or whether it still
holds — and the moment you need those, deciding what is allowed into the record
stops being an implementation detail and becomes the entire design.

**What Atrium is not:** not a Slack replacement, not a bot platform, no voice or
video, and no agent execution in v1. [`init.md`](init.md) draws that boundary
deliberately — v1 is a handful of humans, a few hundred messages, and no
autonomous agents.

## What the three surfaces look like

**The panel below is the design, not a screenshot.** Nothing renders it today.
`apps/web` lays out the three regions over hardcoded fixtures, and this sketch is
drawn from [`design/CONVENTIONS.md`](design/CONVENTIONS.md) rather than captured
from a running app.

Current state is a flat list, one glyph per line. Needs you is the subset
addressed to the person reading it.

```
CURRENT STATE                                                       #deploy

✓  decision     Self-host on one VPS; compose identical locally    alex  09:14  →
~  decision     Use Postgres for the event log                     alex  14:02  →
✓  commitment   sam — wire the flag into the server (due today)    sam   10:04  →
~  claim        the migration is reversible                        sam   11:30  →
·  routine      3 more · sam, alex · 11:40–13:55 · peek

NEEDS YOU                                                                 1

◆  open question   Do we keep the flag after launch?
                   you opened this on Tuesday and nobody else can settle it
```

Two things there carry the argument. The `~` decision sits in the list rather
than in a pending queue — a reading is *in* the state, visible, and simply not
dressed as settled. And the `◆` item states why it is *this* person's: attention
items are a recomputed projection over the state, and every one of them must
carry the sentence that justifies it. "Needs you" without a reason is a
notification badge, and the design does not have one.

## A claim is not a fact

Someone writes: *"yeah that sounds fine, let's go with Postgres."*

Was that a decision? A machine reading says probably. Atrium's answer is to
record the reading and mark what it is, rather than to settle it on the reader's
behalf. It enters the state as `~`. It becomes `✓` only when a person accepts
it — not when a confidence score crosses a threshold.

That rule is not a UI convention. `packages/core/src/authority.ts` refuses an
acceptance of a decision by a model actor, and the refusal happens inside the
reducer rather than in the layer above it, because a boundary enforced only
above the reducer is one that a second writer, or a replay, can walk around.
[The actor floor](#the-actor-floor) is the exact list of what that covers — and
of what it does not cover yet, which is more than `✓` currently implies.

**Corrections are events, not erasures.** Saying *"that was only a suggestion,
not a decision"* does not delete the decision. It writes a correction that
supersedes it; both stay on the record, and the chain between them is something
you can read. Replay the log and you get the same state back, correction
included.

That is the structural difference from a summary. A summary is regenerated, so a
correction to one lasts exactly until the next generation. Here the correction is
the durable thing.

Seven glyphs carry the whole vocabulary — `✓` verified, `~` claim, `?`
explicitly unverified, `·` routine, `◆` needs you, `■` destructive decision
pending, `✗` failed. [`design/CONVENTIONS.md`](design/CONVENTIONS.md) defines
each one, records the measured contrast rulings that constrain them — `■` and
`✗` had to be moved off `--red2`, which fails AA in dark at glyph sizes — and
states the invariant they all exist to serve: **a claim never dresses as a
fact.**

## What is actually built

**Nothing here is deployed, and nothing that runs touches the semantic core.**
`apps/web` and `apps/server` both declare `@atrium/core` in their
`package.json`; neither imports a symbol from it. `apps/server/src/index.ts`
opens a database handle, starts a WebSocket server and registers a worker, and
issues no query. The reducer the rest of this file describes is exercised by
its test suite and by nothing else — 315 tests across 14 files, all passing,
measuring something real about code that no user action can currently reach.

**On `main`.** `packages/core` is the semantic core: pure TypeScript with no I/O
and no clock, holding five accepted object types (decision, commitment, open
question, claim, objective), typed relations, proposal staging,
corrections-as-events, and a deterministic reducer whose live-and-replay
equivalence is checked property-style — the test generates logs and asserts the
equivalence across all of them, rather than over hand-written cases.
`packages/db` has the Drizzle schema and its first migration. `packages/ingest`
turns a real conversation into canonical JSONL, byte-identically on a rerun;
three corpora are committed, of 454, 111 and 480 messages. `design/` holds the
token system — 51 variables per theme, values byte-identical to the `:root`
and `html.atr-dark` blocks of `Atrium v6.dc.html`, the last of the prior
prototype lineage — and the rules for using it. `apps/web` is a Next.js shell that lays out the three regions over hardcoded
fixtures, and depends on `@atrium/core` directly rather than through `db`.
`apps/server` is one Node process whose WebSocket
server is a heartbeat-and-echo placeholder and whose job queue is real but
registers `interpret-message` as a no-op.

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
itself on a branch. There is also no host. #40 is open precisely because the
deployment does not yet serve a page, so the compose stack under "Boot it" is a
local stack today, whatever the file says about production.

**Not built at all.** No product code here calls a language model — not on
`main`, not on any branch under review. There is no interpretation job that does
anything, no eval run, no live multiplayer, and no attention computation over
real data. The only model work that has happened is a throwaway spike on a
`research/` branch, which measured how the reading would behave and settled the
pipeline decision; nothing from it ships. The `~`/`✓` grammar above is enforced
in the core and rendered against fixtures — it has never yet marked a machine
reading of a real conversation.

Which means the thesis at the top of this file is still a thesis. It has not been
tested; [what would settle it](#what-would-settle-this) is the last section.

## Why it is built this way

**Humans before agents.** If a handful of people and a few hundred messages do
not reorient faster in Atrium than in Slack, agents will not rescue that; they
will only add volume. `init.md` sequences the product in five phases — replay a
historical conversation, add minimal native multiplayer, test long-running
collaboration, add one narrow agent, add execution only when demanded — and
agents are the fourth, after the thing they would accelerate is known to work.

**Postgres, not a custom event store.** Append-only events with recomputable
projections, in an ordinary database. This one was not argued and won; it was
inherited. `init.md`'s persistence section is a list of things *not to build* —
"a custom event database; a graph database; an embedding-native database; a
distributed ledger" (`init.md:212–217`) — issued as a directive, not as the
record of a comparison, and nothing in this repository weighs those four against
Postgres. [#11](https://github.com/lmvdz/atrium/issues/11) locked the stack and
[#12](https://github.com/lmvdz/atrium/issues/12) settled the table set and the
wire protocol on top of that premise; neither reopened it. The reason it holds
is that none of the four is where this product's difficulty lives.

**Server-authoritative WebSockets, not CRDTs.** Messages are append-only and
semantic state changes through server commands, so there is nothing to merge.
Who may change shared understanding is an access-control question, not a
convergence question — and
[`plans/research-terminal-multiplexing/`](plans/research-terminal-multiplexing/)
found the same answer in a different field. Of the collaborative terminals
surveyed — sshx, tmate, Zellij, VS Code Live Share — not one resolves concurrent
input by merging. Every one of them does it with read-only tokens and
per-terminal read/write permissions.

**Borrow the pattern, not the dependency.** The design system, the glyph grammar
and the attention rules come from the prior Atrium design lineage recorded in
[`plans/research-live-call-design-system/`](plans/research-live-call-design-system/).
Several architectural rules come from reading `block/buzz` — the closest live
analog — at a pinned commit, source and issue tracker together, in
[`plans/research-buzz/`](plans/research-buzz/). The finding that mattered there
was that its documentation is better than this project's and its enforcement
is worse, and that every serious bug in its tracker lives in that gap. Both were
taken as patterns. Neither was taken as a dependency.

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

Two examples of what that catches.

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
That file is this project's record of its own errors, including both of the
above.

## Where the decisions are written down

- [`init.md`](init.md) — the product bible: what to build from scratch, what to
  reuse, what to defer, and the five phases.
- [Issue #1](https://github.com/lmvdz/atrium/issues/1) — the map. Every settled
  decision, one line each, linked to the ticket that argued it. Start here for
  *why* rather than *what*.
- [`RETRO.md`](RETRO.md) — what the process got wrong, per ticket, kept so
  decisions are made against evidence rather than memory.
- [`design/CONVENTIONS.md`](design/CONVENTIONS.md) — the token system, the
  glyphs, and the measured contrast floors, as an operating manual.
- [`plans/`](plans/) — the research briefs the decisions were made from: the
  prior Atrium design lineage, a read of `block/buzz`, and the
  terminal-multiplexing landscape.

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
nothing is ever erased. Attention items — what the **Needs you** surface
renders — are a recomputable projection, and every one of them must say why it
needs *this* person. (Issue #3.)

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
of that matrix is policy — the confidence threshold a reading must clear (`θ` in
the source), which types a model may propose at all, and how a commitment naming
someone else routes to that person — and that policy belongs to the
acceptance-policy layer being built in
[#21](https://github.com/lmvdz/atrium/issues/21). Five rows are not policy. They
are the trust boundary itself, so they are enforced in
`packages/core/src/authority.ts`, and the reducer refuses to fold an event that
breaks them:

| what | who |
| --- | --- |
| Accepting an object with **no proposal** cited | human only |
| Accepting a **decision**, proposal or not | human only |
| Any transition of a claim to `verification: 'verified'` | human only |
| **Superseding an accepted decision** | human only |
| **Corrections** — amend, retract, restore | human only |

Those five rows are the whole floor, and **what they cover is narrower than `✓`
implies.** Drive the shipped reducer with a model actor proposing an object and
then accepting its own proposal, one type at a time, and this is what comes
back:

| type | may a model mint it accepted? | why |
| --- | --- | --- |
| `decision` | **no** — refused | the floor, above |
| a claim moving to `verification: 'verified'` | **no** — refused | the floor, above |
| a claim accepted `unverified` or `disputed` | yes | deliberate: truth status lives in the `verification` field, so it never reads as `✓` |
| `open_question` | yes | deliberate: #4's auto-accept path |
| `commitment` | **yes — and it should not** | attribution is deferred to #21 |
| `objective` | **yes — and it should not** | no gate exists |

The commitment row is the sharp one. `{statement: 'Bob will deploy production
Friday', owner: 'user_bob'}` — a third-party commitment naming a human — is
accepted on a model actor's word with no issue raised. `authority.ts`'s own
header concedes why: deciding whether a commitment is self-stated or third-party
needs the message it was drawn from, which the reducer does not have, so the row
is routed to [#21](https://github.com/lmvdz/atrium/issues/21). It is scheduled
rather than unknown. But until #21 lands, "`✓` means a human checked it" is true
of decisions and of verified claims, and false of commitments and objectives.

The openings that *are* deliberate are the remaining rows. A model may accept
its own claim and open-question readings — a claim carries its truth status in a
separate `verification` field, so an accepted claim still renders `~` — may
supersede a claim or a question, and may reject a proposal, because withdrawing
a staged reading destroys nothing. Refusals are recorded in `state.issues` with
the route that stays open, and every gate is tested in both directions.

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
| `corpora/nextjs-isr.jsonl` | Next.js discussion #11552, *RFC: Incremental Static Regeneration* | **demo** | 454 messages, 368 reply edges, 184 participants. Not the biggest corpus, but the most deeply threaded — a two-year RFC-to-shipped-feature argument, which is what the replay UI has to render. |
| `corpora/ts9998.jsonl` | TypeScript #9998, *Trade-offs in Control Flow Analysis* | sample | 111 messages, 70 participants, and the only corpus on the REST path. Flat: GitHub *issues* carry no threading, so it has zero reply edges — which is why it is no longer the demo. |
| `corpora/holdout-nextjs-rfc.jsonl` | Next.js discussion #37136, *RFC: Layouts* | eval holdout | 480 messages, 314 reply edges, 241 participants — the largest of the three. Held back for the interpretation-quality golden set so prompts are never tuned on the corpus they are scored against. Today that is a role string in the registry and a convention, not a guard: `pnpm ingest all` still fetches it. Making the exclusion structural belongs to [#24](https://github.com/lmvdz/atrium/issues/24). |

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
| `pnpm infra:up` | Start Postgres + MinIO only |
| `pnpm infra:down` | `docker compose down` — stops every service, not just those two |

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

## What would settle this

Everything above is machinery in service of one unproven sentence: that a person
returning after four hours can reorient substantially faster here than in Slack.
Nothing in the repository is evidence for it yet. A passing test suite proves the
reducer does what it says; it says nothing about whether the state the reducer
holds is worth reading.

The experiment is already staged. `corpora/holdout-nextjs-rfc.jsonl` — Next.js
discussion #37136, 480 messages across a year, 314 reply edges, 241 people — was
fetched, committed, and deliberately never opened for demos or prompt work.
[#24](https://github.com/lmvdz/atrium/issues/24) is the ticket that turns it into
a verdict: hand-annotate at least 25 windows of it, including at least 3
supersessions and 5 commitments naming someone other than the speaker, then score
the machine reading against those annotations for per-type precision and recall,
commitment-attribution accuracy, and supersession detection.

Twenty-five windows is the number to watch. Until it exists, this document is a
design and an argument, and the honest summary of the project is that the hard
part is specified, partly enforced, and entirely untested against reality.
