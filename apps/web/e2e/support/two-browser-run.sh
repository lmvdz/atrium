#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# T5 (#219) — the two-real-browser covenant acceptance run, end to end.
#
#   1. stand up the dedicated Electric stack (postgres logical + role + electric)
#      under its own compose project on unique ports (electric-stack.mjs up),
#   2. prepare the app DB against that same postgres (ensure-database.mjs:
#      migrate/truncate/seed + the e2e minio),
#   3. run the acceptance suite in production posture with Electric wired in —
#      TWICE (--repeat-each=2) to prove it is not flaky under contention,
#   4. ALWAYS tear the Electric stack down (down -v), green or red.
#
# Run from apps/web:  bash e2e/support/two-browser-run.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/../.."   # apps/web

# The T5 postgres the app, the harness and Electric all share. Exported BEFORE
# node loads any config so config.mjs's `databaseUrl` resolves to it.
export E2E_DATABASE_URL="postgres://atrium:atrium@127.0.0.1:55433/atrium"

teardown() {
  node e2e/support/electric-stack.mjs down || true
}
trap teardown EXIT

echo "== [1/4] Electric stack up =="
node e2e/support/electric-stack.mjs up

echo "== [2/4] app database prepared (migrate/truncate/seed + minio) =="
node e2e/support/ensure-database.mjs

echo "== [3/4] playwright install chromium =="
pnpm exec playwright install chromium

echo "== [4/4] acceptance suite, twice (green twice at concurrency) =="
pnpm exec playwright test --config playwright.destination-electric.config.ts --repeat-each=2

echo "== acceptance run complete =="
