# Atrium

You step away for four hours. You come back to two hundred messages.

You can read every one of them and still not answer three questions: what got
decided, what is owed and by whom, and what is waiting on you.

```
~  decision   Use Postgres for the event log            alex, 14:02  →
✓  decision   Use Postgres for the event log            alex, 14:02  →
```

The bet: what is worth keeping from a conversation is not the transcript. It is
a list of what the group decided, promised, asked, claimed and set out to do,
each line pointing back at the messages it came from. A machine can draft that
list. A machine can never be the thing that certifies it, so every line says
which of the two it is.

`~` is a *reading*: something in the transcript looked like a decision, and
nothing has checked it. `✓` is the same sentence after a person accepted it. The
arrow is the provenance link back to the messages it was read from. [The actor
floor](#the-actor-floor) is where that difference is enforced.

**None of that runs yet.** The rules are enforced and tested in `packages/core`,
and nowhere else: the machine reading that would feed them does not exist, and
no running process is wired to the core at all. [What is actually
built](#what-is-actually-built) spells that out, and it is the section to read
before believing anything above it.

**And a machine drafted it.** This codebase was written by AI — an orchestrated
campaign of Claude models building against a decision graph kept on [this repo's
issues](https://github.com/lmvdz/atrium/issues/1). Each round of work was handed
to blind reviewers: fresh-context critics, some from other model families, given
the artifact and never the builder's notes. They found real defects in almost
every round, including in the guards that had been written to catch defects, and
including in the review receipts themselves. Those receipts are on the tickets,
kept as written — the wrong calls and the retractions along with the rest.

That is not a disclaimer bolted on at the end. It is the same distinction the
product is built on, turned on the thing that built it: a machine can draft a
codebase, and it cannot be what certifies one. The `~` on this repository is
mine to make a `✓`, and where I have not, the tickets say so.

## What goes wrong now

A transcript is a record of what was *said*. It has no position on what is
*true*. A decision and someone thinking out loud are the same kind of line in
it, and the message where last week's decision was quietly reversed looks like
every other message.

So you re-read, or you ask, and someone answers a question they already
answered. Every person on the thread pays that cost, every time any of them is
away.

The nearest familiar thing to this is a memory store: save what was said,
retrieve it later. That is a different product. A store has no opinion about
whether what it saved is true, who is accountable for it, or whether it still
holds. The moment you need those, deciding what is allowed into the record stops
being an implementation detail and becomes the entire design.

The scope is deliberately small. Atrium does not replace Slack, host bots, carry
voice or video, or run agents in v1; [`init.md`](init.md) draws that boundary on
purpose, and v1 is a handful of humans, a few hundred messages, and nothing
autonomous.

## What the three surfaces look like

**The panel below is the design, not a screenshot.** Nothing renders it today.
`apps/web` lays out the three regions over hardcoded fixtures, and this sketch is
drawn from [`design/CONVENTIONS.md`](design/CONVENTIONS.md). Nothing here was
captured from a running app.

Conversation is the messages, with each machine reading attached to the message
it was drawn from. Current state is a flat list, one glyph per line. Needs you is
the subset addressed to the person reading it.

```
CONVERSATION                                                        #deploy

alex   14:02   yeah that sounds fine, let's go with Postgres
               ~ decision · Use Postgres for the event log · accept · reject
sam    14:06   agreed — I'll run the migration this week
               ~ commitment · sam — run the migration · accept · reject

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

The `~ decision` under alex's message and the `~ decision` in Current state are
one object seen from two sides. Pressing *accept* is the entire interaction the
product is about:

```
~  decision     Use Postgres for the event log            alex  14:02  →
✓  decision     Use Postgres for the event log            alex  14:02  →  you, 14:09
```

Nobody retypes the sentence and nothing is regenerated. The mark changes, an
acceptance event goes on the log, and the arrow still points at alex's message.

The `~` decision sits in the list itself. A reading is *in* the state, where you
can see it and act on it; there is no pending queue holding it out of sight
until someone triages it. And the `◆` item states why it is *this* person's.
Attention items are a recomputed projection over the state, and every one of
them must carry the sentence that justifies it. "Needs you" without a reason is
a notification badge, and the design does not have one.

## A claim is not a fact

Someone writes: *"yeah that sounds fine, let's go with Postgres."*

Was that a decision? A machine reading says probably. Atrium's answer is to
record the reading and mark what it is. It does not settle the question on the
reader's behalf. The reading enters the state as `~`, and becomes `✓` only when
a person accepts it, never when a confidence score crosses a threshold.

`packages/core/src/authority.ts` holds that line, and it holds it inside the
reducer rather than in the layer above it, because a boundary enforced only
above the reducer is one that a second writer, or a replay, can walk around.
Hand the shipped reducer a model actor proposing a decision and then accepting
its own proposal, and nothing is accepted:

```
state.objects  {}
state.issues   [ { eventId: "evt_a_decision",
                   reason: "object \"obj_decision\" is a decision accepted by a
                            model actor — a decision never auto-accepts (issue
                            #4): a model actor may propose one, but only a
                            human may accept it" } ]
```

That is the reducer's own output, wrapped to fit. The refusal is on the record,
and it names the act that would satisfy it.

Run the same probe once per object type, though, and the floor turns out to be
narrower than `✓` implies:

| type | may a model mint it accepted? | why |
| --- | --- | --- |
| `decision` | **no** — refused | [the actor floor](#the-actor-floor) |
| a claim moving to `verification: 'verified'` | **no** — refused | [the actor floor](#the-actor-floor) |
| a claim accepted `unverified` or `disputed` | yes | deliberate: an accepted claim keeps its truth status in a separate `verification` field, and that field is what the glyph renders |
| `open_question` | yes | deliberate: #4's auto-accept path |
| `commitment` | **yes — and it should not** | attribution is deferred to #21 |
| `objective` | **yes — and it should not** | no gate exists |

`{statement: 'Bob will deploy production Friday', owner: 'user_bob'}` — a
third-party commitment naming a human — is accepted on a model actor's word with
no issue raised. `authority.ts`'s own header concedes why: deciding whether a
commitment is self-stated or third-party needs the message it was drawn from,
which the reducer does not have, so the commitment row is routed to
[#21](https://github.com/lmvdz/atrium/issues/21) and the gap is scheduled. Until
#21 lands, "`✓` means a human checked it" is true of decisions and of verified
claims, and false of commitments and objectives.

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
each one, records the measured contrast rulings that constrain them (`--red2`
measures 4.21–4.26:1 behind a glyph at 10.5px on `--bg1`/`--bg3` and fails AA
**in dark**, so `■` and `✗` are prescribed `--red3` instead), and states the
invariant they all exist to serve:
**a claim never dresses as a fact.**

## What is actually built

**Nothing here is deployed, and nothing that runs touches the semantic core.**
`apps/web` and `apps/server` both declare `@atrium/core` in their
`package.json`; neither imports a symbol from it. `apps/server/src/index.ts`
opens a database handle, starts a WebSocket server and registers a worker, and
never queries through that handle — the only SQL the process runs at boot is
pg-boss creating and polling its own queue tables. The reducer the rest of this file describes is exercised by its
own test suite and by nothing else: 129 tests across 4 files in
`packages/core`, all passing, measuring something real about code that no user
action can currently reach. The repository's whole unit suite is 315 tests
across 14 files, over the four projects `vitest.config.ts` declares
(`packages/core`, `packages/db`, `packages/ingest`, `apps/server`); the 150 in
`packages/ingest` do back a CLI you can run today.

**On `main`.** `packages/core` is the semantic core: pure TypeScript with no I/O
and no clock, holding five accepted object types (decision, commitment, open
question, claim, objective), typed relations, proposal staging,
corrections-as-events, and a deterministic reducer whose live-and-replay
equivalence is checked property-style: the test generates logs and asserts the
equivalence across all of them.
`packages/db` has the Drizzle schema and its first migration. `packages/ingest`
turns a real conversation into canonical JSONL, byte-identically on a rerun;
three corpora are committed, of 454, 111 and 480 messages. `design/` holds the
token system (51 variables per theme, extracted from the `:root` and
`html.atr-dark` blocks of `Atrium v6.dc.html`, the last of the prior prototype
lineage) and the rules for using it. `apps/web` is a Next.js shell that lays
out the three regions over hardcoded fixtures; it declares `@atrium/core`
directly and does not declare `@atrium/db` at all, so the arrow under
[Layout](#layout) is the shape the code is held to; it is not what the manifests
currently say. `apps/server` is one Node process whose WebSocket
server is a heartbeat-and-echo placeholder and whose job queue is real but
registers `interpret-message` as a no-op.

The token file's header still says its values are byte-identical to that
prototype. On `main` they are not: a routine `pnpm lint` reformatted the file,
lower-casing every hex, renotating two `rgba()` values (`rgba(244,241,234,.10)`
→ `rgba(244, 241, 234, 0.1)`), and changing 83 lines. The checker that proved
the property was never committed, so nothing caught it. Measured today, the
`:root` block matches on 0 of 51 declarations and `html.atr-dark` on 19 of 51;
every colour is still the same colour. The byte-identity claim broke; the
palette did not.
[#48](https://github.com/lmvdz/atrium/issues/48) owns restoring the file and
committing the checker; the same stale sentence is still in `CONVENTIONS.md`
and in `design/tokens.css`'s own header, which is how this class survives being
fixed in one place.

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
continuous integration on `main` yet; the workflow that would provide it is
itself on a branch. There is also no host. #40 is open precisely because the
deployment does not yet serve a page, so the compose stack under "Boot it" is a
local stack today, whatever the file says about production.

**Not built at all.** No product code here calls a language model — not on
`main`, not on any branch under review. There is no interpretation job that does
anything, no eval run, no live multiplayer, and no attention computation over
real data. The only model work that has happened is a throwaway spike on a
`research/` branch, which measured how the reading would behave and settled the
pipeline decision; nothing from it ships. [What would settle
this](#what-would-settle-this) is the last section.

## Why it is built this way

Four choices shape everything above, and not one of them was reasoned out here
for the first time. They come from what was already written down: the map,
`init.md`, and the research briefs, including the choice that was never argued
at all.

**Humans come before agents.** If a handful of people and a few hundred messages
do not reorient faster in Atrium than in Slack, agents will not rescue that; they
will only add volume. `init.md` sequences the product in five phases — replay a
historical conversation, add minimal native multiplayer, test long-running
collaboration, add one narrow agent, add execution only when demanded — and
agents are the fourth, after the thing they would accelerate is known to work.

**Postgres holds the event log**, append-only, with projections recomputed over
it. That choice was not argued and won; it was inherited. `init.md`'s
persistence section is a list of things *not to build*
("a custom event database; a graph database; an embedding-native database; a
distributed ledger", `init.md:212–217`), issued as a directive, not as the
record of a comparison, and nothing in this repository weighs those four against
Postgres. [#11](https://github.com/lmvdz/atrium/issues/11) locked the stack and
[#12](https://github.com/lmvdz/atrium/issues/12) settled the table set and the
wire protocol on top of that premise; neither reopened it. It hasn't been
reopened because none of those four is where this product's difficulty lives.
That's a judgement, not a comparison — nobody has run the comparison.

**The server is authoritative over the shared state.** Clients do not converge on
it through CRDTs. Messages are append-only and semantic state changes through
server commands, so there is nothing to merge. Who may change shared
understanding is an access-control question, not a convergence question, and
[`plans/research-terminal-multiplexing/`](plans/research-terminal-multiplexing/)
found the same answer in a different field: of the collaborative terminals
surveyed — sshx, tmate, Zellij, VS Code Live Share — not one resolves concurrent
input by merging, and they all push the conflict up to the access-control layer
instead, though how far varies: Zellij mints distinct read and read-write tokens
and Live Share can hold a whole session read-only, while an sshx link gives every
viewer the ability to type.

**Patterns are borrowed; dependencies are not.** The design system, the glyph
grammar and the attention rules come from the prior Atrium design lineage
recorded in
[`plans/research-live-call-design-system/`](plans/research-live-call-design-system/).
Three things came back from reading `block/buzz`, the closest live analog,
Apache-2.0, read at a pinned commit — source and specifications together — in
[`plans/research-buzz/`](plans/research-buzz/): the authorization shape the agent
phase is now designed toward, where a machine acting under a person's authority
never *becomes* that person; a name for a failure Atrium had already ruled out
for actors, a confused deputy, avoided by resolving the tenant server-side from
the connection rather than from a tag on the event the client sends; and the
activity-feed doctrine the Conversation surface inherits, where every item
renders as verb, object and outcome, waiting and timeout are rendered states
rather than silence, and references resolve to names rather than ids. Both
bodies of work were read as patterns. Neither was taken as a dependency.

## How the work gets reviewed

The work is charted as a decision graph on
[issue #1](https://github.com/lmvdz/atrium/issues/1): one ticket per open
question, blocking edges between them, and a running list of settled decisions
with the reasoning attached. Work does not start from a decision that is not
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
suggested fix would itself have broken a working healthcheck. Every closed
*build* ticket appends what its rounds caught to [`RETRO.md`](RETRO.md) — no
entry, no close. That file is this project's record of its own errors, including
both of the above.

## Where the decisions are written down

- [`init.md`](init.md) — the product bible: what to build from scratch, what to
  reuse, what to defer, and the five phases.
- [Issue #1](https://github.com/lmvdz/atrium/issues/1) — the map. Every settled
  decision, one line each, linked to the ticket that argued it. Start here for
  the *why*.
- [`RETRO.md`](RETRO.md) — what the process got wrong, per ticket, kept so
  decisions are made against evidence and not from memory.
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

Then open <http://localhost:3000/sign-up>. There is no mail server in
development: the confirmation link is printed to the terminal running `pnpm dev`
under `atrium dev mailer`. Paste it in, create a workspace, and you land in its
first room.

Everything in containers instead:

```bash
ATRIUM_DOMAIN=atrium.example.com    # in .env; required, no default
docker compose up --build           # postgres, minio, migrate, server, app, proxy
```

`docker-compose.yml` is the **production** stack and it is HTTPS-only. Point a
hostname at the box, put it in `ATRIUM_DOMAIN`, and Caddy (`deploy/Caddyfile`)
obtains and renews the certificate itself; `APP_URL` and `NEXT_PUBLIC_WS_URL`
are derived from that one value as `https://` and `wss://` and are not
separately settable. Everything arrives through the `proxy` service — `/ws` to
the realtime server, everything else to the app — and it publishes 443 and 80
(the second answers the ACME challenge and redirects). Neither `app` nor
`server` publishes a port of its own, and that is load-bearing rather than tidy
— see below.

For the same topology on a laptop, over plaintext:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

That override is development-only, says so at the top of the file, and also
sets `NODE_ENV=development` — because under `NODE_ENV=production` both
processes refuse to start with an `http://` origin at all. It is a second file
rather than a variable for exactly that reason. The everyday loop needs neither:
`pnpm infra:up && pnpm dev`.

### HTTPS is a boot condition, not a recommendation

Round 4 shipped this stack with the proxy on `:80`, an `http://` `APP_URL`
default, and a comment in `deploy/Caddyfile` asking the operator to change it.
Every session cookie, verification link and invitation link in that deployment
crossed the network in cleartext. A comment is not a control, so there are now
four:

- compose refuses to interpolate an unset `ATRIUM_DOMAIN`;
- Caddy refuses an empty site address, and a hostname is what switches its
  automatic HTTPS on (an IP or a bare `:80` would switch it off);
- `apps/web` and `apps/server` each refuse to serve production with an
  `http://` `APP_URL` or a `ws://` `NEXT_PUBLIC_WS_URL`, and so does
  `createAtriumAuth`, which both processes build through — the rule itself is
  one function, `assertSecureTransport` in `packages/auth/src/transport.ts`, so
  the two cannot end up with different ideas of "secure enough to serve";
- session cookies carry `Secure` (and the `__Secure-` prefix), stated in the
  config rather than inherited from a library default, and asserted against the
  real instance's own options.

There is deliberately **no override**. An escape hatch is the comment again with
extra steps: the deployment that reaches for it is the one the check exists for.
Development and test are untouched, and `next build` is exempt — it compiles
route modules without serving a request, the same exemption the mailer gate
makes.

### Why there is a proxy in front

`ATRIUM_TRUSTED_PROXY_HOPS=1` is a *claim* that exactly one proxy appends the
caller's address to `X-Forwarded-For`. It buys the rate limiter its per-address
dimension, and it is only as true as the topology: a second, un-proxied way in
would let a direct caller write the whole chain and name their own address.
Hence no published ports on `app` and `server`.

The reason it is not optional is on the web side. A Next.js Server Action cannot
see the socket — `headers()` is the whole request, and Next fills
`x-forwarded-for` from the peer *only when the client sent none*, so a present
value there is either the peer or entirely attacker-written with no way to tell.
Without something in front, the sign-in and sign-up limiters have no address to
count at all. (They do not then stop counting: an unresolvable caller shares one
global bucket, `unresolvedIpKey` in `packages/auth/src/client-ip.ts`. That is a
cap, and it is not a per-address cap.)

TLS terminates there, automatically, from `ATRIUM_DOMAIN` — see above.

### The compose stack does not serve a page yet

`app` runs `NODE_ENV=production`, and `resolveMailer` refuses to hand out the
console transport there — it prints verification links, and a verification link
is a single-use account takeover. There is no production mail transport in this
repository yet; it lands with the notification work. Until it does, every route
in `app` answers 500 in this stack. Overriding the variable does not help:
`next build` inlines `process.env.NODE_ENV` into the standalone bundle.

Everything else comes up: postgres, minio, migrate, `server` and `proxy` are
healthy, and the realtime upgrade routes through the proxy to its origin and
session checks. `pnpm dev` is unaffected — it is `NODE_ENV=development`, where
the console transport is exactly right.

[#40](https://github.com/lmvdz/atrium/issues/40) owns the fix: a real transport
plus a CI job that boots this stack and asserts a *page*, not a health endpoint.
The gate itself is adjudicated correct and must not be weakened to make the
stack come up. One consequence worth stating rather than glossing: the HTTPS
rules above have not been observed serving real traffic either. What has been
checked is that `caddy validate` accepts the Caddyfile (and reports
"enabling automatic HTTP->HTTPS redirects"), that `docker compose config`
refuses an unset `ATRIUM_DOMAIN`, and that both processes refuse an `http://`
origin under `NODE_ENV=production` — the last by test, the first two by running
the tools.

### The credentials in this repo are development-only

`.env.example` ships postgres `atrium:atrium` and MinIO
`atrium:atrium-dev-secret`. **They are development credentials, committed to
this repository in plain text and readable by anyone who can read it.** They
exist so a laptop boots with no setup, and for nothing else. Never run this
stack on a public VPS with those values.

Two things enforce that: the three secrets in `docker-compose.yml` have no
default, so compose refuses to start when one of them is unset, and an unset
`NODE_ENV` is treated as production, because "nobody said" on a bare host is a
host on the internet. That default holds only because `NODE_ENV` is read from
the process environment and nowhere else: the `.env` you copied above says
`development`, and a file may supply a value nobody set but may never set
`NODE_ENV`, or the strict default would be decoration.
`apps/server/test/entrypoint-env.test.ts` boots the real entrypoint against a
planted `.env` to prove it, and `docker run atrium-server` with no environment
at all fails at boot with a named error rather than reaching for a public
secret.

Before exposing anything: set real values in `.env`, or the deployment's own
secret store.

**On the data ports.** This sentence used to say "do not publish 5432 / 9000 /
9001 at all unless you mean to", which was an instruction to the operator rather
than a control — the same shape rounds 4 and 5 removed from the Caddyfile.
`docker-compose.yml` now publishes those three on `127.0.0.1` explicitly, so the
default is a decision the file makes rather than one a reader has to remember.
Only 80 and 443 reach a network, and only through `proxy`.

What that costs, said plainly, because "loopback only" is not free:

- Unaffected: `pnpm infra:up`, `pnpm db:migrate`, `pnpm test:e2e`, and `psql`
  from the host — every documented use runs on the box and goes over loopback.
- **Changed: anything reaching the database or MinIO from another host.** A
  backup job, a remote `pg_dump`, a MinIO console opened from a laptop — those
  now need an SSH tunnel (`ssh -L 5432:127.0.0.1:5432 …`) or a private network
  between the hosts. A deployment that genuinely needs it should give the
  service that network rather than widening the published line.
- Not a network control on its own: on Docker Engine before 28.0 a
  `127.0.0.1`-published port can still be reachable from hosts on the same L2
  segment. Requiring Engine ≥28 with default NAT, or a host firewall policy, is
  a deployment prerequisite and belongs to **#40** with the rest of the serving
  stack — a compose file cannot assert it.

## Layout

```
apps/web        Next.js 16 App Router, React 19. Shell, auth screens, workspaces.
apps/server     Node 22. ws WebSocket server + pg-boss workers. One process.
packages/core   The Semantic Core. Pure TypeScript, zero I/O.
packages/db     Drizzle schema, migrations, postgres-js client.
packages/auth   One Better Auth configuration + `authorize()`. Shared by both apps.
packages/ingest Replay ingest. Conversations in, canonical JSONL out.
corpora/        Committed replay corpora (see below).
design/         Design tokens (light default, dark via `html.atr-dark`).
```

The dependency arrow only ever points one way: `web`/`server` → `auth` → `db` →
`core`. `packages/core` imports nothing from `node:*`, no driver, no clock — that
purity is what makes interpretation replayable and unit-testable in isolation.

### Auth and workspaces

Better Auth (issue #13), self-hosted on our own Postgres through its official
Drizzle adapter. Three decisions are worth knowing before you touch it:

- **One row per human.** Better Auth's `user` model *is* the existing `users`
  table and its `organization` model *is* `workspaces`, rather than a parallel
  identity store synced by webhook. Application data foreign-keys straight at
  them. The remapping lives in `packages/db/src/auth-schema.ts`, and
  `packages/db/test/auth-schema.test.ts` asks the installed library what schema
  it expects and fails if ours has drifted — the adapter resolves columns by
  name at runtime, so nothing else would catch a rename.
- **One configuration, two processes.** `packages/auth` builds the instance; the
  web app adds `nextCookies()` and the realtime server adds nothing. They must
  share `BETTER_AUTH_SECRET` or every WebSocket upgrade reads as unauthenticated.
- **One authorization function.** `authorize(command, membership)` in
  `packages/auth/src/authz.ts` is deny-by-default: unknown command, unknown role,
  no membership and wrong scope all refuse. The WebSocket passes `scope: 'room'`,
  so a workspace-level command can never be waved through on a room membership.

The WebSocket upgrade is authenticated in `apps/server/src/ws-auth.ts` —
`authenticateUpgrade(request) → session | null`, before the handshake completes,
so there is no "connected but anonymous" state. That is the seam the realtime
protocol (#22) builds on. Two things happen alongside it:

- **The `Origin` header is checked first**, against the same `APP_URL` Better
  Auth trusts. A WebSocket handshake ignores the same-origin policy and still
  carries cookies, so without this any page a signed-in person visits could open
  an authenticated socket as them — and the valid session is what would make it
  work. A client that sends no `Origin` at all is refused too, unless
  `WS_ALLOW_ORIGINLESS=true` says the deployment has real non-browser clients.
- **A socket does not outlive its session, or its membership.** Each command
  re-validates the session, cached for `WS_REVALIDATE_TTL_MS` (5s) — and the
  negative verdicts are cached too, so a revoked socket is not a session read
  per frame. Room membership is read per command with no cache at all, so
  removing somebody takes effect on their very next frame. A socket that only
  *listens* sends no commands, so both questions are also asked of every open
  connection every `WS_SWEEP_INTERVAL_MS` (15s); losing a room takes the socket
  off that room's roster and closes it with 1008, because "cannot send" is not
  revocation and "cannot see" is. In production the server **refuses to start**
  without a session validator rather than defaulting to trusting the handshake.
- **Accepted, and genuinely bounded: presence keeps arriving until the sweep
  notices.** A socket that joined a room before its owner was removed stays on
  that room's roster until the sweep takes it off, and `broadcastPresence` fans
  out to the roster without re-asking membership per recipient. So a removed
  member can still see *who is connected* to a room they have lost, for as long
  as it takes the sweep to reach them. That is bounded two ways, and there is no
  third case:
  - **the membership lookup answers** — at most `WS_SWEEP_INTERVAL_MS` (15s);
  - **it does not answer**, because it threw or because it never returned at all
    — at most `WS_SWEEP_FAILURE_LIMIT` sweeps (3) or `WS_SWEEP_UNVERIFIED_MS`
    (60s), whichever comes first, and then the socket is closed with 1008.

  A lookup cannot buy itself more time by hanging: every lookup inside a sweep
  is deadlined, a sweep that overruns cannot stop the next one starting, and a
  hung lookup counts as a failure to verify rather than as a pause. That last
  part is a correction: through round 7 the 15s figure was the *default
  configuration* rather than a guarantee, because one wedged query held the
  sweep latch and every later sweep was skipped.

  Command authority is already gone inside the window — the very next frame they
  send is refused — and no room content travels on that path; it is a list of
  display names. Re-checking membership per recipient would put a database read
  on every presence fan-out to shorten a window on non-content, so the clean fix
  is a post-commit eviction signal instead, which needs the LISTEN/NOTIFY
  plumbing #22 is building. Routed to **#27**. The same paragraph is on
  `broadcastPresence` in `apps/server/src/ws-server.ts`, which is the line that
  produces the window, and `apps/server/test/ws-server.test.ts` measures both
  bounds with a clock rather than restating them.

Removing or demoting a workspace member reconciles room membership in the same
request (`packages/auth/src/org.ts`, `workspace.ts`) — room membership is what
the realtime server authorizes against, so it is what removal has to remove.
Note what that is *not*: our writes and Better Auth's are separate transactions
and nothing joins them. The guarantee is directional — revocations commit before
the library's write, grants only after it — so a partial failure leaves somebody
a member with no rooms, never a non-member with every room.

Every write to one member's room rows happens inside one advisory lock keyed on
`(workspace, member)`, with a `lock_timeout` so a stalled holder fails that
member's next mutation instead of hanging it forever. The lock also spans the
*whole* of the invitation compensation: taking the room rows back and deleting
the workspace member row are one transaction, so an acceptance racing the
compensation either completes before it and is undone, or waits and then finds
no member row to join on — `joinWorkspaceRooms` reads an absent member row as a
refusal, never as a reason to fall back to the role it was handed. Round 4 did
those two writes in two transactions, and the gap between them was long enough
for a concurrent acceptance to re-grant every room the compensator had just
taken away; `apps/web/e2e/role-sync.spec.ts` now holds that interleaving in
place with a row lock and asserts it cannot happen.

Only three of Better Auth's HTTP endpoints are actually mounted
(`packages/auth/src/mounted.ts`): the verification link, the OAuth callback and
the error page it redirects to. Everything else Atrium needs it calls in-process
from a Server Action, where `authorize()` and the sign-in throttle live, so
publishing the rest would only provide a way around both. The guard matches on
the same terms Better Auth's own router does — the raw pathname, per segment,
method included, percent-encoding refused outright — so the two cannot disagree
about what a path means; the smuggling fixtures in `mounted.test.ts` assert the
refusals at the guard rather than trusting a dependency to be stricter than we
are.

One correction to what earlier rounds claimed about that guard's input.
`rawPathname` exists because `new URL(...).pathname` resolves dot segments, and
a guard handed a rewritten path answers about a request nobody sent. That is
genuinely load-bearing **on the realtime server**, where `req.url` is the
literal request target from Node's HTTP parser — `apps/server/test/ws-server.test.ts`
writes `GET /nope/../ws` onto a raw socket and asserts the 404, so reverting
that call site fails a test. It is **not** load-bearing on the Next route
handler: constructing a `Request` already runs the WHATWG URL parser, so by the
time a handler exists the dot segments are gone and both functions return the
same string for every input. Next owns canonicalization there and `rawPathname`
is defense-in-depth — said plainly, in the route file and in `mounted.ts`,
because an unproved guard described as proved is worse than no guard.
`mounted.test.ts` measures that premise, so if a runtime ever stops
canonicalizing, the failing test says the web-side call has become load-bearing. The organization plugin additionally enforces its own policy in
`beforeCreateInvitation`, and re-checks it in `afterCreateInvitation` — nobody
can hand out a role they do not hold, and an inviter demoted in the gap between
those two has the invitation voided.

Email verification and invitations both go through the mailer
(`packages/auth/src/mailer.ts`). In development it prints to the console and,
when `ATRIUM_MAIL_OUTBOX` is set, appends one JSON object per message to a file;
the e2e suite reads its links from there. **There is no production transport
yet, and the process refuses to boot with `NODE_ENV=production` until one is
passed** — those links are one-click account takeovers and belong in an inbox,
not in a log aggregator.

Sign-in, sign-up and resend are throttled per address *and* per IP
(`packages/auth/src/throttle.ts`). `ATRIUM_TRUSTED_PROXY_HOPS` says what is in
front of the process and is **required in production** — both apps refuse to run
without it, because an unset value is a limiter running on one dimension while
looking like it has two. There are three states, not two: unset (believe
nothing), `0` (nothing in front, so the socket's peer address *is* the caller),
and `N` (N proxies that append to `X-Forwarded-For`; the caller is the Nth entry
counted from the right). Better Auth's own limiter is handed the same answer, so
the two cannot bucket a caller differently. One honest limit: on the Next.js
side `0` yields no address at all — Next cannot hand a Server Action the socket's
peer — so the per-address limit carries the load until a proxy is put in front.
Absent, never forged. Counters are per-process and reset on restart, which is
honest for the one-node deployment in issue #18 and must move to Postgres or
Redis if that changes.

One OAuth provider (GitHub) is wired but optional: set `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` and the button appears, leave them blank and it does not.

### The semantic model

Five first-class accepted object types share one table with a `type`
discriminator and a typed jsonb payload: **decision**, **commitment**,
**open_question**, **claim**, **objective**. Supersession, dependency, blocking,
answering and evidence are typed edges in `relations`, not objects. Proposals
are pre-acceptance staging. Corrections are events, so nothing is ever erased.
Attention items — what the **Needs you** surface renders — are a recomputable
projection, and every one of them must say why it needs *this* person.
(Issue #3.)

`reduce(events) → state` in `packages/core` is deterministic: events are
canonically ordered by `(at, id)`, and the same log always serializes
byte-identically. It is total over the events it is given: one it cannot apply
lands in `state.issues` and does not throw, so a replay never wedges. That
totality starts at the schema. `reduce` takes `CoreEvent[]`, and structurally
malformed input is refused one level up by `CoreEvent.parse`, which throws.

The reducer is also where the trust boundary is enforced. A recorded proposal is
always `proposed` — an interpreter cannot hand itself an
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

Those five rows are the whole floor. [A claim is not a
fact](#a-claim-is-not-a-fact) runs the shipped reducer once per object type and
prints which ones a model can still mint accepted.

The openings that *are* deliberate are the remaining rows. A model may accept
its own claim and open-question readings — a claim carries its truth status in a
separate `verification` field, so an accepted claim still renders `~` — may
supersede a claim or a question, and may reject a proposal, because withdrawing
a staged reading destroys nothing. Refusals are recorded in `state.issues` with
the route that stays open, and every gate is tested in both directions.

### Consumed, or rejected

`appendEvent(state, event)` either consumes an event or rejects it. The gate is
`state.cursor`, the canonical `(at, id)` position of the last event this state
consumed; an event that does not sort **strictly after** it is rejected outright.
A consumed event takes its position even when its business checks failed, and its
problem is recorded in `state.issues`. A rejected one, out of order or a
duplicate id arriving ahead of the cursor, leaves nothing behind: no issue, no
cursor movement, no `consumedEventIds` entry, and the state handed back is the
state handed in.

Consumption only ever moves forward, and the consumed sequence is in
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
| `corpora/nextjs-isr.jsonl` | Next.js discussion #11552, *RFC: Incremental Static Regeneration* | **demo** | 454 messages, 368 reply edges, 184 participants. Not the biggest corpus, but the most deeply threaded — a nearly three-year RFC-to-shipped-feature argument (2020-04-01 to 2023-01-02), which is what the replay UI has to render. |
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
`--check` deliberately reports drift as a failure and never absorbs it.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Build packages, then web + server in watch mode |
| `pnpm build` | Build packages, then both apps |
| `pnpm test` | Vitest across `packages/*` and `apps/server` |
| `pnpm ingest <source>` | Fetch a conversation into `corpora/` (see Replay ingest) |
| `pnpm test:e2e` | Playwright: shell, auth, workspaces, WebSocket authorization |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome with safe fixes applied |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm infra:up` | Start Postgres + MinIO only |
| `pnpm infra:down` | `docker compose down` — stops every service, not just those two |

Playwright needs its browser once: `pnpm --filter @atrium/web exec playwright
install chromium`. Without it the suite skips with a reason instead of failing —
a red e2e run should mean "the app is broken", never "no browser here". **In CI
that courtesy stops**: `CI=1` turns the missing browser into a hard error, because
a fully skipped suite reporting green is the exact failure CI exists to catch.

`pnpm test:e2e` drives the real thing: a real Next server, a real WebSocket
server and a real Postgres. It provisions its own throwaway database first
(`apps/web/e2e/support/ensure-database.mjs`) — reusing `E2E_DATABASE_URL` if it
answers, otherwise starting a `postgres:16-alpine` container on :55432 — then
migrates and empties it. If neither is available it fails with instructions
rather than skipping; a green run that tested nothing is worse than a red one.

## Notes for the next change

- `design/tokens.css` is a placeholder transcribed from the settled Atrium token
  system recorded in `plans/research-live-call-design-system/`. When the
  `design/tokens` branch lands, replace the file wholesale. `shell.module.css`
  reads only the variables, so replacing the file is enough for everything the
  page paints; the one exception is `apps/web/app/layout.tsx`, whose viewport
  `themeColor` hardcodes `#e6e2da` and `#0a0b0c` for the browser chrome. Those
  are emitted as `<meta name="theme-color">`, which is HTML metadata and so
  cannot reference a custom property; they have to be updated by hand and kept
  in step with `--bg0`.
- `interpret-message` is registered as a no-op worker. Its idempotency contract
  is already in place: dedup key `${messageId}:${interpretationVersion}` with an
  explicit singleton window, backed by the `(message_id, interpretation_version)`
  unique constraint on `interpretations` (issue #16).
- The WebSocket protocol is heartbeat, echo, and an authorized command path with
  a presence roster. The real command and event contract slots into
  `handleCommand` without the authentication or authorization around it moving.
  Commands in `commandPolicy` with no handler answer `not_implemented` rather
  than pretending to have worked.
- `rooms.workspace_id` is `NOT NULL` with no backfill, so migration `0001` will
  fail on a database that already has rooms in it. Nothing has shipped; drop the
  dev database rather than writing a backfill for rows that do not exist.
- No MFA, SSO or SCIM (out of scope for #26). Better Auth's `twoFactor` and
  `passkey` plugins are the documented path when MFA is wanted; both add tables,
  so they land with a migration and an update to the parity test.
- Adapter seams (`ConversationSource`, `ExecutionProvider`) are type-only ports
  in `packages/core/src/ports.ts`. No integration ships in v1; the door stays
  open.

## What would settle this

Everything above is machinery in service of one sentence: that a person returning
after four hours can reorient substantially faster here than in Slack. A passing
test suite proves the reducer does what it says; it says nothing about whether
the state the reducer holds is worth reading.

The experiment is already staged. `corpora/holdout-nextjs-rfc.jsonl` — Next.js
discussion #37136, 480 messages across a year, 314 reply edges, 241 people — was
fetched, committed, and deliberately never opened for demos or prompt work.
[#24](https://github.com/lmvdz/atrium/issues/24) is the ticket that turns it into
a verdict: hand-annotate at least 25 windows of it, including at least 3
supersessions and 5 commitments naming someone other than the speaker, then score
the machine reading against those annotations for per-type precision and recall,
commitment-attribution accuracy, and supersession detection.

Twenty-five windows is the number to watch — and scoring them settles only half
of it. Precision and recall say whether the machine reads a conversation
correctly. They say nothing about whether the list it produces gets anyone back
up to speed faster than scrolling would, which is the actual claim and still has
no test behind it. #24 is necessary and not sufficient; its thread now also
records what the other half would need — a task, a measurement, a baseline, and
a population — though its acceptance test does not yet ask for them.
