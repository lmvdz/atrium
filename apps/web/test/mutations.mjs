#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every anchor in this
// ledger is a VERBATIM SLICE OF ANOTHER FILE'S SOURCE, matched with
// `String.includes`. Eleven of them quote a line that contains a template
// literal, so the `${…}` has to be there character for character — the rule is
// looking for a template written by mistake and finding one quoted on purpose.
// Suppressed with a reason rather than left standing: r8 corrected the claim
// "biome 0" to "0 errors, 12 warnings", and a dozen permanent warnings is how a
// twelfth one stops being visible.
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
import ts from 'typescript';

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
    /* Round 5 rewrote this entry rather than deleting it. The old anchor was
       `actor: message.actor` — a field that no longer exists, because carrying
       the actor beside the id is the defect four rounds kept relocating. The
       guarantee at the mint is now "only a message a person actually wrote
       becomes quotable at all", so that is what gets broken here. */
    name: 'the mint stops checking that the message is somebody’s own words',
    file: 'src/components/model/quotation.ts',
    find: '  if (!isQuotableOrigin(message.origin)) return null;',
    replace: '  void message;',
    test: 'test/quotation.test.tsx',
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
    find: '  const compact = rest.slice(start, start + budget);',
    replace: '  const compact = rest.slice(start);',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the way out of the fold goes idempotent again',
    file: 'src/components/model/records.ts',
    find: '    return ((requested % count) + count) % count;',
    replace: '    return Math.min(requested, 1);',
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
    find: '            onSelect:\n              onRowAction === undefined',
    replace:
      '            onSelect: undefined,\n            unusedSelect:\n              onRowAction === undefined',
    test: 'test/timeline-handlers.test.tsx',
  },
  {
    name: 'onOpenTag is dropped on the way to the row',
    file: 'src/components/timeline/Timeline.tsx',
    find: `            <TimelineRow
              actions={actions}
              entry={entry}
              key={entry.id}
              onOpenAttachment={onOpenAttachment}
              onOpenTag={onOpenTag}
            />`,
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
    find: "bodyDivergence('TimelineRow', entry.body, attribution.text, {",
    replace:
      "bodyDivergence('TimelineRow', entry.body, entry.body.map((s) => (s.kind === 'mention' ? `@${s.text}` : s.text)).join(''), {",
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'system voice stops rejecting "X said" framing',
    file: 'src/components/model/quotation.ts',
    find: 'const SPEECH_REPORT: Ban = {\n  pattern:\n',
    replace: 'const SPEECH_REPORT: Ban = {\n  pattern: /^(?!)/ ??\n',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'system voice stops rejecting the first person',
    file: 'src/components/model/quotation.ts',
    find: 'const FIRST_PERSON: Ban = {\n  pattern:\n',
    replace: 'const FIRST_PERSON: Ban = {\n  pattern: /^(?!)/ ??\n',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the system-voice bans hold at the constructor but not at the JSON boundary',
    file: 'src/components/model/quotation.ts',
    find: '  return statementDefect(parts) === null;',
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
    find: '.cbox.cboxBound:focus-within {\n  border-color: var(--amb2);\n}',
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
    find: '            aria-label={surface.count === null ? label : `${label} — ${surface.count}`}\n',
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
    find: "        aria-label={`${count} routine ${count === 1 ? 'row' : 'rows'} between ${from} and ${to}, from ${actors} — ${entry.open ? 'click to hide' : 'click to peek'}`}\n",
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

  /* --- round 5 -------------------------------------------------------------
   * The round-4 gauntlet's findings, each reintroduced by name.
   *
   * The first block is the cardinal defect at its FOURTH address. Round 4's
   * ledger entry for it asserted only that "a forged literal compiles", which is
   * why 51/51 validated a claim the code did not hold: the forgery that shipped
   * was a SPREAD, and a spread carries `unique symbol` keys through. Every route
   * the receipt demonstrated is an entry here — the spread, the JSON parse, and
   * each render boundary that prints a name.
   * ---------------------------------------------------------------------- */
  {
    name: 'the quotation carries an actor again and a spread can overwrite it',
    file: 'src/components/model/quotation.ts',
    find: '  readonly mintedFrom: string;\n  readonly [citationBrand]: ',
    replace:
      '  readonly mintedFrom: string;\n  readonly actor?: string;\n  readonly [citationBrand]: ',
    typecheck: true,
    test: 'tsc --noEmit',
  },
  {
    name: 'the derivation reads the carried actor instead of the cited record',
    file: 'src/components/model/quotation.ts',
    find: '    actor: record.actor,\n    text: record.text,',
    replace:
      '    actor: (quotation as unknown as { actor?: string }).actor ?? record.actor,\n    text: record.text,',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'parseQuotation goes back to validating shape and never provenance',
    file: 'src/components/model/quotation.ts',
    find: '  const record = ledger.recordFor(value.messageId);\n  if (record === null) return false;',
    replace:
      '  const record = ledger.recordFor(value.messageId);\n  if (record === null) return true;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'parseQuotation hands the incoming object through instead of the citation',
    file: 'src/components/model/quotation.ts',
    find: "  return adopt(value, record, 'parseQuotation') as unknown as Quotation;",
    replace: '  return value as Quotation;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the ledger lets two records claim one message id',
    file: 'src/components/model/quotation.ts',
    find: '    if (existing !== undefined && existing !== record) {',
    replace: '    if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the timeline row stops looking the actor up from the message id',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: "  const attribution = useAttribution(entry.attribution, 'TimelineRow');",
    replace:
      '  const attribution = entry.attribution as unknown as { messageId: string; actor: string; text: string };',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the reply banner stops looking the actor up from the message id',
    file: 'src/components/frame/Composer.tsx',
    find: "  const reply = useAttribution(to, 'Composer reply banner');",
    replace:
      '  const reply = to as unknown as { messageId: string; actor: string; at: string; text: string; room: string | null };',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the receipt excerpt stops looking the actor up from the message id',
    file: 'src/components/lens/ReceiptView.tsx',
    find: "  const excerpt = useAttribution(entry.excerpt, 'ReceiptView provenance');",
    replace:
      '  const excerpt = entry.excerpt as unknown as { messageId: string; actor: string; at: string; text: string; room: string | null };',
    test: 'test/attribution.test.tsx',
  },
  {
    /* ROUND 10: the anchor was `if (ledger === null)`, and r9 moved the refusal
       into `useRegister`, where the value is the whole register. A stale anchor
       is a guard nobody is running — `test/harness-integrity.test.ts` now asserts
       every anchor in this ledger still matches its file exactly once, so the
       next one is a red gate rather than a discovery. */
    name: 'a render boundary with no record ledger degrades instead of refusing',
    file: 'src/components/model/ledger.tsx',
    find: '  if (register === null) {\n    throw new Error(',
    replace: '  if (false) {\n    throw new Error(',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the provenance token goes back to a carried room',
    file: 'src/components/model/quotation.ts',
    find: '    room: record.room ?? null,',
    replace: '    room: (quotation as unknown as { room?: string }).room ?? record.room ?? null,',
    test: 'test/quotation.test.tsx',
  },

  /* The first-person ban, re-scoped to the system's framing. */
  {
    name: 'the first-person ban goes back to covering the option payload',
    file: 'src/components/model/quotation.ts',
    find: '  verbatim: VERBATIM_BANS,',
    replace: '  verbatim: SYSTEM_VOICE_BANS,',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the payload exemption swallows the system’s own framing',
    file: 'src/components/model/quotation.ts',
    find: '  system: SYSTEM_VOICE_BANS,',
    replace: '  system: VERBATIM_BANS,',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a statement may open with somebody else’s words again',
    file: 'src/components/model/quotation.ts',
    find: "  if (first === undefined || first.voice !== 'system' || first.text.trim().length === 0) {",
    replace: '  if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the JSON boundary stops checking the parts add up to the text',
    file: 'src/components/model/quotation.ts',
    find: "  if (parts.map((part) => part.text).join('') !== value.text) return false;",
    replace: '  void 0;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a statement arriving without parts gets the payload exemption by default',
    file: 'src/components/model/quotation.ts',
    find: "    : [{ voice: 'system' as const, text: value.text }];",
    replace: "    : [{ voice: 'verbatim' as const, text: value.text }];",
    test: 'test/attribution.test.tsx',
  },

  /* IME. */
  {
    name: 'Enter sends the half-composed IME buffer as a typed message',
    file: 'src/components/frame/Composer.tsx',
    find: '      if (native.isComposing || native.keyCode === 229 || composing.current) return;',
    replace: '      void native;',
    test: 'test/composer.test.tsx',
  },
  {
    name: 'the IME check reads only the modern signal and misses keyCode 229',
    file: 'src/components/frame/Composer.tsx',
    find: '      if (native.isComposing || native.keyCode === 229 || composing.current) return;',
    replace: '      if (native.isComposing || composing.current) return;',
    test: 'test/composer.test.tsx',
  },

  /* The bound against the viewport. */
  {
    name: 'the pin’s belt goes back to a constant that cannot shrink',
    file: 'src/components/model/records.ts',
    find: '  beltShare: 0.34,',
    replace: '  beltShare: 1,',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the fold ignores the room there is and renders the full budget',
    file: 'src/components/model/records.ts',
    find: '  const compact = rest.slice(start, start + budget);',
    replace: '  const compact = rest.slice(start, start + PIN_COMPACT_BUDGET);',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the rendered pin stops measuring the viewport it has to fit',
    file: 'src/components/attention/Pin.tsx',
    find: '  const fold = foldPin(items, { openId, page, budget });',
    replace: '  const fold = foldPin(items, { openId, page });',
    test: 'test/pin-bound.test.tsx',
  },
  {
    name: 'the overflow control goes inert where there is no room for a row',
    file: 'src/components/model/records.ts',
    find: '      nextPage: next === undefined || owed.length < 2 ? [] : [next],',
    replace: '      nextPage: [],',
    test: 'test/pin-bound.test.tsx',
  },

  /* The graphics registry, and the harness exclusions. */
  {
    name: 'the graphics registry goes back to one entry',
    file: 'e2e/audit.ts',
    find: "    { what: 'presence dot (here)', selector: '[data-presence=\"here\"]', side: 'backgroundColor' },",
    replace: '',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the coverage guard goes back to counting one graphic’s instances',
    file: 'e2e/gallery.spec.ts',
    find: '            audit.graphicKinds.length,',
    replace: '            audit.graphicsChecked,',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'a filled graphic is measured against its own fill and reports 1:1',
    file: 'e2e/audit.ts',
    find: '      const outside = backdrop(el.parentElement);',
    replace: '      const outside = backdrop(el);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the presence ring goes back to the token below the 1.4.11 floor',
    file: 'src/components/frame/frame.module.css',
    find: '.presAway {\n  background: transparent;\n  border: 1.5px solid var(--tx2);\n}',
    replace: '.presAway {\n  background: transparent;\n  border: 1.5px solid var(--line3);\n}',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the ANSWERING border goes back to --ambbd at 1.76:1',
    file: 'src/components/frame/frame.module.css',
    find: '.cboxBound {\n  border-color: var(--amb2);',
    replace: '.cboxBound {\n  border-color: var(--ambbd);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the REPLYING border goes back to --filebd at 1.46:1',
    file: 'src/components/frame/frame.module.css',
    find: '.cboxReplying {\n  border-color: var(--blu2);',
    replace: '.cboxReplying {\n  border-color: var(--filebd);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the destructive card’s border goes back under the 1.4.11 floor',
    file: 'src/components/attention/attention.module.css',
    find: '.acardDestructive {\n  background: var(--redbg);\n  border-color: var(--red2);',
    replace: '.acardDestructive {\n  background: var(--redbg);\n  border-color: var(--redbd);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the focus sweep goes back to a constant cap of 90 controls',
    file: 'e2e/gallery.spec.ts',
    find: '      for (let i = 0; i < CEILING; i += 1) {',
    replace: '      for (let i = 0; i < 90; i += 1) {',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the reduced-motion check goes back to never testing transitions',
    file: 'e2e/gallery.spec.ts',
    find: '        const longest = style.transitionDuration',
    replace: '        const longest = (0 as unknown as string)',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the disabled sweep goes back to reading only the first span',
    file: 'e2e/gallery.spec.ts',
    find: "          const spans = [...button.querySelectorAll('span')].filter(",
    replace: "          const spans = [button.querySelector('span')].filter(",
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the rendered audit goes back to running only on /gallery',
    file: 'e2e/gallery.spec.ts',
    find: "    { path: '/', ready: '[data-region=\"needs-you\"]' },",
    replace: '',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the text sweep goes back to skipping ::before, ::after and ::placeholder',
    file: 'e2e/audit.ts',
    find: "    for (const which of ['::before', '::after']) {",
    replace: '    for (const pseudo of []) {',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the pin harness goes back to one hard-coded viewport height',
    file: 'e2e/pin-bound.spec.ts',
    find: 'const HEIGHTS = [420, 500, 640, 768, 900] as const;',
    replace: 'const HEIGHTS = [900] as const;',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'presence stops being said in words and goes back to a dot alone',
    file: 'src/components/frame/Rail.tsx',
    find: '      <span className="atr-meta">{meta}</span>',
    replace: '      {note === null ? null : <span className="atr-meta">{note}</span>}',
    test: 'test/attention.test.tsx',
  },

  /* --- round 5, from the blind cross-lineage review of round 5's own fix -----
   * The standing rule is that a fix round's claims get the same adversarial
   * treatment as the original. gpt-5.6 found four defects in this round's work
   * before it was pushed; each is reintroduced here by name.
   * ---------------------------------------------------------------------- */
  {
    /* Round 6 moved this check off the row and onto the citation, so it holds at
       all five resolution boundaries instead of at one. The mutation moved with
       it: break `resolveCitation` and every boundary stops checking. */
    name: 'a row can be rendered against a different register than it was minted from',
    file: 'src/components/model/quotation.ts',
    find: '  if (citation.mintedFrom !== here) {',
    replace: '  if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the row prints the caller’s message id and time instead of the record’s',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: '      data-message-id={attribution.messageId}\n      data-origin={attribution.origin}',
    replace: '      data-message-id={entry.id}\n      data-origin={entry.origin}',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'system voice stops being checked at the render boundary',
    file: 'src/components/primitives/Voice.tsx',
    find: "  statementText({ ...statement, text: parts.map((p) => p.text).join(''), parts }, 'SystemVoice');",
    replace: '  void parts;',
    test: 'test/quotation.test.tsx',
  },
  {
    name: 'the receipt’s history line prints an unchecked statement',
    file: 'src/components/lens/ReceiptView.tsx',
    find: '<SystemVoice className={styles.happenedVoice} inline statement={line.statement} />',
    replace: '<span>{line.statement.text}</span>',
    test: 'test/record-integrity.test.tsx',
  },
  {
    name: 'a recorded payload may follow any framing a caller writes',
    file: 'src/components/model/quotation.ts',
    find: '    if (!CHOSE_FRAMING.test(first.text)) {',
    replace: '    if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a recorded payload may be split across spans to dodge the shape check',
    file: 'src/components/model/quotation.ts',
    find: "    if (parts.length !== 2 || parts[1]?.voice !== 'verbatim') {",
    replace: '    if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the way out of the fold goes back inside the clipped box',
    file: 'src/components/attention/Pin.tsx',
    find: '            <div className={styles.pinMore}>',
    replace: '            <div className={styles.pinList}>',
    test: 'test/pin-bound.test.tsx',
  },

  /* --- round 5, second lineage ---------------------------------------------
   * grok-4.5 reviewed the same fix blind and independently of gpt-5.6. It could
   * not break the row's display path; it went past it and found the side
   * channels — the places a page-authored string still reaches the screen, or a
   * real message id still reaches an action, without passing the model at all.
   * The two lineages overlapped on nothing, which is the argument for running
   * both.
   * ---------------------------------------------------------------------- */
  {
    name: 'the row action bus goes back to trusting the caller’s entry id',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: '                    : () => action.onSelect?.(attribution.messageId)',
    replace: '                    : () => action.onSelect?.(entry.id)',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the row tag goes back to the caller’s entry id',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: '        <RowTagButton entry={entry} messageId={attribution.messageId} onOpenTag={onOpenTag} />',
    replace: '        <RowTagButton entry={entry} messageId={entry.id} onOpenTag={onOpenTag} />',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a slot can mint a provenance token again',
    file: 'src/components/model/slot.ts',
    find: "  'data-attribution',\n",
    replace: '',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the slot walk’s node budget fails open again',
    file: 'src/components/model/slot.ts',
    find: '  if (budget.left <= 0) {',
    replace: '  if (budget.left <= 0) return;\n  if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a rationale stops being held to the system voice it declares',
    file: 'src/components/model/rationale.ts',
    find: '  const defect = systemVoiceDefect(trimmed);',
    replace: '  const defect = null as string | null;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'isRationale stops applying the same check the constructor does',
    file: 'src/components/model/rationale.ts',
    find: '    systemVoiceDefect(value) === null',
    replace: '    true',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the Send button sends a half-composed IME buffer',
    file: 'src/components/frame/Composer.tsx',
    find: '    if (composing.current) return;',
    replace: '    void composing;',
    test: 'test/composer.test.tsx',
  },
  {
    name: 'system voice is validated on the value and rendered from it again',
    file: 'src/components/primitives/Voice.tsx',
    find: "  statementText({ ...statement, text: parts.map((p) => p.text).join(''), parts }, 'SystemVoice');",
    replace: "  statementText(statement, 'SystemVoice');",
    test: 'test/quotation.test.tsx',
  },

  /* --- round 6 -------------------------------------------------------------
   * The round-5 gauntlet's findings. Its closing sentence is the brief: "every
   * lesson it learned was applied to that row and to no more than one neighbour
   * of each kind." So the entries below are grouped by DEFECT CLASS, and each
   * class has an entry per call site rather than an entry for the instance the
   * receipt happened to name.
   * ---------------------------------------------------------------------- */

  /* D4 — the register checksum, at all five boundaries that resolve a citation.
     Round 5 put it on `AuthoredMessageEntry`, which is one of them. Each entry
     below breaks the check and asserts a DIFFERENT boundary notices. */
  {
    name: 'the checksum leaves `room` out, and two rooms hash the same',
    file: 'src/components/model/quotation.ts',
    find: ", record.room ?? '∅'",
    replace: '',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a citation stops carrying the register it was minted from',
    file: 'src/components/model/quotation.ts',
    find: '  return { messageId: message.id, mintedFrom: recordFingerprint(message) } as unknown as Quotation;',
    replace: "  return { messageId: message.id, mintedFrom: '' } as unknown as Quotation;",
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'nesting a second record register silently shadows the first',
    file: 'src/components/model/ledger.tsx',
    find: '  if (outer !== null && outer.ledger !== ledger) {',
    replace: '  if (false) {',
    test: 'test/attribution.test.tsx',
  },

  /* D3 — every handler takes the RESOLVED id. Three call sites, three entries. */
  {
    name: 'the receipt’s provenance row acts on a second source instead of the excerpt',
    file: 'src/components/lens/ReceiptView.tsx',
    find: '      onClick={onJump === undefined ? undefined : () => onJump(excerpt.messageId)}',
    replace: "        onClick={onJump === undefined ? undefined : () => onJump('')}",
    test: 'test/timeline-handlers.test.tsx',
  },
  {
    name: 'the correction link dispatches an empty id again',
    file: 'src/components/lens/ReceiptView.tsx',
    find: '        onClick={onJump === undefined ? undefined : () => onJump(record.id)}',
    replace: "        onClick={onJump === undefined ? undefined : () => onJump('')}",
    test: 'test/timeline-handlers.test.tsx',
  },
  {
    name: 'the cross-room trace reveals a caller-supplied id',
    file: 'src/components/attention/CrossRoomJump.tsx',
    find: "  const target = useCitedRecord(jump.targetMessage, 'CrossRoomJump target');",
    replace: '  const target = jump.targetMessage as unknown as { id: string };',
    test: 'test/timeline-handlers.test.tsx',
  },

  /* D15 — the chosen arm derives its id and its time, like the authored one. */
  {
    name: 'the chosen row prints the caller’s id and time again',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: '      data-message-id={record.id}\n      data-origin={record.origin}',
    replace: '      data-message-id={entry.id}\n      data-origin={entry.origin}',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the chosen row stops resolving the message it is about',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: "  const record = useCitedRecord(entry.citation, 'TimelineRow chosen');",
    replace:
      '  const record = entry as unknown as { id: string; at: string; origin: string; room: null };',
    test: 'test/attribution.test.tsx',
  },

  /* D5 — the render boundary for the OTHER page-authored string type. */
  {
    name: 'the open attention card prints an unchecked rationale',
    file: 'src/components/attention/AttentionCard.tsx',
    find: "{rationaleText(item.rationale, 'AttentionCard')}",
    replace: '{item.rationale}',
    test: 'test/attention.test.tsx',
  },
  {
    name: 'the compressed row prints an unchecked rationale',
    file: 'src/components/attention/AttentionCompact.tsx',
    find: "  const why = rationaleText(item.rationale, 'AttentionCompact');",
    replace: '  const why = item.rationale as string;',
    test: 'test/attention.test.tsx',
  },
  {
    name: 'rationaleText stops applying the check its constructor applies',
    file: 'src/components/model/rationale.ts',
    find: '  if (!isRationale(painted)) {',
    replace: '  if (false) {',
    test: 'test/attention.test.tsx',
  },

  /* D6 — the structural backstop. There is no field a renderer can put a name
     in, on either of the two rows that had one. */
  /* ---------------------------------------------------------------------------
   * ROUND 7, D2: THESE TWO ENTRIES PROVED THE WRONG THING.
   *
   * Both added a NEW REQUIRED property and required `tsc` to fail. What that
   * proves is that adding a required property breaks the fixtures — which is true
   * of every interface in the program and says nothing about whether a free
   * string field already exists. `CorrectionEntry.heading: string` sat there
   * through the whole of round 6, unconstrained and rendered one line above the
   * correction's words, while CONVENTIONS said the property was "checkable by
   * reading the types" and this ledger reported it covered.
   *
   * The entries below break the claim the way a defect would: an OPTIONAL free
   * string that a renderer prints. The catcher is the type-reading test, not
   * `tsc` — a compiler cannot refuse an optional property, which is exactly why
   * the compiler was the wrong instrument for this claim.
   * ------------------------------------------------------------------------- */
  {
    name: 'a correction’s heading goes back to a free string',
    file: 'src/components/model/records.ts',
    find: '  readonly heading: SystemStatement;',
    replace: '  readonly heading: string;',
    test: 'test/record-integrity.test.tsx',
  },
  {
    name: 'a receipt history line gets an optional free string beside the words',
    file: 'src/components/model/records.ts',
    find: 'export interface HappenedLine {\n  readonly id: string;\n  readonly kind: HappenedKind;\n',
    replace:
      'export interface HappenedLine {\n  readonly id: string;\n  readonly whoSaid?: string;\n  readonly kind: HappenedKind;\n',
    test: 'test/record-integrity.test.tsx',
  },
  {
    name: 'a provenance note goes back to a free string beside the quoted words',
    file: 'src/components/model/records.ts',
    find: 'one field\n   * over.\n   */\n  readonly note: Maybe<SystemStatement>;',
    replace: 'one field\n   * over.\n   */\n  readonly note: Maybe<string>;',
    test: 'test/record-integrity.test.tsx',
  },

  /* D10 — the denylist sees the spelling the platform produces. */
  {
    name: 'a slot’s tag denylist goes back to being case-sensitive',
    file: 'src/components/model/slot.ts',
    find: 'ATTRIBUTED_TAGS.has(node.type.toLowerCase())',
    replace: 'ATTRIBUTED_TAGS.has(node.type)',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a slot’s prop denylist goes back to being case-sensitive',
    file: 'src/components/model/slot.ts',
    find: '    if (ATTRIBUTED_PROPS_FOLDED.has(key.toLowerCase())) {',
    replace: '    if (ATTRIBUTED_PROPS.includes(key)) {',
    test: 'test/attribution.test.tsx',
  },

  /* D11 — the composition latch has every exit wired. */
  {
    name: 'the composition flag goes back to clearing only on compositionend',
    file: 'src/components/frame/Composer.tsx',
    find: '          onBlur={() => setComposing(false)}\n',
    replace: '',
    test: 'test/composer.test.tsx',
  },
  {
    name: 'a change event can no longer end a stuck composition',
    file: 'src/components/frame/Composer.tsx',
    find: '            if (native.isComposing === false) setComposing(false);',
    replace: '            void native;',
    test: 'test/composer.test.tsx',
  },

  /* D12 — an id minted from a caller-supplied value is not unique. */
  {
    name: 'the hold control mints its aria ids from the caller’s action id again',
    file: 'src/components/primitives/HoldToAct.tsx',
    find: '  const meterId = `${uid}-hold-progress`;\n  const describeId = `${uid}-hold-describe`;',
    replace:
      '  const meterId = `${actionId}-hold-progress`;\n  const describeId = `${actionId}-hold-describe`;',
    test: 'test/hold-to-act.test.tsx',
  },

  /* D2 — the instrument, before the thing it measures. */
  {
    name: 'the guard enumeration goes back to a regex that cannot cross a paren',
    file: 'test/token-contrast.test.ts',
    find: '    const guards = guardsIn(auditProgram()).filter((guard) => /alpha|opacity/i.test(guard));',
    replace:
      "    const guards = [...AUDIT_SOURCE.matchAll(/if\\s*\\([^)]*\\)\\s*continue/g)]\n      .map((match) => match[0].replace(/\\s+/g, ' '))\n      .filter((guard) => /alpha|opacity/i.test(guard));",
    test: 'test/harness-integrity.test.ts',
  },
  {
    name: 'the audit harness is written to skip what its rule covers, behind a call',
    file: 'e2e/audit.ts',
    find: '    const text = ownText(el);',
    replace: '    if (effectiveOpacity(el) < 0.999) continue;\n    const text = ownText(el);',
    test: 'test/token-contrast.test.ts',
  },
  {
    name: 'the ring guard check goes back to a line scan',
    file: 'test/token-contrast.test.ts',
    find: '    const guards = returnsIn(measure).filter((guard) =>\n      /outlineStyle|outlineWidth/.test(guard.condition),\n    );',
    replace:
      "    const guards = measure\n      .split('\\n')\n      .map((line) => ({ condition: line.trim(), returns: line.trim() }))\n      .filter((line) => /outlineStyle|outlineWidth/.test(line.condition));",
    test: 'test/harness-integrity.test.ts',
  },

  /* D8 / D9 / D14 — the browser-side harness. The check that these are wired is
     a source assertion, because the evidence itself is a rendered pixel and this
     ledger states its scope rather than pretending otherwise (see the header). */
  {
    name: 'the overflow sweep goes back to exempting anything under a clipping ancestor',
    file: 'e2e/audit.ts',
    find: '        return node.getBoundingClientRect().right <= limit + 0.5;',
    replace: '        return true;',
    test: 'test/harness-integrity.test.ts',
  },
  {
    name: 'the hidden-overflow sweep goes back to two hard-coded frame selectors',
    file: 'e2e/audit.ts',
    find: "  for (const el of document.querySelectorAll('body *')) {\n    const style = getComputedStyle(el);\n    if (style.display === 'none' || style.visibility === 'hidden') continue;\n    if (style.overflowX === 'visible') continue;",
    replace:
      "  for (const el of document.querySelectorAll('[data-gallery-frame], [data-frame]')) {\n    const style = getComputedStyle(el);\n    if (style.display === 'none' || style.visibility === 'hidden') continue;",
    test: 'test/harness-integrity.test.ts',
  },
  {
    name: 'the pseudo sweep goes back to one number with no denominator',
    file: 'e2e/gallery.spec.ts',
    find: '          ).toBe(audit.placeholdersInDom);',
    replace: '          ).toBeGreaterThanOrEqual(0);',
    test: 'test/harness-integrity.test.ts',
  },
  {
    name: 'the ring sweep’s skip assertion goes back to a tautology',
    file: 'e2e/gallery.spec.ts',
    find: '        [...skipped].filter((what) => what !== DEV_OVERLAY),',
    replace: '        [...skipped],',
    test: 'test/harness-integrity.test.ts',
  },

  /* D7 / D13 — the frame forwards every handler, and a clip names its route. */
  {
    name: 'the frame drops the rail’s room handler again',
    file: 'app/gallery/RoomFrame.tsx',
    find: '          onSelectRoom={on.onSelectRoom}\n',
    replace: '',
    test: 'test/frame-handlers.test.tsx',
  },
  {
    name: 'the frame drops the lens’s objective and receipt handlers again',
    file: 'app/gallery/RoomFrame.tsx',
    find: '            onOpenReceipt={on.onOpenReceipt}\n            onToggleObjective={on.onToggleObjective}\n',
    replace: '',
    test: 'test/frame-handlers.test.tsx',
  },
  {
    name: 'the trailer’s lead goes back to a sentence nothing can act on',
    file: 'src/components/attention/Trailer.tsx',
    find: '          onClick={onShowRest}\n          type="button"\n',
    replace: '',
    test: 'test/frame-handlers.test.tsx',
  },
  {
    name: 'the compressed reason goes back to a clip with no route out',
    file: 'src/components/attention/AttentionCompact.tsx',
    find: '<span className={styles.acompWhyText} data-truncates="control">',
    replace: '<span className={styles.acompWhyText}>',
    test: 'test/truncation.test.tsx',
  },

  /* --- round 6, from the blind cross-lineage review of round 6's own fix -----
   * The standing rule is that a fix round's claims get the same adversarial
   * treatment as the original. Both foreign lineages were pointed at THE
   * ENUMERATION rather than at the fixes — "is the sweep complete, and how would
   * you know" — and between them they found ten more addresses. They overlapped
   * on exactly one (the trailer's unchecked clock), which is the third round in
   * a row that pairing has paid for itself.
   * ---------------------------------------------------------------------- */
  {
    /* gpt-5.6, critical: the parser discarded the incoming fingerprint and minted
       a destination one, so the documented door laundered provenance past the
       one check that says two registers are the same register. */
    name: 'the parser launders a citation minted against another register',
    file: 'src/components/model/quotation.ts',
    find: "  if (typeof arrived === 'string' && arrived.length > 0 && arrived !== here) {",
    replace: '  if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    /* gpt-5.6, critical: the chosen arm carried the words in a SECOND field the
       checksum says nothing about — round 2's body-slot defect on the arm this
       round rebuilt. */
    name: 'a chosen row\u2019s words stop being reconciled against its record',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: '  if (painted !== derived.text) {',
    replace: '  if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    /* gpt-5.6: the sixth handler that takes a message id, missing from the
       round's own enumeration of five. */
    name: 'jump-to-source tells the consumer which card, never which message',
    file: 'src/components/attention/AttentionCard.tsx',
    find: 'onJumpToSource(itemId, record.id)',
    replace: 'onJumpToSource(itemId, itemId)',
    test: 'test/attention.test.tsx',
  },
  {
    /* gpt-5.6 AND grok-4.5, independently: a clock painted inside
       data-voice="system" with no constructor to have been checked at. */
    name: 'the trailer\u2019s clock goes back to an unchecked page-authored string',
    file: 'src/components/attention/Trailer.tsx',
    find: "{systemText(lastCheck, 'Trailer last check')}",
    replace: '{lastCheck}',
    test: 'test/printed-strings.test.tsx',
  },
  {
    /* grok-4.5: the trailer's lead is a whole page-authored SENTENCE. */
    name: 'the trailer\u2019s lead goes back to a free string',
    file: 'src/components/attention/Trailer.tsx',
    find: '<SystemVoice inline statement={summary.lead} />',
    replace: '{summary.lead.text}',
    test: 'test/printed-strings.test.tsx',
  },
  {
    /* grok-4.5: the room name in the trace, inside the same treatment. */
    name: 'the trace\u2019s room name goes back to an unchecked string',
    file: 'src/components/attention/CrossRoomJump.tsx',
    find: "{systemText(jump.fromRoom, 'CrossRoomJump room')}",
    replace: '{jump.fromRoom}',
    test: 'test/printed-strings.test.tsx',
  },
  {
    /* gpt-5.6: React renders any Iterable; the walk tested Array.isArray. */
    name: 'a slot walk goes back to seeing only arrays',
    file: 'src/components/model/slot.ts',
    find: "  if (typeof node === 'object' && node !== null && Symbol.iterator in node) {",
    replace: '  if (Array.isArray(node)) {',
    test: 'test/attribution.test.tsx',
  },
  {
    /* gpt-5.6: a third truncation mechanism neither enumerator could see. */
    name: 'the truncation sweep goes back to knowing two of the three mechanisms',
    file: 'test/truncation.test.tsx',
    find: '      (/max-height:\\s*(?!0[^\\d.])[\\d.]+/.test(body) && /overflow(-y)?:\\s*hidden/.test(body));',
    replace: '      false;',
    test: 'test/harness-integrity.test.ts',
  },
  {
    /* gpt-5.6: the overflow denominator compared two loops one of which contains
       the other by construction. */
    name: 'the overflow denominator goes back to comparing the sweep with itself',
    file: 'e2e/gallery.spec.ts',
    find: '          ).toBe(audit.overflow.renderedElements);',
    replace: '          ).toBeGreaterThanOrEqual(audit.elementsChecked);',
    test: 'test/harness-integrity.test.ts',
  },
  {
    /* gpt-5.6: the edge list this test uses was hand-maintained, inside a test
       whose purpose is to replace hand-maintained claims with counts. */
    name: 'the component edge list goes back to being written by hand',
    file: 'test/frame-handlers.test.tsx',
    find: 'const FORWARDED = COMPONENT_FILES.flatMap(edgesFrom);',
    replace: 'const FORWARDED = COMPONENT_FILES.flatMap(edgesFrom).slice(0, 6);',
    test: 'test/harness-integrity.test.ts',
  },
  /* ---------------------------------------------------------------------------
   * ROUND 7 — the denominator, the Slot boundary, the ledger, the route.
   * ------------------------------------------------------------------------- */

  /* D1 — every caller-supplied string the page prints goes through a door. */
  {
    name: 'the receipt prints a page-authored note beside the quoted words again',
    file: 'src/components/lens/ReceiptView.tsx',
    find: '        <SystemVoice className={styles.provNote} inline statement={entry.note} />',
    replace: '        <span className={styles.provNote}>{String(entry.note)}</span>',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'a correction heading goes back to being printed raw above the words',
    file: 'src/components/lens/ReceiptView.tsx',
    find: '        <SystemVoice className={styles.corrHeading} inline statement={entry.heading} />',
    replace: '        <span>{String(entry.heading)}</span>',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'a row tag welds an unchecked label onto a person’s sentence',
    file: 'src/components/timeline/TimelineRow.tsx',
    find: "      {systemText(entry.tag.label, 'TimelineRow tag')}",
    replace: '      {entry.tag.label}',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the open card prints its facts unchecked',
    file: 'src/components/attention/AttentionCard.tsx',
    find: "  const facts = list(item.facts.map((fact) => systemText(fact, 'AttentionCard fact')));",
    replace: '  const facts = list(item.facts);',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'a state-object row prints its facts unchecked',
    file: 'src/components/lens/ObjectRow.tsx',
    find: "                {systemText(fact, 'ObjectRow fact')}",
    replace: '                {fact}',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the receipt prints its status parts unchecked',
    file: 'src/components/lens/ReceiptView.tsx',
    find: "              {systemText(part, 'ReceiptView status')}",
    replace: '              {part}',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'a slot goes back to letting a raw caller string through',
    file: 'src/components/model/slot.ts',
    find: "  if (typeof node === 'string') {\n    systemText(node, 'slot');\n    return;\n  }",
    replace: "  if (typeof node === 'string') return;",
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the printed-string sweep stops seeing announced-text attributes',
    file: 'test/printed.ts',
    /* r8: re-anchored. The predicate moved into `model/printed-surface.ts` when
       the runtime door and the static sweep were made to share one list, and the
       old anchor named a line that no longer exists — reported STALE, which is
       the ledger's own integrity check doing its job. */
    find: '    if (!announcesText(name, hostTag(node)) && !cssPrintedAttributes.has(name.toLowerCase())) {\n      return [];\n    }',
    replace: '    return [];',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the printed-string sweep stops tracing into the object that holds the string',
    file: 'test/printed.ts',
    find: '      return this.compliant(node.expression, next, true);\n    }\n    if (ts.isElementAccessExpression(node))',
    replace: '      return null;\n    }\n    if (ts.isElementAccessExpression(node))',
    test: 'test/printed-strings.test.tsx',
  },

  /* D3 — the component reached through an opaque value. */
  {
    name: 'the consumer stops passing the receipt’s jump handler',
    file: 'app/gallery/RoomFrame.tsx',
    find: '                    onJump={on.onJumpToMessage}\n',
    replace: '',
    test: 'test/frame-handlers.test.tsx',
  },
  {
    name: 'the component node set goes back to being written by hand',
    file: 'test/frame-handlers.test.tsx',
    find: 'const COMPONENT_FILES = componentFiles();',
    replace: "const COMPONENT_FILES = componentFiles().filter((e) => e.name !== 'ReceiptView');",
    test: 'test/frame-handlers.test.tsx',
  },
  {
    name: 'the Slot holes stop being enumerated from the type of the hole',
    file: 'test/frame-handlers.test.tsx',
    find: '      if (/^Slot(\\s*\\|\\s*undefined)?$/.test(printed)) out.push(node.name.getText(file));',
    replace: '      void printed;',
    test: 'test/frame-handlers.test.tsx',
  },

  /* D5 — two records under one id, and the boundary that catches the throw. */
  {
    name: 'the ledger compares records by reference again',
    file: 'src/components/model/quotation.ts',
    find: '      const before = recordFingerprint(existing);\n      const after = recordFingerprint(record);',
    replace: "      const before = 'a';\n      const after = 'b';",
    test: 'test/session.test.tsx',
  },
  {
    name: 'the ledger goes all the way to last-write-wins',
    file: 'src/components/model/quotation.ts',
    find: '      if (before !== after) {',
    replace: '      if (before === after && before !== after) {',
    test: 'test/session.test.tsx',
  },
  {
    name: 'the sent id is minted from rendered state again',
    file: 'app/RoomSession.tsx',
    find: '      id: `local-${minted.current}`,',
    replace: '      id: `local-${(sentIn[here.current] ?? []).length + 1}`,',
    test: 'test/session.test.tsx',
  },

  /* D6 — a room chip that changes the room, not the header. */
  {
    name: 'the room chip goes back to changing the head and nothing else',
    file: 'app/RoomSession.tsx',
    find: '  const view = useMemo(() => sessionView(roomId, actedOn), [roomId, actedOn]);',
    replace:
      "  const view = useMemo(() => ({ ...sessionView('r1', actedOn), room: sessionView(roomId, actedOn).room }), [roomId, actedOn]);",
    test: 'test/session.test.tsx',
  },
  {
    name: 'the rail stops following the room the head names',
    file: 'app/RoomSession.tsx',
    find: '      rooms={view.rooms}',
    replace: "      rooms={sessionView('r1', actedOn).rooms}",
    test: 'test/session.test.tsx',
  },

  /* D7 — the trailer says the worst count twice. */
  {
    name: 'the trailer repeats the count its lead is already about',
    file: 'src/components/attention/Trailer.tsx',
    find: "        {summary.leadsWith === 'failures' ? null : (",
    replace: '        {false ? null : (',
    test: 'test/attention.test.tsx',
  },

  /* ---------------------------------------------------------------------------
   * ROUND 8 — the walk, the sink surface, and the sweep's three denominators.
   * ------------------------------------------------------------------------- */

  /* D1 — a walk that returns on the unrecognised is an allowlist that fails open. */
  {
    name: 'the slot walk goes back to returning on every shape it does not recognise',
    file: 'src/components/model/slot.ts',
    find: '  if (!isValidElement(node)) {',
    replace: '  if (!isValidElement(node)) return;\n  if (false) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a portal carries its contents past the walk unchecked',
    file: 'src/components/model/slot.ts',
    find: '    if (tag === PORTAL_TYPE) {\n      walk((node as unknown as { children: ReactNode }).children, budget);',
    replace: '    if (tag === PORTAL_TYPE) {\n      void budget;',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'a prop that is not children stops being searched for markup',
    file: 'src/components/model/slot.ts',
    find: '    walkProp(value, budget, { left: MAX_PROP_SEARCH });',
    replace: '    void value;',
    test: 'test/attribution.test.tsx',
  },

  /* D6 — the static half and the runtime door, enforcing one rule from two lists. */
  {
    name: 'the slot door stops holding announced attributes to the system’s voice',
    file: 'src/components/model/slot.ts',
    find: '      if (announcesText(key, tag)) {',
    replace: '      if (false && announcesText(key, tag)) {',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the sink surface loses the announced attributes nobody had listed',
    file: 'src/components/model/printed-surface.ts',
    find: "  'aria-roledescription',\n",
    replace: '',
    test: 'test/attribution.test.tsx',
  },
  {
    name: 'the tag-scoped text attributes stop being text',
    file: 'src/components/model/printed-surface.ts',
    find: "  ['optgroup', new Set(['label'])],",
    replace: "  ['optgroup', new Set([])],",
    test: 'test/printed-strings.test.tsx',
  },

  /* D2 — the type narrowing that excluded the one branded string in the library. */
  {
    name: 'the sweep’s type narrowing goes back to skipping branded strings',
    file: 'test/printed-strings.test.tsx',
    find: '  if (part.isIntersection() && depth < 3) {\n    return part.types.some((member) => partIsFree(member, depth + 1));\n  }',
    replace: '  void depth;',
    test: 'test/printed-strings.test.tsx',
  },

  /* D4 — the node types outside the denominator. */
  {
    name: 'the sweep stops seeing children and dangerouslySetInnerHTML as content',
    file: 'test/printed.ts',
    find: '    if (CHILDREN_PROPS.includes(name)) {\n      if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) return [];',
    replace:
      '    if (CHILDREN_PROPS.includes(name)) {\n      if (true) return [];\n      if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) return [];',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the sweep stops seeing React.createElement',
    file: 'test/printed.ts',
    find: '  if (ts.isCallExpression(node)) return createElementSites(node);',
    replace: '  if (ts.isCallExpression(node)) return [];',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the sweep stops asking the CSS which attributes a stylesheet prints',
    file: 'test/printed.ts',
    find: '  cssPrintedAttributes = new Set([...names].map((name) => name.toLowerCase()));',
    replace: '  void names;',
    test: 'test/printed-strings.test.tsx',
  },

  /* D5 — the file set, the fourth incomplete input set in this repo. */
  {
    name: 'the sweep’s file list goes back to two named directories',
    /* The enumeration moved to `test/app-sources.ts` in round 10, when the glyph
       sweep became its second consumer and a denominator with two copies became
       the r8 defect one level up. */
    file: 'test/app-sources.ts',
    find: 'export const SOURCES: readonly string[] = appSources();',
    replace:
      "const SOURCES: readonly string[] = appSources().filter((p) => p.includes('/src/components/') || p.includes('/app/'));",
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the sweep’s extension list goes back to TypeScript only',
    file: 'test/printed-strings.test.tsx',
    find: "  '.jsx',\n",
    replace: '',
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the tsconfig include stops rooting the JavaScript Next also ships',
    file: 'tsconfig.json',
    find: '    "**/*.jsx",\n',
    replace: '',
    test: 'test/printed-strings.test.tsx',
  },

  /* D3 — the payload door's bound, which asked a question about the file. */
  {
    name: 'the payload door’s bound goes back to asking about the function',
    file: 'test/printed.ts',
    find: '  const here = directHost(call, file, named);\n  if (here !== null) return here;',
    replace:
      "  const here = directHost(call, file, named);\n  if (true) return here ?? '<button>';",
    test: 'test/printed-strings.test.tsx',
  },
  {
    name: 'the payload door stops following a const to every one of its uses',
    file: 'test/printed.ts',
    find: '    const host = directHost(use, file, named);\n    if (host === null) return null;',
    replace: '    const host = directHost(use, file, named);\n    if (host === null) continue;',
    test: 'test/printed-strings.test.tsx',
  },

  /* The enumerators' own soft spots. */
  {
    name: 'the component node set goes back to being compared with itself',
    file: 'test/frame-handlers.test.tsx',
    find: '  for (const area of readdirSync(root).sort()) {\n    const dir = join(root, area);\n    if (!statSync(dir).isDirectory()) continue;',
    replace:
      "  for (const area of readdirSync(root).sort()) {\n    const dir = join(root, area);\n    if (!statSync(dir).isDirectory() || area === 'lens') continue;",
    test: 'test/frame-handlers.test.tsx',
  },
  {
    name: 'the register’s field list goes back to being written by hand',
    file: 'test/attribution.test.tsx',
    find: "    id: { id: 'm-not-this-one' },\n",
    replace: '',
    test: 'test/attribution.test.tsx',
  },

  /* D7–D10 — the product. */
  {
    name: 'the receipt’s provenance section goes back to a heading over nothing',
    file: 'src/components/lens/ReceiptView.tsx',
    find: '        {receipt.provenance.length === 0 ? (',
    replace: '        {false ? (',
    test: 'test/timeline-handlers.test.tsx',
  },
  {
    name: 'a history line with no clock paints a dash where a time goes',
    file: 'app/gallery/fixtures.ts',
    find: '      id: `${object.id}-h${index}`,\n      kind,\n      statement: systemStatement(fact),',
    replace:
      "      id: `${object.id}-h${index}`,\n      kind,\n      at: '—',\n      statement: systemStatement(fact),",
    test: 'test/timeline-handlers.test.tsx',
  },
  {
    name: 'the shell stops stating the narrowest window it works in',
    file: 'src/components/frame/AppFrame.tsx',
    find: '      <div className={styles.belowMin} data-below-minimum-width={String(MINIMUM_WIDTH)}>',
    replace: '      <div className={styles.belowMin}>',
    test: 'test/viewport.test.tsx',
  },
  {
    name: 'the minimum-width notice drifts from the floor the stylesheet declares',
    file: 'src/components/frame/AppFrame.tsx',
    find: 'export const MINIMUM_WIDTH = 1024;',
    replace: 'export const MINIMUM_WIDTH = 900;',
    test: 'test/viewport.test.tsx',
  },
  {
    name: 'the notice is revealed at a width that is not the floor',
    file: 'src/components/frame/frame.module.css',
    find: '@media (max-width: 1023px) {\n  .belowMin {',
    replace: '@media (max-width: 900px) {\n  .belowMin {',
    test: 'test/viewport.test.tsx',
  },
  {
    name: 'the composer goes back to seeding its status line with demo scaffolding',
    file: 'app/RoomSession.tsx',
    find: '  const [note, setNote] = useState<string | undefined>(undefined);',
    replace:
      "  const [note, setNote] = useState<string | undefined>(\n    'every control on this page is wired — click one and this line reports what it did',\n  );",
    test: 'test/session.test.tsx',
  },
];

if (process.argv.includes('--list')) {
  for (const entry of LEDGER) console.info(`${entry.test.padEnd(34)} ${entry.name}`);
  process.exit(0);
}

/**
 * The syntax error in a mutated file, or null.
 *
 * ONE PARSER PER LANGUAGE. Round 8 added a `tsconfig.json` mutation and this gate
 * ran the TypeScript parser over JSON, which reports `';' expected` for perfectly
 * good JSON — so a valid mutation was rejected as BROKEN. That is the round-6
 * defect's mirror image and the same lesson as everything else this round:
 * a wrong instrument invents defects, not just misses them. CSS was already
 * exempted the same way, and an exemption is worse than a parser, so it has one.
 */
function syntaxError(file, source) {
  if (file.endsWith('.json')) {
    try {
      JSON.parse(source);
      return null;
    } catch (error) {
      return String(error.message);
    }
  }
  if (file.endsWith('.css')) {
    /* No CSS parser in this toolchain. What CAN be checked is that the braces
       still balance, which is what every mutation here could plausibly break. */
    const opens = (source.match(/\{/g) ?? []).length;
    const closes = (source.match(/\}/g) ?? []).length;
    return opens === closes ? null : `unbalanced braces (${opens} open, ${closes} close)`;
  }
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const errors = parsed.parseDiagnostics ?? [];
  return errors.length === 0 ? null : ts.flattenDiagnosticMessageText(errors[0].messageText, ' ');
}

/** Run a catcher. Returns true when it FAILED — which is what "caught" means. */
function red(entry) {
  const argv =
    entry.typecheck === true ? ['exec', 'tsc', '--noEmit'] : ['exec', 'vitest', 'run', entry.test];
  try {
    execFileSync('pnpm', argv, { cwd: WEB, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

/* ---------------------------------------------------------------------------
 * THE BASELINE. WITHOUT IT THIS SCRIPT MEASURES NOTHING.
 *
 * Round 6, D1. This script decided "caught" purely from whether `execFileSync`
 * threw, and it ran no baseline — so an entry whose catcher was ALREADY RED on
 * the unmutated tree was credited whatever the mutation did. That was not
 * hypothetical: `pnpm exec vitest run test/quotation.test.tsx` was exit 1 on a
 * clean clone (a render throw escaping to React 19's global error handler), and
 * the two entries naming that file — "system voice stops being checked at the
 * render boundary" and "system voice is validated on the value and rendered from
 * it again" — were counted among round 5's reported 101/101 without ever having
 * been tested. A ledger that converts a red gate into evidence of coverage is
 * worse than no ledger, because it is a number people quote.
 *
 * Every distinct catcher is now run ONCE, unmutated, before anything is edited.
 * A red one disqualifies every entry that names it, loudly, as `UNCHECKED` — not
 * as caught, and not silently skipped. The result is cached because 100+ entries
 * name a handful of files and re-running each suite per entry would triple the
 * runtime for no information.
 * ------------------------------------------------------------------------- */
const catchers = [...new Set(LEDGER.map((entry) => entry.test))];
const baseline = new Map();
console.info(`baseline: ${catchers.length} distinct catchers, unmutated\n`);
for (const test of catchers) {
  const entry = LEDGER.find((candidate) => candidate.test === test);
  const isRed = red(entry);
  baseline.set(test, isRed);
  console.info(`${isRed ? 'RED     ' : 'green   '} ${test}`);
}
console.info('');

let caught = 0;
const escaped = [];
const unchecked = [];

for (const entry of LEDGER) {
  if (baseline.get(entry.test) === true) {
    unchecked.push(`${entry.name} — ${entry.test} is already failing unmutated`);
    console.info(`UNCHECKED ${entry.name}`);
    continue;
  }
  const path = resolve(WEB, entry.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(entry.find)) {
    escaped.push(`${entry.name} — the ledger's anchor is stale in ${entry.file}`);
    console.info(`STALE    ${entry.name}`);
    continue;
  }
  const mutated = original.replace(entry.find, entry.replace);
  /* A MUTATION THAT DOES NOT PARSE IS NOT A MUTATION.

     Found by the blind cross-lineage review of round 6's own fix: one entry
     replaced `<button` with `<span` and left the `</button>` behind, so the file
     failed to transform and every test in the catcher errored out. `red()` reads
     a non-zero exit, which a transform error also produces — so the entry was
     credited without its catcher ever running a single assertion. That is the
     baseline defect (D1) in the other direction: there a red gate credited every
     entry, here a broken file credits one.

     Syntax is checked before the catcher runs. An unparseable mutation is
     reported as a defect in the LEDGER, not as a caught defect in the code. */
  const broken = syntaxError(entry.file, mutated);
  if (broken !== null) {
    escaped.push(
      `${entry.name} — the mutated ${entry.file} does not parse, so the catcher never ran (${broken})`,
    );
    console.info(`BROKEN   ${entry.name}`);
    continue;
  }
  /* A `find`/`replace` pair that changes nothing is a mutation that was never
     applied, and an unapplied mutation the catcher "survives" reports exactly
     like a defect the catcher misses. */
  if (mutated === original) {
    escaped.push(`${entry.name} — the ledger's replacement is identical to the original`);
    console.info(`INERT    ${entry.name}`);
    continue;
  }
  writeFileSync(path, mutated);
  let failed = false;
  try {
    failed = red(entry);
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

const attempted = LEDGER.length - unchecked.length;
console.info(`\n${caught}/${attempted} mutations caught (${LEDGER.length} in the ledger)`);
if (unchecked.length > 0) {
  console.error(
    `\nunchecked — the catcher is red before the mutation, so the entry proves nothing:`,
  );
  for (const line of unchecked) console.error(`  ${line}`);
}
if (escaped.length > 0) {
  console.error('\nnot caught:');
  for (const line of escaped) console.error(`  ${line}`);
}
if (escaped.length > 0 || unchecked.length > 0) process.exit(1);
