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
cp .env.example .env      # defaults work as-is
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
docker compose up --build   # postgres, minio, migrate, server, app
```

Same compose file locally and on the VPS (issue #18) — only `.env` differs.

## Layout

```
apps/web        Next.js 16 App Router, React 19. Shell, auth screens, workspaces.
apps/server     Node 22. ws WebSocket server + pg-boss workers. One process.
packages/core   The Semantic Core. Pure TypeScript, zero I/O.
packages/db     Drizzle schema, migrations, postgres-js client.
packages/auth   One Better Auth configuration + `authorize()`. Shared by both apps.
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
- **A socket does not outlive its session.** Each command re-validates, cached
  for `WS_REVALIDATE_TTL_MS` (5s), so a revoked session loses its socket within
  that window. Room membership is read per command with no cache at all, so
  removing somebody takes effect on their very next frame.

Removing or demoting a workspace member reconciles room membership in the same
operation (`packages/auth/src/org.ts`, `workspace.ts`) — room membership is what
the realtime server authorizes against, so it is what removal has to remove.

Only two of Better Auth's HTTP endpoints are actually mounted
(`packages/auth/src/mounted.ts`): the verification link and the OAuth callback.
Everything else Atrium needs it calls in-process from a Server Action, where
`authorize()` and the sign-in throttle live, so publishing the rest would only
provide a way around both. The organization plugin additionally enforces its own
policy in `beforeCreateInvitation` — nobody can hand out a role they do not hold
themselves — so the rule holds even for a caller who does reach the API.

Email verification and invitations both go through the mailer
(`packages/auth/src/mailer.ts`). In development it prints to the console and,
when `ATRIUM_MAIL_OUTBOX` is set, appends one JSON object per message to a file;
the e2e suite reads its links from there. **There is no production transport
yet, and the process refuses to boot with `NODE_ENV=production` until one is
passed** — those links are one-click account takeovers and belong in an inbox,
not in a log aggregator.

Sign-in, sign-up and resend are throttled per address *and* per IP
(`packages/auth/src/throttle.ts`). The IP dimension believes forwarded headers
only as far as `ATRIUM_TRUSTED_PROXY_HOPS` tells it to — `1` behind a single
reverse proxy, `0` (the default) meaning "trust no header", in which case the
address dimension carries the load rather than a spoofable one pretending to.
Counters are per-process and reset on restart, which is honest for the one-node
deployment in issue #18 and must move to Postgres or Redis if that changes.

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

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Build packages, then web + server in watch mode |
| `pnpm build` | Build packages, then both apps |
| `pnpm test` | Vitest across `packages/*` and `apps/server` |
| `pnpm test:e2e` | Playwright: shell, auth, workspaces, WebSocket authorization |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome with safe fixes applied |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm infra:up` / `infra:down` | Postgres + MinIO only |

Playwright needs its browser once: `pnpm --filter @atrium/web exec playwright
install chromium`. Without it the suite skips with a reason instead of failing —
a red e2e run should mean "the app is broken", never "no browser here".

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
