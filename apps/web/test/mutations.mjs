#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * THE MUTATION LEDGER — re-runnable.
 *
 * A test that says "CATCHES: X" is a claim, and a claim is not a fact until
 * something has checked it. This script breaks the code in each of the ways the
 * comments name, runs the test that claims to catch it, and asserts the test
 * FAILS. Then it puts the file back.
 *
 *   node apps/web/test/mutations.mjs           # run the whole ledger
 *   node apps/web/test/mutations.mjs --list    # show it without running
 *
 * Exit 0 means every mutation was caught. Exit 1 means one of them was not,
 * which means the test that claims to catch it is decorative.
 *
 * Not covered here: the mutations whose evidence is a rendered pixel or a live
 * clock (the pin's height, the pulse animation, the invisible strip stealing
 * clicks, the focus ring as the browser resolved it). Those live in
 * e2e/*.spec.ts and their before/after measurements are in the issue receipt —
 * a browser is not always installed, and a ledger that silently skips is worse
 * than one that states its scope.
 * ------------------------------------------------------------------------- */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each entry: the defect being reintroduced, the exact edit that reintroduces
 * it, and the test file whose comments claim to catch it.
 */
const LEDGER = [
  {
    name: 'a quotation stops carrying the actor it was minted from',
    file: 'src/components/model/quotation.ts',
    find: '    actor: message.actor,\n',
    replace: '',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the message constructor ignores origin and builds one row shape',
    file: 'src/components/model/records.ts',
    find: '  const attribution = quotationFrom(record);',
    replace: "  const attribution = quotationFrom({ ...record, origin: 'seeded' });",
    test: 'test/record-integrity.test.tsx',
  },
  {
    name: 'a page-authored answer renders under the actor’s name again',
    file: 'src/components/model/records.ts',
    find: '  const attribution = quotationFrom(record);',
    replace: "  const attribution = quotationFrom({ ...record, origin: 'seeded' });",
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'composition slots stop rejecting raw attributed markup',
    file: 'src/components/model/slot.ts',
    find: "new Set(['q', 'blockquote', 'cite'])",
    replace: 'new Set([])',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'Maybe loses its runtime boundary and undefined stringifies',
    file: 'src/components/model/text.ts',
    find: "  if (typeof value !== 'string') return null;",
    replace:
      "  if (value === null) return null;\n  if (typeof value !== 'string') return String(value);",
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the hold acts on a plain click',
    file: 'src/components/primitives/HoldToAct.tsx',
    find: '      onPointerCancel={cancel}',
    replace:
      '      onClick={() => onAct?.({ actionId, armedAt: new Date().toISOString(), heldMs: 0 })}\n      onPointerCancel={cancel}',
    test: 'test/hold-to-act.test.tsx',
  },
  {
    name: 'releasing early stops cancelling the hold',
    file: 'src/components/primitives/HoldToAct.tsx',
    find: '      onPointerUp={cancel}',
    replace: '      onPointerUp={() => undefined}',
    test: 'test/hold-to-act.test.tsx',
  },
  {
    name: 'the hold duration is quietly shortened',
    file: 'src/components/primitives/HoldToAct.tsx',
    find: 'export const DEFAULT_HOLD_MS = 2000;',
    replace: 'export const DEFAULT_HOLD_MS = 120;',
    test: 'test/hold-to-act.test.tsx',
  },
  {
    name: 'the compressed row loses its destructive variant',
    file: 'src/components/attention/AttentionCompact.tsx',
    find: '{primary === undefined ? null : item.state.irreversible ? (',
    replace: '{primary === undefined ? null : false ? (',
    test: 'test/hold-to-act.test.tsx',
  },
  {
    name: 'the pin stops bounding its rows',
    file: 'src/components/model/records.ts',
    find: '  const budget = options.showAll === true ? PIN_HARD_CAP : PIN_COMPACT_BUDGET;',
    replace: '  const budget = Number.POSITIVE_INFINITY;',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the pin renders the overflow as rows instead of a count',
    file: 'src/components/attention/Pin.tsx',
    find: '{fold.compact.map((item) => (',
    replace: '{[...fold.compact, ...fold.overflow].map((item) => (',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'a clean item takes a row instead of compressing to a count',
    file: 'src/components/model/records.ts',
    find: '  const owed = hardestFirst(items.filter((item) => needsViewer(item.state)));\n  const clean = hardestFirst(items.filter((item) => !needsViewer(item.state)));',
    replace: '  const owed = hardestFirst(items);\n  const clean: readonly AttentionItem[] = [];',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the pin head glyph is hard-coded to ◆ again',
    file: 'src/components/attention/Pin.tsx',
    find: "{headGlyph ?? '·'}",
    replace: "{'◆'}",
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the focus ring goes back to --line3',
    file: 'app/globals.css',
    find: '  outline: 2px solid var(--tx1);',
    replace: '  outline: 2px solid var(--line3);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the destructive button renders the reversible gate’s amber',
    file: 'test/token-contrast.test.ts',
    find: "const DESTRUCTIVE_FILL = 'red3';",
    replace: "const DESTRUCTIVE_FILL = 'amb2';",
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'row actions go back to a constant with no handler',
    file: 'src/components/timeline/Timeline.tsx',
    find: '            onSelect:\n              onRowAction === undefined ? undefined : () => onRowAction(entry.id, action.id),',
    replace: '            onSelect: undefined,',
    test: 'test/timeline-handlers.test.tsx',
  },
  {
    name: 'onOpenTag is dropped on the way to the row',
    file: 'src/components/timeline/Timeline.tsx',
    find: '<TimelineRow actions={actions} entry={entry} key={entry.id} onOpenTag={onOpenTag} />',
    replace: '<TimelineRow actions={actions} entry={entry} key={entry.id} />',
    test: 'test/timeline-handlers.test.tsx',
  },
  {
    name: 'mark seen and unmark seen stop being forwarded',
    file: 'src/components/timeline/Timeline.tsx',
    find: '              onMarkSeen={onMarkSeen === undefined ? undefined : () => onMarkSeen(entry.id)}\n              onUnmarkSeen={onUnmarkSeen === undefined ? undefined : () => onUnmarkSeen(entry.id)}',
    replace: '',
    test: 'test/timeline-handlers.test.tsx',
  },
];

if (process.argv.includes('--list')) {
  for (const entry of LEDGER) console.info(`${entry.test.padEnd(34)} ${entry.name}`);
  process.exit(0);
}

let caught = 0;
const escaped = [];

for (const entry of LEDGER) {
  const path = resolve(WEB, entry.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(entry.find)) {
    escaped.push(`${entry.name} — the ledger's anchor is stale in ${entry.file}`);
    continue;
  }
  writeFileSync(path, original.replace(entry.find, entry.replace));
  let failed = false;
  try {
    execFileSync('pnpm', ['exec', 'vitest', 'run', entry.test], {
      cwd: WEB,
      stdio: 'ignore',
    });
  } catch {
    failed = true;
  } finally {
    writeFileSync(path, original);
  }
  if (failed) {
    caught += 1;
    console.info(`caught   ${entry.name}`);
  } else {
    escaped.push(`${entry.name} — ${entry.test} passed anyway`);
    console.info(`ESCAPED  ${entry.name}`);
  }
}

console.info(`\n${caught}/${LEDGER.length} mutations caught`);
if (escaped.length > 0) {
  console.error('\nnot caught:');
  for (const line of escaped) console.error(`  ${line}`);
  process.exit(1);
}
