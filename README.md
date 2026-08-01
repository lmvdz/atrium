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

Two things enforce that rather than merely asking:

- Every secret in `docker-compose.yml` is `${VAR:?...}` with **no default**.
  Compose refuses to start when one is unset instead of reusing a known
  password. That is why `cp .env.example .env` is the first step above.
- `apps/server/src/env.ts` applies its dev fallback for `S3_ACCESS_KEY_ID` /
  `S3_SECRET_ACCESS_KEY` **only** when `NODE_ENV=development`. The `server`
  service runs `NODE_ENV=production`, so a deployment missing them fails at
  boot with a named error rather than reaching for a public secret.

Before exposing anything: set real values in `.env` (or the deployment's own
secret store), and do not publish 5432 / 9000 / 9001 at all unless you mean to.
Only 3000 and 4000 need to face the internet.

## Layout

```
apps/web        Next.js 16 App Router, React 19. The three-region shell.
apps/server     Node 22. ws WebSocket server + pg-boss workers. One process.
packages/core   The Semantic Core. Pure TypeScript, zero I/O.
packages/db     Drizzle schema, migrations, postgres-js client.
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
`accepted` one. An acceptance that cites a proposal must cite one that exists,
is still open, has not already been spent on another object, and matches the
object's type; an object with no proposal at all stays legal, because a human
writing a decision directly is not an interpretation.

Live folding gets the same guarantee. `reduce([next], state)` cannot re-sort
what it has already folded, so `CoreState.watermarks` holds each room's last
consumed `(at, id)` and an event arriving before it is refused into
`state.issues` rather than applied out of order. A live fold and a full replay
of the same accepted sequence therefore land on the same bytes.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Build packages, then web + server in watch mode |
| `pnpm build` | Build packages, then both apps |
| `pnpm test` | Vitest across `packages/*` |
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
