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
| `pnpm test:e2e` | Playwright: shell, auth, workspaces, WebSocket authorization |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome with safe fixes applied |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm infra:up` / `infra:down` | Postgres + MinIO only |

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
  `design/tokens` branch lands, replace the file wholesale; the app reads only
  the variables and hardcodes no colour.
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
