#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `${VAR:-default}`
// strings below are compose interpolation syntax being matched inside YAML text.
// They must stay literal — turning one into a template string would make this
// file edit something other than what ships.
/**
 * The mutation ledger for #26 round 6, re-runnable.
 *
 *   node scripts/mutation-ledger.mjs --list
 *   node scripts/mutation-ledger.mjs <name>      apply one mutation
 *   node scripts/mutation-ledger.mjs --restore   put every touched file back
 *
 * Every "this test catches X" claim in the round-6 receipt was produced by
 * running one of these and then the suite named beside it, rather than by
 * reading the test and believing it. Three rounds of this ticket shipped a
 * first-draft test that asserted a mechanism instead of measuring one, so the
 * ledger is a file a reviewer can run rather than a table they have to trust.
 *
 * **`packages/*` mutations need a rebuild before the e2e sees them.** The
 * Playwright suite imports `@atrium/auth` as its built `dist`, so:
 *
 *   node scripts/mutation-ledger.mjs drop-join
 *   pnpm --filter @atrium/auth build      # tsc exits non-zero on the mutated
 *                                         # tree and still emits; that is fine
 *   pnpm --filter @atrium/web exec playwright test e2e/room-access.spec.ts
 *   node scripts/mutation-ledger.mjs --restore && pnpm --filter @atrium/auth build
 *
 * Skipping that rebuild is how the first attempt at this ledger recorded "7
 * passed" against a mutation that had never been compiled.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TOUCHED = [
  'packages/auth/src/room-access.ts',
  'packages/auth/src/org.ts',
  'docker-compose.dev.yml',
  'docker-compose.yml',
  'deploy/Caddyfile.dev',
];

function edit(file, pairs) {
  let source = readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!source.includes(from)) throw new Error(`mutation target not found in ${file}:\n${from}`);
    source = source.split(from).join(to);
  }
  writeFileSync(file, source);
}

/** name → [what it reverts to, which suite should go red, how]. */
const mutations = {
  'drop-join': [
    "round 5's read: no workspace_members join, no role ceiling",
    'apps/web/e2e/room-access.spec.ts — 5 of 7 fail, the 2 positive controls hold',
    () =>
      edit('packages/auth/src/room-access.ts', [
        ['    .innerJoin(workspaceMembers, roomWorkspaceMemberJoin)\n', ''],
        [
          'export const roomAuthorizationRoles = {\n  role: memberships.role,\n  workspaceRole: workspaceMembers.role,\n} as const;',
          'export const roomAuthorizationRoles = {\n  role: memberships.role,\n} as const;',
        ],
        [
          'const role = parseRole(lowerOf(row.role, row.workspaceRole));',
          'const role = parseRole(row.role);',
        ],
      ]),
  ],

  'drop-ceiling': [
    'the join stays, only the role ceiling goes — isolates the demotion half',
    'room-access.spec.ts 1 of 7, and packages/auth/test/room-access.test.ts 4 of 9',
    () =>
      edit('packages/auth/src/room-access.ts', [
        [
          'const role = parseRole(lowerOf(row.role, row.workspaceRole));',
          'const role = parseRole(row.role);',
        ],
      ]),
  ],

  'drop-report': [
    "round 5's swallow: log the message, tell nobody",
    'packages/auth/test/org.test.ts — 3 of 40',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          "          reportCleanupFailure({\n            operation: 'revokeWorkspaceRooms',\n            phase: 'afterRemoveMember',\n            workspaceId,\n            userId: data.member.userId,\n            error: error instanceof Error ? error : new Error(String(error)),\n          });",
          "          logger.error('room revocation sweep failed after member removal', {\n            userId: data.member.userId,\n            error: (error as Error).message,\n          });",
        ],
      ]),
  ],

  'unbind-dev': [
    "round 5's dev binding: publish on every interface, answer any Host",
    'packages/auth/test/deployment.test.ts — 2 of 5',
    () => {
      edit('docker-compose.dev.yml', [
        ["- '127.0.0.1:${WEB_PORT:-3000}:80'", "- '${WEB_PORT:-3000}:80'"],
      ]);
      edit('deploy/Caddyfile.dev', [['localhost:80, 127.0.0.1:80, [::1]:80 {', ':80 {']]);
    },
  ],

  'drop-refusal': [
    'the loopback site addresses stay, the 421 fallback goes — a foreign Host then gets an empty 200',
    'packages/auth/test/deployment.test.ts — 1 of 5',
    () =>
      edit('deploy/Caddyfile.dev', [
        [
          ':80 {\n\trespond "atrium dev proxy: this stack answers on localhost only (docker-compose.dev.yml)" 421\n}\n',
          '',
        ],
      ]),
  ],

  'unbind-infra': [
    "round 5's production infra binding: postgres and minio on 0.0.0.0",
    'packages/auth/test/deployment.test.ts — 1 of 5',
    () =>
      edit('docker-compose.yml', [
        ["- '127.0.0.1:${POSTGRES_PORT:-5432}:5432'", "- '${POSTGRES_PORT:-5432}:5432'"],
        ["- '127.0.0.1:${MINIO_PORT:-9000}:9000'", "- '${MINIO_PORT:-9000}:9000'"],
        ["- '127.0.0.1:${MINIO_CONSOLE_PORT:-9001}:9001'", "- '${MINIO_CONSOLE_PORT:-9001}:9001'"],
      ]),
  ],
};

const [name] = process.argv.slice(2);

if (name === '--restore') {
  execFileSync('git', ['checkout', '--', ...TOUCHED], { stdio: 'inherit' });
  console.info('restored; rebuild with `pnpm --filter @atrium/auth build` before re-running e2e');
} else if (name === '--list' || name === undefined) {
  for (const [key, [what, suite]] of Object.entries(mutations)) {
    console.info(`${key.padEnd(14)} ${what}\n${' '.repeat(15)}-> ${suite}`);
  }
} else if (mutations[name]) {
  mutations[name][2]();
  console.info(`applied ${name} -> expect red in: ${mutations[name][1]}`);
} else {
  console.error(`unknown mutation "${name}"; try --list`);
  process.exit(1);
}
