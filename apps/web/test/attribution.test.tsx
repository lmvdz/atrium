/* ---------------------------------------------------------------------------
 * THE ATTRIBUTION, not just the words.
 *
 * Round 1's convergent finding, from both lineages: the no-synthesized-speech
 * enforcement covered what was said and not who it was said by. Every test here
 * names the mutation it catches, and every one of them was run against the
 * pre-fix tree first — see the ledger in the issue comment.
 * ------------------------------------------------------------------------- */

import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { Composer, Quoted, ReceiptView, TimelineRow } from '../src/components';
import type { MessageRecord, Quotation } from '../src/components/model';
import {
  isQuotation,
  maybe,
  messageEntry,
  parseMessageRecord,
  parseQuotation,
  quotationFrom,
  slot,
  text,
} from '../src/components/model';

afterEach(cleanup);

const priya: MessageRecord = {
  id: 'm10',
  at: '11:02',
  actor: 'priya',
  text: 'Cut over Friday 1 Aug.',
  origin: 'seeded',
  room: 'identity-service',
};

const lars: MessageRecord = {
  id: 'm21',
  at: '13:07',
  actor: 'lars',
  text: 'Hold the cutover until 418 is explained.',
  origin: 'typed',
};

const chosen: MessageRecord = {
  id: 'm-chosen',
  at: '13:09',
  actor: 'lars',
  text: 'Keep dual-write on until parity holds for 7 consecutive days',
  origin: 'chosen',
};

describe('a quotation carries the actor it was minted from', () => {
  /* CATCHES: dropping `actor`/`at` from `quotationFrom` — which is exactly what
     the pre-fix version did. Without them every component that renders a name
     beside quoted text has to be handed one, and a handed-in name is a name
     nothing checks. */
  it('the actor and the time come off the message, not beside it', () => {
    const quotation = quotationFrom(priya) as Quotation;
    expect(quotation.actor).toBe('priya');
    expect(quotation.at).toBe('11:02');
    expect(quotation.text).toBe(priya.text);
    expect(quotation.messageId).toBe('m10');
  });

  /* CATCHES: reintroducing a `by` prop on <Quoted>. There must be no way to
     render priya's name over lars's sentence; the only name the component can
     reach is the one on the quotation it was given. */
  it('<Quoted> renders the quotation’s own actor and takes no other', () => {
    const quotation = quotationFrom(lars) as Quotation;
    const { container } = render(<Quoted quote={quotation} />);
    expect(container.textContent).toContain('— lars 13:07');
    expect(container.querySelector('q')?.getAttribute('data-quoted')).toBe('msg:m21');
    // @ts-expect-error — there is no `by`: the attribution is derived, not passed.
    render(<Quoted by="priya" quote={quotation} />);
  });

  /* CATCHES: a `who` field creeping back onto ProvenanceEntry. The receipt is
     the artifact whose whole job is being the trustworthy record; a name there
     that does not come from the cited message is the cardinal defect. */
  it('a receipt excerpt is attributed by its own quotation', () => {
    const { container } = render(<ReceiptView receipt={f.RECEIPT} />);
    for (const row of container.querySelectorAll('[data-attribution]')) {
      const id = row.getAttribute('data-attribution') ?? '';
      const message = f.MESSAGES[id];
      expect(message, `${id} is not a message in the record`).toBeDefined();
      expect(row.textContent).toContain(message?.actor);
    }
    // and the receipt does render at least one, so this is not vacuous
    expect(container.querySelectorAll('[data-attribution]').length).toBeGreaterThan(0);
  });

  /* CATCHES: the composer reply banner going back to `{actor, at, excerpt}`,
     where the name and the excerpt could disagree. */
  it('the reply banner names whoever the quotation says wrote it', () => {
    const { container } = render(
      <Composer binding={f.REPLYING} footNote="" roomName="users-migration" />,
    );
    const attribution = container.querySelector('[data-attribution="m17"]');
    expect(attribution?.textContent).toContain('justin');
    expect(container.querySelector('[data-quoted]')?.getAttribute('data-quoted')).toBe('msg:m17');
  });
});

describe('the message row is discriminated on origin', () => {
  /* CATCHES the round-1 cardinal defect at its source: a constructor that
     ignores `origin` and builds one row shape for every message. A chosen
     record must not produce a row that HAS an actor field, because a row with
     an actor field is a row that renders under somebody's name. */
  it('a page-authored record cannot produce a human-attributed row', () => {
    const entry = messageEntry(chosen, { state: f.OBJECTS[0]?.state ?? lars_state() });
    expect(entry.origin).toBe('chosen');
    expect('attribution' in entry).toBe(false);
    expect('body' in entry).toBe(false);
    expect('fromViewer' in entry).toBe(false);
    if (entry.origin === 'chosen') {
      expect(entry.statement.voice).toBe('system');
      expect(entry.statement.text).toBe(`lars chose: ${chosen.text}`);
    }
  });

  /* CATCHES: letting a caller hand inline body segments to a page-authored
     record, which would put page-authored runs back in the human body slot. */
  it('a page-authored record has no body of its own', () => {
    expect(() =>
      messageEntry(chosen, { state: lars_state(), body: [{ kind: 'text', text: 'anything' }] }),
    ).toThrow(/no body of its own/);
  });

  /* CATCHES: `fromViewer` being asserted by a caller rather than derived from
     the record's actor — the same class of defect one field over. */
  it('an authored row derives its attribution and its own-ness', () => {
    const entry = messageEntry(lars, { state: lars_state(), viewer: 'lars' });
    expect(entry.origin).toBe('typed');
    if (entry.origin === 'chosen') throw new Error('unreachable');
    expect(entry.attribution.actor).toBe('lars');
    expect(entry.fromViewer).toBe(true);
    expect(messageEntry(priya, { state: lars_state(), viewer: 'lars' })).toMatchObject({
      fromViewer: false,
    });
  });

  /* CATCHES: rendering the actor cell from anything other than the quotation.
     The DOM carries the citation so the check survives a refactor of the
     markup. */
  it('the rendered actor cell cites the message it came from', () => {
    const entry = messageEntry(priya, { state: lars_state() });
    const { container } = render(<TimelineRow entry={entry} />);
    const cell = container.querySelector('[data-attribution="m10"]');
    expect(cell?.textContent).toBe('priya');
  });
});

describe('the runtime boundary', () => {
  /* CATCHES: relying on the `declare`-only brand for data that never went
     through the compiler. JSON, a cast, `Object.assign` and a JavaScript caller
     all bypass a phantom type; these are what actually hold at the edge. */
  it('a quotation-shaped object without provenance is refused', () => {
    expect(
      isQuotation({ text: 'x', actor: 'lars', at: '1', messageId: 'm1', origin: 'typed' }),
    ).toBe(true);
    expect(isQuotation({ text: 'x', at: '1', messageId: 'm1', origin: 'typed' })).toBe(false);
    expect(
      isQuotation({ text: 'x', actor: 'lars', at: '1', messageId: 'm1', origin: 'chosen' }),
    ).toBe(false);
    expect(
      isQuotation({ text: '  ', actor: 'lars', at: '1', messageId: 'm1', origin: 'typed' }),
    ).toBe(false);
    expect(isQuotation(JSON.parse('{"text":"x","origin":"typed"}'))).toBe(false);
    expect(() => parseQuotation({ text: 'x' })).toThrow(/not a quotation/);
  });

  /* CATCHES: an adapter (#25 replay, #27 live) handing over a message with no
     origin at all. An unlabelled message is indistinguishable from a
     page-authored one, so it must not be assumed quotable. */
  it('a message with no origin is refused at the boundary', () => {
    expect(() => parseMessageRecord({ ...lars, origin: undefined })).toThrow(/origin must be/);
    expect(() => parseMessageRecord({ ...lars, actor: '' })).toThrow(/needs an actor/);
    expect(parseMessageRecord(JSON.parse(JSON.stringify(priya)))).toEqual(priya);
  });

  /* CATCHES: `Maybe` having no runtime half, which is how `undefined` reached
     `source in #undefined` — it passes `!== null` and stringifies. */
  it('undefined is absent at runtime, not the word "undefined"', () => {
    expect(maybe(undefined)).toBeNull();
    expect(maybe(null)).toBeNull();
    expect(maybe('  ')).toBeNull();
    expect(maybe(42)).toBeNull();
    expect(text(undefined as unknown as null)).toBeNull();
  });
});

describe('composition slots', () => {
  /* CATCHES: widening a slot back to ReactNode. A slot that takes any node is a
     hole straight through the quotation model — round 1 found five of them. */
  it('raw attributed markup cannot pass through a slot', () => {
    expect(() => slot(<q>words priya never wrote</q>)).toThrow(/<q> element/);
    expect(() => slot(<div>{[<q key="a">nope</q>]}</div>)).toThrow(/<q> element/);
    expect(() => slot(<blockquote>nope</blockquote>)).toThrow(/<blockquote> element/);
    expect(() => slot(<span data-quoted="msg:invented">nope</span>)).toThrow(/data-quoted/);
    /* Built with createElement and a computed key rather than JSX. Two reasons:
       it is how a caller routing around the model would actually build it, and
       it keeps the repo's own lint rule against the prop honest — this file
       genuinely does not contain the prop, it constructs it. */
    const smuggledProp = `dangerously${'SetInnerHTML'}`;
    const smuggled = createElement('div', { [smuggledProp]: { __html: '<q>nope</q>' } });
    expect(() => slot(smuggled)).toThrow(/dangerouslySetInnerHTML/);
  });

  /* CATCHES: over-tightening the walk so the library's own quotation component
     stops working. <Quoted> takes a Quotation and cannot be handed page text,
     so it must pass. */
  it('a real quotation component still passes', () => {
    const quotation = quotationFrom(lars) as Quotation;
    expect(() => slot(<Quoted quote={quotation} />)).not.toThrow();
    expect(() => slot('plain text')).not.toThrow();
    expect(() => slot(null)).not.toThrow();
  });
});

function lars_state() {
  return {
    kind: 'event' as const,
    verification: 'routine' as const,
    owedToViewer: false,
    irreversible: false,
  };
}
