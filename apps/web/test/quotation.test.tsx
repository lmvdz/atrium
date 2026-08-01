import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Quoted, SystemVoice } from '../src/components';
import type { MessageRecord, Quotation } from '../src/components/model';
import {
  attribute,
  chosenAnswer,
  isQuotableOrigin,
  quotationFrom,
  quotationRef,
  systemStatement,
} from '../src/components/model';

afterEach(cleanup);

const typed: MessageRecord = {
  id: 'm21',
  at: '13:07',
  actor: 'lars',
  text: 'Hold the cutover until 418 is explained.',
  origin: 'typed',
};

const seeded: MessageRecord = {
  id: 'm10',
  at: '11:02',
  actor: 'priya',
  text: 'Cut over Friday 1 Aug.',
  origin: 'seeded',
  room: 'identity-service',
};

const chosen: MessageRecord = {
  id: 'm-chosen',
  at: '13:09',
  actor: 'lars',
  text: 'Keep dual-write on until parity holds for 7 consecutive days',
  origin: 'chosen',
};

describe('the quotation invariant', () => {
  /* CATCHES: adding 'chosen' to QuotableOrigin, or dropping the origin check in
     quotationFrom(). This is the exact round-4 gauntlet defect: a one-click
     answer appended as the user's message, then validated as a quotation
     against that page-fabricated message. */
  it('a page-authored answer cannot be minted into a quotation', () => {
    expect(quotationFrom(chosen)).toBeNull();
    expect(isQuotableOrigin('chosen')).toBe(false);
  });

  /* CATCHES: loosening quotationFrom() to accept an empty message or one with
     no id. A quotation whose provenance token points nowhere is a quotation
     nothing is checking, which is worse than no quotation at all. */
  it('a quotation needs both an id and some text behind it', () => {
    expect(quotationFrom({ ...typed, text: '   ' })).toBeNull();
    expect(quotationFrom({ ...typed, id: '' })).toBeNull();
  });

  it('typed and seeded messages are quotable, and carry their provenance', () => {
    const a = quotationFrom(typed);
    const b = quotationFrom(seeded);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(quotationRef(a as Quotation)).toBe('msg:m21');
    expect(quotationRef(b as Quotation)).toBe('msg:m10@identity-service');
  });

  /* CATCHES: routing a chosen message down the quotation branch in attribute().
     The whole point of the helper is that there is no third outcome — either
     it is provably somebody's words, or it is the page saying what happened. */
  it('attribute() sends chosen text to system voice and nowhere else', () => {
    const forTyped = attribute(typed);
    const forChosen = attribute(chosen);
    expect(forTyped.as).toBe('quotation');
    expect(forChosen.as).toBe('system');
    if (forChosen.as === 'system') {
      expect(forChosen.statement.text).toBe(`chose: ${chosen.text}`);
      expect(forChosen.statement.voice).toBe('system');
    }
  });

  /* CATCHES: rendering a chosen answer with quotation marks, a <q>, or a
     data-quoted attribute. Asserted via the RENDERED OUTPUT rather than the
     type, because the type only stops the mistake at the call site — this
     stops it at the pixel. */
  it('a chosen origin cannot render quoted', () => {
    const { container } = render(<SystemVoice statement={chosenAnswer(chosen.text, chosen.id)} />);
    const html = container.innerHTML;
    expect(html).toContain('chose: ');
    expect(html).not.toContain('<q');
    expect(html).not.toContain('data-quoted');
    expect(container.textContent ?? '').not.toMatch(/[“”"]/);
    expect(container.querySelector('[data-voice="system"]')).not.toBeNull();
  });

  /* CATCHES: dropping data-quoted from <Quoted>, or attributing a quotation to
     nobody. Both are ways for real words to end up on screen with no path back
     to the message that proves them. */
  it('a quotation renders in <q>, attributed, with its provenance on the DOM', () => {
    const quotation = quotationFrom(typed) as Quotation;
    const { container } = render(<Quoted quote={quotation} />);
    const q = container.querySelector('q');
    expect(q).not.toBeNull();
    expect(q?.getAttribute('data-quoted')).toBe('msg:m21');
    expect(q?.textContent).toBe(typed.text);
    expect(container.textContent).toContain('— lars 13:07, typed here');
  });

  /* CATCHES: making systemStatement()/chosenAnswer() tolerate empty input. A
     system line that states nothing is a row of chrome pretending to be a
     record entry. */
  it('a system statement with no text is refused', () => {
    expect(() => systemStatement('   ')).toThrow(/states nothing/);
    expect(() => chosenAnswer('')).toThrow(/not an answer/);
  });

  it('the types refuse the swap that the runtime also refuses', () => {
    const quotation = quotationFrom(typed) as Quotation;
    // @ts-expect-error — a Quotation is not a SystemStatement; the two voices
    // are different types precisely so they cannot be handed to each other.
    render(<SystemVoice statement={quotation} />);
    cleanup();
    // @ts-expect-error — a page-authored statement can never reach <Quoted>.
    render(<Quoted quote={systemStatement('chose: something')} />);
    cleanup();
    // @ts-expect-error — and neither can a hand-written object literal: the
    // Quotation brand is a module-private symbol nobody else can name.
    render(<Quoted quote={{ text: 'x', origin: 'typed', messageId: 'm1' }} />);
  });
});
