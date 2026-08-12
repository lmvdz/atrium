/* ---------------------------------------------------------------------------
 * THE ATTRIBUTION, not just the words.
 *
 * Round 1's convergent finding, from both lineages: the no-synthesized-speech
 * enforcement covered what was said and not who it was said by. Every test here
 * names the mutation it catches, and every one of them was run against the
 * pre-fix tree first — see the ledger in the issue comment.
 * ------------------------------------------------------------------------- */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { createPortal } from 'react-dom';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import {
  AttributionLedger,
  Composer,
  Quoted,
  ReceiptView,
  RoomHead,
  TimelineRow,
} from '../src/components';
import type { MessageEntry, MessageRecord, Quotation } from '../src/components/model';
import {
  ANNOUNCED_ATTRIBUTES,
  bodyText,
  chosenAct,
  chosenAnswer,
  citationFrom,
  isCitation,
  isQuotation,
  isRationale,
  isSystemStatement,
  maybe,
  messageEntry,
  messageLedger,
  parseCitation,
  parseMessageRecord,
  parseQuotation,
  parseSystemStatement,
  quotationFrom,
  rationale,
  recordFingerprint,
  resolveCitation,
  resolveQuotation,
  slot,
  systemStatement,
  text,
} from '../src/components/model';
import { renderBare, renderWith } from './harness';

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

const RECORDS = [priya, lars, chosen];

/* ---------------------------------------------------------------------------
 * ROUND 4's GAUNTLET: THE FREE STRING WAS INSIDE THE BRANDED VALUE.
 *
 * `{...quotationFrom(larsMessage)!, actor: 'priya'}` compiled — TypeScript
 * carries `unique symbol` keys through an object spread, so the phantom brand
 * survived — and rendered priya's name over lars's sentence with
 * `data-attribution="m14"`. The render-boundary check passed because it
 * re-derived THE WORDS and only `actor` had moved. `parseQuotation` accepted the
 * same shape from JSON, because it validated shape and never provenance.
 *
 * The fix is not a fifth guard over `actor`. The fields are gone: a Quotation is
 * a message id, and everything printed beside quoted words is looked up from the
 * page's records at the render boundary.
 * ------------------------------------------------------------------------- */
describe('a quotation cites a message; the attribution is looked up from it', () => {
  /* CATCHES: putting the actor, the words or the time back ON the quotation.
     A citation carries no fact a reader sees, which is the property under test —
     `mintedFrom` is a checksum of the record, never printed and never read for
     its value, and asserting the EXACT key set is what stops a displayable field
     being added beside it. */
  it('a quotation carries a message id, a checksum, and nothing a reader sees', () => {
    const quotation = quotationFrom(priya) as Quotation;
    expect(quotation.messageId).toBe('m10');
    expect(Object.keys(quotation).sort()).toEqual(['messageId', 'mintedFrom']);
    /* The checksum is not a copy of any single visible fact: it is not the
       actor, not the words, not the time, and it never reaches the DOM. */
    for (const visible of [priya.actor, priya.text, priya.at]) {
      expect(quotation.mintedFrom).not.toBe(visible);
    }
  });

  /* CATCHES: the checksum omitting a field a reader can see. Round 5's version
     hashed id, origin, at, actor and text — and NOT `room`, which is read at the
     render boundary and printed into `data-quoted` as `msg:m10@identity-service`.
     Two records differing only in room had identical fingerprints, so the one
     check that says "these two registers are the same register" could not see a
     difference the DOM was publishing. */
  it('the checksum covers every field the render boundary can print, room included', () => {
    const { room: _dropped, ...withoutRoom } = priya;
    const here: MessageRecord = withoutRoom;
    const elsewhere: MessageRecord = { ...withoutRoom, room: 'identity-service' };
    expect(recordFingerprint(here)).not.toBe(recordFingerprint(elsewhere));
    const row = messageEntry(elsewhere, { state: lars_state() });
    expect(() => renderWith([here], <TimelineRow entry={row} />)).toThrow(
      /minted from a different record/,
    );
  });

  /* CATCHES: an `actor` field coming back onto `Quotation`, in any form.
     `@ts-expect-error` turns "it compiles" into a failing `pnpm typecheck`,
     which is the assertion, because the defect WAS that the spread compiled.

     Note what makes this honest: the spread on its own is legal (TypeScript
     carries `unique symbol` keys through, which is the fact the round-4 doc
     comment got backwards), so the shape is assignable in every respect except
     the one property under test — the same discipline the entry-brand forgery
     needed in round 4. Verified by the mutation ledger under `typecheck: true`:
     add `readonly actor?: string` back to Quotation and tsc reports this
     directive as unused, and the run fails. */
  it('a quotation literal cannot be given an actor', () => {
    const real = quotationFrom(priya) as Quotation;
    // @ts-expect-error — 'actor' is not a property of Quotation; there is no
    // field beside the citation for a name to disagree with the record in.
    const forged: Quotation = { ...real, actor: 'priya' };
    expect(forged.messageId).toBe('m10');
    // the spread WITHOUT the extra key is legal, so the error above is the brand-
    // free excess-property check and not an incidental assignability failure
    const honest: Quotation = { ...real };
    expect(honest.messageId).toBe('m10');
  });

  /* CATCHES: the spread forgery, at the derivation. Run against r4 this returns
     'priya'; the ledger is the only thing that can answer the question now. */
  it('the round-4 spread forgery resolves to the real actor, not the forged one', () => {
    const real = quotationFrom(lars) as Quotation;
    const forged = { ...real, actor: 'priya', text: 'I authorise dropping users_legacy.' };
    const resolved = resolveQuotation(messageLedger(RECORDS), forged as Quotation, 'test');
    expect(resolved.actor).toBe('lars');
    expect(resolved.text).toBe(lars.text);
  });

  /* CATCHES: `parseQuotation` going back to validating shape without provenance
     — the documented runtime door, which the gauntlet walked straight through
     with `parseQuotation(JSON.parse(JSON.stringify({...real, actor:'priya'})))`. */
  it('the JSON route cannot carry an actor through the parser either', () => {
    const ledger = messageLedger(RECORDS);
    const real = quotationFrom(lars) as Quotation;
    const wire = JSON.parse(JSON.stringify({ ...real, actor: 'priya', text: 'invented' }));
    const parsed = parseQuotation(wire, ledger);
    expect(Object.keys(parsed).sort()).toEqual(['messageId', 'mintedFrom']);
    /* The checksum is RE-DERIVED from this ledger rather than read off the wire:
       a fingerprint that arrived with the payload is the sender's claim about a
       register the sender cannot see. */
    expect(parsed.mintedFrom).toBe(recordFingerprint(lars));
    expect(resolveQuotation(ledger, parsed, 'test').actor).toBe('lars');
    // and a citation this ledger cannot resolve is refused outright
    expect(() => parseQuotation({ messageId: 'nope' }, ledger)).toThrow(/not a quotation/);
    expect(isQuotation({ messageId: 'm-chosen' }, ledger)).toBe(false);
  });

  /* CATCHES: resolving against a page that has never seen the message. A
     citation nobody can check is not a weaker citation; it is not one. */
  it('a citation the ledger cannot resolve throws rather than degrading', () => {
    expect(() =>
      resolveQuotation(
        messageLedger([priya]),
        { messageId: 'm21' } as unknown as Quotation,
        'test',
      ),
    ).toThrow(/is not a message on this page/);
    /* An HONEST citation of a page-authored record — minted through the public
       door, checksum and all — so what this asserts is the origin check rather
       than the register check that would otherwise fire first. */
    const chosenCitation = citationFrom(chosen) as unknown as Quotation;
    expect(() => resolveQuotation(messageLedger(RECORDS), chosenCitation, 'test')).toThrow(
      /page-authored/,
    );
    /* And the register check, which is the one a hand-written literal trips. */
    expect(() =>
      resolveQuotation(
        messageLedger(RECORDS),
        { messageId: 'm10' } as unknown as Quotation,
        'test',
      ),
    ).toThrow(/minted from a different record/);
  });

  /* CATCHES: a ledger that resolves last-write-wins. Two records under one id is
     exactly the state in which a lookup returns somebody else's name, and it is
     the poisoning attack a process-wide registry would have been open to. */
  it('a ledger refuses to hold two records under one id', () => {
    expect(() => messageLedger([lars, { ...lars, actor: 'priya' }])).toThrow(/both claim the id/);
  });

  /* CATCHES: reintroducing a `by` prop on <Quoted>, or reading a carried actor. */
  it('<Quoted> renders the cited record’s actor and takes no other', () => {
    const quotation = quotationFrom(lars) as Quotation;
    const { container } = renderWith(RECORDS, <Quoted quote={quotation} />);
    expect(container.textContent).toContain('— lars 13:07');
    expect(container.querySelector('q')?.textContent).toBe(lars.text);
    expect(container.querySelector('q')?.getAttribute('data-quoted')).toBe('msg:m21');
    // @ts-expect-error — there is no `by`: the attribution is derived, not passed.
    renderWith(RECORDS, <Quoted by="priya" quote={quotation} />);
  });

  /* CATCHES: a render boundary falling back to something instead of refusing
     when there is no record set to check against. An audit may not exempt the
     case its rule covers, and neither may a renderer. */
  it('rendering a quotation with no ledger at all throws', () => {
    const quotation = quotationFrom(lars) as Quotation;
    expect(() => renderBare(<Quoted quote={quotation} />)).toThrow(
      /outside an <AttributionLedger>/,
    );
  });

  /* CATCHES: a `who` field creeping back onto ProvenanceEntry. The receipt is
     the artifact whose whole job is being the trustworthy record; a name there
     that does not come from the cited message is the cardinal defect. */
  it('a receipt excerpt is attributed by the record it cites', () => {
    const { container } = renderWith(f.RECORDS, <ReceiptView receipt={f.RECEIPT} />);
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
     where the name and the excerpt could disagree — or to a quotation whose
     actor a spread could overwrite. */
  it('the reply banner names whoever the record says wrote it', () => {
    const { container } = renderWith(
      f.RECORDS,
      <Composer binding={f.REPLYING} footNote="" roomName="users-migration" />,
    );
    const attribution = container.querySelector('[data-attribution="m17"]');
    expect(attribution?.textContent).toContain('justin');
    /* `@users-migration` because the record says so. `MessageRecord.room` is
       ABSOLUTE since r9 — it used to be written only when the message was not in
       the room on screen, which is a fact about a viewport stored on a register
       four viewports share. The token is still pinned exactly; what it pins now
       includes the room the register records, which is the field
       `recordFingerprint` has hashed since round 6. */
    expect(container.querySelector('[data-quoted]')?.getAttribute('data-quoted')).toBe(
      'msg:m17@users-migration',
    );
  });

  /* CATCHES the forgery AT EVERY BOUNDARY THAT PRINTS A NAME, not just the one
     the last receipt named. "Fixed at the row" is what rounds 1–4 each shipped. */
  it('a tampered citation prints the record’s words at the reply banner', () => {
    const forged = {
      messageId: 'm17',
      actor: 'priya',
      text: 'I authorise the drop.',
    } as unknown as Quotation;
    /* Round 6: this used to RENDER and print justin's words over the forged
       name's place, which was the right outcome for the display path and left
       the register question open — the banner was one of the four boundaries
       whose citation nothing checked against the page's record. A citation with
       no checksum is now refused outright, which is a stronger answer than
       printing the right thing anyway. */
    expect(() =>
      renderWith(
        f.RECORDS,
        <Composer
          binding={{ mode: 'replying', to: forged }}
          footNote=""
          roomName="users-migration"
        />,
      ),
    ).toThrow(/minted from a different record/);
    cleanup();
    /* …and the honest citation still renders the record's own name and words, so
       this is not a boundary that refuses everything. */
    const { container } = renderWith(
      f.RECORDS,
      <Composer
        binding={{ mode: 'replying', to: f.REPLYING.mode === 'replying' ? f.REPLYING.to : never() }}
        footNote=""
        roomName="users-migration"
      />,
    );
    expect(container.querySelector('[data-attribution="m17"]')?.textContent).toContain('justin');
    expect(container.textContent).not.toContain('I authorise the drop.');
  });

  it('a tampered citation is refused in the receipt', () => {
    const forged = {
      messageId: 'm10',
      actor: 'lars',
      text: 'I authorise the drop.',
    } as unknown as Quotation;
    const receipt = {
      ...f.RECEIPT,
      provenance: [{ id: 'p1', excerpt: forged, note: null }],
      corrections: [],
    };
    expect(() => renderWith(f.RECORDS, <ReceiptView receipt={receipt} />)).toThrow(
      /minted from a different record/,
    );
    cleanup();
    const honest = { ...f.RECEIPT, corrections: [] };
    const { container } = renderWith(f.RECORDS, <ReceiptView receipt={honest} />);
    expect(container.querySelector('[data-attribution="m10"]')?.textContent).toBe('priya');
    expect(container.textContent).not.toContain('I authorise the drop.');
  });
});

function never(): never {
  throw new Error('fixture: REPLYING is not a replying binding');
}

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
    expect(entry.attribution.messageId).toBe('m21');
    expect(entry.fromViewer).toBe(true);
    expect(messageEntry(priya, { state: lars_state(), viewer: 'lars' })).toMatchObject({
      fromViewer: false,
    });
  });

  /* CATCHES: rendering the actor cell from anything other than the cited
     record. The DOM carries the citation so the check survives a refactor of the
     markup. */
  it('the rendered actor cell cites the message it came from', () => {
    const entry = messageEntry(priya, { state: lars_state() });
    /* IN THE ROOM THE RECORD SAYS IT IS IN. This `priya` fixture carries
       `room: 'identity-service'` and the harness stands in #users-migration by
       default; since round 10 a feed row refuses to render a record from another
       room (D2), so a test about ATTRIBUTION has to stand where the words were
       said. The refusal itself is asserted in `the feed is one room's
       conversation` below. */
    const { container } = renderWith(RECORDS, <TimelineRow entry={entry} />, 'identity-service');
    const cell = container.querySelector('[data-attribution="m10"]');
    expect(cell?.textContent).toBe('priya');
  });

  /* ---------------------------------------------------------------------------
   * ROUND 10, D2 — A FEED IS ONE ROOM'S CONVERSATION.
   *
   * `/gallery` frame 05 rendered a head, a lens, a composer and a rail chip all
   * saying `#identity-service` over EIGHT `room: 'users-migration'` records, so a
   * reader came away believing priya said "Staging backfill ran clean — 4.2M rows
   * in 38 minutes" in #identity-service. r8's D3 taught three boundaries to SAY
   * where a cited message is; r9 made the disagreement visible. Neither prevented
   * it, because a frame is assembled prop by prop and `room` can be overridden
   * independently of `entries`.
   *
   * CATCHES: deleting `refuseElsewhere` from either arm of `TimelineRow`, and
   * anything that reassembles a frame with a head from one room and a feed from
   * another — the gallery's own frame is asserted below in gallery.spec.ts, and
   * this is the unit that makes it unrenderable rather than merely absent.
   * ------------------------------------------------------------------------- */
  it('a feed refuses a row whose record is from another room', () => {
    const entry = messageEntry(priya, { state: lars_state() });
    expect(() => renderWith(RECORDS, <TimelineRow entry={entry} />, 'users-migration')).toThrow(
      /is a message in #identity-service, and this feed is #users-migration/,
    );
  });

  /* BOTH DIRECTIONS, AND ON BOTH ARMS. A chosen row has no actor to forge and
     could still be filed into the wrong room's feed; and a record that says
     nothing about its room is not a record that says it is elsewhere. */
  it('the refusal covers the page-authored arm, and passes an unrecorded room', () => {
    const chosenRow = messageEntry(
      { ...chosen, room: 'identity-service' },
      { state: lars_state() },
    );
    expect(() =>
      renderWith(
        [{ ...chosen, room: 'identity-service' }],
        <TimelineRow entry={chosenRow} />,
        'users-migration',
      ),
    ).toThrow(/is a message in #identity-service/);

    cleanup();
    /* `lars` (m21) carries no `room`; absence is a fact about the register, not a
       claim that the message is elsewhere. */
    const local = messageEntry(lars, { state: lars_state() });
    const { container } = renderWith(RECORDS, <TimelineRow entry={local} />, 'anywhere-at-all');
    expect(container.querySelector('[data-attribution="m21"]')?.textContent).toBe('lars');
  });

  /* CATCHES: the row rendering a name with no record behind it. Every rendered
     row goes through the lookup; a row outside a ledger is not a degraded row. */
  it('a row rendered with no ledger throws', () => {
    const entry = messageEntry(priya, { state: lars_state() });
    expect(() => renderBare(<TimelineRow entry={entry} />)).toThrow(
      /outside an <AttributionLedger>/,
    );
  });
});

/* ---------------------------------------------------------------------------
 * THE BODY IS A DERIVATION, NOT AN OVERRIDE.
 *
 * Round 2 closed the chosen arm — no actor field, no body field — and the free
 * string moved one field over. `body?: readonly BodySegment[]` on the AUTHORED
 * arm was a caller override that nothing reconciled against the record whose
 * actor and message id the row was about to print. The gauntlet's reproduction,
 * through the public API with no cast: record m14, actor `lars`,
 * `data-attribution="m14"`, body reading "I authorise dropping users_legacy
 * right now." — words lars never wrote, under lars's name, citing lars's
 * message as the proof.
 * ------------------------------------------------------------------------- */
describe('an authored body derives from its record', () => {
  /* CATCHES: dropping the reconciliation in `messageEntry` — the exact defect,
     reproduced exactly as the gauntlet reproduced it. If this passes without
     throwing, a caller can put any sentence at all under a real person's name
     and the DOM will cite a real message as its proof. */
  it('a body that says something else throws at construction', () => {
    expect(() =>
      messageEntry(lars, {
        state: lars_state(),
        body: [{ kind: 'text', text: 'I authorise dropping users_legacy right now.' }],
      }),
    ).toThrow(/does not read as the message it is attributed to/);
  });

  /* CATCHES: a check loose enough to wave through "close enough" — an added
     clause, a dropped clause, a changed word, a stray space. The words are the
     record's; only the markup is the caller's. */
  it.each([
    ['an added clause', `${lars.text} And drop the table while you are there.`],
    ['a dropped clause', lars.text.slice(0, 20)],
    ['a changed word', lars.text.replace('Hold', 'Ship')],
    ['a stray space', `${lars.text} `],
  ])('%s is a different message', (_name, text) => {
    expect(() =>
      messageEntry(lars, { state: lars_state(), body: [{ kind: 'text', text }] }),
    ).toThrow(/does not read as the message/);
  });

  /* CATCHES: over-tightening it into "no markup allowed". Segments exist so a
     body can carry mentions and code runs; what they may not do is change the
     words. The `@` counts, because the reader sees it. */
  it('markup over the same text is accepted, and the @ of a mention counts', () => {
    const mentioned: MessageRecord = {
      id: 'm-mention',
      at: '10:12',
      actor: 'mateo',
      text: '@lars this is `users.dualwrite`, not the backfill',
      origin: 'seeded',
    };
    const body = [
      { kind: 'mention', text: 'lars' },
      { kind: 'text', text: ' this is `' },
      { kind: 'code', text: 'users.dualwrite' },
      { kind: 'text', text: '`, not the backfill' },
    ] as const;
    expect(bodyText(body)).toBe(mentioned.text);
    const entry = messageEntry(mentioned, { state: lars_state(), body });
    if (entry.origin === 'chosen') throw new Error('unreachable');
    expect(entry.body).toEqual(body);

    /* And dropping the `@` from the model while `MessageBody` still renders it
       is caught too: the two now come from one function. */
    expect(() =>
      messageEntry(mentioned, {
        state: lars_state(),
        body: [{ kind: 'text', text: mentioned.text.slice(1) }, ...body.slice(1)],
      }),
    ).toThrow(/does not read as the message/);
  });

  /* CATCHES the SHIPPED INSTANCE. Round 2's gallery contained one: m7's body
     added a mention and a whole clause that MESSAGES.m7.text did not have, so
     the demo the reviewer opens was itself the defect. This walks every authored
     row in every fixture frame rather than spot-checking m7, because the next
     one will be a different message. */
  it('every authored row in the shipped fixtures reads as its own record', () => {
    const frames = [
      f.timeline({ seen: false, filter: null, routineOpen: false }),
      f.timeline({ seen: true, filter: 'need', routineOpen: true }),
      f.QUIET_TIMELINE,
      f.FRESH_TIMELINE,
    ];
    let checked = 0;
    for (const entries of frames) {
      for (const entry of entries) {
        if (entry.type !== 'message' || entry.origin === 'chosen') continue;
        const record = f.MESSAGES[entry.id];
        expect(record, `fixture ${entry.id} has no record`).toBeDefined();
        expect(bodyText(entry.body), `${entry.id} renders words its record does not have`).toBe(
          record?.text,
        );
        checked += 1;
      }
    }
    expect(checked, 'the walk found no authored rows to check').toBeGreaterThan(8);
  });

  /* CATCHES: the check passing because the renderer prints something else. The
     DOM has to agree with the record too, not just the model. */
  it('the rendered row reads as the record it cites', () => {
    const entry = messageEntry(f.MESSAGES.m7 as MessageRecord, {
      state: lars_state(),
      body: [
        { kind: 'mention', text: 'lars' },
        {
          kind: 'text',
          text: ' dual-write costs about $900/mo in extra write throughput — that is ',
        },
        { kind: 'code', text: 'users.dualwrite' },
        { kind: 'text', text: ' on both tables, not the backfill.' },
      ],
    });
    const { container } = renderWith(f.RECORDS, <TimelineRow entry={entry} />);
    const body = container.querySelector('[data-row-body]');
    expect(body?.textContent).toBe(f.MESSAGES.m7?.text);
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 3's GAUNTLET: THE GUARANTEE MOVED AND THE HOLE FOLLOWED IT.
 *
 * `messageEntry` threw on a divergent body — and `AuthoredMessageEntry` was an
 * exported, structurally inhabitable interface while `TimelineRow` took
 * `MessageEntry` directly. So the attack did not have to defeat the check; it
 * walked around it. Get a genuine Quotation from the public `quotationFrom`,
 * write the entry literal, hand it to the row. `tsc --noEmit` exit 0, priya's
 * name over words she did not write, `data-attribution` citing her real
 * message as the proof.
 *
 * Fixed two ways on purpose, and both are tested here, because each covers what
 * the other does not:
 *   - the TYPE is closed (a brand), so the literal no longer compiles;
 *   - the RENDERER re-derives, so a cast that defeats the brand still cannot
 *     put a name over words that are not on the record.
 * ------------------------------------------------------------------------- */
describe('the forged entry, from the round-3 receipt', () => {
  /** The gauntlet's forgery, verbatim: real quotation, invented body. */
  function forge() {
    const attribution = quotationFrom(priya) as Quotation;
    /* EVERY LITERAL IS NARROWED. The first version of this helper let TypeScript
       widen `type` to `string` and `kind` to `string`, so the assignment below
       failed for those reasons and the `@ts-expect-error` stayed satisfied with
       the brand deleted — the ledger caught it escaping. A forgery that fails to
       compile for an incidental reason proves nothing about the guarantee under
       test: the shape has to be assignable in every respect EXCEPT the brand. */
    return {
      type: 'message' as const,
      id: priya.id,
      at: priya.at,
      state: lars_state(),
      replyTo: null,
      tag: null,
      targeted: false,
      matchesFilter: true,
      origin: 'seeded' as const,
      attribution,
      body: [{ kind: 'text' as const, text: 'I authorise dropping users_legacy right now.' }],
      fromViewer: false,
      note: null,
      /* Round 5 added `mintedFrom`, and leaving it off would have made the
         assignment below fail for a MISSING FIELD rather than for the brand —
         which is the round-4 lesson exactly: a negative type test proves nothing
         unless the shape is assignable in every respect except the property
         under test. The mutation ledger caught it escaping within the hour. */
      mintedFrom: recordFingerprint(priya),
    };
  }

  /* CATCHES: un-branding the entry. `@ts-expect-error` turns "it compiles" into
     a failing `pnpm typecheck` — which is the assertion, because the defect was
     precisely that the forgery compiled. The entry is built by `forge()` and
     only ASSIGNED here, so this is testing the type of the shape rather than
     testing that some hand-written literal is missing a field. Verified by the
     mutation ledger under `typecheck: true`: with the brand removed, tsc reports
     the directive as unused and the run fails. */
  it('an AuthoredMessageEntry literal does not compile', () => {
    // @ts-expect-error — only `messageEntry` mints a MessageEntry; the brand is
    // not a field a caller can supply.
    const forged: MessageEntry = forge();
    expect(forged.type).toBe('message');
  });

  /* CATCHES: dropping the render-boundary derivation. This defeats the brand
     the way a determined caller would — a cast, which no phantom type stops —
     and asserts the ROW still refuses. It is the half that a future call site
     cannot route around, because every rendered row goes through it.

     Note what is NOT asserted: that it renders something safe instead. A row
     that quietly corrects itself is a corrected row nobody finds out about. */
  it('a cast past the brand still cannot render a name over invented words', () => {
    const forged = forge() as unknown as Parameters<typeof TimelineRow>[0]['entry'];
    expect(() => renderWith(RECORDS, <TimelineRow entry={forged} />)).toThrow(
      /does not read as the message it is attributed to \(priya\)/,
    );
  });

  /* CATCHES: the check being written against the wrong operand — comparing the
     body to itself, or to `entry.id`, either of which passes on the forgery
     above but also passes on a genuine row. An honest row must still render. */
  it('an honest row built the honest way still renders', () => {
    const entry = messageEntry(priya, { state: lars_state() });
    const { container } = renderWith(RECORDS, <TimelineRow entry={entry} />, 'identity-service');
    expect(container.querySelector('[data-row-body]')?.textContent).toBe(priya.text);
    expect(container.querySelector('[data-attribution]')?.textContent).toBe('priya');
  });

  /* CATCHES: the renderer trusting `entry.body` when the row was built by a
     JavaScript caller with no types at all — the JSON path. Same defect, no
     TypeScript involved. */
  it('an entry that arrived as JSON gets the same check', () => {
    const forged = JSON.parse(JSON.stringify(forge())) as Parameters<
      typeof TimelineRow
    >[0]['entry'];
    expect(() => renderWith(RECORDS, <TimelineRow entry={forged} />)).toThrow(
      /may not change the words/,
    );
  });
});

/* ---------------------------------------------------------------------------
 * THE OTHER HALF OF SYSTEM VOICE.
 *
 * Same round-3 finding, same family: `systemStatement('priya said: …')`
 * compiled and rendered. CONVENTIONS says system voice is "no quotation marks,
 * no first person, no 'X said' framing"; the stylesheet enforced mono and
 * muted, and nothing enforced the other three.
 * ------------------------------------------------------------------------- */
describe('system voice says facts about acts, not sentences people uttered', () => {
  /* CATCHES: removing the framing bans from `systemStatement`. The first case
     is the gauntlet's, verbatim. */
  it.each([
    ['the gauntlet’s own case', 'priya said: I authorise dropping users_legacy right now.'],
    ['a speech verb on its own', 'lars said the cutover is fine'],
    ['past-tense writing', 'priya wrote that the backfill is done'],
    ['telling', 'mateo told the room to hold'],
    ['asking', 'lars asked whether parity held'],
    ['first person singular', 'I authorised the drop'],
    ['first person plural', 'we agreed to cut over on Friday'],
    ['an object pronoun', 'priya sent it to us at 13:09'],
    ['straight quotation marks', 'the answer was "keep dual-write on"'],
    ['curly quotation marks', 'the answer was “keep dual-write on”'],
  ])('%s is refused', (_name, text) => {
    expect(() => systemStatement(text)).toThrow(/systemStatement:/);
  });

  /* CATCHES: over-tightening it until the app's own system voice stops
     compiling. These are the shapes the receipt, the feed and the chosen row
     actually use, and every one of them is a report of an act. */
  it.each([
    'parity #415 passed with 0 diffs',
    'lars chose: Keep dual-write on until parity holds for 7 consecutive days',
    'reopened it — pending again',
    'answered by lars at 13:09 · chosen from the options on the card',
    'proposed the cutover date',
    'lars’s answer of 13:09 stays on the record',
  ])('%s is accepted', (text) => {
    expect(systemStatement(text).text).toBe(text);
  });

  /* ---------------------------------------------------------------------
   * ROUND 4's GAUNTLET: THE BAN WAS APPLIED TO THE OPTION PAYLOAD.
   *
   * `messageEntry` threw, at render, on ordinary English button copy — every
   * reversible one-click answer in the product had to avoid the five commonest
   * pronouns in the language. The rule was never about the letters; it is about
   * WHO IS SPEAKING. The system's framing is held to the whole rule; the option
   * it is reporting keeps its pronouns.
   * ------------------------------------------------------------------- */
  it.each([
    'Keep it behind our retention window',
    'Give us another day',
    'Yes — I approve',
    'Ship it, we agreed',
  ])('“%s” is a legal one-click answer', (option) => {
    expect(chosenAnswer(option).text).toBe(`chose: ${option}`);
    expect(chosenAct('lars', option).text).toBe(`lars chose: ${option}`);
    /* And through the constructor every feed row goes through — the shape that
       actually threw. Round 4's fixtures happened to dodge it, which is why the
       four strings are now records in the shipped gallery. */
    const record: MessageRecord = {
      id: `m-${option.length}`,
      at: '13:11',
      actor: 'lars',
      text: option,
      origin: 'chosen',
    };
    const entry = messageEntry(record, { state: lars_state() });
    if (entry.origin !== 'chosen') throw new Error('unreachable');
    expect(entry.statement.text).toBe(`lars chose: ${option}`);
    /* The statement knows which words it wrote and which it is reporting, so
       the JSON boundary can apply the same split instead of guessing. */
    expect(entry.statement.parts.map((p) => p.voice)).toEqual(['system', 'verbatim']);
    expect(isSystemStatement(entry.statement)).toBe(true);
  });

  /* CATCHES: the re-scope going too far — the payload exemption swallowing the
     framing. The SYSTEM's own words are still held to all three bans, a payload
     may still not wear quotation marks, and a statement that OPENS with a
     payload is a quotation without the marks whatever its type says. */
  it('the re-scope does not become a hole', () => {
    expect(() => chosenAnswer('the answer was "keep dual-write on"')).toThrow(/quotation marks/);
    /* The framing is checked for SHAPE before it is checked for words, so a
       caller who tries to smuggle a name and a speech verb into the framing is
       refused for the shape — which is the stronger refusal of the two, because
       it does not depend on the verb being on a list. */
    expect(() => chosenAct('priya said', 'anything')).toThrow(/may only follow/);
    expect(() => systemStatement('priya said: it is fine')).toThrow(/X said/);
    expect(() => systemStatement('we agreed to cut over on Friday')).toThrow(/first person/);
    /* THE ROUTE THE BLIND CROSS-LINEAGE REVIEW FOUND. A public general composer
       let a caller pair ANY framing with an exempt payload:
       [{system:'priya '}, {verbatim:'said: I approve…'}] passed every per-span
       ban and rendered "priya said: I approve…". The composer is module-private
       now, and the shape check refuses it at the JSON boundary too — the
       exemption belongs to one sentence shape, not to a span. */
    expect(
      isSystemStatement({
        text: 'priya said: I approve deleting users_legacy.',
        voice: 'system',
        parts: [
          { voice: 'system', text: 'priya ' },
          { voice: 'verbatim', text: 'said: I approve deleting users_legacy.' },
        ],
      }),
      'a caller-chosen framing can still carry an exempt payload',
    ).toBe(false);
    expect(
      isSystemStatement({
        text: 'I authorise dropping users_legacy — recorded',
        voice: 'system',
        parts: [
          { voice: 'verbatim', text: 'I authorise dropping users_legacy' },
          { voice: 'system', text: ' — recorded' },
        ],
      }),
    ).toBe(false);
    /* and a payload may not be split across spans to dodge the shape check */
    expect(
      isSystemStatement({
        text: 'lars chose: a · b',
        voice: 'system',
        parts: [
          { voice: 'system', text: 'lars chose: ' },
          { voice: 'verbatim', text: 'a' },
          { voice: 'verbatim', text: ' · b' },
        ],
      }),
    ).toBe(false);
  });

  /* CATCHES: the payload exemption being available at the JSON boundary to a
     payload that never was one. A statement arriving without parts is read as
     ALL system voice — the strictest reading, not the lenient one. */
  it('the JSON boundary does not hand out the payload exemption', () => {
    expect(isSystemStatement({ text: 'lars chose: Yes — I approve', voice: 'system' })).toBe(false);
    expect(
      isSystemStatement({
        text: 'lars chose: Yes — I approve',
        voice: 'system',
        parts: [
          { voice: 'system', text: 'lars chose: ' },
          { voice: 'verbatim', text: 'Yes — I approve' },
        ],
      }),
    ).toBe(true);
    // a payload alone is not a system statement, whatever the parts claim
    expect(
      isSystemStatement({
        text: 'Yes — I approve',
        voice: 'system',
        parts: [{ voice: 'verbatim', text: 'Yes — I approve' }],
      }),
    ).toBe(false);
    /* and a statement that opens on an EMPTY system span opens on nothing — the
       framing is what says the words after it are being reported, so a blank one
       is the same hole as a missing one. This is the case only the opening check
       can see: with a verbatim span present the shape check catches it too, so a
       test that only used that case could not tell the two guards apart. */
    expect(
      isSystemStatement({
        text: '  parity #415 passed',
        voice: 'system',
        parts: [
          { voice: 'system', text: '  ' },
          { voice: 'system', text: 'parity #415 passed' },
        ],
      }),
    ).toBe(false);
    // and the parts have to add up to the text they claim to compose
    expect(
      isSystemStatement({
        text: 'lars chose: drop the table',
        voice: 'system',
        parts: [
          { voice: 'system', text: 'lars chose: ' },
          { voice: 'verbatim', text: 'something else entirely' },
        ],
      }),
    ).toBe(false);
  });

  /* CATCHES: enforcing it at the constructor and not at the runtime boundary,
     which is the exact shape of the defect this round is fixing — a guarantee
     that holds only for callers who used the door it was installed in. */
  it('a statement that arrived as JSON gets the same check', () => {
    expect(isSystemStatement({ text: 'parity #415 passed', voice: 'system' })).toBe(true);
    expect(isSystemStatement({ text: 'priya said: drop it', voice: 'system' })).toBe(false);
    expect(() => parseSystemStatement({ text: 'we agreed', voice: 'system' })).toThrow(/X said/);
  });

  /* CATCHES: the ban list silently doing nothing because every fixture happens
     to sit outside it — a check with no live subject is a check nobody has run.
     Every statement the shipped gallery renders goes through the constructor,
     so this asserts the constructor is the thing that built them. */
  it('every shipped statement was minted through the guarded constructor', () => {
    const statements = [
      ...f.RECEIPT.happened.map((line) => line.statement),
      ...f.RECEIPT.corrections.flatMap((c) => [c.was, c.now, ...(c.fact === null ? [] : [c.fact])]),
      f.JUMP.why,
    ];
    expect(statements.length).toBeGreaterThan(8);
    for (const statement of statements) {
      expect(statement.voice).toBe('system');
      expect(() => systemStatement(statement.text)).not.toThrow();
    }
  });
});

describe('the runtime boundary', () => {
  /* CATCHES: relying on the `declare`-only brand for data that never went
     through the compiler. JSON, a cast, `Object.assign` and a JavaScript caller
     all bypass a phantom type; these are what actually hold at the edge. */
  it('a quotation-shaped object without provenance is refused', () => {
    const ledger = messageLedger(RECORDS);
    expect(isQuotation({ messageId: 'm21' }, ledger)).toBe(true);
    /* Every one of these used to be answered by reading fields off the payload.
       They are answered by the RECORD now: an unknown id, a page-authored one,
       and an object with no id at all. */
    expect(isQuotation({ text: 'x', actor: 'lars', at: '1', origin: 'typed' }, ledger)).toBe(false);
    expect(isQuotation({ messageId: 'm-chosen' }, ledger)).toBe(false);
    expect(isQuotation({ messageId: 'never-seen' }, ledger)).toBe(false);
    expect(isQuotation({ messageId: '   ' }, ledger)).toBe(false);
    expect(isQuotation(JSON.parse('{"text":"x","origin":"typed"}'), ledger)).toBe(false);
    expect(() => parseQuotation({ text: 'x' }, ledger)).toThrow(/not a quotation/);
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

  /* CATCHES: the walk going back to `return`ing on a raw string. ROUND 7: a
     `Slot` is the one boundary the printed-string sweep can see through, on the
     strength of `slot()` validating what it is handed — and the walk looked only
     for MARKUP. A bare string is not markup, so `slot(object.text)` and
     `slot(receipt.title)` carried a caller's sentence through the hole whose
     entire purpose is stopping caller content, with `ClaimText` printing
     `content.node` at the other end. */
  it('a raw string in a slot goes through the same door every printed string does', () => {
    expect(() => slot('priya said the drop is fine')).toThrow(/no "X said"/);
    expect(() => slot('I authorise the drop')).toThrow(/no first person/);
    expect(() => slot(<div>“invented words”</div>)).toThrow(/no quotation marks/);
    /* …and the shipped content still passes, so this is not a blanket refusal. */
    expect(() =>
      slot('Drop users_legacy at cutover rather than after the retention window'),
    ).not.toThrow();
  });

  /* CATCHES: `RoomHead.surfaces` going back to `ReactNode`. It was the last
     composition hole in the frame taking the widest type React has — in the
     header of every room, above every conversation — so raw attributed markup
     could reach the screen there with no cast and no constructor. */
  it('the room head takes a slot, not a ReactNode', () => {
    /* The type is the first layer, and `@ts-expect-error` is not decoration:
       `pnpm typecheck` fails if this line ever starts compiling. It renders
       nothing at runtime, which is the second half of the same statement — raw
       markup does not reach the DOM through this prop. */
    /* `RoomHead` itself still takes a full `RoomHeadRecord` — it is the leaf that
       paints the member chips. `f.ROOM` is the frame-level `Omit<…, 'members'>`
       now (the head's members derive from the participant source in `RoomFrame`),
       so this direct render supplies the members the component still needs. This
       test is about the surfaces slot, not the roster, so an empty list serves. */
    const head = { ...f.ROOM, members: [] };
    const raw = render(
      // @ts-expect-error — `surfaces` is a Slot: raw markup does not compile.
      <RoomHead room={head} surfaces={<b data-raw="true">raw</b>} />,
    );
    expect(raw.container.querySelector('[data-raw]')).toBeNull();
    cleanup();
    expect(() => render(<RoomHead room={head} surfaces={slot(<q>invented words</q>)} />)).toThrow(
      /<q> element/,
    );
    const { container } = render(
      <RoomHead room={head} surfaces={slot(<span data-surfaces="true">CONVERSATION</span>)} />,
    );
    expect(container.querySelector('[data-surfaces]')?.textContent).toBe('CONVERSATION');
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

/* ---------------------------------------------------------------------------
 * WHAT THE BLIND CROSS-LINEAGE REVIEW OF ROUND 5's OWN FIX FOUND.
 *
 * The standing rule is that a fix round's claims get the same adversarial
 * treatment as the original. Two of these are the cardinal invariant reached
 * through doors the round had not closed.
 * ------------------------------------------------------------------------- */
/** `model/quotation.ts`, read as source — the declaration, not an instance. */
const MODEL_SOURCE = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, 'apps/web/src/components/model/quotation.ts');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    dir = dirname(dir);
  }
  throw new Error('model/quotation.ts not found');
})();

/** Every property an interface declares, by name, sorted. */
function declaredMembers(name: string): readonly string[] {
  const file = ts.createSourceFile('q.ts', MODEL_SOURCE, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.getText(file) === name) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) out.push(member.name.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (out.length === 0) throw new Error(`no interface named ${name}`);
  return out.sort();
}

/** Does `recordFingerprint`'s body read this field of the record? */
function fingerprintCovers(field: string): boolean {
  const body = MODEL_SOURCE.slice(MODEL_SOURCE.indexOf('export function recordFingerprint'));
  return new RegExp(`record\\.${field}\\b`).test(body.slice(0, 1200));
}

describe('the row and the register it renders against are the same register', () => {
  /* CATCHES the review's finding, exactly as it wrote it: `RoomFrame` takes the
     rows and the record register as INDEPENDENT props, so a row minted from
     lars's record can be rendered inside a ledger whose `m21` says priya. No
     cast, no forged field, and the body check passes because only the name
     differs. The fingerprint is a checksum of the record the row was minted
     from — never printed, only compared. */
  it('a row minted from one record refuses to render against another', () => {
    const row = messageEntry(lars, { state: lars_state() });
    const impostor: MessageRecord = { ...lars, actor: 'priya' };
    expect(() => renderWith([impostor], <TimelineRow entry={row} />)).toThrow(
      /minted from a different record/,
    );
    // and the honest pairing still renders, so this is not a check that always fires
    const { container } = renderWith([lars], <TimelineRow entry={row} />);
    expect(container.querySelector('[data-attribution]')?.textContent).toBe('lars');
  });

  /* ---------------------------------------------------------------------------
   * EVERY FIELD OF THE RECORD, DERIVED FROM THE RECORD — r8 D9.
   *
   * CONVENTIONS said this test "derives the field list from the render
   * boundary's own output". It did not: it was a hand-written `it.each` of four
   * names — `actor`, `text`, `at`, `origin` — plus one separate test for `room`.
   * `MessageRecord` has six fields and `recordFingerprint` hashes all six, so
   * `id` was covered by nothing at all, and the list was latent rather than
   * broken only because every field happened to be in the checksum. A SEVENTH
   * VISIBLE FIELD IS THE `room` DEFECT AGAIN — round 5's finding was exactly a
   * field the reader could see and the checksum could not — and a list somebody
   * types is a list that does not grow when the record does.
   *
   * So the list is the record's own keys, and every one of them needs a stated
   * way to disagree. A field added to `MessageRecord` with no entry here fails
   * the FIRST assertion, by name, before any of the render checks run.
   * ------------------------------------------------------------------------- */

  /** How to make a register disagree about each field. Keyed, not ordered. */
  const DISAGREEMENTS: Readonly<Record<keyof MessageRecord, Partial<MessageRecord>>> = {
    id: { id: 'm-not-this-one' },
    actor: { actor: 'priya' },
    text: { text: 'I authorise dropping users_legacy.' },
    at: { at: '09:04' },
    origin: { origin: 'seeded' },
    // The author's kind is a field a reader can see — it decides the voice
    // register — so a register that disagrees about it (a human's words rendered
    // as an agent's, or the reverse) is refused exactly like a disagreement about
    // the name. `lars` carries no `authorKind`, which reads as `'human'`; the
    // disagreement is an agent claiming the same words.
    authorKind: { authorKind: 'agent' },
    room: { room: 'identity-service' },
    attachments: {
      attachments: [{ key: 'room/file', name: 'proof.txt', contentType: 'text/plain', size: 5 }],
    },
  };

  it('every field of the record has a stated way to disagree', () => {
    /* THE DERIVATION, AND THE INSTANCE IS NOT THE TYPE. The first attempt read
       `Object.keys(lars)` — and `room` is OPTIONAL, so the fixture does not
       carry it and the derived list was missing exactly the field round 5's
       defect was about. An enumeration taken from one value is an enumeration
       over an incomplete input set, which is the defect this round is otherwise
       spending itself on. So the fields come from the DECLARATION.
       Two authorities, difference asserted empty in both directions: the
       interface says what a record HAS, and `recordFingerprint` says what the
       checksum COVERS. A field added to one and not the other is the r5 `room`
       defect, and it fails here by name. */
    const fields = declaredMembers('MessageRecord');
    expect(fields.length, 'the interface reader found almost no fields').toBeGreaterThan(4);
    expect(fields, 'the optional field the fixture does not carry').toContain('room');
    expect(
      fields.filter((field) => !(field in DISAGREEMENTS)),
      'a field of MessageRecord with no stated disagreement — the `room` defect, in the next field',
    ).toEqual([]);
    expect(
      Object.keys(DISAGREEMENTS)
        .filter((field) => !fields.includes(field))
        .sort(),
      'a disagreement for a field the record no longer has',
    ).toEqual([]);
    expect(
      fields.filter((field) => !fingerprintCovers(field)),
      'a field of the record the checksum does not hash — two registers differing in it are one register',
    ).toEqual([]);
    /* …and every one of them changes the checksum, which is the property the
       whole register comparison rests on. */
    for (const [field, change] of Object.entries(DISAGREEMENTS)) {
      const impostor = { ...lars, ...change } as MessageRecord;
      expect(
        recordFingerprint(impostor),
        `the checksum cannot see a disagreement about ${field}`,
      ).not.toBe(recordFingerprint(lars));
    }
  });

  /* CATCHES: the fingerprint being computed over too little. Every field a
     reader can see has to be in it, or the register that disagrees about that
     field slips through. Driven off `DISAGREEMENTS`, whose completeness the test
     above derives from the record itself. */
  it.each(Object.entries(DISAGREEMENTS))(
    'a register that disagrees about %s is refused',
    (_field, change) => {
      const row = messageEntry(lars, { state: lars_state() });
      const impostor = { ...lars, ...change } as MessageRecord;
      /* Any of the three refusals is the right one — a disagreement about the
         WORDS trips the body derivation first, which is the older and more
         specific check, and a disagreement about the ID means the register holds
         no record under the row's citation at all. What must not happen is a
         render. */
      expect(() => renderWith([impostor], <TimelineRow entry={row} />)).toThrow(
        /minted from a different record|does not read as the message|is not a message on this page/i,
      );
    },
  );

  /* CATCHES: the row printing the caller's `id`/`at` rather than the record's.
     A brand-preserving spread needs no cast — `{...messageEntry(lars, …), id:
     'm2', at: '09:04'}` — and made the DOM cite one message while the name and
     the words came from another. Both are facts about the record now. */
  it('the rendered id and time come off the record, not off the row', () => {
    const row = messageEntry(lars, { state: lars_state() });
    const relabelled = { ...row, id: 'm10', at: '09:04' } as MessageEntry;
    const { container } = renderWith([lars, priya], <TimelineRow entry={relabelled} />);
    const rendered = container.querySelector('[data-row="message"]');
    expect(rendered?.getAttribute('data-message-id')).toBe('m21');
    expect(container.textContent).toContain('13:07');
    expect(container.textContent).not.toContain('09:04');
  });
});

/* ---------------------------------------------------------------------------
 * THE AGENT VOICE REGISTER — #101, AGENTS.md's "no synthesized speech" reached
 * from the author end.
 *
 * A person's words and an agent's words are both real, attributed and quotable;
 * what the rule forbids is rendering the machine's sentence AS a person's. So an
 * agent-authored row is painted in the machine register — the monospace body,
 * the worded kind, `data-author-kind` — and a human's row keeps the default
 * treatment. The two are never the same row. The kind is read off the record's
 * `authorKind`, so it rides the same re-derivation as the name and the words:
 * flip the field and the register moves; nothing carries it beside the record.
 * ------------------------------------------------------------------------- */
describe('an agent’s authored words render in the agent voice register, never a person’s', () => {
  const scribe: MessageRecord = {
    id: 'm-agent',
    at: '13:11',
    actor: 'atrium',
    text: 'I read the last twelve messages and nothing was settled.',
    origin: 'seeded',
    authorKind: 'agent',
  };

  it('marks the row a machine author, words the kind, and paints the body in the machine register', () => {
    const entry = messageEntry(scribe, { state: lars_state() });
    const { container } = renderWith([scribe], <TimelineRow entry={entry} />);

    const row = container.querySelector('[data-row="message"]');
    // the row itself says a machine authored it — the attribute replay and the
    // audit read, not the display name
    expect(row?.getAttribute('data-author-kind')).toBe('agent');

    // the kind is stated in a WORD, not left to a shape alone
    expect(container.querySelector('[data-author-kind-word]')?.textContent).toBe('agent');

    // the actor cell names the identity by the same attribute the roster does
    const actorCell = container.querySelector('[data-attribution="m-agent"]');
    expect(actorCell?.getAttribute('data-participant-kind')).toBe('agent');
    expect(actorCell?.textContent).toContain('atrium');

    // the words are in the machine register, and they are the AGENT's real words
    const body = container.querySelector('[data-author-voice="agent"]');
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain('nothing was settled');

    // and it is NOT the page's system voice — an agent speaks its own words, it
    // is not the interface reporting an act
    expect(container.querySelector('[data-voice="system"]')).toBeNull();
  });

  it('flip the author’s kind and the register moves — a human’s words carry none of it', () => {
    /* The same message, the same words, authored by a person: every agent marker
       is gone and the row is the plain human treatment. This is the acceptance
       test's "flip the input" at the unit the rendering logic lives in — the
       register is a function of `authorKind` and nothing else. */
    const asPerson: MessageRecord = { ...scribe, authorKind: 'human' };
    const entry = messageEntry(asPerson, { state: lars_state() });
    const { container } = renderWith([asPerson], <TimelineRow entry={entry} />);

    const row = container.querySelector('[data-row="message"]');
    expect(row?.getAttribute('data-author-kind')).toBeNull();
    expect(container.querySelector('[data-author-kind-word]')).toBeNull();
    expect(container.querySelector('[data-author-voice]')).toBeNull();
    expect(
      container
        .querySelector('[data-attribution="m-agent"]')
        ?.getAttribute('data-participant-kind'),
    ).toBe('human');
  });

  it('an agent row is never the same DOM as the same words from a person', () => {
    /* The invariant stated as a comparison: no agent-authored row is visually
       identical to a human-authored one. The machine markers are exactly the
       difference. */
    const agentRow = renderWith(
      [scribe],
      <TimelineRow entry={messageEntry(scribe, { state: lars_state() })} />,
    );
    const humanRecord: MessageRecord = { ...scribe, authorKind: 'human' };
    const humanRow = renderWith(
      [humanRecord],
      <TimelineRow entry={messageEntry(humanRecord, { state: lars_state() })} />,
    );
    const agentHtml = agentRow.container.querySelector('[data-row="message"]')?.outerHTML ?? '';
    const humanHtml = humanRow.container.querySelector('[data-row="message"]')?.outerHTML ?? '';
    expect(agentHtml).not.toBe(humanHtml);
    // and specifically by the register, not by some incidental difference
    expect(agentHtml).toContain('data-author-kind="agent"');
    expect(humanHtml).not.toContain('data-author-kind="agent"');
  });

  it('a cited agent message is quoted in the machine register, not the human one', () => {
    /* V75 through a citation: a reply line or a receipt that quotes an agent must
       not render its words in the human italic-quote register. `<Quoted>` reads
       the same `authorKind` and switches register, and names the kind on the
       source line. */
    const quotation = quotationFrom(scribe);
    expect(quotation).not.toBeNull();
    if (quotation === null) return;
    const { container } = renderWith([scribe], <Quoted quote={quotation} />);
    const quote = container.querySelector('q');
    expect(quote?.getAttribute('data-author-kind')).toBe('agent');
    expect(quote?.textContent).toContain('nothing was settled');
    // the source line names the kind, so the attribution is not a bare name that
    // reads as a person's
    expect(container.querySelector('[data-attribution]')?.textContent).toContain('· agent');
  });
});

/* ---------------------------------------------------------------------------
 * THE SECOND LINEAGE'S FINDINGS — the side channels the citation machine never
 * ran through.
 *
 * grok-4.5, reviewing the same fix blind and independently of gpt-5.6, went past
 * the row's display path (which it could not break) and found the places a
 * page-authored string still reaches the screen, or a real message id still
 * reaches an action, without passing the model at all.
 * ------------------------------------------------------------------------- */
describe('the side channels go through the same model as the row', () => {
  /* CATCHES: the action bus trusting `entry.id` after the renderer stopped
     trusting it. The row displayed lars's name and words while "reply" acted on
     whatever id the caller wrote on the entry — the display path was sealed and
     the product path was not. */
  it('a row action reports the message the row resolved, not the id it was handed', () => {
    const row = messageEntry(lars, { state: lars_state() });
    const relabelled = { ...row, id: 'm10' } as MessageEntry;
    const acted: string[] = [];
    const { container } = renderWith(
      [lars, priya],
      <TimelineRow
        actions={[{ id: 'reply', label: 'reply', onSelect: (id) => acted.push(id) }]}
        entry={relabelled}
      />,
    );
    const button = container.querySelector('[class*="acts"] button') as HTMLElement | null;
    expect(button, 'the row rendered no action').not.toBeNull();
    button?.click();
    expect(acted, 'the action fired on the id the caller wrote, not the record').toEqual(['m21']);
  });

  /* CATCHES: the row tag doing the same thing one control over. */
  it('a row tag reports the resolved message too', () => {
    const row = messageEntry(lars, {
      state: lars_state(),
      tag: { label: 'claim · unverified', tone: 'neutral' },
    });
    const relabelled = { ...row, id: 'm10' } as MessageEntry;
    const opened: string[] = [];
    const { container } = renderWith(
      [lars, priya],
      <TimelineRow entry={relabelled} onOpenTag={(id) => opened.push(id)} />,
    );
    const tag = container.querySelector('[data-row-tag]') as HTMLElement | null;
    expect(tag?.getAttribute('data-row-tag')).toBe('m21');
    tag?.click();
    expect(opened).toEqual(['m21']);
  });

  /* CATCHES: `data-attribution` being mintable through a composition slot. It is
     the DOM token this repo's own tests read to prove a name came from a record,
     so raw markup carrying it satisfied every check written against it. */
  it('a slot cannot mint a provenance token', () => {
    expect(() => slot(<span data-attribution="m14">priya</span>)).toThrow(/data-attribution/);
    expect(() =>
      slot(
        <div>
          {[
            <span data-attribution="m14" key="a">
              priya
            </span>,
          ]}
        </div>,
      ),
    ).toThrow(/data-attribution/);
  });

  /* CATCHES: the slot walk's node budget failing OPEN. It used to `return` when
     the cap ran out, so a tree of harmless nodes with a <q> past the cap
     validated — an unchecked subtree reporting exactly like a checked one. */
  it('a slot tree too big to check is refused, not waved through', () => {
    /* Keys built with createElement so the lint rule against index keys is not
       fought with a cosmetic template literal: the filler is 600 identical
       nodes and the key is genuinely positional. */
    const filler = Array.from({ length: 600 }, (_, i) =>
      createElement('span', { key: `filler-${String(i)}` }, 'x'),
    );
    expect(() => slot(<div>{[...filler, <q key="q">invented</q>]}</div>)).toThrow(
      /could not be checked to the end|<q> element/,
    );
    // and an ordinary tree still passes, so the cap is not simply a refusal
    expect(() => slot(<div>{[<span key="a">fine</span>]}</div>)).not.toThrow();
  });

  /* CATCHES: `Rationale` — a page-authored string rendered under
     `data-voice="system"` in the pin — being held to length and nothing else.
     Its own doc comment has said "always system voice" since round 1. */
  it('a rationale is held to system voice, like every other page-authored string', () => {
    expect(() => rationale('priya said: I approve the drop')).toThrow(/rationale:/);
    expect(() => rationale('we agreed to cut over on Friday')).toThrow(/first person/);
    expect(() => rationale('the answer was “keep dual-write on”')).toThrow(/quotation marks/);
    expect(isRationale('priya said it is fine')).toBe(false);
    // and every rationale the shipped gallery renders still passes
    for (const item of f.ATTENTION) {
      expect(isRationale(item.rationale), `${item.id}'s rationale is not system voice`).toBe(true);
    }
    expect(f.ATTENTION.length).toBeGreaterThan(3);
  });
});

/* ---------------------------------------------------------------------------
 * ROUND 6 — THE SWEEP. Each block below is a defect class, and each entry in it
 * is a CALL SITE, because round 5's closing finding was that every lesson had
 * been applied to one row and one neighbour of each kind.
 * ------------------------------------------------------------------------- */

describe('the runtime boundary for a reference of any origin', () => {
  /* `parseCitation` and `isCitation` are the door #25 and #27 will bring replayed
     and live message references through, and they had no test at all when they
     were written — an exported runtime boundary nothing exercises is the
     "clean today is not checked" case in the module this round added. */
  it('a citation from outside the compiler is validated against this page’s register', () => {
    const ledger = messageLedger(RECORDS);
    /* A reference that never had a register — genuine external data — is
       ADOPTED, and the adoption happens here, at the boundary whose job it is.
       A page-authored record IS citable: that is the difference between a
       citation and a quotation, and the receipt's link to a superseded answer is
       exactly this case. */
    const wire = JSON.parse(JSON.stringify({ messageId: 'm-chosen' }));
    const parsed = parseCitation(wire, ledger);
    expect(Object.keys(parsed).sort()).toEqual(['messageId', 'mintedFrom']);
    expect(parsed.mintedFrom).toBe(recordFingerprint(chosen));
    expect(resolveCitation(ledger, parsed, 'test').actor).toBe('lars');
  });

  /* CATCHES THE PARSER LAUNDERING PROVENANCE — round 6's own defect, committed
     by round 6's own fix and found by the blind review of it.

     The first version of these parsers DISCARDED the incoming fingerprint and
     minted a fresh one from the destination ledger, on the reasoning that data
     crossing a process boundary is being adopted. The consequence is the exact
     cross-register forgery the checksum exists to refuse, reachable through the
     documented door: mint a citation against a register whose `m10` is priya,
     parse it against a register whose `m10` is lars, and it resolves to lars
     with no complaint. A laundering step in front of a checksum is worse than no
     checksum, because the checksum is what everything downstream then trusts. */
  it('the parser refuses a reference minted against a different register', () => {
    const here = messageLedger(RECORDS);
    const elsewhere = messageLedger([{ ...priya, actor: 'someone else' }]);
    const foreign = quotationFrom({ ...priya, actor: 'someone else' }) as Quotation;
    expect(resolveQuotation(elsewhere, foreign, 'test').actor).toBe('someone else');
    expect(() => parseQuotation(foreign, here)).toThrow(/minted from a different record/);
    expect(() => parseCitation(foreign, here)).toThrow(/minted from a different record/);
    /* …and the honest one still crosses, so the boundary is not simply closed. */
    const honest = quotationFrom(priya) as Quotation;
    expect(parseQuotation(honest, here).mintedFrom).toBe(recordFingerprint(priya));
  });

  it('a citation this page has never seen is refused outright', () => {
    const ledger = messageLedger(RECORDS);
    expect(() => parseCitation({ messageId: 'nope' }, ledger)).toThrow(/not a citation/);
    expect(() => parseCitation({}, ledger)).toThrow(/not a citation/);
    expect(isCitation({ messageId: 'nope' }, ledger)).toBe(false);
    expect(isCitation({ messageId: 'm-chosen' }, ledger)).toBe(true);
    /* …and a quotation is strictly narrower: a page-authored record is citable
       and not quotable, which is the whole reason both doors exist. */
    expect(isQuotation({ messageId: 'm-chosen' }, ledger)).toBe(false);
  });
});

describe('two registers in one tree', () => {
  /* CATCHES: `<AttributionLedger>` nesting silently taking the inner one. React
     context is designed to shadow, which is right for a theme and wrong for the
     one value on the page whose whole job is being the single source of truth
     about who wrote what — the outer rows and the inner rows would resolve the
     same id against different records with nothing reporting it. */
  it('nesting a second record register is refused rather than shadowing the first', () => {
    const other: MessageRecord = { ...lars, actor: 'priya' };
    expect(() =>
      render(
        <AttributionLedger messages={[lars]} room="users-migration">
          <AttributionLedger messages={[other]} room="users-migration">
            <span>anything</span>
          </AttributionLedger>
        </AttributionLedger>,
      ),
    ).toThrow(/already inside a record register/);
  });

  /* …and one ledger is still one ledger: the check is about a SECOND register,
     not about being inside one at all. */
  it('a single register renders', () => {
    const quotation = quotationFrom(lars) as Quotation;
    const { container } = renderWith([lars], <Quoted quote={quotation} />);
    expect(container.querySelector('q')?.textContent).toBe(lars.text);
  });
});

describe('the chosen arm derives its facts too', () => {
  /* CATCHES: `ChosenRow` printing caller-supplied `entry.id` and `entry.at`.
     Round 5 rebuilt the AUTHORED arm so both came off the record and left this
     arm printing the copies — the one arm that cannot forge a NAME could still
     forge WHICH MESSAGE the row cites, and that id went straight into
     `onOpenTag`. A copy of a fact is a second source of truth for it, on both
     arms. */
  it('the rendered id and time of a page-authored row come off the record', () => {
    const chosenRecord = f.MESSAGES['m-chosen'] as MessageRecord;
    const row = messageEntry(chosenRecord, { state: lars_state() });
    const relabelled = { ...row, id: 'm10', at: '09:04' } as MessageEntry;
    const { container } = renderWith(f.RECORDS, <TimelineRow entry={relabelled} />);
    const rendered = container.querySelector('[data-row="message"]');
    expect(rendered?.getAttribute('data-message-id')).toBe('m-chosen');
    expect(rendered?.getAttribute('data-origin')).toBe('chosen');
    expect(container.textContent).toContain('13:09');
    expect(container.textContent).not.toContain('09:04');
  });

  /* CATCHES: the chosen arm resolving nothing — a citation the register never
     saw, or one whose record turns out to be somebody's own words. */
  it('a chosen row whose citation the register cannot resolve does not render', () => {
    const chosenRecord = f.MESSAGES['m-chosen'] as MessageRecord;
    const row = messageEntry(chosenRecord, { state: lars_state() });
    expect(() => renderWith([lars], <TimelineRow entry={row} />)).toThrow(
      /is not a message on this page/,
    );
    cleanup();
    /* And a chosen ROW over a typed RECORD is refused: the arms are not
       interchangeable just because both carry a message id. */
    const swapped = {
      ...(row as unknown as Record<string, unknown>),
      citation: citationFrom(lars),
    } as unknown as MessageEntry;
    expect(() => renderWith([lars], <TimelineRow entry={swapped} />)).toThrow(
      /renders it as a page-authored answer/,
    );
  });
});

describe('the slot denylist sees the spelling the platform produces', () => {
  /* CATCHES: `ATTRIBUTED_TAGS.has(node.type)` without folding. `createElement('Q',
     …)` renders a `<q>`; HTML tag names are case-insensitive and the denylist
     was not. */
  it('an uppercase intrinsic tag is still an intrinsic tag', () => {
    for (const tag of ['Q', 'BLOCKQUOTE', 'Cite']) {
      expect(() => slot(createElement(tag, null, 'words priya never wrote'))).toThrow(
        /may not carry attributed markup/,
      );
    }
  });

  /* CATCHES: the prop denylist matching only the exact spelling. HTML lowercases
     attribute names, so `data-Quoted` reaches the DOM as `data-quoted` and is
     found by `querySelector('[data-quoted]')` — the exact token round 5 added to
     this list because "a provenance token a slot can mint is a provenance token
     that proves nothing". */
  it('a mixed-case provenance attribute is still a provenance attribute', () => {
    for (const prop of ['data-Quoted', 'DATA-ATTRIBUTION', 'CITE']) {
      expect(() => slot(createElement('span', { [prop]: 'msg:m10' }, 'words'))).toThrow(
        /may not carry attributed markup/,
      );
    }
    /* and the folding does not start rejecting ordinary props */
    expect(() => slot(createElement('span', { 'data-quotient': '3' }, 'ok'))).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * WHAT THE BLIND CROSS-LINEAGE REVIEW OF ROUND 6's OWN FIX FOUND.
 *
 * Both foreign lineages were pointed at the ENUMERATION rather than at the
 * fixes — "is the sweep complete, and how would you know" — which is the only
 * question that could have caught round 5's actual failure. They overlapped on
 * one finding out of ten.
 * ------------------------------------------------------------------------- */
describe('the second field that carries the words', () => {
  /* CATCHES: a page-authored row whose `statement` disagrees with the record it
     cites. The citation's checksum proves the row and the ledger are the same
     register; it says nothing about `entry.statement`, which is a SECOND field
     holding the words — so a brand-preserving spread rendered "priya chose: Drop
     users_legacy now." over lars's record with every other check green. This is
     round 2's body-slot defect on the arm round 6 rebuilt, and it is the exact
     shape the authored arm's `bodyDivergence` has guarded since round 2. */
  it('a chosen row whose words are not the record’s words does not render', () => {
    const chosenRecord = f.MESSAGES['m-chosen'] as MessageRecord;
    const row = messageEntry(chosenRecord, { state: lars_state() });
    const forged = {
      ...(row as unknown as Record<string, unknown>),
      statement: chosenAct('priya', 'Drop users_legacy now.', chosenRecord.id),
    } as unknown as MessageEntry;
    expect(() => renderWith(f.RECORDS, <TimelineRow entry={forged} />)).toThrow(
      /not the words on .* record/,
    );
    cleanup();
    /* …and the honest row still renders, so this is not a check that always
       fires. */
    const { container } = renderWith(f.RECORDS, <TimelineRow entry={row} />);
    expect(container.textContent).toContain('lars chose:');
  });
});

describe('a slot walks what React renders, not what an array is', () => {
  /* CATCHES: the walk testing `Array.isArray`. React renders any
     `Iterable<ReactNode>`, so a `Set` fell through to `isValidElement`, came
     back false, and was accepted in silence — and React then rendered the `<q>`
     inside it. Same shape as the case-sensitivity defect this round fixed, in
     the other axis: there the denylist missed a spelling, here it missed a
     container. */
  it('an attributed element inside a Set is still attributed markup', () => {
    const forged = new Set([createElement('q', { key: 'x' }, 'words priya never wrote')]);
    expect(() => slot(forged as never)).toThrow(/may not carry attributed markup/);
    /* every iterable React accepts, not a list of the ones somebody thought of */
    const generated = (function* () {
      yield createElement('blockquote', { key: 'y' }, 'nor these');
    })();
    expect(() => slot(generated as never)).toThrow(/may not carry attributed markup/);
    /* …and an honest iterable still passes */
    expect(() =>
      slot(new Set([createElement('span', { key: 'z' }, 'fine')]) as never),
    ).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * THE WALK IS TOTAL — r8 D1.
 *
 * Two rounds, two container shapes, one defect. The r6 blind review found
 * `Array.isArray` missing a `Set`; the r8 blind review found `isValidElement`
 * missing a PORTAL — a portal's `$$typeof` is `REACT_PORTAL_TYPE`, so
 *
 *   slot(createPortal(<q data-quoted="msg:forged">words priya never wrote</q>, host))
 *
 * validated while React rendered the `<q>`, minting the exact provenance token r5
 * added to the prop denylist because "a provenance token a slot can mint is a
 * provenance token that proves nothing".
 *
 * A WALK THAT RECURSES ON RECOGNISED SHAPES AND RETURNS ON THE REST IS AN
 * ALLOWLIST THAT FAILS OPEN, and patching it one container at a time builds a
 * denylist of the containers somebody happened to think of. So the walk now
 * answers for every shape `ReactNode` can be and refuses the rest — and this
 * block is the enumeration that makes "the rest" a bounded claim rather than a
 * hope. It enumerates FROM React's own `ReactNode` union, member by member.
 * ------------------------------------------------------------------------- */
describe('a slot walks every shape React renders, and refuses the shapes it does not', () => {
  /** Every refusal `slot()` can raise — the markup denylists and the two voices
      of the string door. Matching on the union is what keeps this block about
      "was it checked at all", which is the question the walk answers. */
  const REFUSED = /may not carry attributed markup|no "X said"|no first person|no quotation marks/;

  const NODE_SHAPES: readonly {
    readonly what: string;
    readonly clean: () => unknown;
    readonly forged: (() => unknown) | null;
  }[] = [
    { what: 'null', clean: () => null, forged: null },
    { what: 'undefined', clean: () => undefined, forged: null },
    { what: 'boolean', clean: () => true, forged: null },
    { what: 'number', clean: () => 41, forged: null },
    { what: 'bigint', clean: () => 41n, forged: null },
    {
      what: 'string',
      clean: () => 'Drop users_legacy at cutover rather than after the retention window',
      forged: () => 'priya said the drop is fine',
    },
    {
      what: 'element',
      clean: () => createElement('span', null, 'fine'),
      forged: () => createElement('q', { 'data-quoted': 'msg:forged' }, 'words priya never wrote'),
    },
    {
      what: 'array',
      clean: () => [createElement('span', { key: 'a' }, 'fine')],
      forged: () => [createElement('q', { key: 'a' }, 'words priya never wrote')],
    },
    {
      what: 'Set',
      clean: () => new Set([createElement('span', { key: 'a' }, 'fine')]),
      forged: () => new Set([createElement('q', { key: 'a' }, 'words priya never wrote')]),
    },
    {
      what: 'generator',
      clean: () =>
        (function* () {
          yield createElement('span', { key: 'a' }, 'fine');
        })(),
      forged: () =>
        (function* () {
          yield createElement('q', { key: 'a' }, 'words priya never wrote');
        })(),
    },
    {
      what: 'portal',
      clean: () => createPortal(createElement('span', null, 'fine'), document.createElement('div')),
      forged: () =>
        createPortal(
          createElement('q', { 'data-quoted': 'msg:forged' }, 'words priya never wrote'),
          document.createElement('div'),
        ),
    },
  ];

  /* CATCHES: the walk returning on a shape instead of descending into it. Every
     member that can HOLD content is exercised in both directions, so a container
     the walk stops at fails here rather than two rounds later. */
  it.each(NODE_SHAPES)('answers for a $what', ({ clean, forged }) => {
    expect(() => slot(clean() as never)).not.toThrow();
    if (forged !== null) expect(() => slot(forged() as never)).toThrow(REFUSED);
  });

  /* CATCHES the r8 defect at its own address with REACT as the witness rather
     than an assertion about the walk: the forged token has to be absent from the
     document. A portal renders outside the host's subtree, which is exactly why
     `container.innerHTML` is not the question to ask. */
  it('a portal cannot carry a forged provenance token into the document', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      expect(() =>
        slot(
          createPortal(
            createElement('q', { 'data-quoted': 'msg:forged' }, 'words priya never wrote'),
            host,
          ),
        ),
      ).toThrow(/<q> element/);
      /* …and an honest portal still renders. This is not a refusal of portals:
         the walk has an opinion about a portal's CONTENT and none about its
         destination, which is a live DOM node and never was a claim `slot()`
         made. */
      const ok = slot(createPortal(createElement('span', null, 'fine'), host));
      render(<div>{ok.node}</div>);
      expect(host.textContent).toBe('fine');
      expect(document.querySelector('[data-quoted]')).toBe(null);
    } finally {
      host.remove();
    }
  });

  /* CATCHES: the fall-through coming back. None of these is a `ReactNode` —
     React itself throws on each — so before r8 they reached `isValidElement`,
     came back false, and were reported CLEAN by a walk whose entire job is
     saying whether a tree was checked. A value nothing walked is a value nothing
     validated, which is the rule the node budget already fails closed on. */
  const NOT_NODES: readonly { readonly what: string; readonly value: unknown }[] = [
    { what: 'a plain object', value: { text: 'words priya never wrote' } },
    { what: 'a Date', value: new Date(0) },
    { what: 'a class instance', value: new (class Forged {})() },
    { what: 'a function', value: () => createElement('q', null, 'words priya never wrote') },
    { what: 'a WeakMap', value: new WeakMap() },
  ];
  it.each(NOT_NODES)('refuses $what rather than returning on it', ({ value }) => {
    expect(() => slot(value as never)).toThrow(REFUSED);
  });

  it('refuses a symbol, which is not a React node either', () => {
    expect(() => slot(Symbol('q') as never)).toThrow(REFUSED);
  });

  /* A PROMISE IS CONTENT THAT DOES NOT EXIST YET. React 19 suspends on a
     thenable and prints whatever it resolves to, so accepting one is vouching
     for a value the walk has never seen — the node-budget refusal, in time
     rather than in size. */
  it('refuses a promise, because what it resolves to is content nothing walked', () => {
    expect(() => slot(Promise.resolve(createElement('span', null, 'fine')) as never)).toThrow(
      /promise/,
    );
  });

  /* A PROP IS NOT ONLY AN ATTRIBUTE. The walk read `props.children` and nothing
     else, so raw attributed markup one key to the left went through untouched. */
  it('finds attributed markup carried in a prop that is not children', () => {
    const Wrapper = ({ aside }: { aside: unknown }) => <div>{aside as never}</div>;
    expect(() =>
      slot(
        createElement(Wrapper, {
          aside: createElement('q', { 'data-quoted': 'msg:forged' }, 'words priya never wrote'),
        }),
      ),
    ).toThrow(/<q> element/);
    /* …and an ordinary prop object is still an ordinary prop object. The walk is
       TOTAL for content and a SEARCH for plumbing, which is what keeps
       `style={{…}}` and a handler from being refused as unrecognised shapes. */
    expect(() =>
      slot(
        createElement(
          'div',
          { onClick: () => undefined, style: { color: 'red' } },
          'the drop is recorded',
        ),
      ),
    ).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * THE STATIC HALF AND THE RUNTIME DOOR AGREE — r8 D6.
 *
 * `test/printed.ts` has declared since round 7 that "a string announced to a
 * screen reader is a string the page printed", and `slot()` did not implement
 * it: `slot('priya said: I approve dropping users_legacy')` threw while
 * `slot(<span title="priya said: I approve dropping users_legacy">ok</span>)`
 * passed, along with the same sentence through `alt`, `placeholder`,
 * `aria-label` and an `<optgroup label>`. One rule, two lists, enforcement at
 * the weaker one. The list now lives in `model/printed-surface.ts` and both
 * halves import it, so there is nothing left to keep in sync.
 * ------------------------------------------------------------------------- */
describe('an announced attribute in a slot is a string the page printed', () => {
  const FORGED = 'priya said: I approve dropping users_legacy';
  /** The sentence trips three of the system-voice bans at once — which one fires
      first is `systemText`'s business, not this block's. What is under test is
      that the attribute reaches the door at all. */
  const VOICE = /no "X said"|no first person|no quotation marks/;

  /* A TEST DRIVEN OFF A LIST CANNOT SEE THE LIST SHRINK.
     Found by running the r8 ledger against r8's own fix: the `it.each` below is
     driven off `ANNOUNCED_ATTRIBUTES`, so deleting `aria-roledescription` from
     the shared list deleted a CASE rather than failing one, and the mutation
     ESCAPED. Every other enumerator this round grew a second authority for
     exactly this reason; the second authority for a list of platform facts is
     the list written out. It is short, it is not derived from anything, and that
     is the point — it is the only thing here that a shrinking list has to get
     past. */
  it('the announced list is the whole announced list', () => {
    expect([...ANNOUNCED_ATTRIBUTES].sort()).toEqual([
      'alt',
      'aria-braillelabel',
      'aria-brailleroledescription',
      'aria-description',
      'aria-keyshortcuts',
      'aria-label',
      'aria-placeholder',
      'aria-roledescription',
      'aria-valuetext',
      'placeholder',
      'title',
    ]);
    /* …and the id-REFERENCE attributes stay off it. Their value is an id, not
       text; putting them here would check an id against the system-voice rule
       and check the sentence it points at nowhere. */
    for (const reference of ['aria-labelledby', 'aria-describedby', 'aria-details']) {
      expect(ANNOUNCED_ATTRIBUTES, `${reference} is a reference, not text`).not.toContain(
        reference,
      );
    }
  });

  /* CATCHES: the runtime door checking content and not attributes. Driven off
     the SHARED list rather than four names typed here, so an attribute added to
     the sweep is an attribute this refuses on the same commit. */
  it.each([...ANNOUNCED_ATTRIBUTES])('refuses a forged sentence in %s', (attribute) => {
    expect(() => slot(createElement('span', { [attribute]: FORGED }, 'ok'))).toThrow(VOICE);
    /* BOTH DIRECTIONS: the page's own voice still goes through. */
    expect(() =>
      slot(createElement('span', { [attribute]: 'the drop is recorded' }, 'ok')),
    ).not.toThrow();
  });

  /* …and the tag-scoped ones, on the elements the platform actually paints them
     on. `<optgroup label>` is the shape the r8 review named. */
  it.each([
    ['optgroup', 'label'],
    ['option', 'label'],
    ['option', 'value'],
    ['input', 'value'],
  ])('refuses a forged sentence in <%s %s>', (tag, attribute) => {
    expect(() => slot(createElement(tag, { [attribute]: FORGED }))).toThrow(VOICE);
  });

  /* BOTH DIRECTIONS at the list's edge: an attribute nothing announces is not
     held to the rule, because a sink set that grows to every attribute stops
     being a claim about what a reader receives. `data-*` IS printable — by a CSS
     rule using `content: attr(…)` — and the sweep derives that set from the
     stylesheets rather than trusting this sentence. */
  it('does not hold an attribute nothing announces to the announced rule', () => {
    expect(() =>
      slot(createElement('span', { className: FORGED, 'data-note': FORGED }, 'ok')),
    ).not.toThrow();
  });

  /* HTML FOLDS ATTRIBUTE NAMES, and this comparison folds — the round-6
     case-sensitivity finding, in the axis of the attribute rather than the tag. */
  it('folds the attribute name, because the platform does', () => {
    expect(() => slot(createElement('span', { TITLE: FORGED }, 'ok'))).toThrow(VOICE);
    expect(() => slot(createElement('span', { 'aria-Label': FORGED }, 'ok'))).toThrow(VOICE);
  });
});
