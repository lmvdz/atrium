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

Requires Node 22.12+, pnpm 10, and Docker Engine 28.0.0+. The engine floor is a
deployment prerequisite rather than a preference — see "the deployment is proved
by a CI job" below, and `scripts/ci/assert-deploy-preflight.mjs`, which refuses
to build against a host below it.

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
ATRIUM_MAIL_TRANSPORT=smtp          # in .env; required, no default — see below
docker compose up --build           # postgres, minio, migrate, server, app, proxy
```

`docker-compose.yml` is the **production** stack and it is HTTPS-only. Point a
hostname at the box, put it in `ATRIUM_DOMAIN`, and Caddy (`deploy/Caddyfile`)
obtains and renews the certificate itself; `APP_URL` and `ATRIUM_WS_URL` are
derived from that one value as `https://` and `wss://` and are not separately
settable. Everything arrives through the `proxy` service — `/ws` to the realtime
server, everything else to the app — and it publishes 443 and 80 (the second
answers the ACME challenge and redirects). Neither `app` nor `server` publishes a
port of its own, and that is load-bearing rather than tidy — see below.

That stack needs a mail relay before it will start, because the console
transport prints one-click sign-in links and `resolveMailer` refuses it in
production. Say which one in `.env`:

```bash
ATRIUM_MAIL_TRANSPORT=smtp
ATRIUM_MAIL_FROM='Atrium <no-reply@example.com>'
SMTP_URL=smtps://user:password@relay.example.com   # or SMTP_HOST/PORT/USER/PASSWORD
```

`smtps://` is implicit TLS; plain `smtp://` negotiates, and `SMTP_REQUIRE_TLS=true`
makes it refuse a session that never reaches STARTTLS. Use one of those two for
any relay that is not on this deployment's own private network — the message
carries the verification link. `ATRIUM_MAIL_TRANSPORT=console` is a legitimate
answer meaning "no relay", and in production it means the stack refuses to boot.
The full contract is at the top of `packages/auth/src/smtp.ts`.

For the same topology on a laptop, with a mail catcher and a certificate from
Caddy's own internal CA:

```bash
docker compose -f docker-compose.yml \
               -f docker-compose.mailpit.yml \
               -f docker-compose.dev.yml up --build
```

That serves `https://localhost:3000` and puts every message Atrium sends in
mailpit's web UI on `:8025`. Your browser will not trust the certificate until
you install Caddy's root — `docker compose cp
proxy:/data/caddy/pki/authorities/local/root.crt /tmp/atrium-root.crt` — which is
the honest cost of the local stack being genuinely encrypted. Until #40 this
override served cleartext and set `NODE_ENV=development` on `app`; the first was
one `cp` from being somebody's production Caddyfile and the second never worked
at all, because a Next standalone entrypoint assigns `NODE_ENV=production` to
itself before any application code runs. The everyday loop needs none of it:
`pnpm infra:up && pnpm dev`.

### The deployment is proved by a CI job, not by a receipt

Three rounds of gauntlet receipts described this compose stack as working. It had
never served a page: under `NODE_ENV=production` `app` answered 500 to every
request, and neither image had built at all since `packages/ingest` landed
without its manifest being copied into the Dockerfiles. Every gate was green
because every gate tested a part.

So `.github/workflows/ci.yml`'s `deploy` job runs the product. It builds both
images from the shipped Dockerfiles, brings up `docker-compose.yml` plus
`docker-compose.mailpit.yml` (a mail catcher and nothing else), and asserts,
over TLS through the shipped Caddyfile, on the published port:

- the host qualifies at all — Docker Engine ≥ 28.0.0, default NAT, no network in
  routed or `nat-unprotected` mode (`assert-deploy-preflight.mjs`), checked
  before a single image is built, and failing closed when the daemon's bridge
  cannot be inspected rather than reading an empty answer as a safe one;
- the **migration** container will run the image this run built — checked
  *before* `up` (`assert-migration-image.mjs`), because `migrate` is a one-shot
  that `server` and `app` both wait on, so it executes inside the boot and a
  wrong image would have altered a persistent volume before any assertion looked
  at a container;
- every container healthy, none restarting, both one-shot jobs exited 0
  (`assert-stack-health.mjs`);
- the running containers' own `NODE_ENV`, origins, hop count and mail transport
  are the production ones — read back with `docker inspect`, so the overlay
  cannot quietly turn this into a check on a development stack
  (`assert-stack-config.mjs`);
- `app`, `server` and `migrate` are running exactly the image **IDs** this run
  built, recorded straight after the build (`record-built-images.mjs`,
  `assert-image-identity.mjs`) — so built, scanned and running are one
  content-addressed object rather than three uses of a tag;
- no realtime origin compiled into that image (`assert-image-origins.mjs`, which
  scans the recorded ID);
- the **deployed database is the schema the migrations describe** — table set,
  column set per table, and drizzle's own applied-migration count against this
  tree's journal (`assert-stack-schema.mjs`). `migrate` exiting 0 is a claim
  about a process, not about a schema;
- signing up through the real form sends a verification mail over real SMTP, and
  the link in the message that arrived signs the account in
  (`assert-signup-verifies.mjs`);
- **a real page**, and one this run's app rendered from this run's database:
  `/` is fetched as a per-run account and must carry that account's display
  name, compared against the value read straight out of the `postgres`
  container; the same URL fetched signed out must *not* carry it; `/app` names
  the address behind `requireSession`; HSTS is present and `:80` redirects
  rather than serving (`assert-page-serves.mjs`). Every marker a fixture could
  copy is a constant, so the assertion rests on the things that are not: a value
  that did not exist a minute ago, and two different answers to two different
  requests. A `handle /` in the Caddyfile returning a stale copy of the page
  passes every structural check and fails exactly there;
- an authenticated `wss://` upgrade completes, welcomes the user id Postgres
  holds for that account, and an unauthenticated one is refused
  (`assert-ws-upgrade.mjs`);
- the sign-in limiter refuses a caller at its configured cap and lets a caller at
  a different address straight through (`assert-rate-limit.mjs`);
- `docker compose down -v` leaves no container, volume or network
  (`assert-stack-teardown.mjs`).

Not a health endpoint, deliberately: `app` reported healthy for three rounds
while 500ing, and a check that cannot tell those apart is the instrument that
allowed it.

**Docker Engine ≥ 28 is a hard deployment prerequisite, not a nicety.** Earlier
engines insert their DNAT rules ahead of the filter chain, so a port published to
`127.0.0.1` — mailpit's UI here, a store of live single-use sign-in links — is
reachable from any host that can route a packet to the box, typically anything on
the same L2 segment. A hostname matcher in the proxy is not a fix, because `Host`
is a header the caller writes: a remote client sending `Host: localhost` matches
whatever `localhost` was meant to protect. Nothing in this repository can close
it, which is why it is a preflight rather than a configuration change.

`node scripts/ci/deploy-mutation-ledger.mjs` is the receipt behind those claims,
and since round 2 it runs the **real ordered job** — the stage list is parsed out
of `ci.yml`'s `deploy` job, every case runs it from the top, and the stage that
actually fires is what gets credited. A case whose declared check is not the one
that fired fails the ledger, which is how three cases that had been crediting a
later check came to name the earlier gate that really stops them. It also refuses
to run if the job grows a stage no case names and no exemption explains — 5
stages are exempt, each with the reason no mutation of it exists, and the number
is asserted against the table so that exempting a sixth is a visible edit
rather than a quiet one. Round 4 removed one of them: `assert-image-origins` was
required by policy and never mutation-proven, and now has `origin-baked-into-the-image`,
which re-points the tag `compose build` produced at an image carrying a `wss://`
literal and lets the job's own `record-built-images` resolve it.

Since round 3 the ledger **executes each step's own argv**, parsed out of
`ci.yml` with the parser the policy engine uses, instead of recovering a script
name by regular expression and running something of its own. That is what closes
the worst failure this ticket found: `false && node scripts/ci/assert-page-serves.mjs;
true` made CI skip the assertion and exit green *while the ledger certified that
the same assertion had caught its mutation*. It also requires a clean working
tree and a HEAD that does not move for the duration, because it reads `ci.yml`
once and the scripts from disk — a branch switch mid-run produced a receipt for
workflow A with scripts B, once, for real.

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
  `http://` `APP_URL` or a `ws://` `ATRIUM_WS_URL`, and so does
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

Before exposing anything: set real values in `.env` (or the deployment's own
secret store), and do not publish 5432 / 9000 / 9001 at all unless you mean to.
Only `WEB_PORT` — the proxy — needs to face the internet.

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
  a file no report will ever name — is still read. "Rooted at a test runner"
  means rooted at a binding actually *derived* from the runner, per name: a
  module that imports `vitest` for its own assertions and also exports domain
  code does not turn that domain code's `.fails` property into an annotation.
  That holds through a namespace too: `import * as helpers from './lib'` taints
  the members of `helpers` that are runner-derived and no others, so
  `helpers.knownBroken.fails` is an annotation and `helpers.validate().fails` is
  a count of failures in a domain object. 18 spellings and 7 lookalikes are
  fixtures in `gate-selftest.mjs`.
- **The source scan is an independent witness, not a complete one**, and the
  difference is load-bearing. It cannot see an annotation behind a bare or
  aliased import specifier, a computed key it would have to constant-fold
  (`it[KEY]`), a `globalThis` root, or a wrapper a `setupFiles` entry registered
  outside every test file's import graph. All four fail *closed* through the
  other witness — `vitest-ci-reporter.mjs` reads `options.fails` off the live
  task object, so an annotation that actually runs raises its count above the
  scan's and the gate fails on the disagreement. That is the whole design and
  exactly its strength: it survives *either* witness being wrong, not both. 4
  stated blind spots are fixtures asserting both halves of that. Closing the
  conjunction needs a check that does not run from the revision under test,
  which is the governance trigger below.
- **Prerequisites are enforced as pairs.** A gate can be present, named, invoked
  and useless because the step it depends on is gone. `assert-floor-ratchet.mjs`
  is the case: without the `git fetch` of `origin/main` before it, the shallow
  clone has no baseline, so the ratchet reports "no baseline" and exits 0 — a
  floor lowered in the same pull request sails through. So required steps declare
  their setup, and `required-step-prerequisites` fails the build unless the
  prerequisite is in the same job *and earlier*. 31 pairs across 23 steps that
  declare one: the ratchet's fetch of `origin/main`; both report resets, before
  the runs they reset for; both report gates, after those runs; the migration's
  wait for Postgres and the schema assertion's migration; the browser install and
  browser check the Playwright suite needs, and the database migration without
  which its two servers query tables that do not exist; and, in the `deploy` job,
  everything that depends on a running stack — the boot's dependence on the image
  build and on the host preflight, the certificate copy's on the boot, four
  assertions' on that certificate, three more on the boot, the image record's on
  the build, the identity and origin scans' on that record, and the teardown
  assertion's on the teardown. The count is derived —
  `PREREQUISITE_PAIRS.length`, printed by the self-test — because a hand-counted
  number in a receipt is how round 2 claimed 15 rules over an engine with 18.
  Every number in this section is now read back out of the code by the
  self-tests, prose included, because deriving a count at the point it is
  printed does nothing for the copy of it sitting in a README.
- **A protected step must be *invoked*, not mentioned — and recognition is a
  parse, not a pattern.** Round 4 matched by substring, so
  `run: echo 'git fetch … refs/heads/main'` satisfied the pair while
  `origin/main` never existed and the ratchet took its no-baseline exit-0 path.
  Round 5 replaced that with a line-start regular expression, and nine words
  defeated it: `pnpm --version && echo exec node scripts/ci/assert-floor-ratchet.mjs`
  matched, because arbitrary text was allowed between a package manager and a
  later `exec`. The same expression was wrong in the other direction too — it
  rejected `(git fetch …)`, `true && git fetch …`, `VAR=x git fetch …`, `sudo`,
  `timeout 30`, `command git`, `xargs`, and any line long enough to wrap over a
  backslash, while accepting `git fetch … &`, which never establishes that the
  fetch finished. So `scripts/ci/shell-command.mjs` tokenizes the script —
  quoting, comments, expansions, redirections, here-documents, operators,
  subshells — and yields simple commands; a rule is a predicate over the words
  of one command, and `echo exec node x` is an `echo` with two arguments however
  it is spaced. Both polarities are fixtures: the evasions are mutations that
  must go red, and 14 legitimate rewrites of the real steps must leave the whole
  file clean, because a guard that is wrong in that direction is one somebody
  deletes.
- **Recognising a command is not proving it runs.** Six rounds asked whether a
  protected script was *invoked* and got a correct answer.
  `false && node scripts/ci/assert-page-serves.mjs; true` satisfies that
  question, skips the assertion, and exits the step green — and the mutation
  ledger, which recovered the script's name by regular expression and ran it
  itself, went on certifying that the assertion caught its mutation. No matcher
  can tell that from `true && …`, because nothing here evaluates a shell. So
  `protected-steps-run-one-command` refuses the shape instead: a step whose
  purpose is to fail must be one unconditional command — no `&&`, `||`, `;`,
  pipe, subshell, reserved word, function definition or background — while
  launchers, one-shot variables, redirections and wrapped lines all still pass.
  Four spellings round 6 deliberately accepted are refused here for that reason
  and are fixtures of it; recognition still sees every one of them, which is
  what their purity proves. Every `run:` step of `deploy` is held to the same
  bar, because that job is the pipeline the mutation ledger re-executes command
  for command — and the ledger now runs each step's own argv rather than a name
  it recovered.
- **Recognising a command word is not proving what runs.** `git` means "the word
  `git` in command position", and a shell function, an alias, `hash -p`, a PATH
  assignment or a write to `$GITHUB_PATH` can all make that word mean something
  else. `no-command-shadowing` bans those spellings — derived from the command
  words the rules actually depend on, launchers and package managers included —
  and that is a list, not a proof. Executable *provenance* cannot be established
  by reading the workflow, because anything checking it also runs from the
  revision under test. It belongs to the governance trigger below.
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
- `scripts/ci/workflow-policy.mjs` enforces 26 house rules over the parsed
  workflow: no `continue-on-error`, no job conditions, no step conditions beyond
  `failure()` on an artifact upload, no shell overrides, no step timeouts, every
  action pinned to a commit SHA, no reusable workflows (a job body that is not in
  the file cannot be checked by anything in the file), `gate.needs` covering every
  job, every protected step being one unconditional command, the `deploy` job
  reaching compose only through `scripts/ci/compose-stack.mjs` so that one
  resolved file list serves the preflight and the boot alike, and —
  self-referentially — `verify`, `e2e` and `deploy` still *containing* the steps
  that do the checking, each assert script named and each one's setup ordered
  before it. `actionlint` runs alongside it.
- Both self-tests run in CI. `workflow-policy-selftest.mjs` feeds the policy 138
  mutated copies of the real workflow and additionally asserts that every one of
  the 26 declared rules has a mutation proving it fires — coverage derived from
  the engine's own rule list rather than counted by hand, which is how four rules
  went unexercised through round 2. Each mutation must also name *what* it broke
  (a message pattern, or the exact step→prerequisite edge) and must trip nothing
  else it has not declared, so a mutation cannot pass for the wrong reason: two
  of round 4's deleted a step that was required in its own right, and would have
  gone red with the rule they claimed to test removed from the engine.
  `gate-selftest.mjs` runs 118 cases, including extracting the `gate` job's
  verdict script from the workflow and **executing it** against synthetic
  `needs` payloads: a parser reads shapes, and a shape can be right while the
  logic is wrong.

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

Four things this harness deliberately does **not** guarantee, all of them owned
by that trigger rather than by anything automated:

1. **Semantics.** Every rule pins the *shape* of a gate — named, invoked as a
   command, in the right job, after its setup. Replacing an assert script's body
   with `process.exit(0)` satisfies all of them, and reachability is not
   execution: `false && git fetch …` is a genuine invocation nothing here
   evaluates.
2. **Executable provenance.** Commands are recognised by their word.
   `no-command-shadowing` bans the obvious redefinitions of one; a list of
   spellings is not a proof that `git` is git.
3. **Freedom from self-reference.** The policy engine, both self-tests, and the
   README readback that keeps these numbers honest all run from the revision
   under test. A hostile revision edits the checker and the checked in one
   commit, and the readback compares a count against prose that commit wrote.
4. **Complete mutation purity.** Each mutation must fire its own rule and
   declare any other rule it trips. A second violation of the *same* rule is
   invisible, and an `also` entry's justification is prose, not a check.

They are written down because a boundary with a sentence on it can be argued
about; a boundary that nobody wrote down is one somebody walks over.

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
