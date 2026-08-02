import { describe, expect, it } from 'vitest';
import {
  type AttentionItem,
  addedBlockStructure,
  appendEvent,
  blockStructures,
  breakStructures,
  decideAcceptance,
  emptyState,
  objectStatement,
  type ProvenanceMessage,
  projectAttention,
  reconcileAttention,
  reduce,
  trustedContext,
  validateProposalProvenance,
} from '../src/index.js';
import { ALICE, at, BOB, event, model, ROOM } from './fixtures.js';

/**
 * **r12 — a guard on what an author wrote is anchored to what the author wrote.**
 *
 * Two findings, one shape each level of the campaign has now produced twice:
 * a check compared two things it was handed and was read as comparing one of
 * them to the world.
 *
 *  - The structure guards r10 and r11 built diff the statement against the
 *    **quote**, and `Proposal.quote` is a field the proposer writes beside
 *    `payload.statement`. Put the forgery in both and the multiset difference
 *    cancels to empty. The quote's own fidelity *is* checked against the body —
 *    twice — but both checks run through `normalizeForReceipt`, and that fold
 *    was designed to ignore exactly the dimension a structure guard depends on.
 *    Two mechanisms, each correct alone; the defect is the seam.
 *  - `mentionItems` declared an examination per *subject* it was handed, and an
 *    `ExaminedSubject` has the person taken out of it. One signal naming bob on
 *    an object concluded about that object for alice too.
 *
 * Everything here is driven through the real engine — `appendEvent` parses the
 * proposal, `decideAcceptance` judges it, `appendEvent` refuses the acceptance,
 * `reduce` replays the log — and judged on `state.objects`, because the returned
 * verdict is not the harm. The stored text is.
 */

function proposalEvent(input: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  cites: readonly string[];
  quote: string;
  at: string;
  confidence?: number;
}) {
  return event({
    id: `ev_${input.id}`,
    at: input.at,
    actor: model(),
    type: 'proposal_recorded',
    proposal: {
      id: input.id,
      roomId: ROOM,
      type: input.type,
      payload: input.payload,
      confidence: input.confidence ?? 0.95,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: [...input.cites],
      quote: input.quote,
      createdAt: input.at,
    },
  } as Parameters<typeof event>[0]);
}

function acceptEvent(input: {
  objectId: string;
  proposalId: string;
  type: string;
  payload: Record<string, unknown>;
  cites: readonly string[];
  at: string;
}) {
  return event({
    id: `ev_accept_${input.objectId}`,
    at: input.at,
    actor: model(),
    type: 'object_accepted',
    object: {
      id: input.objectId,
      roomId: ROOM,
      objectiveId: null,
      type: input.type,
      payload: input.payload,
      provenance: {
        messageIds: [...input.cites],
        proposalId: input.proposalId,
        interpretationId: null,
      },
      createdAt: input.at,
      updatedAt: input.at,
    },
  } as Parameters<typeof event>[0]);
}

/**
 * One proposal, all the way through: parsed, judged, accepted-at, replayed.
 *
 * The caller supplies `quote` and `statement` separately **because that is the
 * degree of freedom this round is about** — every structure test written before
 * r12 passed the message body as the quote, which is what a test author does
 * when the thing under test is the statement.
 */
function drive(input: { body: string; quote: string; statement: string }) {
  const messages: ProvenanceMessage[] = [
    { id: 'm1', authorId: ALICE, body: input.body },
    { id: 'm2', authorId: BOB, body: 'Got it, thanks for the heads-up.' },
  ];
  const payload = {
    statement: input.statement,
    claimant: ALICE,
    verification: 'unverified' as const,
  };
  const staged = proposalEvent({
    id: 'p1',
    type: 'claim',
    payload,
    cites: ['m1'],
    quote: input.quote,
    at: at(1),
  });
  const context = trustedContext({ actor: model(), messages });
  const recorded = appendEvent(emptyState(), staged.event, context);
  const proposal = recorded.state.proposals.p1?.proposal;
  if (!proposal) throw new Error('the proposal did not even parse');

  const accepted = acceptEvent({
    objectId: 'o1',
    proposalId: 'p1',
    type: 'claim',
    payload,
    cites: ['m1'],
    at: at(2),
  });
  const landed = appendEvent(recorded.state, accepted.event, context);
  const replayed = reduce([staged, accepted]);
  return {
    recorded: recorded.outcome,
    verdict: decideAcceptance(proposal, { messages }),
    stored: landed.state.objects.o1 ? objectStatement(landed.state.objects.o1.object) : null,
    replayed: replayed.objects.o1 ? objectStatement(replayed.objects.o1.object) : null,
    statements: Object.values(landed.state.objects).map((record) => objectStatement(record.object)),
  };
}

/** The problem kinds a proposal raises, without the engine around it. */
function kinds(input: { body: string; quote: string; statement: string }): string[] {
  return validateProposalProvenance(
    {
      type: 'claim',
      provenance: ['m1'],
      quote: input.quote,
      proposer: { kind: 'model' },
      attributedTo: ALICE,
      statement: input.statement,
    },
    [
      { id: 'm1', authorId: ALICE, body: input.body },
      { id: 'm2', authorId: BOB, body: 'Got it, thanks for the heads-up.' },
    ],
  ).map((problem) => problem.kind);
}

/* ─────────────────────────────────────────────────────────────────────────
 * §1 — the quote is a field the proposer writes
 * ───────────────────────────────────────────────────────────────────────── */

describe('r12 — the structure guards are anchored to the message, not to the quote', () => {
  /**
   * **The case two rounds of tests could not reach.** r10 and r11 each built a
   * guard, each wrote a table of attacks, and each supplied the message body as
   * the quote — so both tables drove the statement against an *honest* anchor
   * and neither could see that the anchor is an input. Here the proposer writes
   * the same forgery into `quote` and into `payload.statement`: the multiset
   * difference cancels, and on r11 every one of these is `auto_accept` and lands
   * in `state.objects` under Alice's name.
   *
   * **Catches**: anchoring either guard to `quote` again —
   * `addedLinkStructure(quote, statement)` /
   * `addedBlockStructure(quote, statement)`. Also catches dropping either guard
   * entirely, since the honest-anchor half of the separation is asserted below.
   */
  const forgeries: { label: string; body: string; forged: string }[] = [
    {
      label: 'a link whose text names the safe host and whose destination is the other one',
      body: 'Use https://safe.example and never https://evil.example for the runbook.',
      forged: 'Use [https://safe.example and never](https://evil.example) for the runbook.',
    },
    {
      label: 'the link title forged out of the author’s trailing warning',
      body: 'Read the runbook at https://safe.example do not run step 4.',
      forged: 'Read the runbook at [https://safe.example]( "do not run step 4").',
    },
    {
      label: 'a comparison re-broken into a block quote',
      body: 'Latency > 200ms is unacceptable for the search API.',
      forged: 'Latency\n> 200ms is unacceptable for the search API.',
    },
    {
      label: 'a section number re-broken into a heading',
      body: 'See section # 4 of the runbook before the deploy.',
      forged: 'See section\n# 4 of the runbook before the deploy.',
    },
    {
      label: 'a dash re-broken into a list item',
      body: 'Roll back the migration - the freeze starts at noon.',
      forged: 'Roll back the migration\n- the freeze starts at noon.',
    },
    {
      label: 'a pipe re-broken into a table row',
      body: 'Run the migration | the rollback is documented in the runbook.',
      forged: 'Run the migration\n| the rollback is documented in the runbook.',
    },
    {
      label: 'a colon and an indent re-broken into a code block',
      body: 'Do this before the freeze: run the migration script.',
      forged: 'Do this before the freeze:\n    run the migration script.',
    },
  ];

  // One `it`, seven inputs, for the reason r10's and r11's tables give: a
  // templated title cannot be named in the mutant ledger's `catches`.
  it('refuses a forgery the proposer wrote into the quote as well as the statement', () => {
    for (const attack of forgeries) {
      const forged = drive({ body: attack.body, quote: attack.forged, statement: attack.forged });
      expect(forged.recorded, attack.label).toBe('applied');
      expect(forged.verdict.rule, attack.label).toBe('provenance_failed');
      expect(forged.verdict.verdict, attack.label).toBe('discard');
      // A wrong receipt, not an unread window: this one *was* judged.
      expect(forged.verdict.about, attack.label).toBe('the_reading');
      // The refusal names the message it was read against, so a reader can go
      // and check it — and so this assertion fails if the anchor moves back.
      expect(forged.verdict.reason, attack.label).toContain('message "m1" does not');
      expect(forged.stored, attack.label).toBeNull();
      expect(forged.replayed, attack.label).toBeNull();
      expect(forged.statements, attack.label).toEqual([]);
    }
  });

  /**
   * The measured separation r11 had and r12 keeps: the same statement against an
   * honest quote was refused before this round too. If this goes red while the
   * test above stays green, the guards have been replaced by something that
   * refuses on a property of the *statement* alone.
   *
   * **Catches**: a guard rewritten to refuse any statement carrying structure,
   * which would pass every attack table in this file and refuse every ordinary
   * reading of a message that contains a list.
   */
  it('refuses the same forgery against an honest quote, as r10 and r11 already did', () => {
    for (const attack of forgeries) {
      const honest = drive({ body: attack.body, quote: attack.body, statement: attack.forged });
      expect(honest.verdict.verdict, attack.label).toBe('discard');
      expect(honest.stored, attack.label).toBeNull();
    }
  });

  /**
   * The false-refusal control, and it is the one the new anchor could break: the
   * anchor is the **whole body**, so an author who really wrote a link and a
   * list is quoted, restated, and lands.
   *
   * `bearing.body` is the *whole* body rather than `stripReplyBlockquotes(body)`
   * for r5's reason, quoted in `quoteCoversOwnText`: a machine cannot tell the
   * author quoting somebody from the author formatting an aside, so deleting
   * every `>` line from the anchor would refuse a statement reproducing one.
   * That choice is not observable through a quote, and this test learned it the
   * hard way rather than asserting it: a quote containing a `>` line never
   * reaches the anchor at all, because **authorship** is decided on the stripped
   * text and a quote that is not in any cited author's own words is
   * `quote_only_in_reply_blockquote` before any of this runs. The distinction is
   * live for a body whose blockquote sits *outside* the quoted span — which
   * `quoteCoversOwnText` then refuses as `quote_omits_surrounding_text`, a
   * `refer` rather than a `reject`. So the anchor is the body, the argument for
   * it is r5's, and the case that would separate it from the stripped text is
   * unreachable through the receipt today.
   *
   * **Catches**: anchoring to the empty string, or to the *statement* (which
   * would make the difference always empty), or a guard that refuses any
   * statement carrying structure.
   */
  it('leaves the author’s own markup alone, links and lists together', () => {
    const body =
      'Before the freeze:\n\n- read the [runbook](https://safe.example "step 4 is destructive")\n- verify the backfill';
    expect(kinds({ body, quote: body, statement: body })).not.toContain(
      'statement_adds_link_structure',
    );
    expect(kinds({ body, quote: body, statement: body })).not.toContain(
      'statement_adds_block_structure',
    );
    // …and one bullet, or one link, more than the author wrote is one too many.
    expect(kinds({ body, quote: body, statement: `${body}\n- and page the on-call` })).toContain(
      'statement_adds_block_structure',
    );
    expect(
      kinds({
        body,
        quote: body,
        statement: `${body} Also [the dashboard](https://evil.example).`,
      }),
    ).toContain('statement_adds_link_structure');
  });

  /**
   * **The invariant that says the anchoring is complete**: however the proposer
   * spaced the quote, an honest statement is judged the same. Before r12 the
   * quote's line structure and link punctuation *were* the guards' anchor, so
   * this was the attack surface; after it, no verdict depends on them at all.
   *
   * Measured rather than reasoned about, because the reasoning is not obvious:
   * `SENTENCE_BREAK` **does** split on line breaks, so a quote's line structure
   * is not inert by construction. It is inert because `sentencesOf` is only ever
   * applied to the *body* — `quoteSpansWholeSentences` tokenizes the quote with
   * `significant`, which drops whitespace, and `quoteCoversOwnText` never splits
   * at all.
   *
   * **Catches**: any repair that makes the quote-versus-body comparison
   * structure-sensitive instead of moving the anchor — which would refuse an
   * honest quote whose client re-wrapped it, the exact case the fold's
   * whitespace entry has the strongest argument for admitting. It is the design
   * this round considered and did not take, and this is what would have failed.
   */
  it('does not care how the proposer spaced the quote, only what the message says', () => {
    const body = 'Latency > 200ms is unacceptable for the search API. Bob agreed to the plan.';
    const reflowed =
      'Latency\n> 200ms is unacceptable for the search API.\n\nBob agreed to the plan.';
    const hardBroken = body.replace('. Bob', '.  \nBob');
    // An honest statement, against three spellings of the same quote.
    for (const quote of [body, reflowed, hardBroken]) {
      expect(kinds({ body, quote, statement: body })).toEqual([]);
    }
    // …and the statement is still judged against the message, not against
    // whichever of those the proposer chose to send.
    expect(kinds({ body, quote: reflowed, statement: reflowed })).toContain(
      'statement_adds_block_structure',
    );
  });

  /**
   * **Fail-closed when there is no message to anchor to.** When no cited message
   * bears the quote in its own text there is no author's text at all, so every
   * structure in the statement is unattributed and is reported. The proposal is
   * already rejected for `quote_not_found`; the point of the assertion is that
   * the guard does not *depend* on that — an invariant that holds only because
   * another check fired is the shape this campaign has now found four times.
   *
   * **Catches**: `if (bearing === null) skip` in place of `bearing?.body ?? ''`.
   */
  it('reports every structure in a statement no cited message bears', () => {
    const found = kinds({
      body: 'The freeze starts at noon on Friday.',
      quote: 'Something nobody in this window ever wrote down anywhere.',
      statement: 'Something nobody in this\n> window ever [wrote](https://evil.example) down.',
    });
    expect(found).toContain('quote_not_found');
    expect(found).toContain('statement_adds_block_structure');
    expect(found).toContain('statement_adds_link_structure');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * §2 — the structure a line ending makes
 * ───────────────────────────────────────────────────────────────────────── */

describe('r12 — a break with no marker on it is still structure the author did not write', () => {
  const BODY = 'Do not deploy on Friday. Bob agreed to the rollback plan.';

  /**
   * `blockStructures` reads line *beginnings*, so the two rendered breaks that
   * carry no marker were clean **even with an honest quote** — `blockOpener`
   * returns `null` for a blank line, correctly, because a blank line *ends* a
   * block; inserting one into a single paragraph *starts* a second. Both of
   * these are `auto_accept` on r11 with the quote set to the body.
   *
   * **Catches**: dropping `breakStructures` from `addedBlockStructure`.
   */
  it('refuses a paragraph break and a hard line break the author never wrote', () => {
    const paragraph = drive({
      body: BODY,
      quote: BODY,
      statement: 'Do not deploy on Friday.\n\nBob agreed to the rollback plan.',
    });
    expect(paragraph.verdict.verdict).toBe('discard');
    expect(paragraph.verdict.rule).toBe('provenance_failed');
    expect(paragraph.verdict.reason).toContain('blank line before');
    expect(paragraph.stored).toBeNull();

    const hard = drive({
      body: BODY,
      quote: BODY,
      statement: 'Do not deploy on Friday.  \nBob agreed to the rollback plan.',
    });
    expect(hard.verdict.verdict).toBe('discard');
    expect(hard.verdict.reason).toContain('hard line break after');
    expect(hard.stored).toBeNull();

    // …and forging the quote too does not buy the paragraph break either, which
    // is §1's finding meeting this one.
    const both = drive({
      body: BODY,
      quote: 'Do not deploy on Friday.\n\nBob agreed to the rollback plan.',
      statement: 'Do not deploy on Friday.\n\nBob agreed to the rollback plan.',
    });
    expect(both.verdict.verdict).toBe('discard');
    expect(both.stored).toBeNull();
  });

  /**
   * **The line this round drew, asserted as a disposition rather than left in
   * prose.** A blank line and a hard break are structure in every
   * CommonMark-family renderer. A *bare* newline is a space in CommonMark and a
   * `<br>` only under `breaks: true`, so reporting it would be this package
   * claiming a rendering it cannot know — and it would narrow the fold's
   * whitespace entry, which has the best argument of the four and which r11
   * refused to narrow.
   *
   * **Catches**: reporting a re-wrapped line as added structure — the
   * over-broad repair that would refuse every client that wraps a message
   * differently from the quote it produced. Also catches `LINE_BREAK_SPLIT`
   * losing its CRLF alternative, which reads one CRLF break as two and turns a
   * CRLF **soft wrap** into a paragraph break the author never wrote.
   *
   * That second one is a mutant this test *failed to catch* on its first
   * writing, and the escape is worth recording because the shape is this
   * round's own: the assertion used `\r\n\r\n`, which is the input a test
   * author reaches for when the subject is "CRLF". Both splitters agree on it —
   * consecutive blank lines collapse into one descriptor, so cutting the pair
   * into two line ends changes nothing that survives the collapse. **Only a
   * single `\r\n` separates them**, because only there does the spurious empty
   * line have a content line on both sides. Measured, not reasoned: with the
   * real splitter `breakStructures('a\r\nb')` is `[]` and `('a\r\n\r\nb')` is
   * one descriptor; the mutant cuts them to `['a','','b']` and
   * `['a','','','','b']`, which differ in the first case and not the second.
   */
  it('leaves a re-wrapped line and the author’s own breaks alone', () => {
    // A bare newline where the author put a space: allowed, and stated residue.
    expect(
      kinds({
        body: BODY,
        quote: BODY,
        statement: 'Do not deploy on Friday.\nBob agreed to the rollback plan.',
      }),
    ).not.toContain('statement_adds_block_structure');
    // The author's own paragraph break, reproduced.
    const paragraphed = 'Do not deploy on Friday.\n\nBob agreed to the rollback plan.';
    expect(kinds({ body: paragraphed, quote: paragraphed, statement: paragraphed })).not.toContain(
      'statement_adds_block_structure',
    );
    // …and flattened, which drops no word the author wrote.
    expect(kinds({ body: paragraphed, quote: paragraphed, statement: BODY })).not.toContain(
      'statement_adds_block_structure',
    );
    // **A single CRLF is a soft wrap, and this is the assertion that separates
    // the two splitters** — see the docblock. Under the class-only split the
    // spurious empty line sits between two content lines and reads as a
    // paragraph break, so an ordinary CRLF client is refused.
    expect(
      kinds({
        body: BODY,
        quote: BODY,
        statement: 'Do not deploy on Friday.\r\nBob agreed to the rollback plan.',
      }),
    ).not.toContain('statement_adds_block_structure');
    // …in the other direction too: the message is CRLF-wrapped and the
    // statement is not.
    expect(
      kinds({
        body: 'Do not deploy on Friday.\r\nBob agreed to the rollback plan.',
        quote: 'Do not deploy on Friday.\r\nBob agreed to the rollback plan.',
        statement: BODY,
      }),
    ).not.toContain('statement_adds_block_structure');
    // CRLF against LF is one line ending spelled two ways, not a new paragraph.
    // Kept, but it is not what catches the splitter — both spellings collapse a
    // blank run to one descriptor.
    const crlf = 'Do not deploy on Friday.\r\n\r\nBob agreed to the rollback plan.';
    expect(kinds({ body: crlf, quote: crlf, statement: paragraphed })).not.toContain(
      'statement_adds_block_structure',
    );
    expect(kinds({ body: paragraphed, quote: paragraphed, statement: crlf })).not.toContain(
      'statement_adds_block_structure',
    );
  });

  /**
   * **Catches**: a `breakStructures` that reports a break with nothing on one
   * side of it (a leading or trailing blank line renders nothing, and a hard
   * break at the end of a block is one CommonMark drops), that keys a
   * descriptor on nothing (so a paragraph break the author put *elsewhere*
   * would cancel this one), or that counts a tab as a hard break's two spaces.
   */
  it('reads a break as structure only where a renderer would', () => {
    expect(breakStructures('a\n\nb')).toEqual(['blank line before "b"']);
    expect(breakStructures('a\n\n\nb')).toEqual(['blank line before "b"']);
    expect(breakStructures('\n\na\nb')).toEqual([]);
    expect(breakStructures('a\nb\n\n')).toEqual([]);
    expect(breakStructures('a  \nb')).toEqual(['hard line break after "a"']);
    expect(breakStructures('a\\\nb')).toEqual(['hard line break after "a\\"']);
    // One space is a space; a tab is not two spaces.
    expect(breakStructures('a \nb')).toEqual([]);
    expect(breakStructures('a\t\nb')).toEqual([]);
    // The descriptor names what follows the break, so a break somewhere else
    // does not cancel it.
    expect(addedBlockStructure('a\n\nb c', 'a b\n\nc')).toEqual(['blank line before "c"']);
    expect(addedBlockStructure('a\n\nb c', 'a\n\nb c')).toEqual([]);
    // And the marker reader still sees only line beginnings — the two readers
    // are disjoint, which is what lets one difference cover both.
    expect(blockStructures('a\n\nb')).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * §3 — a signal that named bob concluded nothing about alice
 * ───────────────────────────────────────────────────────────────────────── */

describe('r12 — a mention is finished by the person, not by a cycle that named somebody else', () => {
  const OBJECT = 'obj_7';
  const mention = (userId: string, request: string) => ({
    roomId: ROOM,
    objectId: OBJECT,
    userId,
    request,
  });
  const statuses = (items: readonly AttentionItem[]): string[] =>
    [...items].map((entry) => `${entry.userId}:${entry.status}`).sort();

  /**
   * r10 made `mentionItems` declare an examination only for a subject it was
   * handed, which closed the empty case. It did not close the partial one: the
   * item id carries the user and the `ExaminedSubject` beside it did not, so one
   * signal about an object concluded about that object for everybody. No caller
   * mistake — an ordinary sliding window past the message that named alice while
   * a newer message on the same object names bob.
   *
   * **Catches**: `mentionItems` declaring an `ExaminedSubject` again.
   */
  it('does not resolve one person’s mention on a cycle whose signal named another', () => {
    const state = emptyState();
    const cycle1 = projectAttention(state, {
      now: at(1),
      mentions: [mention(ALICE, 'please confirm the rollback plan')],
    });
    const stored1 = reconcileAttention([], cycle1) as AttentionItem[];
    expect(statuses(stored1)).toEqual([`${ALICE}:pending`]);

    // The window slid past alice's message; a newer one on the same object names
    // bob. Nothing here concluded anything about alice.
    const cycle2 = projectAttention(state, {
      now: at(2),
      mentions: [mention(BOB, 'and can you review it')],
    });
    const stored2 = reconcileAttention(stored1, cycle2) as AttentionItem[];
    expect(statuses(stored2)).toEqual([`${ALICE}:pending`, `${BOB}:pending`]);

    // …and the window comes back. On r11 rule 1 pinned the resolved status here
    // and alice's item never returned.
    const cycle3 = projectAttention(state, {
      now: at(3),
      mentions: [
        mention(ALICE, 'please confirm the rollback plan'),
        mention(BOB, 'and can you review it'),
      ],
    });
    const stored3 = reconcileAttention(stored2, cycle3) as AttentionItem[];
    expect(statuses(stored3)).toEqual([`${ALICE}:pending`, `${BOB}:pending`]);

    // The control r10 built, unchanged: a cycle handed nothing resolves nothing.
    expect(
      statuses(reconcileAttention(stored1, projectAttention(state, { now: at(2), mentions: [] }))),
    ).toEqual([`${ALICE}:pending`]);
  });

  /**
   * The other half of the disposition, so "never resolved by absence" is not
   * mistaken for "never resolved". A mention leaves the panel by the person —
   * #6's one-click dismiss — and rule 1 keeps it settled through a cycle that
   * cannot see it.
   *
   * **Catches**: a repair that makes `reconcileAttention` preserve every stored
   * mention item's status unconditionally, which would also undo dismissal.
   */
  it('still lets the person finish it, and keeps it finished', () => {
    const state = emptyState();
    const cycle = projectAttention(state, {
      now: at(1),
      mentions: [mention(ALICE, 'please confirm the rollback plan')],
    });
    const pending = reconcileAttention([], cycle) as AttentionItem[];
    const dismissed = pending.map((entry) => ({ ...entry, status: 'dismissed' as const }));
    const blind = reconcileAttention(dismissed, projectAttention(state, { now: at(2) }));
    expect(statuses(blind as AttentionItem[])).toEqual([`${ALICE}:dismissed`]);
    const back = reconcileAttention(blind as AttentionItem[], cycle);
    expect(statuses(back as AttentionItem[])).toEqual([`${ALICE}:dismissed`]);
  });
});
