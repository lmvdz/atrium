/**
 * Stub every predicate in `@atrium/auth` fail-open, and report which tests do
 * not notice.
 *
 * ## Why this exists
 *
 * The round-10 gauntlet found `authz.test.ts`'s "is the single list of commands
 * — nothing is authorized off-table", which asserted
 * `Object.keys(commandPolicy).every(isCommand)` — where `isCommand` **is**
 * `Object.hasOwn(commandPolicy, value)`. That holds for every possible table and
 * every possible implementation: it is a restatement of a definition wearing a
 * test's name. The critic proved it by replacing `isCommand` with
 * `typeof value === 'string'` and watching that test pass alone.
 *
 * That is a *class*, not an instance, and the way to find the class is to do the
 * same thing to every predicate: replace its body with the answer that lets
 * everything through, then ask which assertions still hold. A predicate whose
 * fail-open stub breaks nothing is a predicate nothing tests. A *test* that
 * survives the stub of the predicate it names is a test about something else.
 *
 * This is deliberately **not** a mutation-ledger row. The ledger records one
 * curated mutation per claim, with a receipt; this is a sweep that answers "what
 * else is like that", is expected to be run when predicates are added, and
 * prints a table rather than a verdict.
 *
 *   node scripts/predicate-sweep.mjs            # every predicate
 *   node scripts/predicate-sweep.mjs isCommand  # one
 *
 * Exits non-zero if any predicate's fail-open stub leaves the whole suite green,
 * because that predicate is then load-bearing in production and untested here.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = 'packages/auth';

/**
 * Each entry: the file, the exact signature line, and the fail-open body.
 *
 * Written as a literal match against the source rather than as a regex, for the
 * same reason the mutation ledger is: a stub that silently stops matching
 * measures nothing, and a string that no longer appears fails loudly here.
 */
const PREDICATES = [
  {
    name: 'isRole',
    file: 'src/authz.ts',
    from: 'export function isRole(value: unknown): value is Role {',
    open: "export function isRole(value: unknown): value is Role {\n  return typeof value === 'string' as unknown as boolean;",
  },
  {
    name: 'isCommand',
    file: 'src/authz.ts',
    from: 'export function isCommand(value: unknown): value is Command {',
    open: "export function isCommand(value: unknown): value is Command {\n  return typeof value === 'string' as unknown as boolean;",
  },
  {
    name: 'mayGrantRole',
    file: 'src/authz.ts',
    from: 'export function mayGrantRole(actorRole: string, requestedRole: string): boolean {',
    open: 'export function mayGrantRole(actorRole: string, requestedRole: string): boolean {\n  return true;',
  },
  {
    name: 'isDemotion',
    file: 'src/org.ts',
    from: 'export function isDemotion(currentRole: string | null, nextRole: string): boolean {',
    open: 'export function isDemotion(currentRole: string | null, nextRole: string): boolean {\n  return false;',
  },
  {
    name: 'assertKnownRole',
    file: 'src/org.ts',
    from: 'export function assertKnownRole(raw: unknown): string {',
    open: 'export function assertKnownRole(raw: unknown): string {\n  return String(raw);',
  },
  {
    name: 'mayInvite',
    file: 'src/org.ts',
    from: 'function mayInvite(inviterRole: string | null, requestedRole: string): boolean {',
    open: 'function mayInvite(inviterRole: string | null, requestedRole: string): boolean {\n  return true;',
  },
  {
    name: 'isMountedAuthPath',
    file: 'src/mounted.ts',
    from: 'export function isMountedAuthPath(pathname: string, method: string): boolean {',
    open: 'export function isMountedAuthPath(pathname: string, method: string): boolean {\n  return true;',
  },
  {
    name: 'isSecureUrl',
    file: 'src/transport.ts',
    from: 'export function isSecureUrl(value: string): boolean {',
    open: 'export function isSecureUrl(value: string): boolean {\n  return true;',
  },
  {
    name: 'requiresSecureTransport',
    file: 'src/transport.ts',
    from: 'export function requiresSecureTransport(env: TransportSource = process.env): boolean {',
    open: 'export function requiresSecureTransport(env: TransportSource = process.env): boolean {\n  return false;',
  },
  {
    name: 'useSecureCookies',
    file: 'src/transport.ts',
    from: 'export function useSecureCookies(baseURL: string): boolean {',
    open: 'export function useSecureCookies(baseURL: string): boolean {\n  return false;',
  },
  {
    name: 'hasProxyStrategy',
    file: 'src/client-ip.ts',
    from: 'export function hasProxyStrategy(env: NodeJS.ProcessEnv = process.env): boolean {',
    open: 'export function hasProxyStrategy(env: NodeJS.ProcessEnv = process.env): boolean {\n  return true;',
  },
  {
    name: 'effectiveRoomRole',
    file: 'src/room-access.ts',
    from: 'export function effectiveRoomRole(',
    open: 'export function effectiveRoomRole(\n  ...ignored: unknown[]\n): "owner" | null {\n  return "owner";\n}\nfunction unusedEffectiveRoomRole(',
  },
];

/** Every test name the auth suite runs, with its verdict. */
function runSuite() {
  const result = spawnSync('pnpm', ['vitest', 'run', '--reporter=json', '--silent'], {
    cwd: PACKAGE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = result.stdout ?? '';
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const report = JSON.parse(text.slice(start));
    const failed = new Set();
    let total = 0;
    for (const file of report.testResults ?? []) {
      for (const test of file.assertionResults ?? []) {
        total += 1;
        if (test.status === 'failed') failed.add(test.fullName);
      }
    }
    return { total, failed };
  } catch {
    return null;
  }
}

function apply(predicate) {
  const path = join(PACKAGE, predicate.file);
  const before = readFileSync(path, 'utf8');
  if (!before.includes(predicate.from)) {
    throw new Error(
      `${predicate.name}: the signature this sweep stubs is no longer in ${predicate.file}.\n` +
        'A stub that cannot apply measures nothing; repoint it.',
    );
  }
  writeFileSync(path, before.replace(predicate.from, predicate.open));
  return () => writeFileSync(path, before);
}

const only = process.argv.slice(2);
const chosen = only.length === 0 ? PREDICATES : PREDICATES.filter((p) => only.includes(p.name));
if (chosen.length === 0) throw new Error(`no predicate named ${only.join(', ')}`);

const baseline = runSuite();
if (!baseline) throw new Error('the baseline suite produced no JSON report');
if (baseline.failed.size > 0) {
  throw new Error(`the baseline suite is red (${baseline.failed.size} failing); fix that first`);
}
console.info(`baseline: ${baseline.total} tests, all green\n`);

const unnoticed = [];
for (const predicate of chosen) {
  const restore = apply(predicate);
  let measured;
  try {
    measured = runSuite();
  } finally {
    restore();
  }
  if (!measured) {
    console.error(`${predicate.name.padEnd(24)} NO REPORT (the package did not build)`);
    continue;
  }
  const caught = [...measured.failed];
  if (caught.length === 0) unnoticed.push(predicate.name);
  console.info(
    `${predicate.name.padEnd(24)} ${String(caught.length).padStart(3)} test(s) noticed` +
      (caught.length === 0 ? '   <- FAIL-OPEN AND UNTESTED' : ''),
  );
  for (const name of caught.slice(0, 4)) console.info(`${' '.repeat(28)}${name}`);
  if (caught.length > 4) console.info(`${' '.repeat(28)}…and ${caught.length - 4} more`);
}

if (unnoticed.length > 0) {
  console.error(
    `\n${unnoticed.length} predicate(s) can be stubbed fail-open with the whole suite still ` +
      `green: ${unnoticed.join(', ')}.\nEach one is a decision nothing measures.`,
  );
  process.exit(1);
}
console.info('\nevery predicate is noticed by at least one test');
