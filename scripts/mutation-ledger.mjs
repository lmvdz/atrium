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
    'room-access.spec.ts 1 of 7, and packages/auth/test/room-access.test.ts 4 of 54',
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
    'packages/auth/test/org.test.ts — 14 of 52 (round 7 recorded 3 of 40; the reporter now has eleven more tests around it)',
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

  // ── round 7 ────────────────────────────────────────────────────────────────

  'drop-await': [
    "round 6's un-awaited reporter — the live crash path",
    'packages/auth/test/org.test.ts — 8 of 52, including the unhandled-rejection watch (round 7: 4 of 45)',
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
    'packages/auth/test/org.test.ts — 2 of 52, and packages/auth/test/errors.test.ts — 2 of 14. Round 9 moved the guard from `org.ts` into `errors.ts`, so this now covers both packages at once; it threw "mutation target not found" until it was repointed, which is the ledger doing its job.',
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
    'packages/auth/test/room-access.test.ts — 5 of 54',
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
    'packages/auth/test/room-access.test.ts — 3 of 54, including the empty-allowlist premise',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        ['        if (touches) before.all = true;', '        void touches;'],
      ]),
  ],

  'boundary-no-access': [
    'the whole access half goes — the table reached off a handle stops being seen at all',
    "packages/auth/test/room-access.test.ts — 12 of 54. **The round-8 receipt recorded 8 of 48 and that was wrong**: measured on r8's own tree (`--against fix/auth-r8`) this fails 11 of 48. 8 is `r7-access-analysis`'s number, one row up — a transcription slip in the very table whose header says a table copied forward is a defect with an extra step.",
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
    'packages/auth/test/room-access.test.ts — 21 of 54; of the evasion fixtures, 6 still fire — the named-import shapes the regex was written for',
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
    'packages/auth/test/org.test.ts — 2 of 52',
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
    'packages/auth/test/org.test.ts — 2 of 52 (one of them by never finishing)',
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
    'packages/auth/test/room-access.test.ts — 13 of 54 (8 of 48 in round 8; the five new limit fixtures are receiver controls too, and a receiver-blind check reports every one of them)',
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
    'packages/auth/test/room-access.test.ts — 4 of 54',
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
    'packages/auth/test/room-access.test.ts — 2 of 54',
    () =>
      edit('packages/auth/test/support/import-boundary.ts', [
        ["          record(node, 'computed-key');", '          void 0;'],
      ]),
  ],

  'boundary-blind-receiver': [
    'the receiver question goes — every `anything.memberships` under apps/ fires again',
    'packages/auth/test/room-access.test.ts — 9 of 54 (4 of 48 in round 8): three receiver controls, the real-repo access assertion — which then names 23 legitimate computed accesses under apps/ (`order[level]`, `errors[error]`, `holder[key]`…) — and the five round-9 limit fixtures, every one of which a receiver-blind check reports. That list is the argument for asking about the receiver.',
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
    'apps/server/test/ws-server.test.ts — 2 of 54, both by hanging until vitest gives up',
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
    'apps/server/test/ws-server.test.ts — 2 of 54; proves both window tests measure a duration and not merely an eventual close',
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
    'packages/auth — 12 (9 in errors.test.ts, 3 in org.test.ts). **`apps/server` stays green, and that is the finding**: the realtime sites survive a non-total describer because the counter moves first and the log is guarded. Measured, not assumed — three layers, and each one is separately mutable (see `sweep-log-before-counting`, `sweep-counts-then-reads`, `sweep-unguarded-log`). Requires `pnpm --filter @atrium/auth build` to reach `apps/server` at all.',
    () =>
      edit('packages/auth/src/errors.ts', [
        [
          "export function describeUnknown(value: unknown): string {\n  try {\n    if (value instanceof Error) return value.message;\n  } catch {\n    // A hostile prototype chain or a throwing `message` getter. Fall through to\n    // the string conversion, which is guarded in its turn.\n  }\n  try {\n    return String(value);\n  } catch {\n    // `Object.create(null)`, a throwing `Symbol.toPrimitive`, a Proxy.\n  }\n  return '<a rejection value that cannot be converted to a string>';\n}",
          'export function describeUnknown(value: unknown): string {\n  const message = (value as { message?: unknown }).message;\n  return typeof message === "string" ? message : String(value);\n}',
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
    'packages/auth/test/org.test.ts — 2. **Measured against round 8 and it caught this too**, but on the logged `timeoutMs: 40` rather than on the clock: the run took 165ms against a 2000ms ceiling, so the elapsed assertion never fired. The delta was right about what that assertion measured, and it was not the only thing pinning the number. `report-deadline-overruns` isolates the clock.',
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
    'packages/auth/test/org.test.ts — 2 under round 9, including the deadline test itself. **Against round 8 it fails 1, and not that one**: the deadline test stayed green (165ms → 600ms, both under its 2000ms ceiling) and the incidental red is the sibling late-rejection test, which stops being late when the deadline quadruples. That is the polish finding measured rather than argued — round 8 pinned the number in a log field and never on the clock.',
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
    'packages/auth/test/deployment.test.ts — 1 of 5',
    () =>
      edit('docker-compose.yml', [
        ["- '127.0.0.1:${POSTGRES_PORT:-5432}:5432'", "- '${POSTGRES_PORT:-5432}:5432'"],
        ["- '127.0.0.1:${MINIO_PORT:-9000}:9000'", "- '${MINIO_PORT:-9000}:9000'"],
        ["- '127.0.0.1:${MINIO_CONSOLE_PORT:-9001}:9001'", "- '${MINIO_CONSOLE_PORT:-9001}:9001'"],
      ]),
  ],
};

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

const [name, ...rest] = process.argv.slice(2);

if (name === '--restore') {
  restore();
} else if (name === '--verify') {
  verify();
} else if (name === '--against') {
  const [ref, ...paths] = rest;
  if (!ref) throw new Error('usage: --against <ref> <path…>');
  against(ref, paths);
} else if (name === '--list' || name === undefined) {
  for (const [key, [what, suite]] of Object.entries(mutations)) {
    console.info(`${key.padEnd(24)} ${what}\n${' '.repeat(25)}-> ${suite}`);
  }
} else if (mutations[name]) {
  snapshot();
  mutations[name][2]();
  console.info(`applied ${name} -> expect red in: ${mutations[name][1]}`);
} else {
  console.error(`unknown mutation "${name}"; try --list`);
  process.exit(1);
}
