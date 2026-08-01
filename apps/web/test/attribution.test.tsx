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
  bodyText,
  chosenAct,
  chosenAnswer,
  citationFrom,
  isQuotation,
  isRationale,
  isSystemStatement,
  maybe,
  messageEntry,
  messageLedger,
  parseMessageRecord,
  parseQuotation,
  parseSystemStatement,
  quotationFrom,
  rationale,
  recordFingerprint,
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
    expect(container.querySelector('[data-quoted]')?.getAttribute('data-quoted')).toBe('msg:m17');
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
    const { container } = renderWith(RECORDS, <TimelineRow entry={entry} />);
    const cell = container.querySelector('[data-attribution="m10"]');
    expect(cell?.textContent).toBe('priya');
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
    const { container } = renderWith(RECORDS, <TimelineRow entry={entry} />);
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

  /* CATCHES: `RoomHead.surfaces` going back to `ReactNode`. It was the last
     composition hole in the frame taking the widest type React has — in the
     header of every room, above every conversation — so raw attributed markup
     could reach the screen there with no cast and no constructor. */
  it('the room head takes a slot, not a ReactNode', () => {
    /* The type is the first layer, and `@ts-expect-error` is not decoration:
       `pnpm typecheck` fails if this line ever starts compiling. It renders
       nothing at runtime, which is the second half of the same statement — raw
       markup does not reach the DOM through this prop. */
    const raw = render(
      // @ts-expect-error — `surfaces` is a Slot: raw markup does not compile.
      <RoomHead room={f.ROOM} surfaces={<b data-raw="true">raw</b>} />,
    );
    expect(raw.container.querySelector('[data-raw]')).toBeNull();
    cleanup();
    expect(() => render(<RoomHead room={f.ROOM} surfaces={slot(<q>invented words</q>)} />)).toThrow(
      /<q> element/,
    );
    const { container } = render(
      <RoomHead room={f.ROOM} surfaces={slot(<span data-surfaces="true">CONVERSATION</span>)} />,
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

  /* CATCHES: the fingerprint being computed over too little. Every field a
     reader can see has to be in it, or the register that disagrees about that
     field slips through. */
  it.each([
    ['the actor', { actor: 'priya' }],
    ['the words', { text: 'I authorise dropping users_legacy.' }],
    ['the time', { at: '09:04' }],
    ['the origin', { origin: 'seeded' as const }],
  ])('a register that disagrees about %s is refused', (_name, change) => {
    const row = messageEntry(lars, { state: lars_state() });
    const impostor = { ...lars, ...change } as MessageRecord;
    /* Either refusal is the right one — a disagreement about the WORDS trips the
       body derivation first, which is the older and more specific check. What
       must not happen is a render. */
    expect(() => renderWith([impostor], <TimelineRow entry={row} />)).toThrow(
      /minted from a different record|does not read as the message/,
    );
  });

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
        <AttributionLedger messages={[lars]}>
          <AttributionLedger messages={[other]}>
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
