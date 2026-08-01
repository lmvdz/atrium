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
    find: '  const compact = rest.slice(start, start + PIN_PAGE);',
    replace: '  const compact = rest.slice(start);',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the way out of the fold goes idempotent again',
    file: 'src/components/model/records.ts',
    find: '  const page = ((requested % pageCount) + pageCount) % pageCount;',
    replace: '  const page = Math.min(requested, 1);',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the overflow control raises a cap instead of paging',
    file: 'src/components/attention/Pin.tsx',
    find: '                  setPage((current) => current + 1);',
    replace: '                  setPage(1);',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the overflow label promises the total rather than the next page',
    file: 'src/components/attention/Pin.tsx',
    find: '  return fold.wraps ? `back to the hardest ${n}` : `show the next ${n}`;',
    replace: '  return `show the next ${fold.overflow.length}`;',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'an authored body stops being reconciled against its record',
    file: 'src/components/model/records.ts',
    find: '    if (rendered !== record.text) {',
    replace: '    if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the @ of a mention stops counting as text the reader sees',
    file: 'src/components/model/records.ts',
    find: "  return segment.kind === 'mention' ? `@${segment.text}` : segment.text;",
    replace: '  return segment.text;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a shipped fixture body drifts from the message it is attributed to',
    file: 'app/gallery/fixtures.ts',
    find: "{ kind: 'text', text: ' on both tables, not the backfill.' },",
    replace: "{ kind: 'text', text: ' on both tables, and drop it on Friday.' },",
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the room head takes a ReactNode again',
    file: 'src/components/frame/RoomHead.tsx',
    find: '      {surfaces.node}',
    replace: '      {surfaces as unknown as import("react").ReactNode}',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the disabled surface goes back to an alpha fade',
    file: 'src/components/frame/frame.module.css',
    find: '.surf[disabled] {\n  cursor: default;\n}',
    replace: '.surf[disabled] {\n  cursor: default;\n  opacity: 0.55;\n}',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the disabled label becomes identical to the enabled one',
    file: 'src/components/frame/frame.module.css',
    find: '.surf[disabled] .surfLabel {\n  color: var(--tx2);\n}',
    replace: '.surf[disabled] .surfLabel {\n  color: var(--tx1);\n}',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the audit harness is written to skip what its rule covers',
    file: 'e2e/audit.ts',
    find: '    if (alpha === 0) continue;',
    replace: '    if (alpha < 0.999) continue;',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the armed fill moves to a token that cannot carry its label',
    file: 'src/components/primitives/primitives.module.css',
    find: ".hold[data-armed='true'] {\n  background: var(--red);",
    replace: ".hold[data-armed='true'] {\n  background: var(--redbg3);",
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the token audit measures the light theme twice and calls one of them dark',
    file: 'test/token-contrast.test.ts',
    find: "  const start = TOKENS.search(new RegExp(`^${selector.replace('.', '\\\\.')}\\\\s*\\\\{`, 'm'));",
    replace: '  const start = TOKENS.indexOf(selector);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the composer stops sending on Enter while its footer still says it does',
    file: 'src/components/frame/Composer.tsx',
    find: "      if (event.key !== 'Enter' || event.shiftKey) return;",
    replace: '      return;',
    test: 'test/composer.test.tsx',
  },
  {
    name: 'onSend goes back to taking no argument',
    file: 'src/components/frame/Composer.tsx',
    find: '    onSend?.(text);',
    replace: '    onSend?.(undefined as unknown as string);',
    test: 'test/composer.test.tsx',
  },
  {
    name: 'the arming record drops the measured hold at the card boundary',
    file: 'src/components/attention/AttentionCard.tsx',
    find: '(arming) => onArm(item.id, arming)',
    replace: '(arming) => onArm(item.id, { ...arming, heldMs: 0 })',
    test: 'test/hold-to-act.test.tsx',
  },
  {
    name: 'the arming record loses the actor the convention requires',
    file: 'src/components/primitives/HoldToAct.tsx',
    find: '    const arming: Arming = { actionId, actor, armedAt: new Date().toISOString(), heldMs };',
    replace:
      "    const arming: Arming = { actionId, actor: '', armedAt: new Date().toISOString(), heldMs };",
    test: 'test/hold-to-act.test.tsx',
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
