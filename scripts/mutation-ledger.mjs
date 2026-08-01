#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `${VAR:-default}`
// strings below are compose interpolation syntax being matched inside YAML text.
// They must stay literal — turning one into a template string would make this
// file edit something other than what ships.
/**
 * The mutation ledger for #26, rounds 6 to 9, re-runnable.
 *
 *   node scripts/mutation-ledger.mjs --list
 *   node scripts/mutation-ledger.mjs <name>          apply one mutation
 *   node scripts/mutation-ledger.mjs --against <ref> <path…>
 *                                                    swap in a previous round's
 *                                                    files to re-measure it
 *   node scripts/mutation-ledger.mjs --restore       put everything back
 *   node scripts/mutation-ledger.mjs --verify        every mutation still applies
 *   node scripts/mutation-ledger.mjs --prove <name…> mutate, build, run the
 *                                                    suite, assert it went red,
 *                                                    write the receipt
 *   node scripts/mutation-ledger.mjs --prove-all     every row, one baseline per
 *                                                    suite
 *   node scripts/mutation-ledger.mjs --receipts [--strict]
 *                                                    the table, read out of the
 *                                                    receipts
 *
 * `--restore` restores from a snapshot this script takes, not from git — see
 * {@link SNAPSHOT}. It is safe to run on a dirty tree, and one mutation must be
 * restored before the next is applied.
 *
 * Every "this test catches X" claim in the round-6 and round-7 receipts was
 * produced by running one of these and then the suite named beside it, rather
 * than by reading the test and believing it. Three rounds of this ticket shipped
 * a first-draft test that asserted a mechanism instead of measuring one, so the
 * ledger is a file a reviewer can run rather than a table they have to trust.
 *
 * ## Rebuild every artifact the suites consume, before running them
 *
 * This is the round-6 lesson and it is not a footnote. The Playwright suite
 * imports `@atrium/auth` as its built `dist`, so a mutation to `packages/*`
 * source that is not compiled is a mutation the e2e never sees — the first run
 * of this ledger recorded *seven passes* against `drop-join` for exactly that
 * reason, which is worse than no ledger at all.
 *
 *   node scripts/mutation-ledger.mjs drop-join
 *   pnpm --filter @atrium/auth build      # tsc exits non-zero on the mutated
 *                                         # tree and still emits; that is fine
 *   pnpm --filter @atrium/web exec playwright test e2e/room-access.spec.ts
 *   node scripts/mutation-ledger.mjs --restore && pnpm --filter @atrium/auth build
 *
 * `--restore` prints the rebuild command for the same reason.
 *
 * Two of round 7's mutations consume artifacts that are **not** `dist`, and they
 * are listed here so nobody has to rediscover the rule in a new shape:
 *
 *  - `regex-boundary` reverts the import-boundary analysis to round 6's regex.
 *    Its suite (`packages/auth/test/room-access.test.ts`) imports the analysis
 *    from source through vitest, so no build step — but it *reads the working
 *    tree*, so it must be run from a tree with no other mutation applied.
 *  - `drop-await` and `unguard-logger` are unit-level only
 *    (`packages/auth/test/org.test.ts`, source-imported). No rebuild needed, and
 *    saying so is part of the discipline: "no rebuild needed" is a claim about
 *    how a suite loads its subject, and it was checked.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOUCHED = [
  'packages/auth/src/room-access.ts',
  'packages/auth/src/org.ts',
  'packages/auth/src/errors.ts',
  'packages/auth/test/support/import-boundary.ts',
  'packages/auth/test/room-access.test.ts',
  'apps/server/src/ws-server.ts',
  'apps/server/src/ws-auth.ts',
  'docker-compose.dev.yml',
  'docker-compose.yml',
  'deploy/Caddyfile.dev',
];

/**
 * Where the pre-mutation copies live, and why `--restore` is no longer git.
 *
 * Round 7 recorded this as a known limit and left it: `--restore` was
 * `git checkout -- <TOUCHED>`, which restores from the *index*, not from what
 * the file looked like a moment ago. Run mid-round — which is the only time
 * anyone runs it — it silently reverted uncommitted work on every file it could
 * reach. It did exactly that again in round 8, to the fix this ledger existed to
 * measure, so it is fixed rather than named a third time.
 *
 * Applying a mutation now copies each touched file here first, and `--restore`
 * puts those copies back. Two consequences worth stating: it works on a dirty
 * tree, which is the normal state while a round is in flight; and it refuses to
 * apply a second mutation over a first, because the snapshot would then be of
 * already-mutated files. `node_modules/.cache` is never tracked, so the copies
 * cannot be committed by accident.
 */
const SNAPSHOT = 'node_modules/.cache/atrium-mutation-ledger';

/** Copy the given files aside, so `--restore` has something honest. */
function snapshotPaths(files) {
  if (existsSync(SNAPSHOT)) {
    throw new Error(
      `a mutation is already applied (${SNAPSHOT} exists).\n` +
        'Run `node scripts/mutation-ledger.mjs --restore` before applying another —\n' +
        'snapshotting mutated files would make --restore restore the mutation.',
    );
  }
  mkdirSync(SNAPSHOT, { recursive: true });
  for (const file of files) {
    if (!existsSync(file)) continue;
    writeFileSync(join(SNAPSHOT, file.split('/').join('%')), readFileSync(file));
  }
}

/** Everything any mutation can reach. */
function snapshot() {
  snapshotPaths(TOUCHED);
}

function restore() {
  if (!existsSync(SNAPSHOT)) {
    console.info('nothing to restore: no mutation is applied');
    return;
  }
  for (const entry of readdirSync(SNAPSHOT)) {
    writeFileSync(entry.split('%').join('/'), readFileSync(join(SNAPSHOT, entry)));
  }
  rmSync(SNAPSHOT, { recursive: true, force: true });
  console.info('restored; rebuild with `pnpm --filter @atrium/auth build` before re-running e2e');
}

/**
 * Which files the mutation currently being applied actually rewrote.
 *
 * Collected rather than declared, because a declared list is one more thing that
 * can go stale — and this one feeds `subjectHash` in a receipt, which is what
 * makes a receipt notice that the code it was measured against has moved.
 */
let editedFiles = new Set();

function edit(file, pairs) {
  let source = readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!source.includes(from)) throw new Error(`mutation target not found in ${file}:\n${from}`);
    source = source.split(from).join(to);
  }
  writeFileSync(file, source);
  editedFiles.add(file);
}

/** name → [what it reverts to, which suite should go red, how]. */
const mutations = {
  'drop-join': [
    "round 5's read: no workspace_members join, no role ceiling",
    'apps/web/e2e/room-access.spec.ts — the workspace-role paths; the positive controls hold',
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
    'apps/web/e2e/room-access.spec.ts and packages/auth/test/room-access.test.ts — the demotion half alone',
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
    'packages/auth/test/org.test.ts — every assertion about the cleanup reporter. Round 7 recorded 3; the reporter has eleven more tests around it now, which is why a hand-copied count is worth less than a receipt.',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          "          await reportCleanupFailure({\n            operation: 'revokeWorkspaceRooms',\n            phase: 'afterRemoveMember',\n            workspaceId,\n            userId: data.member.userId,\n            error,\n          });",
          "          logger.error('room revocation sweep failed after member removal', {\n            userId: data.member.userId,\n            error: (error as Error).message,\n          });",
        ],
      ]),
  ],

  'unbind-dev': [
    "round 5's dev binding: publish on every interface, answer any Host",
    'packages/auth/test/deployment.test.ts — the dev-binding assertions',
    () => {
      edit('docker-compose.dev.yml', [
        ["- '127.0.0.1:${WEB_PORT:-3000}:80'", "- '${WEB_PORT:-3000}:80'"],
      ]);
      edit('deploy/Caddyfile.dev', [['localhost:80, 127.0.0.1:80, [::1]:80 {', ':80 {']]);
    },
  ],

  'drop-refusal': [
    'the loopback site addresses stay, the 421 fallback goes — a foreign Host then gets an empty 200',
    'packages/auth/test/deployment.test.ts — the 421-fallback assertion',
    () =>
      edit('deploy/Caddyfile.dev', [
        [
          ':80 {\n\trespond "atrium dev proxy: this stack answers on localhost only (docker-compose.dev.yml)" 421\n}\n',
          '',
        ],
      ]),
  ],

  // ── round 7 ────────────────────────────────────────────────────────────────

  'drop-await': [
    "round 6's un-awaited reporter — the live crash path",
    'packages/auth/test/org.test.ts — the reporter tests, including the unhandled-rejection watch',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          '      const returned = input.onCleanupFailure?.(failure);',
          '      input.onCleanupFailure?.(failure);\n      const returned = undefined;',
        ],
      ]),
  ],

  'unguard-logger': [
    "round 6's unprotected `logger.error` — a throwing log transport fails a committed removal",
    'packages/auth/test/org.test.ts and packages/auth/test/errors.test.ts. Round 9 moved the guard from `org.ts` into `errors.ts`, so this now covers both files at once; it threw "mutation target not found" until it was repointed, which is the ledger doing its job.',
    () =>
      edit('packages/auth/src/errors.ts', [
        [
          '    try {\n      logger.error(message, fields());\n    } catch {\n      // Intentionally empty; see above.\n    }',
          '    logger.error(message, fields());',
        ],
      ]),
  ],

  'boundary-names-only': [
    'the import boundary stops looking at whole-module references (namespace, dynamic, require, `export *`)',
    'packages/auth/test/room-access.test.ts — the whole-module evasion fixtures',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        [
          '      if (reference.whole) {\n        if (!exposesAnything(target)) continue;',
          '      if (reference.whole) {\n        continue;\n        // biome-ignore lint/correctness/noUnreachable: mutation\n        if (!exposesAnything(target)) continue;',
        ],
      ]),
  ],

  'boundary-no-helpers': [
    'rule 2 goes: a module may hold the table and export a wrapper around it',
    'packages/auth/test/room-access.test.ts — the laundered-helper fixtures and the empty-allowlist premise',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        ['        if (touches) before.all = true;', '        void touches;'],
      ]),
  ],

  'boundary-no-access': [
    'the whole access half goes — the table reached off a handle stops being seen at all',
    "packages/auth/test/room-access.test.ts — the whole access half. **The round-8 receipt recorded 8 of 48 and that was wrong**: measured on r8's own tree (`--against fix/auth-r8`) it failed 11 of 48. 8 is `r7-access-analysis`'s number, one row up — a transcription slip in the very table whose header says a table copied forward is a defect with an extra step, and the reason counts now come from `--prove` rather than from this string.",
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        [
          '    if (rule.forbiddenAccessName !== undefined) {',
          '    if (rule.forbiddenAccessName === undefined) {',
        ],
      ]),
  ],

  'regex-boundary': [
    "round 6's regex, in effect: named imports of a literal specifier and nothing else",
    'packages/auth/test/room-access.test.ts — most of it; of the evasion fixtures, the named-import shapes the regex was written for are the ones that still fire',
    () => {
      mutations['boundary-names-only'][2]();
      mutations['boundary-no-helpers'][2]();
      mutations['boundary-no-access'][2]();
      edit('packages/auth/test/support/import-boundary.ts', [
        [
          '    if (found) return rel(found);\n    return root ? rel(root) : null;',
          '    if (found) return rel(found);\n    return null;',
        ],
      ]);
    },
  ],

  // ── round 8 ────────────────────────────────────────────────────────────────

  'normalize-outside-guard': [
    "round 7's hole one line upstream of its own guard: `String(error)` at the call site",
    'packages/auth/test/org.test.ts — the un-normalizable-rejection tests',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          '            userId: data.member.userId,\n            error,\n          });',
          '            userId: data.member.userId,\n            error: error instanceof Error ? error : new Error(String(error)),\n          });',
        ],
      ]),
  ],

  'drop-report-deadline': [
    "round 7's unbounded await on the reporter — a pager that never answers hangs a committed removal",
    'packages/auth/test/org.test.ts — the reporter-deadline tests (one of them by never finishing)',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          '      const outcome = await withDeadline(\n        Promise.resolve(returned),\n        reportTimeoutMs,',
          '      const outcome = await withoutDeadline(\n        Promise.resolve(returned),\n        reportTimeoutMs,',
        ],
        [
          'function withDeadline(\n  work: Promise<unknown>,',
          "async function withoutDeadline(\n  work: Promise<unknown>,\n  _timeoutMs: number,\n  _onLateRejection: (reason: unknown) => void,\n): Promise<'settled' | 'timed-out'> {\n  await work;\n  return 'settled';\n}\n\nfunction withDeadline(\n  work: Promise<unknown>,",
        ],
      ]),
  ],

  'r7-access-analysis': [
    "round 7's access check in effect: receiver-blind, property and literal string index only",
    'packages/auth/test/room-access.test.ts — the destructuring, computed-key and receiver fixtures. The limit fixtures are receiver controls too, and a receiver-blind check reports every one of them.',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        [
          '  const visit = (node: ts.Node): void => {\n    if (ts.isPropertyAccessExpression(node)) {',
          '  const visit = (node: ts.Node): void => {\n' +
            '    const r7Named =\n' +
            '      (ts.isPropertyAccessExpression(node) && node.name.text === accessName) ||\n' +
            '      (ts.isElementAccessExpression(node) &&\n' +
            '        ts.isStringLiteral(node.argumentExpression) &&\n' +
            '        node.argumentExpression.text === accessName);\n' +
            "    if (r7Named) record(node, ts.isElementAccessExpression(node) ? 'string-index' : 'property');\n" +
            '    ts.forEachChild(node, visit);\n' +
            '    return;\n' +
            '    // biome-ignore lint/correctness/noUnreachable: mutation\n' +
            '    if (ts.isPropertyAccessExpression(node)) {',
        ],
      ]),
  ],

  'boundary-no-destructuring': [
    'the destructuring half goes — `const { memberships: rows } = db().query` becomes invisible again',
    'packages/auth/test/room-access.test.ts — the destructuring fixtures, in both binding positions',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        [
          '      walkPattern(node.name);\n    }\n    ts.forEachChild(node, visit);',
          '      void walkPattern;\n    }\n    ts.forEachChild(node, visit);',
        ],
      ]),
  ],

  'boundary-literal-keys-only': [
    'the unresolvable-key half goes — `db().query[someVar]` reads as fine again',
    'packages/auth/test/room-access.test.ts — the unresolvable-key fixtures',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        ["          record(node, 'computed-key');", '          void 0;'],
      ]),
  ],

  'boundary-blind-receiver': [
    'the receiver question goes — every `anything.memberships` under apps/ fires again',
    'packages/auth/test/room-access.test.ts — the receiver controls, the real-repo access assertion (which then names every legitimate computed access under apps/ — `order[level]`, `errors[error]`, `holder[key]`…) and the limit fixtures, every one of which a receiver-blind check reports. That list is the argument for asking about the receiver.',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        [
          '    const isHandle = (node: ts.Expression): boolean => {',
          '    const isHandle = (_node: ts.Expression): boolean => {\n      return true;\n      // biome-ignore lint/correctness/noUnreachable: mutation\n    };\n    const unusedIsHandle = (node: ts.Expression): boolean => {',
        ],
      ]),
  ],

  'sweep-latch-forever': [
    "round 7's sweep: unbounded lookups behind a latch only a finished pass releases",
    'apps/server/test/ws-server.test.ts — the latch tests, both by hanging until vitest gives up',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          'function withLookupDeadline<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {\n  let settled = false;',
          'function withLookupDeadline<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {\n  return work;\n  // biome-ignore lint/correctness/noUnreachable: mutation\n  let settled = false;',
        ],
        [
          '    const release = setTimeout(() => {\n      if (!sweeping) return;\n      sweeping = false;',
          '    const release = setTimeout(() => {\n      if (!sweeping) return;',
        ],
      ]),
  ],

  'widen-sweep-window': [
    'the sweep still runs, just four times less often — the window survives, the ceiling does not',
    'apps/server/test/ws-server.test.ts — the sweep-window tests; proves they measure a duration and not merely an eventual close',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          '  }, sweepIntervalMs);\n  sweep.unref();',
          '  }, sweepIntervalMs * 4);\n  sweep.unref();',
        ],
      ]),
  ],

  // ── round 9 ────────────────────────────────────────────────────────────────
  //
  // Three independent things went wrong at each site in round 8, and each entry
  // below restores exactly one of them, because "the fix works" is not the same
  // claim as "each half of the fix is load-bearing".
  //
  // Measured, and the first draft of this ledger got it wrong: a mutation that
  // restored `(error as Error).message` *inside* the `logSafely` thunk left
  // every suite green, because building the fields is inside the guard. That is
  // a real property of the fix and not a defect in the test — but it means the
  // faithful reproduction of round 8 is the **unguarded** `logger.error`, which
  // is what these use. Written down because it took a failed mutation to learn,
  // and the same trap is waiting for the next person who mutates this file.

  'sweep-log-before-counting': [
    'round 8 exactly: an unguarded `logger.error` reading `.message`, above the counter',
    'apps/server/test/ws-server.test.ts — the two sweep-bound tests, by timing out',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          "          const at = Date.now();\n          connection.retryAfter = at + revalidateBackoffMs;\n          recordSweepFailure(connection, at);\n          logSafely('session revalidation failed during sweep', () => ({\n            connectionId: connection.id,\n            error: describeUnknown(error),\n          }));",
          "          const at = Date.now();\n          logger.error('session revalidation failed during sweep', {\n            connectionId: connection.id,\n            error: (error as Error).message,\n          });\n          connection.retryAfter = at + revalidateBackoffMs;\n          recordSweepFailure(connection, at);",
        ],
        [
          "          checkedEveryRoom = false;\n          logSafely('membership sweep failed', () => ({\n            connectionId: connection.id,\n            roomId,\n            error: describeUnknown(error),\n          }));",
          "          logger.error('membership sweep failed', {\n            connectionId: connection.id,\n            roomId,\n            error: (error as Error).message,\n          });\n          checkedEveryRoom = false;",
        ],
      ]),
  ],

  'sweep-counts-then-reads': [
    "round 9's ordering kept, its guard and its describer removed — does counting first save it on its own?",
    'apps/server/test/ws-server.test.ts — measured, not predicted; see the round-9 receipt',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          "          logSafely('membership sweep failed', () => ({\n            connectionId: connection.id,\n            roomId,\n            error: describeUnknown(error),\n          }));",
          "          logger.error('membership sweep failed', {\n            connectionId: connection.id,\n            roomId,\n            error: (error as Error).message,\n          });",
        ],
      ]),
  ],

  'sweep-unguarded-log': [
    'the describer stays, the guard goes — a logger that throws while serializing still abandons a pass',
    'apps/server/test/ws-server.test.ts — the outer-catch test',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          '  const logSafely = guardedErrorLog(logger);',
          '  const logSafely = (message: string, fields: () => Record<string, unknown>): void => {\n    logger.error(message, fields());\n  };',
        ],
      ]),
  ],

  'sweep-catch-can-reject': [
    "round 8's outer handler: `(error as Error).message` in a `.catch`, with no terminal handler after it",
    'apps/server/test/ws-server.test.ts — the outer-catch test, on its unhandled-rejection assertion',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          "    void sweepConnections(deadline)\n      .then(releaseLatch, (error: unknown) => {\n        releaseLatch();\n        logSafely('sweep failed', () => ({ error: describeUnknown(error) }));\n      })\n      .catch(() => {\n        sweeping = false;\n      });",
          "    void sweepConnections(deadline)\n      .catch((error: unknown) => {\n        logger.error('sweep failed', { error: (error as Error).message });\n      })\n      .finally(releaseLatch);",
        ],
      ]),
  ],

  'command-reads-error-message': [
    "round 8's command path: the membership lookup's rejection described before the refusal is sent",
    'apps/server/test/ws-server.test.ts — the command-path test, by timing out with an unhandled rejection',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          "      logSafely('membership lookup failed', () => ({\n        connectionId: connection.id,\n        command,\n        roomId,\n        error: describeUnknown(error),\n      }));",
          "      logger.error('membership lookup failed', {\n        connectionId: connection.id,\n        command,\n        roomId,\n        error: (error as Error).message,\n      });",
        ],
        [
          '      handleFrame(socket, raw.toString()).catch((error: unknown) => {',
          '      void handleFrame(socket, raw.toString());\n      const unusedFrameCatch = (): void => {\n        Promise.resolve().catch((error: unknown) => {',
        ],
        [
          '          error: describeUnknown(error),\n        }));\n      });\n    });',
          '          error: describeUnknown(error),\n        }));\n        });\n      };\n      void unusedFrameCatch;\n    });',
        ],
      ]),
  ],

  'backoff-after-reading': [
    "round 8's command path: the back-off armed *after* the session rejection is described",
    'apps/server/test/ws-server.test.ts — the session-command test, on both the refusal frame and the one-lookup assertion',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          "      connection.retryAfter = Date.now() + revalidateBackoffMs;\n      logSafely('session revalidation failed', () => ({\n        connectionId: connection.id,\n        error: describeUnknown(error),\n      }));",
          "      logger.error('session revalidation failed', {\n        connectionId: connection.id,\n        error: (error as Error).message,\n      });\n      connection.retryAfter = Date.now() + revalidateBackoffMs;",
        ],
      ]),
  ],

  'resolver-reads-error-message': [
    "round 8's session resolver: the driver's rejection described on the line above `return null`",
    'apps/server/test/ws-auth.test.ts — the unreadable-rejection test, which then rejects instead of returning null',
    () =>
      edit('apps/server/src/ws-auth.ts', [
        [
          "      logSafely('ws session lookup failed', () => ({ error: describeUnknown(error) }));",
          "      logger.error('ws session lookup failed', { error: (error as Error).message });",
        ],
      ]),
  ],

  'invitation-reads-error-message': [
    "round 8's invitation compensation: the port's rejection described before the deliberate `APIError`",
    'packages/auth/test/org.test.ts — the unreadable-compensation test, which then rejects with a TypeError',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          "          logSafely('failed to void an over-privileged invitation', () => ({\n            invitationId: data.invitation.id,\n            error: describeUnknown(error),\n          }));",
          "          logger.error('failed to void an over-privileged invitation', {\n            invitationId: data.invitation.id,\n            error: (error as Error).message,\n          });",
        ],
      ]),
  ],

  'undescribable-describer': [
    'the shared describer stops being total — `(value as Error).message ?? String(value)`, which is what every call site did before round 9',
    'packages/auth, across errors.test.ts and org.test.ts. **`apps/server` stays green, and that is the finding**: the realtime sites survive a non-total describer because the counter moves first and the log is guarded. Measured, not assumed — three layers, and each one is separately mutable (see `sweep-log-before-counting`, `sweep-counts-then-reads`, `sweep-unguarded-log`). Requires `pnpm --filter @atrium/auth build` to reach `apps/server` at all. **Repointed in round 10**, which rewrote `describeUnknown` to coerce a non-string `message`: this mutation stopped matching, `--verify` said so, and the receipt below is against the new body. Second time the self-check has caught its own drift, after `unguard-logger` in round 9.',
    () =>
      edit('packages/auth/src/errors.ts', [
        [
          'export function describeUnknown(value: unknown): string {',
          'export function describeUnknown(value: unknown): string {\n' +
            '  const raw = (value as { message?: unknown }).message;\n' +
            "  return typeof raw === 'string' ? raw : String(value);\n" +
            '}\n' +
            '/** The pre-mutation body, kept exported so the module still compiles. */\n' +
            'export function describeUnknownTotal(value: unknown): string {',
        ],
      ]),
  ],

  // The timing family. Each widens exactly one configured duration by 4× and
  // changes nothing else, which is the only honest way to ask whether a test
  // measures its bound or merely observes that something eventually happened.
  // `widen-sweep-window` has been here since round 8 and is the reason this
  // family exists: it caught a *test*, not the code.

  'widen-revalidate-ttl': [
    'a positive session verdict is reused four times as long as configured',
    'apps/server/test/ws-server.test.ts — the TTL test. Round 8 asserted this against a flat 2s ceiling and stayed green under this mutation.',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          '  const revalidateTtlMs = options.revalidateTtlMs ?? 5_000;',
          '  const revalidateTtlMs = (options.revalidateTtlMs ?? 5_000) * 4;',
        ],
      ]),
  ],

  'widen-revalidate-backoff': [
    'a failed session verdict is remembered four times as long as configured',
    'apps/server/test/ws-server.test.ts — the back-off test. Same story: green under round 8, which used 30ms against 2s.',
    () =>
      edit('apps/server/src/ws-server.ts', [
        [
          '  const revalidateBackoffMs = options.revalidateBackoffMs ?? 1_000;',
          '  const revalidateBackoffMs = (options.revalidateBackoffMs ?? 1_000) * 4;',
        ],
      ]),
  ],

  'widen-report-deadline': [
    'the cleanup reporter gets four times the deadline it was configured with',
    'packages/auth/test/org.test.ts — the reporter-deadline tests. **Measured against round 8 and it caught this too**, but on the logged `timeoutMs: 40` rather than on the clock: the run took 165ms against a 2000ms ceiling, so the elapsed assertion never fired. The delta was right about what that assertion measured, and it was not the only thing pinning the number. `report-deadline-overruns` isolates the clock.',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          '  const reportTimeoutMs = input.cleanupReportTimeoutMs ?? DEFAULT_CLEANUP_REPORT_TIMEOUT_MS;',
          '  const reportTimeoutMs = (input.cleanupReportTimeoutMs ?? DEFAULT_CLEANUP_REPORT_TIMEOUT_MS) * 4;',
        ],
      ]),
  ],

  'report-deadline-overruns': [
    'the deadline is reported honestly and waited on for four times as long — the elapsed-time assertion, isolated from every field assertion around it',
    'packages/auth/test/org.test.ts — the deadline test itself and its sibling. **Against round 8 it failed 1, and not that one**: the deadline test stayed green (165ms → 600ms, both under its 2000ms ceiling) and the incidental red is the sibling late-rejection test, which stops being late when the deadline quadruples. That is the polish finding measured rather than argued — round 8 pinned the number in a log field and never on the clock.',
    () =>
      edit('packages/auth/src/org.ts', [
        [
          "    const timer = setTimeout(() => {\n      timedOut = true;\n      resolve('timed-out');\n    }, timeoutMs);",
          "    const timer = setTimeout(\n      () => {\n        timedOut = true;\n        resolve('timed-out');\n      },\n      timeoutMs * 4,\n    );",
        ],
      ]),
  ],

  'unbind-infra': [
    "round 5's production infra binding: postgres and minio on 0.0.0.0",
    'packages/auth/test/deployment.test.ts — the production-binding assertion',
    () =>
      edit('docker-compose.yml', [
        ["- '127.0.0.1:${POSTGRES_PORT:-5432}:5432'", "- '${POSTGRES_PORT:-5432}:5432'"],
        ["- '127.0.0.1:${MINIO_PORT:-9000}:9000'", "- '${MINIO_PORT:-9000}:9000'"],
        ["- '127.0.0.1:${MINIO_CONSOLE_PORT:-9001}:9001'", "- '${MINIO_CONSOLE_PORT:-9001}:9001'"],
      ]),
  ],

  // ── round 10 ───────────────────────────────────────────────────────────────

  'boundary-initializer-walk': [
    "round 9's initializer walk: no conditional, no `??`/`||`/`&&`, no comma or assignment, and a parameter read only for its annotation",
    'packages/auth/test/room-access.test.ts — measured; see the receipt',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        [
          '      if (ts.isPartiallyEmittedExpression(node)) return isHandle(node.expression);',
          '      if (ts.isPartiallyEmittedExpression(node)) return isHandle(node.expression);\n      if (true) return r9IsHandle(node);',
        ],
        [
          '    const isHandle = (node: ts.Expression): boolean => {',
          '    const r9IsHandle = (node: ts.Expression): boolean => {\n' +
            '      if (ts.isParenthesizedExpression(node)) return r9IsHandle(node.expression);\n' +
            '      if (ts.isAwaitExpression(node)) return r9IsHandle(node.expression);\n' +
            '      if (ts.isNonNullExpression(node)) return r9IsHandle(node.expression);\n' +
            '      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {\n' +
            '        return referencesHandleType(node.type, handleTypeNames) || r9IsHandle(node.expression);\n' +
            '      }\n' +
            '      if (ts.isTypeAssertionExpression(node)) {\n' +
            '        return referencesHandleType(node.type, handleTypeNames) || r9IsHandle(node.expression);\n' +
            '      }\n' +
            '      if (ts.isIdentifier(node)) return bindingIsHandle(node.text);\n' +
            '      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {\n' +
            '        return r9IsHandle(node.expression);\n' +
            '      }\n' +
            '      if (ts.isCallExpression(node)) {\n' +
            '        const dynamic =\n' +
            '          node.expression.kind === ts.SyntaxKind.ImportKeyword ||\n' +
            "          (ts.isIdentifier(node.expression) && node.expression.text === 'require');\n" +
            '        const [argument] = node.arguments;\n' +
            '        if (dynamic && argument && ts.isStringLiteral(argument)) {\n' +
            '          const target = resolveSpecifier(argument.text, module.path);\n' +
            "          return target !== null && exposesHandle(target, '*');\n" +
            '        }\n' +
            '        return r9IsHandle(node.expression);\n' +
            '      }\n' +
            '      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {\n' +
            '        return functionYieldsHandle(node);\n' +
            '      }\n' +
            '      return false;\n' +
            '    };\n' +
            '    const isHandle = (node: ts.Expression): boolean => {',
        ],
        // The declaration half: a parameter read for its annotation only, a
        // binding element with no default of its own, and `collectAccesses`
        // asking its destructuring question of variable declarations alone.
        [
          '        if (referencesHandleType(declaration.type, handleTypeNames)) return true;\n' +
            '        /**\n' +
            '         * A **default** is not the caller',
          '        return referencesHandleType(declaration.type, handleTypeNames);\n' +
            '        /**\n' +
            '         * A **default** is not the caller',
        ],
        ['      if (element.initializer && isHandle(element.initializer)) return true;\n', ''],
        [
          '      if (ts.isParameter(owner)) {\n' +
            '        if (referencesHandleType(owner.type, handleTypeNames)) return true;\n' +
            '        return owner.initializer ? isHandle(owner.initializer) : false;\n' +
            '      }',
          '      if (ts.isParameter(owner)) return referencesHandleType(owner.type, handleTypeNames);',
        ],
        [
          '      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&\n' +
            '      !ts.isIdentifier(node.name) &&\n' +
            '      classifier.isHandleDeclaration(node)',
          '      ts.isVariableDeclaration(node) &&\n' +
            '      !ts.isIdentifier(node.name) &&\n' +
            '      node.initializer !== undefined &&\n' +
            '      classifier.isHandle(node.initializer)',
        ],
        // And the handle graph's `export default`.
        [
          "      if (defaultExport && !before.names.has('default') && isHandle(defaultExport)) {",
          '      if (false && defaultExport) {',
        ],
      ]),
  ],

  'describer-returns-raw-message': [
    "round 9's describer exactly: `return value.message`, guarded against a throw and not against a type",
    'packages/auth/test/errors.test.ts — measured; the shape assertions and nothing else',
    () =>
      edit('packages/auth/src/errors.ts', [
        [
          '      const message: unknown = value.message;\n' +
            "      return typeof message === 'string' ? message : String(message);",
          '      return value.message;',
        ],
      ]),
  ],
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The receipts: proving that the *check* fired, not that the mutation applied
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `--verify` above proves every mutation still bites the code. The round-9
 * delta pointed out that this is one layer short of the claim each row makes:
 *
 * > it only applies and restores; it never executes the named build or suite
 * > and never asserts a red result. A row can still be credited to a suite that
 * > was skipped.
 *
 * It is the same fail-open shape as the one `--verify` closed, one level up, and
 * it has bitten this repository in every form it takes. The prose beside each
 * mutation ("`org.test.ts` — 14 of 52") was produced by a human running the two
 * commands and reading the output, which means it is exactly as trustworthy as
 * the transcription — and the round-9 receipt already documents a row where the
 * transcription was wrong (`boundary-no-access` recorded 8 of 48 when the tree
 * said 11).
 *
 * So a row is now backed by a **receipt**: a JSON file in
 * `scripts/mutation-receipts/` recording a real run of
 *
 *     restore → build → suite (must be green) → mutate → build → suite
 *
 * with both exit codes, both test counts, the names of the tests that were
 * passing before and failing after, and enough identity to tell whether the
 * numbers still describe this tree.
 *
 * ## The three things a receipt has to rule out
 *
 * Each is a way a green-looking measurement can mean nothing, and each one has
 * been seen for real in this repository or in the reviews of it:
 *
 *  1. **The suite never ran.** A non-zero exit is not a failing test — a missing
 *     file, a build error, a bad filter and a crashed runner all exit non-zero
 *     with nothing measured. So a red verdict requires `failed > 0` *parsed from
 *     the runner's own JSON*, not an exit code.
 *  2. **The suite was already red.** A row credited to a suite that fails
 *     anyway measures the suite's health, not the mutation. So the baseline run
 *     must be green, with `total > 0` — a suite that ran zero tests is not a
 *     green suite.
 *  3. **The failure set is a different failure set.** A mutation can break the
 *     build and take out unrelated tests, and the counts would still move.
 *     `caught` is the intersection of *failing after* with *passing before*, and
 *     it must be non-empty; the receipt lists the names, so a reader can see
 *     whether they are the tests the row claims.
 *
 * ## Identity, so a stale receipt cannot be quoted as a fresh one
 *
 * A receipt carries `commit`, `mutationHash` (the mutation function's own
 * source) and `subjectHash` (the content of every file it rewrote, sampled
 * before the rewrite). `--receipts` recomputes the last two and marks any row
 * whose code or mutation has moved as STALE, and `--list` prints the receipt
 * state beside every row — so the table cannot be read as measured when it is
 * not. `--receipts --strict` exits non-zero on any row that is missing or stale,
 * which is what CI would run.
 *
 * ## Cost, stated rather than hidden
 *
 * A full `--prove-all` is minutes, not seconds, and the two rows that name the
 * Playwright suite are minutes each on their own. The cadence is written in the
 * ticket and in `--receipts` output rather than being quietly worked around by
 * sampling: proving a row is what you do when you *change* it, and
 * `--prove-all` is what you do at the end of a round.
 */
const RECEIPTS = 'scripts/mutation-receipts';

/** `pnpm --filter <x> build`, as an argv. */
const buildPackages = ['pnpm', ['--filter', './packages/*', 'build']];
const buildAuth = ['pnpm', ['--filter', '@atrium/auth', 'build']];

/**
 * The suites a row can name, as something runnable.
 *
 * `build` is the round-6 lesson made executable: the Playwright suite and every
 * `apps/server` test import `@atrium/auth` as its built `dist`, so a mutation to
 * `packages/*` source that is not compiled is a mutation they never see. The
 * first run of this ledger recorded seven passes against `drop-join` for exactly
 * that reason. Naming the build beside the suite is what stops the rule from
 * being something a person has to remember.
 */
const SUITES = {
  'auth:room-access': {
    runner: 'vitest',
    cwd: 'packages/auth',
    file: 'test/room-access.test.ts',
    build: [],
  },
  'auth:org': { runner: 'vitest', cwd: 'packages/auth', file: 'test/org.test.ts', build: [] },
  'auth:errors': { runner: 'vitest', cwd: 'packages/auth', file: 'test/errors.test.ts', build: [] },
  'auth:deployment': {
    runner: 'vitest',
    cwd: 'packages/auth',
    file: 'test/deployment.test.ts',
    build: [],
  },
  /** The whole package, for a row whose claim spans several of its files. */
  'auth:all': { runner: 'vitest', cwd: 'packages/auth', file: null, build: [] },
  'server:ws-server': {
    runner: 'vitest',
    cwd: 'apps/server',
    file: 'test/ws-server.test.ts',
    build: [buildAuth],
  },
  'server:ws-auth': {
    runner: 'vitest',
    cwd: 'apps/server',
    file: 'test/ws-auth.test.ts',
    build: [buildAuth],
  },
  'e2e:room-access': {
    runner: 'playwright',
    cwd: 'apps/web',
    file: 'e2e/room-access.spec.ts',
    build: [buildPackages],
  },
};

/**
 * Which suite each row is credited to, in the form the prover runs.
 *
 * Deliberately a second table rather than a fourth field on the mutation: the
 * prose beside a mutation is a *claim*, and this is the machine-readable version
 * of the same claim. Keeping them apart is what lets the two disagree visibly,
 * which is the whole point — a row whose prose says `org.test.ts` and whose
 * receipt shows `errors.test.ts` going red is a row somebody must look at.
 *
 * Completeness is enforced below, so a new mutation with no entry here fails
 * `--verify` rather than quietly becoming unprovable.
 */
const CREDITED = {
  'drop-join': ['e2e:room-access'],
  'drop-ceiling': ['auth:room-access', 'e2e:room-access'],
  'drop-report': ['auth:org'],
  'unbind-dev': ['auth:deployment'],
  'drop-refusal': ['auth:deployment'],
  'drop-await': ['auth:org'],
  'unguard-logger': ['auth:org', 'auth:errors'],
  'boundary-names-only': ['auth:room-access'],
  'boundary-no-helpers': ['auth:room-access'],
  'boundary-no-access': ['auth:room-access'],
  'regex-boundary': ['auth:room-access'],
  'normalize-outside-guard': ['auth:org'],
  'drop-report-deadline': ['auth:org'],
  'r7-access-analysis': ['auth:room-access'],
  'boundary-no-destructuring': ['auth:room-access'],
  'boundary-literal-keys-only': ['auth:room-access'],
  'boundary-blind-receiver': ['auth:room-access'],
  'sweep-latch-forever': ['server:ws-server'],
  'widen-sweep-window': ['server:ws-server'],
  'sweep-log-before-counting': ['server:ws-server'],
  'sweep-counts-then-reads': ['server:ws-server'],
  'sweep-unguarded-log': ['server:ws-server'],
  'sweep-catch-can-reject': ['server:ws-server'],
  'command-reads-error-message': ['server:ws-server'],
  'backoff-after-reading': ['server:ws-server'],
  'resolver-reads-error-message': ['server:ws-auth'],
  'invitation-reads-error-message': ['auth:org'],
  'undescribable-describer': ['auth:all'],
  'widen-revalidate-ttl': ['server:ws-server'],
  'widen-revalidate-backoff': ['server:ws-server'],
  'widen-report-deadline': ['auth:org'],
  'report-deadline-overruns': ['auth:org'],
  'unbind-infra': ['auth:deployment'],
  'boundary-initializer-walk': ['auth:room-access'],
  'describer-returns-raw-message': ['auth:errors'],
};

for (const key of Object.keys(mutations)) {
  if (!CREDITED[key]) {
    throw new Error(
      `mutation "${key}" names no suite in CREDITED.\n` +
        'A row nobody can prove is a row nobody should believe; add its suite.',
    );
  }
  for (const suite of CREDITED[key]) {
    if (!SUITES[suite]) throw new Error(`mutation "${key}" names unknown suite "${suite}"`);
  }
}
for (const key of Object.keys(CREDITED)) {
  if (!mutations[key]) throw new Error(`CREDITED names "${key}", which is not a mutation`);
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The content hash of a suite's own file, or null where the suite is a whole package. */
function suiteHashOf(suiteName) {
  const suite = SUITES[suiteName];
  if (!suite.file) return null;
  try {
    return sha(readFileSync(join(suite.cwd, suite.file), 'utf8'));
  } catch {
    return null;
  }
}

function headCommit() {
  const { status, stdout } = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return status === 0 ? stdout.trim() : 'unknown';
}

function treeIsDirty() {
  const { status, stdout } = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return status !== 0 || stdout.trim().length > 0;
}

/** Run a command, and never hide what it did. */
function run(argv, { cwd = '.', env = {}, timeoutMs = 15 * 60_000 } = {}) {
  const [command, args] = argv;
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: `${command} ${args.join(' ')}`,
    cwd,
    // `spawnSync` reports `null` on a signal; a killed run is a failed run and
    // must never read as 0.
    exitCode: result.status === null ? 124 : result.status,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * The verdict, as a pure function of two measurements.
 *
 * **Extracted and exported so it has its own tests** — `packages/auth/test/
 * mutation-ledger.test.ts`. Round 9's lesson, in the sentence `RETRO.md` keeps:
 * an instrument needs its own verification. The three ways a measurement can
 * look red without being red are decided here, in eleven lines, rather than
 * inline in a function that also spawns processes and rewrites the tree — which
 * would have made them unreachable by any test and therefore unmeasured, which
 * is the defect one level down.
 */
export function judge(baseline, mutated) {
  const passingBefore = new Set(
    (baseline.tests ?? []).filter((test) => test.status === 'passed').map((test) => test.fullName),
  );
  const caught = (mutated.tests ?? [])
    .filter((test) => test.status === 'failed' && passingBefore.has(test.fullName))
    .map((test) => test.fullName)
    .sort();

  if (baseline.exitCode !== 0 || baseline.failed > 0) {
    return {
      verdict: 'no-baseline',
      why: 'the suite is not green before the mutation, so nothing can be credited to it',
      caught,
    };
  }
  if ((baseline.total ?? 0) === 0) {
    return { verdict: 'no-baseline', why: 'the baseline run measured no tests at all', caught };
  }
  if (mutated.parseError) return { verdict: 'unmeasured', why: mutated.parseError, caught };
  if ((mutated.total ?? 0) === 0) {
    return {
      verdict: 'unmeasured',
      why: 'the mutated run measured no tests — the suite did not run',
      caught,
    };
  }
  if (mutated.failed === 0) {
    return {
      verdict: 'green',
      why: 'the suite passed with the mutation applied; this row is not caught by it',
      caught,
    };
  }
  if (caught.length === 0) {
    return {
      verdict: 'unrelated',
      why: 'tests failed, but none of them was passing at baseline — the failures are not this mutation',
      caught,
    };
  }
  return { verdict: 'red', why: null, caught };
}

/**
 * The e2e ports, asked of the suite's own config rather than duplicated here.
 *
 * `apps/web/e2e/support/config.mjs` is already the one place that decides what
 * the end-to-end run talks to; copying 3100 and 4100 into this file would make
 * it the second, and the two would drift on the first `E2E_PORT` anybody sets.
 */
function e2ePorts(cwd) {
  const result = run(
    [
      'node',
      [
        '-e',
        // `process.stdout.write`, not `console.log`: with `FORCE_COLOR` set —
        // which every one of this repository's terminals does — `console.log`
        // runs the inspector's colouriser over a number and emits
        // `[33m3100[39m`, which parses as NaN. That is how the first
        // draft of this function reported "could not read the e2e ports" on a
        // config it had just read correctly.
        "import('./e2e/support/config.mjs').then((m) => process.stdout.write(`${m.webPort} ${m.serverPort}`))",
      ],
    ],
    { cwd, timeoutMs: 60_000, env: { NO_COLOR: '1', FORCE_COLOR: '0' } },
  );
  if (result.exitCode !== 0) return null;
  const [web, server] = result.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(web) && Number.isFinite(server) ? [web, server] : null;
}

/** This script's own process group, which must never be the one killed. */
function ownProcessGroup() {
  const result = run(['ps', ['-o', 'pgid=', '-p', String(process.pid)]], { timeoutMs: 30_000 });
  const pgid = Number(result.stdout.trim());
  return Number.isFinite(pgid) ? pgid : null;
}

/**
 * Kill the process *group* that holds a port, not just the process.
 *
 * `next dev` is a supervisor: killing the `next-server` child it spawned leaves
 * the parent to start another one, and the port is occupied again by the time
 * the check re-runs. Round 10 measured that too — the single-pid version freed
 * the port in one run of `--prove` and failed in the next, which is the worst
 * kind of fix, the kind that works when you test it.
 *
 * Guarded against suicide: this script's own group is never a target.
 */
function killHolders(pids, ownGroup) {
  for (const pid of pids) {
    const group = Number(
      run(['ps', ['-o', 'pgid=', '-p', pid]], { timeoutMs: 30_000 }).stdout.trim(),
    );
    if (Number.isFinite(group) && group !== ownGroup && group > 1) {
      run(['kill', ['-9', `-${group}`]], { timeoutMs: 30_000 });
    }
    run(['kill', ['-9', pid]], { timeoutMs: 30_000 });
  }
}

/** The pids listening on a TCP port, best effort across the tools that exist. */
function listenersOn(port) {
  for (const argv of [
    ['lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']],
    ['bash', ['-c', `ss -H -ltnp 'sport = :${port}' 2>/dev/null | grep -o 'pid=[0-9]*'`]],
  ]) {
    const result = run(argv, { timeoutMs: 30_000 });
    const pids = result.stdout
      .split('\n')
      .map((line) => line.replace('pid=', '').trim())
      .filter((line) => /^\d+$/.test(line));
    if (pids.length > 0) return [...new Set(pids)];
  }
  return [];
}

/**
 * Make sure the Playwright run starts its own servers, or refuse to measure.
 *
 * **This is the round-6 stale-artifact defect in its worst form.**
 * `playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, so a
 * server left running by an earlier run holds the *pre-mutation* `dist` in
 * memory. Rebuilding does not reload it. With `CI=1` Playwright refuses to reuse
 * and instead fails to bind — which is how the first `--prove-all` of round 10
 * found this: `drop-join` came back `0/0`, and the prover declined to credit the
 * row rather than reading a fast failure as a red suite.
 *
 * Two mechanisms, because best-effort cleanup on its own is how a silent stale
 * measurement gets through: kill what is there, then **assert** the ports are
 * free and record a refusal if they are not.
 */
function freeE2ePorts(cwd) {
  const ports = e2ePorts(cwd);
  if (!ports) return { ok: false, why: 'could not read the e2e ports from config.mjs' };
  /**
   * Killed, then *waited for*, then killed again if something came back.
   *
   * One pass is not enough and round 10 measured that too: `next dev` is a
   * supervisor with a child that holds the socket, so a single `kill` can leave
   * the parent to respawn it, and even a clean kill releases the listener a few
   * milliseconds after the call returns. A single-pass version reported the
   * ports free and Playwright then failed with "already used" — a check that
   * answers before the thing it checks has finished is not a check.
   */
  const ownGroup = ownProcessGroup();
  let held = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    held = ports.filter((port) => listenersOn(port).length > 0);
    if (held.length === 0) return { ok: true };
    for (const port of held) killHolders(listenersOn(port), ownGroup);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return {
    ok: false,
    why:
      `port(s) ${held.join(', ')} are still held by a server this run did not start; ` +
      'a Playwright run against them would measure the pre-mutation build',
  };
}

/** Every test a Playwright JSON report contains, flattened. */
export function flattenPlaywright(node, trail, out) {
  for (const suite of node.suites ?? []) {
    flattenPlaywright(suite, [...trail, suite.title], out);
  }
  for (const spec of node.specs ?? []) {
    const name = [...trail, spec.title].filter(Boolean).join(' › ');
    const ok = (spec.tests ?? []).every((test) =>
      (test.results ?? []).some((result) => result.status === 'passed'),
    );
    out.push({ fullName: name, status: ok ? 'passed' : 'failed' });
  }
}

/**
 * Run one suite and report what it *measured*, not merely how it exited.
 *
 * The JSON reporter is the point: an exit code cannot distinguish "eleven tests
 * failed" from "the file was not found", and crediting a row to the second is
 * the defect this whole section exists to close.
 */
function runSuite(suiteName, { label }) {
  const suite = SUITES[suiteName];
  // Relative to the repository root, so a receipt's recorded command is the
  // command another machine would run rather than one person's absolute path.
  const relative = join('node_modules', '.cache', `ledger-${label}.json`);
  const outputFile = join(process.cwd(), relative);
  const fromSuite = join('..', '..', relative);
  mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
  rmSync(outputFile, { force: true });

  const builds = suite.build.map((argv) => {
    const result = run(argv);
    // A build failure is *recorded, not fatal*: `tsc` exits non-zero on a
    // deliberately broken tree and still emits, which is the documented shape
    // for half these mutations. What must not happen is it failing silently.
    return {
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  });

  let execution;
  if (suite.runner === 'vitest') {
    const args = ['exec', 'vitest', 'run'];
    if (suite.file) args.push(suite.file);
    args.push('--reporter=json', `--outputFile=${fromSuite}`);
    execution = run(['pnpm', args], { cwd: suite.cwd });
  } else {
    // `CI=1` is not decoration: `playwright.config.ts` sets
    // `reuseExistingServer: !process.env.CI`, so without it a mutated `dist`
    // would be measured against servers started before the mutation — the
    // round-6 stale-artifact defect in its worst form, because it would look
    // like a clean green.
    const ports = freeE2ePorts(suite.cwd);
    if (!ports.ok) {
      return {
        suite: suiteName,
        builds,
        command: '(refused before starting)',
        exitCode: 125,
        total: 0,
        passed: 0,
        failed: 0,
        tests: [],
        durationMs: 0,
        parseError: ports.why,
      };
    }
    const database = run(['node', ['e2e/support/ensure-database.mjs']], { cwd: suite.cwd });
    if (database.exitCode !== 0) {
      return {
        suite: suiteName,
        builds,
        command: database.command,
        exitCode: database.exitCode,
        total: 0,
        passed: 0,
        failed: 0,
        tests: [],
        durationMs: database.durationMs,
        parseError: 'the e2e database step failed, so nothing was measured',
      };
    }
    execution = run(['pnpm', ['exec', 'playwright', 'test', suite.file, '--reporter=json']], {
      cwd: suite.cwd,
      env: { CI: '1', PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile },
      timeoutMs: 30 * 60_000,
    });
    execution.durationMs += database.durationMs;
  }

  let tests = [];
  let parseError = null;
  if (existsSync(outputFile)) {
    try {
      const report = JSON.parse(readFileSync(outputFile, 'utf8'));
      if (suite.runner === 'vitest') {
        for (const file of report.testResults ?? []) {
          for (const assertion of file.assertionResults ?? []) {
            tests.push({ fullName: assertion.fullName, status: assertion.status });
          }
        }
      } else {
        const out = [];
        flattenPlaywright(report, [], out);
        tests = out;
      }
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  } else {
    parseError = `the runner wrote no JSON report to ${outputFile}`;
  }

  const passed = tests.filter((test) => test.status === 'passed').length;
  const failed = tests.filter((test) => test.status === 'failed').length;
  return {
    suite: suiteName,
    builds,
    command: execution.command,
    cwd: suite.cwd,
    exitCode: execution.exitCode,
    total: tests.length,
    passed,
    failed,
    tests,
    durationMs: execution.durationMs,
    ...(parseError ? { parseError } : {}),
  };
}

/** Restore, then rebuild, so the next measurement starts from the real tree. */
function restoreAndRebuild(suiteNames) {
  restoreQuietly();
  const rebuilt = new Set();
  for (const suiteName of suiteNames) {
    for (const argv of SUITES[suiteName].build) {
      const key = argv[1].join(' ');
      if (rebuilt.has(key)) continue;
      rebuilt.add(key);
      run(argv);
    }
  }
}

/**
 * One row, measured end to end, written down.
 *
 * `baselines` is a cache across a `--prove-all`, because a suite's green run is
 * the same green run for every row credited to it — and re-running the
 * Playwright suite once per row would turn minutes into an hour.
 */
function proveOne(key, baselines) {
  if (existsSync(SNAPSHOT)) {
    throw new Error('a mutation is applied; run `--restore` before proving anything');
  }
  const suiteNames = CREDITED[key];
  const results = [];

  for (const suiteName of suiteNames) {
    if (!baselines.has(suiteName)) {
      restoreAndRebuild([suiteName]);
      baselines.set(
        suiteName,
        runSuite(suiteName, { label: `baseline-${suiteName.replace(/:/g, '-')}` }),
      );
    }
    const baseline = baselines.get(suiteName);
    // The baseline half of the verdict, before anything is mutated: a suite that
    // is already red, or that ran nothing, cannot credit a row whatever the
    // mutated run does.
    const premise = judge(baseline, { total: 1, failed: 1, tests: [] });
    if (premise.verdict === 'no-baseline') {
      results.push({
        suite: suiteName,
        verdict: 'no-baseline',
        why: premise.why,
        baseline: withoutTests(baseline),
      });
      continue;
    }

    editedFiles = new Set();
    snapshot();
    let subjectHash = null;
    try {
      mutations[key][2]();
      subjectHash = sha(
        [...editedFiles]
          .sort()
          .map(
            (file) => `${file}\n${readFileSync(join(SNAPSHOT, file.split('/').join('%')), 'utf8')}`,
          )
          .join('\n'),
      );
    } catch (error) {
      restoreAndRebuild([suiteName]);
      results.push({
        suite: suiteName,
        verdict: 'stale',
        why: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const mutated = runSuite(suiteName, { label: `mutated-${key}` });
    restoreAndRebuild([suiteName]);

    const { verdict, why, caught } = judge(baseline, mutated);

    results.push({
      suite: suiteName,
      verdict,
      ...(why ? { why } : {}),
      subjectHash,
      /**
       * The suite file's own hash, which is a *second* way a number goes stale
       * and the one `subjectHash` cannot see: the mutation is unchanged, the
       * code it rewrites is unchanged, and eleven new tests have been added to
       * the file that measures it. That is the ordinary case — every round of
       * this ticket did it — and it is what turned round 7's "3 of 40" into
       * round 9's "14 of 52" with nothing anywhere marking the first as stale.
       *
       * `null` for a whole-package suite, and `--receipts` says so rather than
       * implying a check it did not make.
       */
      suiteFile: SUITES[suiteName].file
        ? join(SUITES[suiteName].cwd, SUITES[suiteName].file)
        : null,
      suiteHash: suiteHashOf(suiteName),
      files: [...editedFiles].sort(),
      baseline: withoutTests(baseline),
      mutated: withoutTests(mutated),
      caught,
    });
  }

  const verdict = results.every((result) => result.verdict === 'red') ? 'red' : 'not-proved';
  return {
    mutation: key,
    verdict,
    recordedAt: new Date().toISOString(),
    commit: headCommit(),
    // Mid-round is the only time anyone measures, so a dirty tree is normal and
    // saying so is what stops `commit` from being read as "this is what that
    // commit produced". `subjectHash` is the pin that actually holds.
    treeDirty: treeIsDirty(),
    node: process.version,
    mutationHash: sha(mutations[key][2].toString()),
    claim: mutations[key][1],
    suites: results,
  };
}

/** A receipt records counts and names, not the whole test list twice over. */
function withoutTests(result) {
  const { tests: _tests, stdout: _stdout, stderr: _stderr, ...rest } = result;
  return rest;
}

function receiptPath(key) {
  return join(RECEIPTS, `${key}.json`);
}

function writeReceipt(receipt) {
  mkdirSync(RECEIPTS, { recursive: true });
  writeFileSync(receiptPath(receipt.mutation), `${JSON.stringify(receipt, null, 2)}\n`);
}

function readReceipt(key) {
  const path = receiptPath(key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Is this receipt still about this tree?
 *
 * Three hashes, and they answer three different questions. `mutationHash` moves
 * when the mutation is repointed — the round-9 shape, where `unguard-logger` had
 * to be repointed at a moved guard. `subjectHash` moves when the *code being
 * mutated* changes. `suiteHash` moves when the *suite that measured it* changes,
 * which is the most common of the three and the one the first draft of this
 * section missed: round 7 recorded "3 of 40" for `drop-report`, eleven tests
 * were added around the reporter, and nothing marked the number stale until a
 * human noticed it said 14.
 *
 * `subjectHash` is over the whole file, so a comment-only edit invalidates a
 * receipt too. That is deliberate and it is the cheap direction to be wrong in:
 * over-invalidating costs a re-run, and this repository's comments carry the
 * claims the receipts exist to check, so a paragraph rewritten around a number
 * is exactly the moment to re-measure it.
 */
function receiptState(key) {
  const receipt = readReceipt(key);
  if (!receipt) return { state: 'missing', receipt: null };
  if (receipt.mutationHash !== sha(mutations[key][2].toString())) {
    return { state: 'stale-mutation', receipt };
  }
  for (const suite of receipt.suites ?? []) {
    if (suite.suiteHash && suite.suiteHash !== suiteHashOf(suite.suite)) {
      return { state: 'stale-suite', receipt };
    }
    if (!suite.files || !suite.subjectHash) continue;
    let current;
    try {
      current = sha(suite.files.map((file) => `${file}\n${readFileSync(file, 'utf8')}`).join('\n'));
    } catch {
      return { state: 'stale-subject', receipt };
    }
    if (current !== suite.subjectHash) return { state: 'stale-subject', receipt };
  }
  if (receipt.verdict !== 'red') return { state: 'not-proved', receipt };
  return { state: 'proved', receipt };
}

/** One line per row, so a reader sees the measurement state beside the claim. */
function describeReceipt(key) {
  const { state, receipt } = receiptState(key);
  if (state === 'missing') return 'NO RECEIPT — this row is a claim, not a measurement';
  const caught = (receipt.suites ?? []).flatMap((suite) => suite.caught ?? []).length;
  const suites = (receipt.suites ?? [])
    .map((suite) => {
      const mutated = suite.mutated;
      if (!mutated) return `${suite.suite}: ${suite.verdict}`;
      return `${suite.suite} ${mutated.failed}/${mutated.total} red`;
    })
    .join(', ');
  const when = String(receipt.recordedAt).slice(0, 10);
  const at = String(receipt.commit).slice(0, 8);
  if (state === 'proved') return `proved ${when} @${at} — ${suites} (${caught} caught)`;
  if (state === 'stale-mutation') return `STALE (the mutation was repointed since ${when})`;
  if (state === 'stale-subject') return `STALE (the code it measured changed since ${when})`;
  if (state === 'stale-suite') return `STALE (the suite that measured it changed since ${when})`;
  return `NOT PROVED ${when} @${at} — ${suites}`;
}

function proveMany(keys) {
  const baselines = new Map();
  const started = Date.now();
  const failures = [];
  for (const key of keys) {
    const receipt = proveOne(key, baselines);
    writeReceipt(receipt);
    const line = describeReceipt(key);
    if (receipt.verdict === 'red') console.info(`red      ${key.padEnd(30)} ${line}`);
    else {
      failures.push(key);
      console.error(`NOT RED  ${key.padEnd(30)} ${line}`);
      for (const suite of receipt.suites) {
        if (suite.why) console.error(`         ${suite.suite}: ${suite.why}`);
      }
    }
  }
  console.info(`\n${keys.length} row(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  if (failures.length > 0) {
    console.error(
      `${failures.length} row(s) did not produce a red receipt. A row without one is a ` +
        'claim; either the mutation is wrong or the suite does not catch it.',
    );
    process.exit(1);
  }
}

/** The table, read out of the receipts rather than out of the prose. */
function receipts(strict) {
  let bad = 0;
  for (const key of Object.keys(mutations)) {
    const { state } = receiptState(key);
    if (state !== 'proved') bad += 1;
    console.info(`${key.padEnd(30)} ${describeReceipt(key)}`);
  }
  if (bad > 0) {
    console.error(`\n${bad} of ${Object.keys(mutations).length} row(s) are unproved or stale.`);
    if (strict) process.exit(1);
  } else {
    console.info(`\nall ${Object.keys(mutations).length} rows carry a current red receipt`);
  }
}

/**
 * Put a previous round's files in the tree, safely, so its numbers can be
 * re-measured — and put yours back afterwards.
 *
 *   node scripts/mutation-ledger.mjs --against fix/auth-r8 <path…>
 *   node scripts/mutation-ledger.mjs --restore
 *
 * **This exists because the obvious way to do it destroys your work, and it did
 * — three times in this ticket now.** Round 7 recorded `--restore` being
 * `git checkout --` as a known limit; round 8 lost an uncommitted fix to it and
 * replaced it with a snapshot; and round 9 then hand-rolled
 * `git checkout origin/fix/auth-r8 -- <paths>` at the terminal to re-measure the
 * boundary numbers, which overwrote the round-9 work in those same files. A
 * hazard that recurs once the tool is fixed was never a tool problem: the tool
 * had no *safe way to do the thing people actually want*, so they reached past
 * it. This is that way.
 *
 * Snapshots first, so `--restore` brings the working tree back whatever state it
 * was in — staged, unstaged, or clean.
 *
 * **One hazard the snapshot creates, and it bit round 10 within the hour.** Any
 * command here holds the whole of {@link TOUCHED} between `snapshot()` and
 * `restore()`, so an edit made to one of those files *while the ledger is
 * running* is overwritten by the restore that follows. It is the same shape as
 * the `git checkout --` hazard above, arriving from the other direction: an edit
 * to `errors.ts` made during a `--prove-all` vanished with no error anywhere.
 * The rule is one line — **do not edit a `TOUCHED` file while the ledger is
 * running** — and it is written down rather than fixed with locking because a
 * lock would make the failure "the ledger refuses to start", which is a worse
 * trade for a tool that runs for minutes.
 */
function against(ref, paths) {
  if (paths.length === 0) {
    throw new Error('usage: --against <ref> <path…>  (paths, so the blast radius is stated)');
  }
  snapshotPaths(paths);
  const { status, stderr } = spawnSync('git', ['checkout', ref, '--', ...paths], {
    encoding: 'utf8',
  });
  if (status !== 0) {
    restore();
    throw new Error(`git checkout ${ref} failed:\n${stderr}`);
  }
  console.info(
    `${paths.length} path(s) now at ${ref}; your versions are snapshotted.\n` +
      'Rebuild anything the suite consumes, measure, then `--restore`.',
  );
}

/**
 * Apply and restore every mutation in turn, reporting the ones whose target no
 * longer exists. Exits non-zero if any does.
 *
 * A mutation is a string match against source. When the source moves — round 9
 * lifted the log guard out of `org.ts` into `errors.ts` — the match stops
 * finding anything, and the failure mode depends entirely on whether whoever
 * ran it was watching: `edit` throws, but a `> /dev/null 2>&1` in a shell loop
 * turns that into a suite that passes and a row that reads "0 caught". That is
 * the fail-open class this whole ticket has been about, inside the instrument
 * built to detect it. Round 9 hit it once, exactly that way.
 *
 * So the ledger checks itself. Run this before trusting any row.
 */
function verify() {
  const stale = [];
  for (const [key, entry] of Object.entries(mutations)) {
    try {
      snapshot();
      entry[2]();
      console.info(`ok       ${key}`);
    } catch (error) {
      stale.push(key);
      console.error(`STALE    ${key}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      restoreQuietly();
    }
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} mutation(s) no longer match their target. A mutation that ` +
        'cannot apply measures nothing; repoint it or delete it.',
    );
    process.exit(1);
  }
  console.info(`\nall ${Object.keys(mutations).length} mutations apply and restore cleanly`);
}

function restoreQuietly() {
  if (!existsSync(SNAPSHOT)) return;
  for (const entry of readdirSync(SNAPSHOT)) {
    writeFileSync(entry.split('%').join('/'), readFileSync(join(SNAPSHOT, entry)));
  }
  rmSync(SNAPSHOT, { recursive: true, force: true });
}

/**
 * Only act when run as a command.
 *
 * `judge` is exported so `packages/auth/test/mutation-ledger.test.ts` can pin
 * the verdict rules, and importing this file must not therefore rewrite the
 * working tree — which is what an unguarded dispatch would do the moment a test
 * runner touched it.
 */
const RUN_AS_COMMAND =
  process.argv[1] !== undefined && process.argv[1].endsWith('mutation-ledger.mjs');

const [name, ...rest] = RUN_AS_COMMAND ? process.argv.slice(2) : ['--noop'];

if (name === '--noop') {
  // Imported, not run.
} else if (name === '--restore') {
  restore();
} else if (name === '--verify') {
  verify();
} else if (name === '--prove') {
  if (rest.length === 0) throw new Error('usage: --prove <name…>');
  for (const key of rest) {
    if (!mutations[key]) throw new Error(`unknown mutation "${key}"; try --list`);
  }
  proveMany(rest);
} else if (name === '--prove-all') {
  proveMany(Object.keys(mutations));
} else if (name === '--receipts') {
  receipts(rest.includes('--strict'));
} else if (name === '--against') {
  const [ref, ...paths] = rest;
  if (!ref) throw new Error('usage: --against <ref> <path…>');
  against(ref, paths);
} else if (name === '--list' || name === undefined) {
  for (const [key, [what, suite]] of Object.entries(mutations)) {
    console.info(
      `${key.padEnd(24)} ${what}\n${' '.repeat(25)}-> ${suite}\n${' '.repeat(25)}=> ${describeReceipt(key)}`,
    );
  }
} else if (mutations[name]) {
  snapshot();
  mutations[name][2]();
  console.info(`applied ${name} -> expect red in: ${mutations[name][1]}`);
} else {
  console.error(`unknown mutation "${name}"; try --list`);
  process.exit(1);
}
