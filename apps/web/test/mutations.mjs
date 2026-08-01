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
 *
 * `test` names a vitest file. `typecheck: true` runs `tsc --noEmit` instead,
 * which is how a TYPE-level guarantee gets a ledger entry — vitest does not
 * typecheck, so an `@ts-expect-error` assertion is invisible to it, and a
 * guarantee whose only enforcement is the compiler needs the compiler to be the
 * thing that runs. Added in round 4 for the entry brand: the round-3 defect was
 * that a forged `AuthoredMessageEntry` literal COMPILED, so "it no longer
 * compiles" is the claim, and only tsc can falsify it.
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
    find: '    if (diverged !== null) throw new Error(diverged);',
    replace: '    void diverged;',
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

  /* --- round 4 -------------------------------------------------------------
   * The round-3 gauntlet's findings, each reintroduced by name. The first two
   * are the same defect from opposite ends and both have to fire: un-brand the
   * type and the forgery compiles again; delete the render-boundary check and
   * a cast renders it. A fix that only holds when both are present is a fix
   * with a single point of failure, which is what the last three rounds shipped.
   * ---------------------------------------------------------------------- */
  {
    name: 'the message entry stops being branded and a forged literal compiles',
    file: 'src/components/model/records.ts',
    find: "  readonly [entryBrand]: 'message-entry';\n",
    replace: '',
    typecheck: true,
    test: 'tsc --noEmit',
  },
  {
    name: 'the render boundary stops re-deriving the body from the attribution',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: '  if (diverged !== null) throw new Error(diverged);',
    replace: '  void diverged;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the render-boundary check compares the body against itself',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: 'entry.body, entry.attribution.text, {',
    replace:
      "entry.body, entry.body.map((s) => (s.kind === 'mention' ? `@${s.text}` : s.text)).join(''), {",
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'system voice stops rejecting "X said" framing',
    file: 'src/components/model/quotation.ts',
    find: '    pattern:\n      /\\b(?:said|says|saying|say|tell|tells|told|telling|wrote|writes|writing|asked|asks|asking|replied|replies|remarked|remarks|commented|comments|quoted|quotes)\\b/i,',
    replace: '    pattern: /^(?!)/,',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'system voice stops rejecting the first person',
    file: 'src/components/model/quotation.ts',
    find: "    pattern:\n      /\\b(?:I|I'm|I've|I'll|I'd|me|my|mine|myself|we|we're|we've|we'll|we'd|us|our|ours|ourselves)\\b/i,",
    replace: '    pattern: /^(?!)/,',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the system-voice bans hold at the constructor but not at the JSON boundary',
    file: 'src/components/model/quotation.ts',
    find: '  return !SYSTEM_VOICE_BANS.some((ban) => ban.pattern.test(value.text as string));',
    replace: '  return true;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the composer suppresses its focus ring again',
    file: 'src/components/frame/frame.module.css',
    find: '.cbox textarea:focus-visible {\n  outline: 2px solid var(--tx1);',
    replace: '.cbox textarea:focus-visible {\n  outline: none;',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'focusing the composer replaces the amber binding border with grey',
    file: 'src/components/frame/frame.module.css',
    find: '.cbox.cboxBound:focus-within {\n  border-color: var(--ambbd);\n}',
    replace: '',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the ring audit goes back to skipping controls that paint no ring',
    file: 'e2e/gallery.spec.ts',
    find: "        if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0) return none;",
    replace:
      "        if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0) return null;",
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the claim underline goes back to a token below the 1.4.11 floor',
    file: 'app/globals.css',
    find: '  border-bottom: 1px dotted var(--tx2);',
    replace: '  border-bottom: 1px dotted var(--line3);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the rendered audit drops its non-text-graphic sweep',
    file: 'e2e/audit.ts',
    find: "    { what: 'claim underline', selector: '[data-claim=\"true\"]', side: 'borderBottomColor' },",
    replace: '',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the hold progress bar goes back inside the button and into its name',
    file: 'src/components/primitives/HoldToAct.tsx',
    find: '      <span aria-hidden="true" className={styles.holdFill} />',
    replace:
      '      <span aria-label="hold progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={0} className={styles.holdFill} role="progressbar" />',
    test: 'test/hold-to-act.test.tsx',
  },
  {
    name: 'the surface chip welds its label to its count again',
    file: 'src/components/frame/SurfaceIndicators.tsx',
    find: '            aria-label={\n              surface.count === null ? surface.label : `${surface.label} — ${surface.count}`\n            }\n',
    replace: '',
    test: 'test/attention.test.tsx',
  },
  {
    name: 'a rail room chip welds its name to its badge',
    file: 'src/components/frame/Rail.tsx',
    find: '      aria-label={name}\n',
    replace: '',
    test: 'test/attention.test.tsx',
  },
  {
    name: 'the routine strip’s count, window and actors run together',
    file: 'src/components/timeline/RoutineCollapse.tsx',
    find: "        aria-label={`${count} routine ${count === 1 ? 'row' : 'rows'} between ${entry.from} and ${entry.to}, from ${entry.actors.join(', ')} — ${entry.open ? 'click to hide' : 'click to peek'}`}\n",
    replace: '',
    test: 'test/attention.test.tsx',
  },
  {
    name: 'the gallery frame drops the composer’s key and ref seams again',
    file: 'app/gallery/RoomFrame.tsx',
    find: '            onKeyDown={on.onComposerKeyDown}\n',
    replace: '',
    test: 'test/composer.test.tsx',
  },
  {
    name: 'the workspace monogram goes back to a hardcoded LV',
    file: 'app/gallery/RoomFrame.tsx',
    find: '          initials={initials(props.viewer.name)}',
    replace: '          initials="LV"',
    test: 'test/composer.test.tsx',
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
    const argv =
      entry.typecheck === true
        ? ['exec', 'tsc', '--noEmit']
        : ['exec', 'vitest', 'run', entry.test];
    execFileSync('pnpm', argv, { cwd: WEB, stdio: 'ignore' });
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
