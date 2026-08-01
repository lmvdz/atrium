import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { ReceiptView, Timeline, TimelineRow } from '../src/components';
import { list, text } from '../src/components/model';

afterEach(cleanup);

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
      const { container, unmount } = render(<Timeline entries={entries} filtered={false} />);
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
        filtered={false}
      />,
    );
    expect(strayQuotes(container)).toEqual([]);
  });

  /* CATCHES: rendering a chosen answer's own text as the row's note without
     routing it through system voice. The row body is the person's recorded
     answer; the note beside it must say the answer was CHOSEN, in the page's
     voice, with no quotation marks — that is the round-4 finding in one row. */
  it("a chosen answer's row says it was chosen, in system voice", () => {
    const chosen = f
      .timeline({ seen: false, filter: null, routineOpen: false })
      .find((entry) => entry.type === 'message' && entry.id === 'm-chosen');
    expect(chosen).toBeDefined();
    if (chosen === undefined || chosen.type !== 'message') return;
    const { container } = render(<TimelineRow entry={chosen} />);
    const note = container.querySelector('[data-voice="system"]');
    expect(note?.textContent).toMatch(/^chose: /);
    expect(strayQuotes(container)).toEqual([]);
    expect(container.querySelector('q')).toBeNull();
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
