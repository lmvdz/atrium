/* ---------------------------------------------------------------------------
 * EVERY STRING PAINTED IN THE SYSTEM'S VOICE IS CHECKED ON THE PATH — COUNTED.
 *
 * The recurring shape, now at its fourth address in four rounds:
 *
 *   r3  `systemStatement` was checked at the constructor and not at the parser.
 *   r5  it was checked at both and not at the renderer; four components printed
 *       `statement.text` directly, and `statementText()` was written.
 *   r6  `statementText()` was applied to ONE of the page-authored string types;
 *       `Rationale` printed raw at three sites, and `rationaleText()` was
 *       written.
 *   r6, blind review of r6's own fix  a sweep of every element carrying
 *       `data-voice="system"` found six render sites and THREE more unchecked
 *       string sinks inside them — the trailer's lead, the trailer's last-check
 *       clock, and the room name in the cross-room trace. Two of the three have
 *       no constructor at all: they are props, so the renderer is the only place
 *       a check can exist.
 *
 * Each fix was correct about the address it was given. What kept recurring is
 * that the address came from a receipt instead of from a count. So this file
 * does the count: it enumerates every element in the library that carries
 * `data-voice="system"` and requires every caller-supplied string rendered
 * inside it to reach the screen through `statementText`, `rationaleText` or
 * `systemText`.
 *
 * The enumeration is over the SOURCE rather than the DOM, because the property
 * is about what a component CAN render, not about what today's fixtures happen
 * to contain — and "clean today is not checked" is the sentence this repo keeps
 * having to relearn.
 * ------------------------------------------------------------------------- */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemStatement, systemText, systemVoiceDefect } from '../src/components/model';

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

const SOURCES: readonly { readonly file: string; readonly text: string }[] = AREAS.flatMap(
  (area) => {
    const dir = find(`apps/web/src/components/${area}`);
    return readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => ({
        file: `${area}/${name}`,
        text: readFileSync(resolve(dir, name), 'utf8'),
      }));
  },
);

/** The three doors a page-authored string may reach the screen through. */
const DOORS = /statementText\(|rationaleText\(|systemText\(|<SystemVoice\b/;

/**
 * The JSX element that carries `data-voice="system"`, and everything inside it.
 *
 * Brace-counted rather than line-scanned, for the reason D2 names: an opening
 * tag here routinely runs to eight lines, and the interesting content is in the
 * children rather than on the tag.
 */
function systemVoiceRegions(source: string): readonly string[] {
  const out: string[] = [];
  let at = source.indexOf('data-voice="system"');
  while (at !== -1) {
    let start = at;
    while (start > 0 && source[start] !== '<') start -= 1;
    /* Forward to the matching close: count `<` / `</` at depth, which is enough
       for these components and errs toward capturing MORE than the element (a
       larger region can only make the check stricter, never laxer). */
    let depth = 0;
    let end = start;
    let seenOpen = false;
    while (end < source.length) {
      if (source.startsWith('</', end)) {
        depth -= 1;
        if (seenOpen && depth <= 0) {
          end = source.indexOf('>', end);
          break;
        }
      } else if (source[end] === '<' && /[A-Za-z]/.test(source[end + 1] ?? '')) {
        depth += 1;
        seenOpen = true;
      } else if (source.startsWith('/>', end)) {
        depth -= 1;
        if (seenOpen && depth <= 0) break;
      }
      end += 1;
    }
    out.push(source.slice(start, end + 1));
    at = source.indexOf('data-voice="system"', at + 1);
  }
  return out;
}

/**
 * `{expr}` interpolations rendered as CHILDREN of a region — the strings a
 * reader sees.
 *
 * An attribute value is excluded by looking at what precedes the brace, not by
 * a list of attribute names: `title={x}` and `data-jumps-to={y}` are the same
 * shape, and enumerating the names would be a denylist with the failure mode
 * this round spent a defect on.
 */
function interpolations(region: string): readonly string[] {
  const out: string[] = [];
  for (const match of region.matchAll(/\{([^{}]*)\}/g)) {
    const expr = (match[1] ?? '').trim();
    if (expr.length === 0) continue;
    const before = region.slice(0, match.index).replace(/\s+$/, '');
    if (before.endsWith('=')) continue;
    out.push(expr);
  }
  return out;
}

/**
 * Interpolations that are not a caller-supplied STRING, each with the reason.
 *
 * Checked exhaustive in BOTH directions below: an entry that matches nothing is
 * a carve-out that outlived its subject and reports exactly like one doing its
 * job — the same rule the inert-control list in e2e/smoke.spec.ts is held to.
 */
const NOT_A_STRING: readonly { readonly expr: string; readonly why: string }[] = [
  { expr: 'summary.objectivesClear', why: 'a derived count' },
  { expr: 'summary.objectivesTotal', why: 'a derived count' },
  { expr: 'summary.overdue', why: 'a derived count' },
  {
    expr: "plural(summary.commitments, 'commitment')",
    why: 'a count and a literal noun, composed here; neither operand is caller text',
  },
  {
    expr: "plural(summary.failures, 'failure')",
    why: 'a count and a literal noun, composed here; neither operand is caller text',
  },
  {
    expr: 'part.text',
    why: '<SystemVoice> itself — this is the door, and it validates the snapshot it paints',
  },
];

describe('every string painted in the system’s voice goes through a checked door', () => {
  /* CATCHES: the enumeration going blind. Six regions across the library today;
     a run that finds none reports exactly like a run that finds them all clean. */
  it('there are system-voice regions to enumerate', () => {
    const regions = SOURCES.flatMap((source) => systemVoiceRegions(source.text));
    expect(
      regions.length,
      'no component in the library paints system voice',
    ).toBeGreaterThanOrEqual(5);
  });

  /* CATCHES the recurring defect at any address rather than at the one a critic
     names: a caller-supplied string interpolated inside a system-voice element
     without passing a check on the render path. */
  it('no caller-supplied string reaches a system-voice element unchecked', () => {
    const unchecked: string[] = [];
    const hit = new Set<string>();
    for (const { file, text } of SOURCES) {
      for (const region of systemVoiceRegions(text)) {
        for (const expr of interpolations(region)) {
          /* Comments, literals and structural expressions are not caller text. */
          if (/^(\/\*|'|"|`)/.test(expr)) continue;
          /* A CSS-module class name reaching a `className` composed with a
             template — `${styles.x} atr-lbl` — is markup, not text. Matched on
             the value's shape rather than by naming the attribute, for the same
             reason the attribute filter above is positional. */
          if (/^styles\./.test(expr)) continue;
          if (/=>|\.map\(|\.filter\(/.test(expr)) continue;
          if (/^(true|false|null|undefined|\d+)$/.test(expr)) continue;
          const exempt = NOT_A_STRING.find((entry) => entry.expr === expr);
          if (exempt !== undefined) {
            hit.add(exempt.expr);
            continue;
          }
          /* A local already put through a door earlier in the component counts:
             `AttentionCompact` reads its rationale once and paints it three
             times, which is the right shape and not a bypass. */
          if (DOORS.test(expr)) continue;
          if (
            new RegExp(
              `const ${expr}\\s*=\\s*[^;]*(statementText|rationaleText|systemText)\\(`,
            ).test(text)
          ) {
            continue;
          }
          unchecked.push(`${file}: {${expr}}`);
        }
      }
    }
    expect(
      unchecked,
      'a caller-supplied string is painted in the system’s voice with nothing checking it',
    ).toEqual([]);
    /* BOTH DIRECTIONS. An exemption nothing matches is a carve-out that outlived
       its subject, and it reports exactly like one doing its job. */
    expect(
      NOT_A_STRING.filter((entry) => !hit.has(entry.expr)).map((entry) => entry.expr),
      'an exemption in NOT_A_STRING matched nothing in the library',
    ).toEqual([]);
  });

  /* CATCHES: `systemText` becoming a pass-through — the third door, and the one
     with no constructor behind it, so it is the whole guarantee for the strings
     that go through it. */
  it('the third door applies the same rule as the other two', () => {
    expect(() => systemText('priya said the drop is fine', 'test')).toThrow(/no "X said"/);
    expect(() => systemText('I approve the drop', 'test')).toThrow(/no first person/);
    expect(() => systemText('“approved”', 'test')).toThrow(/no quotation marks/);
    expect(systemText('12:29', 'test')).toBe('12:29');
    expect(systemText('identity-service', 'test')).toBe('identity-service');
  });

  /* CATCHES: the three doors drifting apart. They exist because the values have
     different shapes, not because the rule differs — a statement that would be
     refused by one and accepted by another is the exemption this whole class of
     defect is made of. */
  it('the three doors agree on what the system’s voice is', () => {
    for (const bad of ['priya said the drop is fine', 'I approve', 'we agreed', '“x”']) {
      expect(systemVoiceDefect(bad), `${bad} is not refused`).not.toBeNull();
      expect(() => systemText(bad, 'test')).toThrow();
      expect(() => systemStatement(bad)).toThrow();
    }
  });
});
