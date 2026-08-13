#!/usr/bin/env bash
# Run the real-Postgres integration suite (issue #22) against the compose
# service in docker-compose.test.yml.
#
#   pnpm test:integration              # up → migrate → vitest → down
#   pnpm test:integration --keep       # leave the database running afterwards
#   ATRIUM_TEST_DATABASE_URL=... pnpm test:integration
#                                      # use a database you already have; this
#                                      # script then touches compose not at all
#
#   ATRIUM_TEST_COMPOSE_PROJECT=lane2 ATRIUM_TEST_PG_PORT=55447 pnpm test:integration
#                                      # a lane of its own: separate compose
#                                      # project AND separate port
#
# There is no in-suite skip. A test that quietly passes when its database is
# missing is worse than one that fails loudly, because the gate it guards keeps
# reporting green — so if the database cannot be reached, this exits non-zero.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE=docker-compose.test.yml
# THE PROJECT NAME IS A LANE, and it has to be overridable for the same reason
# the port already is — so parallel worktrees can each run the suite against
# their own isolated compose project (and Postgres port) without tearing down
# each other's. It was hardcoded, so two agents running this concurrently on
# different ports still shared one compose project — the second `up` adopted the
# first's container and the trap on either one's exit tore the other's database
# out from under it, mid-suite. A port without a project is half an isolation.
PROJECT="${ATRIUM_TEST_COMPOSE_PROJECT:-atrium-test}"
PORT="${ATRIUM_TEST_PG_PORT:-55445}"
KEEP=0
VITEST_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--keep" ]; then
    KEEP=1
  else
    VITEST_ARGS+=("$arg")
  fi
done

if [ -n "${ATRIUM_TEST_DATABASE_URL:-}" ]; then
  echo "integration: using ATRIUM_TEST_DATABASE_URL, leaving compose alone"
  export ATRIUM_TEST_DATABASE_URL
else
  export ATRIUM_TEST_DATABASE_URL="postgres://atrium_test:atrium_test@127.0.0.1:${PORT}/atrium_test"

  cleanup() {
    if [ "$KEEP" -eq 0 ]; then
      docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down --remove-orphans --volumes >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT

  echo "integration: starting compose postgres on :${PORT}"
  ATRIUM_TEST_PG_PORT="$PORT" docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --wait postgres-test
fi

# Migrations are applied by the suite's own global setup, from the same drizzle
# folder the server ships — the tests exercise the real migrations, never a
# hand-built schema.
#
# Not `exec`: the EXIT trap above is what stops the container, and exec would
# replace this shell before it could fire.
if [ "${#VITEST_ARGS[@]}" -eq 0 ]; then
  # Bash 3.2 treats an empty-array expansion as an unset variable under `set
  # -u`. Keep the no-argument gate runnable on the macOS system Bash.
  pnpm exec vitest run --config vitest.integration.config.ts
else
  pnpm exec vitest run --config vitest.integration.config.ts "${VITEST_ARGS[@]}"
fi
