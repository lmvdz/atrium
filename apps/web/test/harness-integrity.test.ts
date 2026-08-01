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
});
