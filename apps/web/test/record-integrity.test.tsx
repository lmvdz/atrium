import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RenderResult } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { ReceiptView, Timeline, TimelineRow } from '../src/components';
import { list, text } from '../src/components/model';
import { renderWith } from './harness';
import { workspacePath } from './support/workspace-path';

afterEach(cleanup);

/* Same register the fixtures were built from: the DOM checks below are checks
   against the RECORD, which is only meaningful if the render resolved against
   it rather than against whatever the props carried. */
const render = (ui: ReactElement): RenderResult => renderWith(f.RECORDS, ui);

/**
 * Walk every text node and prove that a quotation mark only ever appears inside
 * an element that carries `data-quoted`. This is the exhaustive half of the
 * no-synthesized-speech invariant: rule one says every quotation context must
 * carry provenance, and this says there are no quotation contexts anywhere
 * else. A quote outside a checked context is a quote nothing is checking.
 */
function strayQuotes(root: HTMLElement): string[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const stray: string[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const value = node.nodeValue ?? '';
    if (/[“”]/.test(value)) {
      const parent = (node.parentElement as HTMLElement | null)?.closest('[data-quoted], q');
      if (parent === null || parent === undefined) stray.push(value.trim());
    }
    node = walker.nextNode();
  }
  return stray;
}

/** Anything that shows a JavaScript accident where record text should be. */
const LEAKED = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/;

describe('no optional field reaches a rendered string unguarded', () => {
  /* CATCHES: changing any record-text prop from `Maybe<string>` to
     `string | undefined`, or concatenating an absent fact into a sentence.
     Both print the literal word "undefined" into the record; the receipt is the
     one artifact where that is unforgivable, and it is also where the most
     optional fields live. */
  it('the receipt renders no undefined, null or NaN', () => {
    const { container } = render(<ReceiptView receipt={f.RECEIPT} />);
    expect(container.textContent ?? '').not.toMatch(LEAKED);
  });

  /* CATCHES: the same defect in the feed, where a message may have no reply
     context, no note and no tag — three optional fields on the busiest
     component in the app. */
  it('the timeline renders no undefined, null or NaN in any frame state', () => {
    for (const entries of [
      f.FRESH_TIMELINE,
      f.QUIET_TIMELINE,
      f.timeline({ seen: false, filter: null, routineOpen: false }),
      f.timeline({ seen: true, filter: 'need', routineOpen: true }),
      f.timeline({ seen: true, filter: null, routineOpen: false, targetId: 'm10' }),
    ]) {
      const { container, unmount } = render(<Timeline entries={entries} filter={null} />);
      expect(container.textContent ?? '').not.toMatch(LEAKED);
      unmount();
    }
  });

  /* CATCHES: a message body losing its inline runs, or rendering a mention
     without its `@`. Code and mentions are the only two runs a message has —
     everything else is a person's plain words, deliberately. */
  it('a message body renders code and mentions as themselves', () => {
    const entry = f.FRESH_TIMELINE.find((e) => e.type === 'message' && e.id === 'm7');
    expect(entry).toBeDefined();
    if (entry === undefined || entry.type !== 'message') return;
    const { container } = render(<TimelineRow entry={entry} />);
    expect(container.querySelector('code')?.textContent).toBe('users.dualwrite');
    expect(container.textContent).toContain('@lars');
    expect(container.textContent ?? '').not.toMatch(LEAKED);
  });

  /* CATCHES: letting the browser's default `white-space: normal` flatten
     authored paragraph breaks even though the ledger preserved them. */
  it('the rendered authored body preserves whitespace and line breaks', () => {
    const css = readFileSync(
      workspacePath('apps/web/src/components/timeline/timeline.module.css'),
      'utf8',
    );
    expect(css).toMatch(/\.body \[data-row-body\]\s*\{[^}]*white-space:\s*pre-wrap/s);
  });

  /* CATCHES: making `list()` join with a separator regardless of presence, so
     an absent fact leaves a dangling "·" that reads like a missing value. */
  it('absent parts collapse instead of leaving separators behind', () => {
    expect(list([null, 'due today', null])).toBe('due today');
    expect(list([null, null])).toBeNull();
    expect(list(['  ', 'a', 'b'])).toBe('a · b');
    expect(text('   ')).toBeNull();
  });
});

describe('no synthesized speech, checked against the rendered DOM', () => {
  /* CATCHES: a quotation mark rendered outside a data-quoted element anywhere
     in the receipt — the artifact whose entire job is being the trustworthy
     record, and where the round-3 gauntlet found an invented first-person
     sentence quoted under a real person's name. */
  it('the receipt has no quotation mark outside a checked context', () => {
    const { container } = render(<ReceiptView receipt={f.RECEIPT} />);
    expect(strayQuotes(container)).toEqual([]);
  });

  /* CATCHES: the same defect in the feed, including the reply excerpt — which
     is a quotation of somebody else's message and therefore has to carry its
     provenance like every other one. */
  it('the timeline has no quotation mark outside a checked context', () => {
    const { container } = render(
      <Timeline
        entries={f.timeline({ seen: false, filter: null, routineOpen: true })}
        filter={null}
      />,
    );
    expect(strayQuotes(container)).toEqual([]);
  });

  /* CATCHES the round-1 cardinal defect: rendering a page-authored answer as
     the actor's own words. The whole row must be system voice ("lars chose: …",
     third person, mono, unquoted) and the ATTRIBUTION COLUMN MUST BE EMPTY —
     round 1 shipped this record under lars's name in the same slot as his
     typed sentences. Also catches reintroducing an `actor` field on the chosen
     arm of the union, which is what would make that renderable again. */
  it("a chosen answer's row is system voice and attributed to nobody", () => {
    const chosen = f
      .timeline({ seen: false, filter: null, routineOpen: false })
      .find((entry) => entry.type === 'message' && entry.id === 'm-chosen');
    expect(chosen).toBeDefined();
    if (chosen === undefined || chosen.type !== 'message') return;
    expect(chosen.origin).toBe('chosen');
    expect('attribution' in chosen).toBe(false);
    expect('body' in chosen).toBe(false);

    const { container } = render(<TimelineRow entry={chosen} />);
    const voice = container.querySelector('[data-voice="system"]');
    expect(voice?.textContent).toMatch(/^lars chose: /);
    /* the actor cell exists (the grid keeps its columns) and holds nothing */
    const attribution = container.querySelector('[data-attribution]');
    expect(attribution?.getAttribute('data-attribution')).toBe('none');
    expect(attribution?.textContent).toBe('');
    expect(strayQuotes(container)).toEqual([]);
    expect(container.querySelector('q')).toBeNull();
    expect(container.querySelector('[data-quoted]')).toBeNull();
  });

  /* CATCHES: every quotation the gallery renders losing its provenance token.
     A data-quoted attribute that is empty, or points at no message, is the same
     defect as having none at all. */
  it('every quotation on screen resolves to a message in the record', () => {
    const { container } = render(<ReceiptView receipt={f.RECEIPT} />);
    const quoted = [...container.querySelectorAll('[data-quoted]')];
    expect(quoted.length).toBeGreaterThan(0);
    for (const element of quoted) {
      const ref = element.getAttribute('data-quoted') ?? '';
      expect(ref).toMatch(/^msg:/);
      const id = ref.slice(4).split('@')[0] ?? '';
      const message = f.MESSAGES[id];
      expect(message, `data-quoted cites ${id}, which is not in the record`).toBeDefined();
      expect(message?.origin).not.toBe('chosen');
      expect(message?.text).toContain((element.textContent ?? '').replace(/[“”]/g, ''));
    }
  });
});

/* ---------------------------------------------------------------------------
 * SYSTEM VOICE IS CHECKED WHERE IT IS PRINTED, NOT ONLY WHERE IT IS BUILT.
 *
 * Found by the blind cross-lineage review of round 5: the bans held at the
 * constructor and at `parseSystemStatement`, and four components rendered
 * `statement.text` directly — so a cast or a JSON payload put a first-person
 * sentence into a receipt's history line, beside a free `who` string, in the
 * mono-muted treatment that tells a reader the system checked this. That is
 * round 3's finding ("a guarantee that holds only for callers who used the door
 * it was installed in") in the one artifact whose whole job is being the
 * trustworthy record.
 * ------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
 * "IT IS CHECKABLE BY READING THE TYPES" — SO SOMETHING READS THEM.
 *
 * CONVENTIONS said: "No row that carries page-authored words has a field a
 * renderer could put a name in. That is now a property of all three
 * (`ChosenMessageEntry`, `HappenedLine`, `CorrectionEntry`)… It is checkable by
 * reading the types, and `test/mutations.mjs` re-adds each field and requires
 * `tsc` to fail."
 *
 * It was FALSE, and neither half of the enforcement could see it. `heading:
 * string` sat on `CorrectionEntry`, unconstrained and caller-supplied, rendered
 * one line above the correction's words in the exact slot round 6 had just
 * deleted `who` from. And the mutation entry added a NEW REQUIRED property and
 * required `tsc` to fail — which proves that adding a required property breaks
 * the fixtures, not that no such field exists. Every optional free string in the
 * program passes that mutation.
 *
 * So the claim is read off the types here. The rule stated precisely enough to be
 * true: on a row that carries page-authored words, a member whose type is a bare
 * `string` may only be an IDENTIFIER or a CLOCK — never words. Anything a reader
 * reads as words is a `SystemStatement`, which has no actor field and paints
 * through the one component that paints system voice.
 * ------------------------------------------------------------------------- */
describe('a page-authored row has no field a renderer could put words in', () => {
  function find(relative: string): string {
    let dir = process.cwd();
    for (let i = 0; i < 6; i += 1) {
      const candidate = resolve(dir, relative);
      if (existsSync(candidate)) return candidate;
      dir = dirname(dir);
    }
    throw new Error(`${relative} not found above ${process.cwd()}`);
  }

  const path = find('apps/web/src/components/model/records.ts');
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  /** Every member of an interface, as `name: printed type`. */
  function membersOf(name: string): readonly { readonly name: string; readonly type: string }[] {
    let found: ts.InterfaceDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.getText(source) === name) found = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (found === undefined) throw new Error(`records.ts declares no interface ${name}`);
    return found.members.filter(ts.isPropertySignature).map((member) => ({
      name: member.name.getText(source),
      type: (member.type?.getText(source) ?? 'unknown').replace(/\s+/g, ' '),
    }));
  }

  /** A type that can hold an arbitrary sentence. */
  const FREE = /^(?:readonly )?(?:Maybe<)?string(?:>)?(?: \| null)?$/;

  /* THE THREE ROWS THE CLAIM IS ABOUT. Named from the doctrine, and each one's
     members are read rather than recalled. */
  const ROWS = ['ChosenMessageEntry', 'HappenedLine', 'CorrectionEntry'] as const;

  /* CATCHES: the enumeration going blind — a renamed interface, or a members
     list that comes back empty, reports exactly like a clean sweep. */
  it('there are rows to read, with members on them', () => {
    for (const row of ROWS) {
      expect(membersOf(row).length, `${row} has no members to check`).toBeGreaterThan(2);
    }
    /* …and the reader can actually see a free string when there is one, or every
       assertion below is vacuous. `RowTag.label` is the control: it IS a bare
       string, deliberately (it is a chip's own label, painted through a door). */
    expect(
      membersOf('RowTag')
        .filter((m) => FREE.test(m.type))
        .map((m) => m.name),
    ).toEqual(['label']);
  });

  /* CATCHES the round-7 defect at any address: a free string field on a row that
     carries page-authored words. The exact list is asserted rather than a count,
     because a count is satisfied by swapping one for another. */
  it('the only bare strings on those rows are an id and a clock', () => {
    const free = ROWS.flatMap((row) =>
      membersOf(row)
        .filter((member) => FREE.test(member.type))
        .map((member) => `${row}.${member.name}`),
    );
    expect(
      free,
      'a row that carries page-authored words has a field a renderer could put words in',
    ).toEqual([
      /* `MessageEntryCommon` holds `ChosenMessageEntry`'s id and at, and the
         chosen row prints neither — it resolves its citation and prints the
         record's. */
      'HappenedLine.id',
      'HappenedLine.at',
      'CorrectionEntry.id',
      'CorrectionEntry.at',
    ]);
  });

  /* CATCHES: the words on those rows losing their type. Stated as the positive
     half so a member that is neither a free string nor a statement — a new shape
     nobody thought about — is visible. */
  it('everything a reader reads as words on those rows is a SystemStatement', () => {
    expect(membersOf('HappenedLine').find((m) => m.name === 'statement')?.type).toBe(
      'SystemStatement',
    );
    const correction = membersOf('CorrectionEntry');
    for (const name of ['heading', 'was', 'now']) {
      expect(correction.find((m) => m.name === name)?.type, `${name} is not system voice`).toBe(
        'SystemStatement',
      );
    }
    expect(correction.find((m) => m.name === 'fact')?.type).toBe('Maybe<SystemStatement>');
    expect(membersOf('ChosenMessageEntry').find((m) => m.name === 'statement')?.type).toBe(
      'SystemStatement',
    );
    /* And the receipt's provenance row, which is where round 7 found the
       sharpest instance: a page-authored note printed inside the same button as
       a resolved quotation. */
    expect(membersOf('ProvenanceEntry').find((m) => m.name === 'note')?.type).toBe(
      'Maybe<SystemStatement>',
    );
  });
});

describe('a statement is checked at the boundary where it is printed', () => {
  /** The review's payload, verbatim: a history line with a first-person sentence. */
  const forged = {
    ...f.RECEIPT,
    happened: [
      {
        id: 'h1',
        kind: 'accepted' as const,
        who: 'priya',
        at: '13:09',
        statement: { text: 'I approve deleting users_legacy.', voice: 'system' },
      },
    ],
    corrections: [],
    provenance: [],
  } as unknown as typeof f.RECEIPT;

  /* CATCHES: the receipt's history line going back to `{line.statement.text}`.
     `who` is allowed to be a plain string on this row precisely because nothing
     on it is speech — which stops being true the moment the statement beside it
     is not system voice. */
  it('a receipt history line refuses a statement that is not system voice', () => {
    expect(() => render(<ReceiptView receipt={forged} />)).toThrow(/not system voice/);
  });

  /* CATCHES: the same at the correction chain, the feed's system rows and the
     cross-room trace — every place a SystemStatement's words reach the screen. */
  it('the shipped receipt still renders, so the check is not a blanket refusal', () => {
    const { container } = render(<ReceiptView receipt={f.RECEIPT} />);
    expect(container.querySelectorAll('[data-voice="system"]').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('reopened it');
  });
});
