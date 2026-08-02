/**
 * Where the integration suite's database is.
 *
 * There is no default and no skip. A test that silently passes when its
 * database is missing turns the verification gate into decoration — the suite
 * keeps reporting green while proving nothing. `pnpm test:integration` sets
 * this from the compose service; see `scripts/integration-test.sh`.
 */
export function databaseUrl(): string {
  const url = process.env.ATRIUM_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'ATRIUM_TEST_DATABASE_URL is not set — run `pnpm test:integration`, which starts the compose service in docker-compose.test.yml and points this at it. These tests need a real Postgres and will not pretend otherwise.',
    );
  }
  return url;
}
