/* ---------------------------------------------------------------------------
 * THE HARNESS, CHECKED — the instruments whose evidence is a rendered pixel.
 *
 * Round 6's D2, D8, D9 and D14 were all one shape: a check that could not fail.
 * A guard enumeration whose regex could not cross a paren; an overflow sweep
 * that inspected 33 of 2542 elements because every element had a clipping
 * ancestor; a pseudo-element counter with no floor that had never measured
 * anything; a skip assertion both of whose branches were tautologies. None of
 * them was wrong about the app. Each of them was wrong about ITSELF, and each
 * reported exactly like a check doing its job.
 *
 * The measurements live in e2e (they need a browser). What lives here is the
 * WIRING — the properties of the instruments that make a browser run meaningful,
 * asserted from the source, so `pnpm test` fails when an instrument is quietly
 * narrowed. Separate from token-contrast.test.ts on purpose: two of these are
 * assertions ABOUT the enumerators that file uses, and a file asserting its own
 * instrument is a check with the same subject as its evidence.
 * ------------------------------------------------------------------------- */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function find(relative: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${relative} not found above ${process.cwd()}`);
}

const read = (relative: string) => readFileSync(find(relative), 'utf8');
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const AUDIT = strip(read('apps/web/e2e/audit.ts'));
const GALLERY = strip(read('apps/web/e2e/gallery.spec.ts'));
const SMOKE = strip(read('apps/web/e2e/smoke.spec.ts'));
const TOKEN = strip(read('apps/web/test/token-contrast.test.ts'));
const TRUNCATION = strip(read('apps/web/test/truncation.test.tsx'));
const FRAME_HANDLERS = strip(read('apps/web/test/frame-handlers.test.tsx'));

describe('D2 — a source-grep that enumerates constructs sees every spelling', () => {
  /* CATCHES: the guard enumeration going back to `/if\s*\([^)]*\)\s*continue/`.
     `[^)]*` cannot cross a `)`, so every guard whose condition contains a CALL
     was invisible — and `guards.length > 0` was satisfied by the legitimate
     guard elsewhere, so inserting `if (effectiveOpacity(el) < 0.999) continue;`
     left 51 unit tests and 32 e2e contrast assertions green while a real 1.36:1
     string went unreported.

     This is a THIRD failure mode for a source-grep beyond the two CONVENTIONS
     already records ("matched nothing", "matched the wrong occurrence"): MATCHED
     A STRICT SUBSET OF THE SYNTAX. The fix is not a better regex; it is to stop
     using one where the construct is a language construct. */
  it('the guard enumeration parses the audit rather than pattern-matching it', () => {
    expect(TOKEN, 'token-contrast.test.ts stopped importing a parser').toMatch(
      /import ts from 'typescript'/,
    );
    expect(TOKEN, 'the opacity guards are enumerated by regex again').toMatch(
      /guardsIn\(auditProgram\(\)\)/,
    );
    expect(TOKEN).toMatch(/ts\.isContinueStatement/);
    /* And the enumerator is exercised against the spellings it must not miss —
       an instrument with no self-test is a claim, not a measurement. */
    expect(TOKEN).toMatch(/the enumerator sees every spelling of the construct it enumerates/);
    expect(TOKEN).toMatch(/effectiveOpacity\(el\) < 0\.999/);
  });

  /* CATCHES: the ring-audit guard check going back to a LINE scan. Round 5
     adopted the line scan after the regex was found stopping at an inner paren;
     a line scan is the same hole one step out, because a guard wrapped over two
     lines has no single line carrying both the condition and the `return`. */
  it('the ring guard check parses too', () => {
    expect(TOKEN, 'the ring guards are scanned line-wise again').toMatch(
      /returnsIn\(measure\)\.filter/,
    );
    expect(TOKEN).toMatch(/ts\.isReturnStatement/);
  });

  /* CATCHES: the same failure mode arriving in a new source-grep. Every regex in
     the harness that walks a JS/TS construct is a candidate; this asserts the two
     shapes that bit us are absent rather than trusting a reader to notice. */
  it('no harness grep uses a bracket class to cross a balanced pair', () => {
    const suspects = [...TOKEN.matchAll(/\/[^\n/]*\\\([^\n]*\[\^\)\][^\n]*\\\)[^\n/]*\//g)].map(
      (m) => m[0],
    );
    expect(suspects, 'a harness regex matches a parenthesised construct with [^)]').toEqual([]);
  });
});

describe('D8 — the overflow sweep inspects the page, not 1% of it', () => {
  /* CATCHES: `clipped()` going back to "any ancestor with a non-visible
     overflow exempts this element". `.app` is `overflow: hidden` and `.gallery`
     is `overflow-x: hidden`, so that predicate was true of EVERY element: 33 of
     2542 inspected on /gallery, 12 of 476 on /, and a 3000px-wide element in a
     1124px viewport passed all four overflow assertions. */
  it('an element is exempt only when the clip happens inside the viewport', () => {
    expect(AUDIT, 'the audit no longer asks where the clipping ancestor ends').toMatch(
      /clipsWithin/,
    );
    expect(AUDIT).toMatch(/node\.getBoundingClientRect\(\)\.right <= limit \+ 0\.5/);
    expect(AUDIT, 'the audit exempts anything with a clipping ancestor again').not.toMatch(
      /if \(overflowX !== 'visible'\) return true;/,
    );
  });

  /* CATCHES: the hidden-overflow sweep going back to two hard-coded selectors.
     `[data-gallery-frame], [data-frame]` never matched `.feed`, which is the
     element that actually absorbs the feed's overflow — a check pointed at boxes
     that were never going to fail. */
  it('every clipping box is asked whether it hides horizontal overflow', () => {
    expect(GALLERY, 'the sweep reports no denominator').toMatch(/clippersChecked/);
    expect(AUDIT).toMatch(/clippersChecked \+= 1;/);
    expect(AUDIT, 'the hidden-overflow sweep is pointed at two frame selectors again').not.toMatch(
      /for \(const el of document\.querySelectorAll\('\[data-gallery-frame\]/,
    );
  });

  /* CATCHES: the sweep reporting a denominator and nothing asserting on it. */
  it('the denominators are asserted, not only logged', () => {
    expect(GALLERY).toMatch(/expect\(\s*audit\.overflow\.overflowChecked,/);
    expect(GALLERY).toMatch(/expect\(\s*audit\.overflow\.clippersChecked,/);
  });
});

describe('D9 — the pseudo-element sweep has a floor it can fail', () => {
  /* CATCHES: `pseudoChecked` going back to one unasserted number. It was 1 on
     three of four routes and 0 on the fourth, ::before/::after were 0
     everywhere, and breaking the placeholder lookup outright left the harness
     green — the counter had never measured anything and nothing said so. */
  it('the placeholder count is checked against the DOM that holds them', () => {
    expect(AUDIT, 'the audit reports no placeholder denominator').toMatch(/placeholdersInDom/);
    expect(AUDIT).toMatch(/placeholdersFound \+= 1;/);
    expect(GALLERY, 'the placeholder sweep is not asserted against the DOM').toMatch(
      /\)\.toBe\(audit\.placeholdersInDom\);/,
    );
    expect(GALLERY).toMatch(/expect\(audit\.placeholdersInDom,/);
  });

  /* CATCHES: the split-by-kind report collapsing back to a single total, which
     is what made a zero category invisible. */
  it('the report says how many of each kind it found, so a zero is visible', () => {
    expect(AUDIT).toMatch(/pseudo = \{ before: 0, after: 0, placeholder: 0 \}/);
    expect(GALLERY).toMatch(/audit\.pseudo\.before/);
    expect(GALLERY).toMatch(/audit\.pseudo\.after/);
  });
});

describe('D14 — an assertion whose branches are both tautologies', () => {
  /* CATCHES: `toEqual(skipped.size === 0 ? [] : ['nextjs-portal …'])`. That
     string is the only value ever added to the set, so the empty branch compared
     [] with [] and the non-empty branch compared the set with a spelling of its
     only possible member. The carve-out could not widen because the check could
     not see it widen. */
  it('the ring sweep asserts the residue, not a spelling of the set', () => {
    expect(GALLERY, 'the skip assertion is a tautology again').not.toMatch(
      /toEqual\(skipped\.size === 0/,
    );
    expect(GALLERY).toMatch(/\[\.\.\.skipped\]\.filter\(\(what\) => what !== DEV_OVERLAY\)/);
  });

  /* CATCHES: the per-route graphics guard sitting exactly at its floor with
     nothing checking the route rendered what it could. `>= 3` is met exactly on
     the pin routes, so the guard is one registry entry away from being
     unfalsifiable there; the cross-route assertion is what carries the coverage
     claim and it has to stay. */
  it('the graphics coverage is carried by a per-registry check, not only a floor', () => {
    expect(GALLERY).toMatch(/expect\(\s*audit\.graphicKinds\.length,/);
    expect(GALLERY).toMatch(/\)\.toBe\(registrySize\);/);
  });
});

describe('D7 — the control sweep asserts its denominator', () => {
  /* CATCHES: the smoke test going back to clicking four controls. It exists for
     round 2's "a screen of controls that did nothing", and it clicked four of
     the fifty-three on the page while seventeen were dead. */
  it('every visible control is enumerated and clicked', () => {
    expect(SMOKE).toMatch(/every visible control on \/ changes something, or is listed inert/);
    expect(SMOKE, 'the sweep no longer enumerates controls from the DOM').toMatch(
      /document\.querySelectorAll\(selector\)/,
    );
    expect(SMOKE).toMatch(/expect\(dead,/);
    /* AND THE EXEMPTION LIST IS EXHAUSTIVE IN BOTH DIRECTIONS: an entry that
       matches nothing is a carve-out that outlived its subject. */
    expect(SMOKE).toMatch(/an inert-control exemption matched nothing on the page/);
  });

  /* CATCHES: the truncation sweep being dropped. A clipped string with no route
     is D13, and the browser is the only place clipping is observable. */
  it('every clipped string is required to name its route', () => {
    expect(SMOKE).toMatch(/every clipped string on \/ names its route to the full text/);
    expect(SMOKE).toMatch(/data-truncates/);
  });
});

/* ---------------------------------------------------------------------------
 * WHAT THE BLIND CROSS-LINEAGE REVIEW OF ROUND 6's OWN FIX FOUND IN THESE
 * INSTRUMENTS.
 *
 * Three of its ten findings were defects in the checks this round wrote, which
 * is the honest outcome of pointing two foreign lineages at the ENUMERATION
 * rather than at the fixes: the enumerators are the round's product, so they are
 * where its defects are.
 * ------------------------------------------------------------------------- */
describe('the round’s own enumerators', () => {
  /* CATCHES: the truncation sweep going back to knowing two of the three ways
     this stylesheet can clip text. `.why` clipped with `max-height: 29px;
     overflow: hidden` — on the OPEN CARD, which is the surface a compressed
     row's clamp routes the reader to — and neither enumerator could see it. An
     enumerator that knows two of three mechanisms is D2's "matched a strict
     subset of the syntax", in CSS instead of in a regex. */
  it('the truncation sweep knows every mechanism this stylesheet clips with', () => {
    expect(TRUNCATION).toMatch(/text-overflow/);
    expect(TRUNCATION).toMatch(/-webkit-line-clamp/);
    expect(TRUNCATION, 'the max-height + overflow mechanism is invisible again').toMatch(
      /max-height/,
    );
    /* …and a max-height of ZERO is still absence rather than truncation, or the
       sweep demands a route out of elements that are showing nothing. The
       negative lookahead is the code that draws that line, so it is what is
       asserted — comments are stripped before any of these rules look at a
       file. */
    expect(TRUNCATION, 'a collapsed disclosure counts as a truncation again').toMatch(/\(\?!0\[\^/);
  });

  /* CATCHES: the overflow denominator going back to a comparison between two
     loops one of which contains the other by construction. Both walk `body *`
     with the same visibility filter and the overflow loop's geometry condition
     is strictly weaker, so `overflowChecked >= elementsChecked` held for every
     possible page. A comparison that cannot come out the other way is not a
     measurement — the same sentence as a fill measured against itself. */
  it('the overflow denominator comes from the DOM, not from the other sweep', () => {
    expect(AUDIT, 'the audit counts no independent denominator').toMatch(/renderedElements/);
    expect(GALLERY).toMatch(/\)\.toBe\(audit\.overflow\.renderedElements\);/);
    expect(GALLERY, 'the overflow sweep is compared against the text sweep again').not.toMatch(
      /toBeGreaterThanOrEqual\(audit\.elementsChecked\)/,
    );
  });

  /* CATCHES: the component edge list going back to being written by hand —
     inside the test whose whole purpose is to replace a hand-maintained claim
     with a count. The hand-written version held six edges and was missing four
     (`Pin → AttentionCard`, `StateLens → ObjectiveGroup`, and both of
     `Timeline`'s dividers). */
  it('the component edge list is derived from the source', () => {
    expect(FRAME_HANDLERS, 'the edges are a literal list again').toMatch(
      /COMPONENT_FILES\.flatMap\(edgesFrom\)/,
    );
    expect(FRAME_HANDLERS).toMatch(/function edgesFrom/);
    expect(FRAME_HANDLERS).toMatch(/there are edges to enumerate, and more than the six/);
    expect(FRAME_HANDLERS, 'the derivation is truncated to a fixed count').not.toMatch(
      /flatMap\(edgesFrom\)\.slice\(/,
    );
  });

  /* ---------------------------------------------------------------------------
   * ROUND 7, D8 — AND ITS GENERAL FORM, WHICH IS D3.
   *
   * The check above asserts the EDGES are derived and never asks where the NODE
   * SET came from. It was a hand-written list of 24 paths, inside the test whose
   * whole purpose is to replace a hand-maintained claim with a count, and it
   * matched the filesystem on the day it was written — which is what "latent"
   * means. `test/system-voice.test.tsx` read its directories with `readdirSync`
   * and `frame-handlers` did not, so the repo already held both answers.
   *
   * The general form: **when a check's subject is "every X", the first question
   * is what enumerates X, and the second is what proves the enumerator is
   * complete** — and an enumerator has TWO halves, the edges and the nodes.
   * Deriving one and writing the other down is a derivation exactly as complete
   * as somebody's memory.
   * ------------------------------------------------------------------------- */
  it('the component NODE set is derived from the filesystem, not written down', () => {
    expect(FRAME_HANDLERS, 'the component list is a literal array of paths again').toMatch(
      /function componentFiles/,
    );
    expect(FRAME_HANDLERS).toMatch(/readdirSync/);
    expect(FRAME_HANDLERS).toMatch(/const COMPONENT_FILES = componentFiles\(\)/);
    /* …and the frame's own children are read off the frame rather than listed. */
    expect(FRAME_HANDLERS, 'COMPOSED is a hand-written list again').toMatch(
      /jsxTagsIn\(FRAME_SOURCE\)/,
    );
    /* The same for the sweep whose denominator is every printed string — and
       since r8 the file list is not merely READ, it is cross-checked against the
       compiler's own parse of the project, the resulting module graph, and
       Next's route conventions, with the differences asserted empty. A walk of
       the filesystem is one authority on "what is the app"; on r7 it was the
       only one, and it named two directories and one extension. */
    /* ROUND 10 GAVE THE FILE SET A SECOND CONSUMER — the glyph source sweep —
       so it moved to `test/app-sources.ts`. A denominator with two copies is the
       r8 defect one level up, so the enumerator is asserted in the module that
       owns it and BOTH sweeps are asserted to read that module rather than a
       list of their own. */
    const sources = read('apps/web/test/app-sources.ts');
    expect(sources, 'the app file set hard-codes its file list').toMatch(/function appSources/);
    expect(sources).toMatch(/readdirSync/);
    const glyphs = read('apps/web/test/glyph-source.test.ts');
    expect(glyphs, 'the glyph sweep wrote its own file list').toMatch(/from '\.\/app-sources'/);
    const printed = read('apps/web/test/printed-strings.test.tsx');
    expect(printed, 'the printed-string sweep wrote its own file list').toMatch(
      /from '\.\/app-sources'/,
    );
    expect(printed, 'the file set stopped being checked against the compiler').toMatch(
      /compilerRoots\(PARSED\)/,
    );
    expect(printed, 'the file set stopped being checked against the module graph').toMatch(
      /PROGRAM\.getSourceFiles\(\)/,
    );
    expect(printed, 'the file set stopped being checked against Next’s routes').toMatch(
      /routeEntryPoints\(\)/,
    );
  });

  /* CATCHES: the Slot boundary going back to being invisible. `ReceiptView` is
     reached through an opaque value, so no JSX derivation can see the edge —
     deleting `onJump` from the consumer's `<ReceiptView>` killed five visible
     controls with tsc 0 and every suite green. The rule is to enumerate the edge
     from the TYPE OF THE HOLE, and this asserts the enumerator still does. */
  it('a component reached through a Slot is enumerated from the type of the hole', () => {
    expect(FRAME_HANDLERS, 'Slot-typed holes are no longer enumerated').toMatch(
      /function slotPropsIn/,
    );
    expect(FRAME_HANDLERS, 'nothing looks for what fills a hole').toMatch(/function slotFillsIn/);
    expect(FRAME_HANDLERS).toMatch(/SLOT_FILLS/);
    expect(FRAME_HANDLERS).toMatch(
      /every Slot-typed hole in the library is filled by something this sweep can see/,
    );
  });

  /* CATCHES: the browser backstop going back to sweeping one page state in the
     wrong theme. The receipt's controls were outside the sweep because it ran
     with `receiptId === null`, and 70 of 71 controls were measured in DARK
     because the theme toggle is control #1 — while CONVENTIONS' binding
     measurement is LIGHT. */
  it('the control sweep covers the receipt, and runs in the binding theme', () => {
    expect(SMOKE, 'the control sweep runs in one page state again').toMatch(
      /for \(const state of \['initial', 'receipt-open'\] as const\)/,
    );
    expect(SMOKE, 'the sweep no longer pins a theme').toMatch(/goto\('\/\?theme=light'\)/);
    expect(SMOKE, 'a control that flips the theme leaves the sweep in the wrong one').toMatch(
      /classList\.remove\('atr-dark'\)/,
    );
    expect(SMOKE).toMatch(/the receipt-open sweep did not see the receipt/);
  });

  /* CATCHES: the truncation route going back to unverified prose. Round 6
     asserted the PRESENCE of `data-truncates` and never its truth, which is how
     a clipped quotation shipped declaring a focus-clamp expansion and a claim
     that was false for a cross-room excerpt. */
  it('a declared truncation route is verified against the rendered page', () => {
    expect(SMOKE).toMatch(/names a route that is TRUE/);
    expect(SMOKE, 'the route kinds are no longer distinguished').toMatch(
      /if \(kind === 'control'\)/,
    );
    expect(SMOKE).toMatch(/if \(kind === 'element'\)/);
    expect(SMOKE).toMatch(/if \(kind === 'name'\)/);
    expect(TRUNCATION, 'the route grammar is prose again').toMatch(/const ROUTE =/);
    expect(TRUNCATION).toMatch(/no clamp is widened by a hover or a focus/);
  });

  /* CATCHES: the ledger crediting an entry whose mutation broke the file's
     syntax, so the catcher errored out before running a single assertion — the
     baseline defect (D1) in the other direction. */
  it('the mutation ledger refuses a mutation that does not parse', () => {
    const ledger = read('apps/web/test/mutations.mjs');
    expect(ledger, 'the ledger no longer parses what it mutated').toMatch(/parseDiagnostics/);
    expect(ledger).toMatch(/BROKEN/);
  });

  /* CATCHES: the baseline itself being removed. That is D1's whole fix, and
     without it every number this ledger reports is uncorrelated with the code. */
  it('the mutation ledger runs a baseline before it mutates anything', () => {
    const ledger = read('apps/web/test/mutations.mjs');
    expect(ledger).toMatch(/const baseline = new Map\(\)/);
    expect(ledger).toMatch(/UNCHECKED/);
    expect(ledger, 'a red catcher no longer disqualifies its entries').toMatch(
      /baseline\.get\(entry\.test\) === true/,
    );
  });

  /* ---------------------------------------------------------------------------
   * EVERY ANCHOR IN THE LEDGER STILL MATCHES — ROUND 10.
   *
   * The harness reports a stale `find` as an escape and exits 1, so it is not
   * silent — but only WHEN IT IS RUN, and it rewrites source in place, so it is
   * not part of the ordinary gate and a round is asked not to run it. Measured on
   * r9: FOUR anchors matched nothing.
   *
   *   ledger.tsx      `if (ledger === null) {`               r9 moved the refusal
   *                   `if (outer !== null && outer !== ledger) {`   into useRegister
   *   RoomSession.tsx `const view = useMemo(() => roomView(roomId)…`  r9 replaced
   *                   `rooms={railRooms(roomId)}`             roomView/railRooms
   *
   * Four guards that had stopped guarding, in the ledger whose entire job is
   * proving the other guards work. That is `use is checked by mutation` applied
   * to the mutation ledger itself: an anchor that matches nothing is a mutation
   * that never happens, and the round after it lands has no way to know.
   *
   * This is a STATIC check — it reads the ledger and greps the file. It runs in
   * `pnpm test`, mutates nothing, and leaves the tree alone.
   *
   * CATCHES: any refactor that moves a line the ledger anchors on. It cannot see
   * an anchor that still matches but no longer means what the entry's name says —
   * only running the harness can, and that is what the harness is for.
   * ------------------------------------------------------------------------- */
  it('every mutation anchor still matches its file, exactly once', () => {
    const ledger = read('apps/web/test/mutations.mjs');
    /* The entries are object literals in one array; each is `name`, `file`,
       `find` in that order. Parsed from the source rather than imported, because
       importing `mutations.mjs` RUNS the harness. */
    const entry =
      /name: '((?:[^'\\]|\\.)*)',\s*\n\s*file: '([^']+)',\s*\n\s*find:\s*((?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)(?:\s*\+\s*\n?\s*(?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))*)/g;
    const stale: string[] = [];
    let found = 0;
    for (const match of ledger.matchAll(entry)) {
      found += 1;
      const [, name, file, literal] = match;
      if (name === undefined || file === undefined || literal === undefined) continue;
      /* The `find` is a JavaScript string literal, possibly concatenated. `JSON`
         cannot read a single-quoted one, so the escapes are resolved the way the
         harness itself resolves them — by evaluating the literal, with nothing
         but the literal in scope. */
      const needle = new Function(`return ${literal};`)() as string;
      let body: string;
      try {
        body = read(`apps/web/${file}`);
      } catch {
        stale.push(`${name} — ${file} does not exist`);
        continue;
      }
      const hits = body.split(needle).length - 1;
      if (hits !== 1) stale.push(`${name} — ${file} matches ${hits} times`);
    }
    /* THE DENOMINATOR FIRST. A regex that stops matching the ledger's shape
       reports exactly like a ledger with no stale anchors. */
    expect(found, 'the ledger parse found almost no entries').toBeGreaterThan(100);
    expect(
      stale,
      'a mutation anchor matches nothing (or more than one thing), so that guard is not being run',
    ).toEqual([]);
  });
});
