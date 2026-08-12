import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Quoted, SystemVoice } from '../src/components';
import type { MessageRecord, Quotation } from '../src/components/model';
import {
  attribute,
  chosenAnswer,
  isQuotableOrigin,
  messageLedger,
  quotationFrom,
  quotationRef,
  resolveQuotation,
  systemStatement,
} from '../src/components/model';
import { renderRefusing, renderWith } from './harness';

afterEach(cleanup);

/* Human fixtures declare `authorKind: 'human'`: round 2 made an absent kind fail
   CLOSED to `'unknown'` (a deleted author must not render as a person), so a human
   fixture says it is one rather than leaning on a default. */
const typed: MessageRecord = {
  id: 'm21',
  at: '13:07',
  actor: 'lars',
  text: 'Hold the cutover until 418 is explained.',
  origin: 'typed',
  authorKind: 'human',
};

const seeded: MessageRecord = {
  id: 'm10',
  at: '11:02',
  actor: 'priya',
  text: 'Cut over Friday 1 Aug.',
  origin: 'seeded',
  authorKind: 'human',
  room: 'identity-service',
};

const chosen: MessageRecord = {
  id: 'm-chosen',
  at: '13:09',
  actor: 'lars',
  text: 'Keep dual-write on until parity holds for 7 consecutive days',
  origin: 'chosen',
  authorKind: 'human',
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

  it('typed and seeded messages are quotable, and the ref names the room the RECORD is in', () => {
    const ledger = messageLedger([typed, seeded, chosen]);
    const a = quotationFrom(typed);
    const b = quotationFrom(seeded);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(quotationRef(resolveQuotation(ledger, a as Quotation, 'test'))).toBe('msg:m21');
    expect(quotationRef(resolveQuotation(ledger, b as Quotation, 'test'))).toBe(
      'msg:m10@identity-service',
    );
    /* CATCHES: the ref going back to a carried room. A token built from a field
       that travelled beside the id can point at the wrong room; this one cannot,
       because the room is read off the record the id names.

       Two halves since round 6. A citation carrying a `room` alongside a VALID
       checksum still resolves — and the token still names the record's room,
       which is the original claim. A citation with NO valid checksum does not
       resolve at all, because a reference nothing minted is a reference no
       register vouched for. */
    const lyingButMinted = {
      ...(a as Quotation),
      room: 'identity-service',
    } as unknown as Quotation;
    expect(quotationRef(resolveQuotation(ledger, lyingButMinted, 'test'))).toBe('msg:m21');
    const unminted = { messageId: 'm21', room: 'identity-service' } as unknown as Quotation;
    expect(() => resolveQuotation(ledger, unminted, 'test')).toThrow(
      /minted from a different record/,
    );
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
    const { container } = renderWith([typed, seeded], <Quoted quote={quotation} />);
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
    /* And the runtime refuses it too, since round 5's blind review: <SystemVoice>
       validates what it is about to print rather than trusting the type, so the
       swap is caught for a JavaScript caller as well as a TypeScript one. */
    expect(() =>
      // @ts-expect-error — a Quotation is not a SystemStatement; the two voices
      // are different types precisely so they cannot be handed to each other.
      render(<SystemVoice statement={quotation} />),
    ).toThrow(/not system voice/);
    cleanup();
    /* "the runtime also refuses" is not a figure of speech: with a statement in
       the quote slot the record lookup has no id to look up, and with a literal
       in it the id names no message on this page. Both throw, and asserting THAT
       is stronger than asserting the type — a type error is invisible to a
       JavaScript caller and these two are not. */
    expect(() =>
      // @ts-expect-error — a page-authored statement can never reach <Quoted>.
      renderWith([typed], <Quoted quote={systemStatement('chose: something')} />),
    ).toThrow(/no message id/);
    cleanup();
    expect(() =>
      // @ts-expect-error — and neither can a hand-written object literal: the
      // Quotation brand is a module-private symbol nobody else can name.
      renderWith([typed], <Quoted quote={{ messageId: 'm1' }} />),
    ).toThrow(/not a message on this page/);
  });
});

/* ---------------------------------------------------------------------------
 * CHECK THE THING YOU ARE ABOUT TO PAINT, NOT THE THING YOU WERE HANDED.
 *
 * Raised by the round-5 blind review as a time-of-check/time-of-use gap: a
 * statement whose `text` is a getter can answer the validator with one string
 * and the renderer with another. <SystemVoice> copies the spans into plain data
 * first and validates the COPY, so the value checked and the value painted are
 * the same object.
 * ------------------------------------------------------------------------- */
describe('system voice validates what it is about to paint', () => {
  /* CATCHES: validating the live value and rendering from a snapshot taken
     before it — the two reads can disagree, and the one that reaches the screen
     is the one nothing checked. */
  it('a statement whose text changes between reads cannot slip a sentence past', () => {
    let reads = 0;
    const shifty = {
      voice: 'system' as const,
      get text() {
        return 'reopened it — pending again';
      },
      get parts() {
        reads += 1;
        /* Dirty on the first read (the one the renderer takes), clean on every
           read after it (the one a validator would take if it read again). */
        return [
          {
            voice: 'system' as const,
            text: reads === 1 ? 'I approve deleting users_legacy.' : 'reopened it — pending again',
          },
        ];
      },
    } as unknown as Parameters<typeof SystemVoice>[0]['statement'];

    /* Asserted on the DOM rather than on the throw. React 19 retries a render
       that threw, and the retry reads the getter again and gets the clean value
       — so "did it throw" is not the question. The question is whether the
       sentence ever reached the screen.

       AND THE REPORT IS CAUGHT RATHER THAN LET OUT (round 6, D1). The retry
       SUCCEEDS, so React does not fail the render: it reports a recoverable
       error, and the default handler is `reportError()`, which jsdom turns into
       an uncaught exception. The test's own `try/catch` could not see it — there
       was nothing to catch — so `pnpm test` printed `580 passed` and exited 1,
       and `test/mutations.mjs` credited every entry naming this file without
       running anything. `renderRefusing` owns the root so it can pass
       `onRecoverableError`, and the reports come back as values, which lets this
       assert the thing that used to be invisible: React reported the refusal. */
    const { container, reported } = renderRefusing(<SystemVoice statement={shifty} />);
    expect(container.textContent).not.toContain('I approve deleting users_legacy.');
    expect(
      reported.join('\n'),
      'the render boundary let the sentence past without reporting anything',
    ).toMatch(/not system voice|error during concurrent rendering/);
  });
});
