/* ---------------------------------------------------------------------------
 * TRUNCATION OWES THE READER A ROUTE — the source half.
 *
 * Round 6 measured the compressed owed rows and found all three clipping their
 * WHY YOU line (321 of 777px, 199 of 801px, 379 of 680px at 1440) with the full
 * text on `title=` only — which is the affordance `AttentionCompact`'s own
 * header records as the round-1 defect it was written to fix. A person's name in
 * the rail was clipped, and so was a QUOTATION in the reply line, and nothing in
 * CONVENTIONS governed truncating quoted words at all.
 *
 * The rule CONVENTIONS now carries: anything that truncates names its route to
 * the rest on the DOM, in `data-truncates`, and the route may not be a hover.
 *
 * TWO CHECKS, BECAUSE ONE OF THEM CANNOT SEE THE OTHER'S EVIDENCE.
 *
 *   HERE — every CSS rule in the library that truncates is enumerated from the
 *   stylesheets, and the component that wears that class must set
 *   `data-truncates` on the same element. This is the sweep: it is the CSS that
 *   decides what can clip, so the CSS is what gets enumerated. A rule added
 *   without a route fails here even if the string never happens to overflow on
 *   the fixtures — "clean today" is not "checked" (CONVENTIONS).
 *
 *   e2e/smoke.spec.ts — every string ACTUALLY clipped in a browser at 1124 and
 *   1440 carries one. That is the measurement; this is the invariant.
 *
 * The constructor's 240-character cap is not either of these, and round 6
 * rewrote what it claims: it bounds the SENTENCE, and it never could have
 * bounded the clip, because the clip happens at a pixel width no constructor can
 * see. See model/rationale.ts.
 * ------------------------------------------------------------------------- */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const AREAS = ['frame', 'timeline', 'attention', 'lens', 'primitives'] as const;

/** Comments first: this file's own prose names classes it is not declaring. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every class in a module whose rule truncates.
 *
 * THE SUBJECT OF THE SELECTOR, NOT EVERY CLASS IN IT. `.prov:focus-visible
 * .provExcerpt` truncates `.provExcerpt`; `.prov` is the ancestor that scopes
 * the rule and wears nothing. Taking every class would demand a route from five
 * elements that do not clip, which is a check that fails on correct code — and a
 * check that fails on correct code is a check that gets relaxed under pressure,
 * which is where the exemption comes back (the round-3 lesson, recorded in
 * token-contrast.test.ts).
 */
function truncatingClasses(css: string): readonly string[] {
  const out = new Set<string>();
  /* Selector list, then body. A rule may carry several selectors (`.corrWas,
     .corrFact {`), and each of them wears the truncation. */
  for (const [, selectors, body] of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors === undefined || body === undefined) continue;
    /* THREE MECHANISMS, NOT TWO. Found by the blind cross-lineage review of
       round 6's own fix: `.why` clips with `max-height: 29px; overflow: hidden`
       and neither enumerator could see it — the CSS scan knew only about
       `text-overflow` and `-webkit-line-clamp`, and the browser sweep skips
       containers whose text lives in children, which is exactly `.why`'s shape.
       An enumerator that knows two of the three ways a thing can happen is the
       "matched a strict subset" failure, in CSS instead of in a regex. */
    const truncates =
      /text-overflow:\s*ellipsis/.test(body) ||
      /-webkit-line-clamp:\s*\d/.test(body) ||
      /* A POSITIVE max-height with hidden overflow clips text that is there.
         `max-height: 0` beside `opacity: 0` is a COLLAPSED DISCLOSURE — absence,
         in the same category as `display: none`, which the contrast audit draws
         the same line around. Nothing is cut off; there is nothing shown. */
      (/max-height:\s*(?!0[^\d.])[\d.]+/.test(body) && /overflow(-y)?:\s*hidden/.test(body));
    if (!truncates) continue;
    for (const selector of selectors.split(',')) {
      const compounds = selector.trim().split(/\s+|>/).filter(Boolean);
      const subject = compounds[compounds.length - 1];
      if (subject === undefined) continue;
      const name = subject.match(/^\.([A-Za-z][\w-]*)/)?.[1];
      if (name !== undefined) out.add(name);
    }
  }
  return [...out];
}

/**
 * Every element in a component that wears `styles.<name>`, with the text of the
 * JSX opening tag it sits in — enough to ask whether `data-truncates` is on the
 * same element.
 *
 * Deliberately NOT a line scan: an opening tag in this codebase routinely runs
 * to six lines, and a line scan would look at the line holding `className` and
 * miss the attribute three lines down. That is the failure mode D2 named, one
 * instrument over.
 */
function tagsWearing(source: string, className: string): readonly string[] {
  const out: string[] = [];
  const needle = `styles.${className}`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    /* Walk back to the `<` that opens this tag and forward to the `>` that ends
       it, counting braces so a `{…}` expression containing either cannot end the
       scan early. */
    let start = at;
    while (start > 0 && source[start] !== '<') start -= 1;
    let depth = 0;
    let end = start;
    while (end < source.length) {
      const ch = source[end];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
      end += 1;
    }
    out.push(source.slice(start, end + 1));
    at = source.indexOf(needle, at + needle.length);
  }
  return out;
}

const CSS = Object.fromEntries(
  AREAS.map((area) => [
    area,
    readFileSync(find(`apps/web/src/components/${area}/${area}.module.css`), 'utf8'),
  ]),
) as Record<string, string>;

const TSX = Object.fromEntries(
  AREAS.flatMap((area) => {
    const dir = find(`apps/web/src/components/${area}`);
    return readdirSync(dir)
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => [`${area}/${file}`, readFileSync(resolve(dir, file), 'utf8')] as const);
  }),
) as Record<string, string>;

/**
 * The same source with its comments removed, for the route scan.
 *
 * A component's doc comment QUOTES the route it used to carry — `ReceiptView`'s
 * explains at length why the quotation is no longer clamped and what the old
 * `data-truncates` said. Scanning the raw file reads that prose as a live
 * declaration, which is CONVENTIONS' "a source-grep fails by matching the wrong
 * occurrence, not only by matching nothing", one instrument over.
 */
const TSX_CODE = Object.fromEntries(
  Object.entries(TSX).map(([file, source]) => [file, stripComments(source)]),
) as Record<string, string>;

describe('a string that can be truncated names its route to the rest', () => {
  /* CATCHES: the sweep going blind. If no stylesheet in the library truncates
     anything, the assertion below is vacuous — and a vacuous check reports
     exactly like a passing one. */
  it('the library truncates in more than one place, so there is something to sweep', () => {
    const all = AREAS.flatMap((area) => truncatingClasses(CSS[area] as string));
    /* Round 7 removed four rules whose declared route was the `title` attribute
       or a card stating a different sentence, so the floor moved with them. It
       is a floor rather than an equality on purpose: what has to be impossible
       is a sweep with nothing in it. */
    expect(all.length, 'no CSS rule in the library truncates at all').toBeGreaterThan(5);
  });

  /* CATCHES: a truncating rule shipped without a route — the D13 defect, at any
     of the fourteen addresses rather than at the one the receipt named. */
  it.each(AREAS)('every truncating class in %s is worn with a data-truncates', (area) => {
    const unrouted: string[] = [];
    for (const className of truncatingClasses(CSS[area] as string)) {
      const wearers = Object.entries(TSX_CODE).flatMap(([file, source]) =>
        tagsWearing(source, className).map((tag) => ({ file, tag })),
      );
      /* A class nothing wears is dead CSS, not an unrouted truncation. It is
         reported rather than passed over: a selector that matches nothing looks
         exactly like one that passes (CONVENTIONS). */
      if (wearers.length === 0) {
        unrouted.push(`.${className} — no component wears it (dead truncating rule)`);
        continue;
      }
      for (const { file, tag } of wearers) {
        if (!tag.includes('data-truncates')) {
          unrouted.push(`.${className} in ${file}`);
        }
      }
    }
    expect(unrouted, 'a truncating element does not say how to reach the rest').toEqual([]);
  });

  /* ---------------------------------------------------------------------------
   * A ROUTE IS ONE OF THE THREE CONVENTIONS PERMITS, SAID IN A FORM SOMETHING
   * CAN CHECK.
   *
   * ROUND 7, D4. `data-truncates` was PROSE, and the only thing anything checked
   * was that it was present. So the receipt's clipped quotation could carry
   * `"focusing this row expands it; the cited record is on this page"` — a
   * `:focus-visible` clamp expansion, which is none of the three permitted
   * routes, followed by a claim that was FALSE for the excerpt of
   * `m-legal@identity-service` (that record is not in this room's feed, and the
   * row's own adjacent label says "jump to source in #identity-service →").
   * Three more said "the row's title" or "the item's card in Needs you", which is
   * the `title` attribute CONVENTIONS explicitly refuses, and a card stating a
   * different sentence. Every one of them satisfied "a route is named".
   *
   * The attribute is a GRAMMAR now, one kind per permitted route, and the browser
   * sweep in `e2e/smoke.spec.ts` verifies each kind against the rendered page —
   * the control exists and is pressable, the element exists and states the text
   * in full, the accessible name contains it. A route that is not true fails
   * there; a route that is not one of the three fails here.
   * ------------------------------------------------------------------------- */
  const ROUTE = /^(?:name|control|none|element:\S.*)$/;

  it('every declared route is one of the permitted kinds', () => {
    const claimed = Object.entries(TSX_CODE).flatMap(([file, source]) =>
      [...source.matchAll(/data-truncates=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => ({
        file,
        route: (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, 'X'),
      })),
    );
    expect(claimed.length, 'nothing in the library declares a truncation route').toBeGreaterThan(6);
    expect(
      claimed.filter((entry) => !ROUTE.test(entry.route)).map((e) => `${e.file}: ${e.route}`),
      'a truncation route is prose rather than one of the kinds CONVENTIONS permits',
    ).toEqual([]);
    /* CATCHES the grammar collapsing to one kind that means nothing: the three
       permitted routes are genuinely different affordances and the library uses
       more than one of them. */
    const kinds = new Set(claimed.map((entry) => entry.route.split(':')[0]));
    expect([...kinds].sort()).toEqual(['control', 'element', 'name', 'none']);
  });

  /* CATCHES: a route going back to a hover. `title=` is the affordance round 1
     moved the rationale OFF, and CONVENTIONS names it explicitly as not a route.
     The grammar has no kind for it, and this asserts nothing smuggles one in. */
  it('no route is a tooltip', () => {
    const claimed = Object.entries(TSX_CODE).flatMap(([file, source]) =>
      [...source.matchAll(/data-truncates=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => ({
        file,
        why: m[1] ?? m[2] ?? '',
      })),
    );
    expect(
      claimed.filter((entry) => /tooltip|hover|title|focus/i.test(entry.why)),
      'a truncation route is a hover affordance',
    ).toEqual([]);
  });

  /* CATCHES: the stylesheet growing a hover-expands-the-clamp rule again. That
     is what the receipt's excerpt did, and it is not one of the three routes:
     it is invisible to touch, and a keyboard reader who focuses a row to read it
     loses it again the moment they move on. */
  it('no clamp is widened by a hover or a focus', () => {
    const widened: string[] = [];
    for (const area of AREAS) {
      for (const [, selectors, body] of stripComments(CSS[area] as string).matchAll(
        /([^{}]+)\{([^{}]*)\}/g,
      )) {
        if (selectors === undefined || body === undefined) continue;
        if (!/:hover|:focus/.test(selectors)) continue;
        if (/-webkit-line-clamp|max-height|text-overflow/.test(body)) {
          widened.push(`${area}: ${selectors.trim().replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(widened, 'a truncation is undone by hovering or focusing, which is not a route').toEqual(
      [],
    );
  });
});
