#!/usr/bin/env bash
# T6 (#220) forge-fix acceptance run — ISOLATED stack (project atrium-t6fv, unique ports).
# Mirrors two-browser-run.sh but overrides the compose project + ports so it never
# touches the default atrium-*, the shared atrium-e2e-*, the T5 atrium-t5electric, or
# any dagon-* tenant. ALWAYS tears the stack down (down -v), green or red.
set -euo pipefail
cd "$(dirname "$0")/../.."   # apps/web

export ELECTRIC_STACK_PROJECT="atrium-t6fv"
export ELECTRIC_STACK_PG_PORT="55436"
export ELECTRIC_STACK_ELECTRIC_PORT="3113"
# The app, harness and Electric all share THIS isolated postgres.
export E2E_DATABASE_URL="postgres://atrium:atrium@127.0.0.1:${ELECTRIC_STACK_PG_PORT}/atrium"

teardown() {
  node e2e/support/electric-stack.mjs down || true
}
trap teardown EXIT

echo "== [1/4] Electric stack up (project ${ELECTRIC_STACK_PROJECT}, pg ${ELECTRIC_STACK_PG_PORT}, electric ${ELECTRIC_STACK_ELECTRIC_PORT}) =="
node e2e/support/electric-stack.mjs up

echo "== [2/4] app database prepared (migrate/truncate/seed + e2e minio) =="
node e2e/support/ensure-database.mjs

echo "== [3/4] playwright install chromium =="
pnpm exec playwright install chromium >/dev/null 2>&1 || pnpm exec playwright install chromium

echo "== [4/4] acceptance suite, twice (green twice at concurrency) =="
pnpm exec playwright test --config playwright.destination-electric.config.ts --repeat-each=2

echo "== acceptance run complete =="
