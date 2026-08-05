import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_RULE_NAMES,
  type AttentionItem,
  addedBlockStructure,
  appendEvent,
  blockStructures,
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
import { ALICE, at, BOB, event, human, model, ROOM, UNCITED_TAIL } from './fixtures.js';

/**
 * **r11 — the destruction-and-silence limb.**
 *
 * Three findings and one shape, which is r10's shape one level up: a *consumer*
 * read a narrower fact as a wider one, and the wider reading was the destructive
 * one.
 *
 *  - `proposalItems` asked *"is this verdict `needs_you`?"* and decided *"did
 *    this cycle judge this proposal?"* — so a window that slid past one of two
 *    cited messages produced `discard / provenance_failed`, which is a fact
 *    about the window, and Bob's confirm was resolved forever by a cycle that
 *    could not see the message bearing it.
 *  - `blockingQuestionItems` asked *"is this subject in state?"* and decided
 *    *"has every producer of a `blocking_question` item concluded about it?"* —
 *    so a cycle handed no `questionMentions` resolved somebody's named question
 *    by absence, the slide `mentionItems` refuses.
 *  - `borne` asked *"do these two texts normalize alike?"* and decided *"this is
 *    the author's own sentence"* — r10's own sentence, at the other rule in the
 *    fold that can *build* structure: a statement may put a line break where its
 *    author put a space and land as a block quote, a heading or a list.
 *
 * Every test in this file fails on `fix/core-engine-r10` as committed. Each names
 * the mutation it catches, and every one of them is judged on stored state —
 * `state.objects`, the reconciled item's status — rather than on a returned
 * verdict, because the verdict is not the harm.
 */

const CAROL = 'user_carol';
const NOW = at(30);

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
      confidence: input.confidence ?? 0.9,
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
  actor: Parameters<typeof event>[0]['actor'];
}) {
  return event({
    id: `ev_accept_${input.objectId}`,
    at: input.at,
    actor: input.actor,
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

/* ─────────────────────────────────────────────────────────────────────────
 * §1 — a verdict about the window is not a judgement about the reading
 * ───────────────────────────────────────────────────────────────────────── */

describe('r11 — a cycle concludes about a proposal only when it judged one', () => {
  const BODY = 'Bob will run the backfill before the freeze on Friday.';
  /**
   * **Two citations, which is the whole point.** r10's own regression test cites
   * one, and one is exactly the boundary where r10's repair works: with the sole
   * citation gone the `cited` list is empty, every quote check is skipped, and
   * `unknown_message` at `refer` is the only finding — the `receipt_not_certifiable`
   * arm, which already refuses. With two, one survives, the quote checks *run*
   * over the survivor, and `quote_not_found` at `reject` shadows the referral.
   * The repo's own canonical fixture cites two (`fixtures.ts`, `prop_1`).
   */
  const CITES = ['m1', 'm2'] as const;
  const m1: ProvenanceMessage = { id: 'm1', authorId: CAROL, body: BODY };
  const m2: ProvenanceMessage = { id: 'm2', authorId: BOB, body: 'Ack, noted.' };
  /** Uncited, so cycle 1 clears `window_ends_at_the_citations`. */
  const m3: ProvenanceMessage = { ...UNCITED_TAIL, id: 'm3' };
  const full: ProvenanceMessage[] = [m1, m2, m3];
  /** The ordinary shape of "the room's last N messages", one slide on. */
  const slid: ProvenanceMessage[] = [m2, m3];
  const members = { [ROOM]: [ALICE, BOB, CAROL] };

  const staged = reduce([
    proposalEvent({
      id: 'p1',
      type: 'commitment',
      payload: { statement: BODY, owner: BOB, due: null, status: 'open' },
      cites: CITES,
      quote: BODY,
      at: at(1),
    }),
  ]);
  const ITEM = 'attn:user_bob:proposal:p1:owned_commitment';

  /**
   * **Catches**: deleting the `verdict.about === 'the_window'` guard from
   * `proposalItems`, which is r10's code exactly — `visibility !== 'needs_you'`
   * falling straight through to `conclude`.
   *
   * The sequence from the brief, end to end over three cycles and judged on the
   * reconciled status. On r10 cycle 2 reported **0 items and 0 refusals**, put
   * `owned_commitment:proposal:p1` in `examined`, and Bob's confirm was resolved
   * permanently — while `decideAcceptance` against the full window still said
   * `pending / needs_you / awaitingConfirmFrom: bob` and the proposal was still
   * `proposed`.
   */
  it('keeps a confirm pending when the window dropped one of two citations', () => {
    const cycle1 = projectAttention(staged, { now: NOW, messages: full, members });
    expect(cycle1.items.map((entry) => entry.id)).toEqual([ITEM]);
    let stored = reconcileAttention([], cycle1);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[ITEM, 'pending']]);

    // The cycle that could not see `m1`. `quote_not_found` at `reject` is what
    // comes back, so the fix cannot be a severity move: the finding is real, it
    // is just a finding about the survivors.
    const cycle2 = projectAttention(staged, { now: NOW, messages: slid, members });
    expect(cycle2.items).toEqual([]);
    expect(cycle2.examined).toEqual([]);
    expect(cycle2.refusals.map((refusal) => refusal.proposalId)).toEqual(['p1']);
    expect(cycle2.refusals[0]?.reason).toContain('fact about the window');
    stored = reconcileAttention(stored, cycle2);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[ITEM, 'pending']]);

    const cycle3 = projectAttention(staged, { now: NOW, messages: full, members });
    stored = reconcileAttention(stored, cycle3);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[ITEM, 'pending']]);

    // Nothing about the room changed, only what one cycle could see — which is
    // the reason resolving the item was wrong.
    expect(staged.proposals.p1?.status).toBe('proposed');
    const proposal = staged.proposals.p1?.proposal;
    if (!proposal) throw new Error('unreachable');
    const onTheRecord = decideAcceptance(proposal, { messages: full });
    expect(onTheRecord.visibility).toBe('needs_you');
    expect(onTheRecord.awaitingConfirmFrom).toBe(BOB);
  });

  /**
   * **Catches**: the same guard on a `decision`, whose fan-out means one blind
   * cycle resolves the whole room's items rather than one person's. Same
   * mechanism, wider blast radius, and it is the reason the repair is on the
   * dispatch rather than on the commitment branch.
   */
  it('keeps a whole room’s needs_decision pending across the same slide', () => {
    const STATEMENT = 'We ship the scaffold behind a flag, default off.';
    const d1: ProvenanceMessage = { id: 'm1', authorId: CAROL, body: STATEMENT };
    const d2: ProvenanceMessage = { id: 'm2', authorId: BOB, body: 'Works for me, thanks.' };
    const room = reduce([
      proposalEvent({
        id: 'p_dec',
        type: 'decision',
        payload: { statement: STATEMENT },
        cites: CITES,
        quote: STATEMENT,
        at: at(1),
      }),
    ]);
    const wide = { now: NOW, members };
    let stored = reconcileAttention(
      [],
      projectAttention(room, { ...wide, messages: [d1, d2, m3] }),
    );
    expect(stored.map((entry) => [entry.userId, entry.status])).toEqual([
      [ALICE, 'pending'],
      [BOB, 'pending'],
      [CAROL, 'pending'],
    ]);

    const blind = projectAttention(room, { ...wide, messages: [d2, m3] });
    expect(blind.items).toEqual([]);
    expect(blind.refusals).toHaveLength(1);
    stored = reconcileAttention(stored, blind);
    expect(stored.map((entry) => entry.status)).toEqual(['pending', 'pending', 'pending']);
  });

  /**
   * **Catches**: reading *every* `the_cited_messages` finding as a window fact —
   * the over-correction that closes rule 2 altogether. A quote that appears in
   * none of the messages it cites, **all of which were supplied**, is a wrong
   * receipt and a judgement about the reading, and a cycle that says so has
   * examined the proposal.
   */
  it('still concludes when the window held every citation and the receipt is wrong', () => {
    const wrong = reduce([
      proposalEvent({
        id: 'p_wrong',
        type: 'commitment',
        payload: { statement: BODY, owner: BOB, due: null, status: 'open' },
        cites: ['m2'],
        quote: BODY,
        at: at(1),
      }),
    ]);
    const cycle = projectAttention(wrong, { now: NOW, messages: full, members });
    expect(cycle.items).toEqual([]);
    expect(cycle.refusals).toEqual([]);
    expect(cycle.examined).toEqual([
      {
        class: 'owned_commitment',
        subjectKind: 'proposal',
        subjectId: 'p_wrong',
        producer: 'staged_proposal',
      },
    ]);

    // …and it resolves a stored item, which is rule 2 still working.
    const orphan: AttentionItem = {
      id: 'attn:user_bob:proposal:p_wrong:owned_commitment',
      roomId: ROOM,
      userId: BOB,
      objectId: 'p_wrong',
      subjectKind: 'proposal',
      class: 'owned_commitment',
      reason: { kind: 'commitment_confirm', statement: BODY },
      status: 'pending',
      createdAt: at(2),
    };
    expect(reconcileAttention([orphan], cycle).map((entry) => entry.status)).toEqual(['resolved']);
  });

  /**
   * **Catches**: `about` being written at a `problems.push` site rather than
   * derived, and the classification of any single kind drifting. The property is
   * asked of the finding, not of its name, and it is a *function* of the window:
   * the identical proposal produces `quote_not_found` about the reading against a
   * complete window and about the window against an incomplete one.
   */
  it('makes “about the window” a property of the finding, derived from the window', () => {
    const subject = {
      type: 'commitment' as const,
      provenance: [...CITES],
      quote: BODY,
      proposer: { kind: 'model' as const },
      attributedTo: BOB,
      statement: BODY,
    };
    const incomplete = validateProposalProvenance(subject, slid);
    const notFound = incomplete.find((problem) => problem.kind === 'quote_not_found');
    expect(notFound?.severity).toBe('reject');
    expect(notFound?.about).toBe('the_window');
    expect(incomplete.find((problem) => problem.kind === 'unknown_message')?.about).toBe(
      'the_window',
    );

    // The same finding, the same severity, a complete window: about the reading.
    const complete = validateProposalProvenance({ ...subject, provenance: ['m2'] }, full);
    const sameFinding = complete.find((problem) => problem.kind === 'quote_not_found');
    expect(sameFinding?.severity).toBe('reject');
    expect(sameFinding?.about).toBe('the_reading');

    // A finding read off the proposal alone never moves, whatever the window did.
    for (const window of [full, slid]) {
      const noQuote = validateProposalProvenance({ ...subject, quote: '' }, window);
      expect(noQuote.find((problem) => problem.kind === 'missing_quote')?.about).toBe(
        'the_reading',
      );
    }
  });

  /**
   * **Catches**: `judged`'s `about: 'the_reading'` becoming a lie — a receipt
   * finding that stops being `refer`, or a new verdict cell reachable past the
   * gate on an unread window.
   *
   * `decideAcceptance` asserts in prose that nothing below the receipt gate can
   * be reached with a citation the window missed, because `unknown_message` is
   * `refer` and `refer` returns. That is a claim about code that changes, so it
   * is measured: every rule name the type declares, driven against a window that
   * is missing a citation, and none of the post-gate cells may appear.
   */
  it('reaches no post-gate verdict with a window that missed a citation', () => {
    const postGate = ACCEPTANCE_RULE_NAMES.filter(
      (name) =>
        name !== 'missing_message_context' &&
        name !== 'provenance_failed' &&
        name !== 'receipt_not_certifiable',
    );
    const QUESTION = 'Who runs the backfill before the freeze?';
    const seen = new Set<string>();
    // Both shapes of an incomplete window: one cited message left (the quote
    // checks run over the survivor and `reject` shadows the referral) and none
    // left (they are skipped and the referral is all there is).
    for (const [label, cites] of [
      ['some', ['m1', 'm2']],
      ['none', ['m1']],
    ] as const) {
      for (const confidence of [0.1, 0.55, 0.65, 0.8, 0.99]) {
        for (const type of ['commitment', 'decision', 'claim', 'open_question', 'objective']) {
          const payload =
            type === 'commitment'
              ? { statement: BODY, owner: BOB, due: null, status: 'open' }
              : type === 'claim'
                ? { statement: BODY, claimant: CAROL, verification: 'unverified' }
                : type === 'open_question'
                  ? { question: QUESTION }
                  : type === 'objective'
                    ? { title: BODY }
                    : { statement: BODY };
          const id = `p_${label}_${type}_${confidence}`;
          const room = reduce([
            proposalEvent({
              id,
              type,
              payload,
              cites,
              quote: type === 'open_question' ? QUESTION : BODY,
              at: at(1),
              confidence,
            }),
          ]);
          const record = room.proposals[id];
          if (!record) continue;
          const verdict = decideAcceptance(record.proposal, { messages: slid });
          seen.add(verdict.rule);
          // …and every one of them says so, which is what `proposalItems` reads.
          expect(verdict.about, id).toBe('the_window');
        }
      }
    }
    // Both gate arms are exercised, so the claim is about a reached boundary
    // rather than about a loop that happened to produce one answer.
    expect([...seen].sort()).toEqual(['provenance_failed', 'receipt_not_certifiable']);
    for (const name of postGate) expect(seen.has(name)).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * §2 — one class, two producers, and only one of them owes the item
 * ───────────────────────────────────────────────────────────────────────── */

describe('r11 — a named question is not resolved by a cycle nobody told', () => {
  const QUESTION = 'Which migration order do we run before the freeze?';

  /** An open question and a claim, both accepted, so state holds both subjects. */
  function room(status: 'open' | 'answered' = 'open') {
    const CLAIM = 'The rollback needs somebody to own it before Friday.';
    const claimPayload = { statement: CLAIM, claimant: ALICE, verification: 'unverified' as const };
    return reduce([
      proposalEvent({
        id: 'p_q',
        type: 'open_question',
        payload: { question: QUESTION, status: 'open' },
        cites: ['m1'],
        quote: QUESTION,
        at: at(1),
      }),
      acceptEvent({
        objectId: 'obj_q',
        proposalId: 'p_q',
        type: 'open_question',
        payload: { question: QUESTION, status },
        cites: ['m1'],
        at: at(2),
        actor: human(ALICE),
      }),
      proposalEvent({
        id: 'p_claim',
        type: 'claim',
        payload: claimPayload,
        cites: ['m1'],
        quote: CLAIM,
        at: at(3),
      }),
      acceptEvent({
        objectId: 'obj_claim',
        proposalId: 'p_claim',
        type: 'claim',
        payload: claimPayload,
        cites: ['m1'],
        at: at(4),
        actor: human(ALICE),
      }),
    ]);
  }

  const NAMED = 'attn:user_alice:object:obj_q:blocking_question';

  /**
   * **Catches**: `blockingQuestionItems` declaring `producer: 'named_question'`
   * unconditionally alongside `'blocking_relation'` — which is r10's code, where
   * one declaration covered both halves of the class.
   *
   * The `question_names_you` producer reads no state at all. "No item for
   * `obj_q`" therefore has two readings and the caller cannot mark the
   * difference, so a cycle handed nothing must not resolve the item — the same
   * argument `mentionItems` was closed on, and the class control below is the
   * evidence the two behave alike.
   */
  it('keeps a question_names_you item pending across a cycle with no signal', () => {
    const state = room();
    const signalled = projectAttention(state, {
      now: NOW,
      questionMentions: [{ questionObjectId: 'obj_q', userId: ALICE }],
    });
    let stored = reconcileAttention([], signalled);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[NAMED, 'pending']]);

    // Nobody acted; the caller simply had no mention to hand this cycle.
    const quiet = projectAttention(state, { now: NOW, questionMentions: [] });
    expect(quiet.items).toEqual([]);
    expect(quiet.refusals).toEqual([]);
    // The subject is still declared — by the half that may declare it.
    expect(
      quiet.examined
        .filter((entry) => entry.subjectId === 'obj_q' && entry.class === 'blocking_question')
        .map((entry) => entry.producer),
    ).toEqual(['blocking_relation']);

    stored = reconcileAttention(stored, quiet);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[NAMED, 'pending']]);
    // …and again, because r8's tombstone rule pins whatever rule 2 decided.
    stored = reconcileAttention(stored, projectAttention(state, { now: NOW }));
    expect(stored.map((entry) => entry.status)).toEqual(['pending']);
  });

  /**
   * **Catches**: closing the hole by never declaring for `named_question` at
   * all, which would leave every named question owed forever and be a different
   * way of being wrong. When the subject stops being an open live question no
   * signal *could* raise an item about it, so the state half concludes for both
   * — one better than `mention`, whose subject never settles.
   */
  it('resolves it when the question itself is answered', () => {
    const open = room();
    let stored = reconcileAttention(
      [],
      projectAttention(open, {
        now: NOW,
        questionMentions: [{ questionObjectId: 'obj_q', userId: ALICE }],
      }),
    );
    expect(stored.map((entry) => entry.status)).toEqual(['pending']);

    const answered = projectAttention(room('answered'), { now: NOW, questionMentions: [] });
    expect(
      answered.examined
        .filter((entry) => entry.subjectId === 'obj_q' && entry.class === 'blocking_question')
        .map((entry) => entry.producer)
        .sort(),
    ).toEqual(['blocking_relation', 'named_question']);
    stored = reconcileAttention(stored, answered);
    expect(stored.map((entry) => entry.status)).toEqual(['resolved']);
  });

  /**
   * **Catches**: dropping the producer from `examinedKey`, or mapping
   * `question_blocks_commitment` to `named_question` in `PRODUCER_OF`. The
   * relation-driven half is *state*, so its own items are still resolved by
   * absence exactly as they were in r9 — the fix must not cost that.
   */
  it('still resolves a relation-driven blocking_question by absence', () => {
    const state = room();
    const blocked: AttentionItem = {
      id: 'attn:user_bob:object:obj_q:blocking_question',
      roomId: ROOM,
      userId: BOB,
      objectId: 'obj_q',
      subjectKind: 'object',
      class: 'blocking_question',
      reason: { kind: 'question_blocks_commitment', question: QUESTION, commitment: 'land it' },
      status: 'pending',
      createdAt: at(5),
    };
    const cycle = projectAttention(state, { now: NOW });
    expect(cycle.items).toEqual([]);
    expect(reconcileAttention([blocked], cycle).map((entry) => entry.status)).toEqual(['resolved']);
  });

  /**
   * **Catches**: `producerOf` throwing or defaulting to a real producer for a
   * rationale this build does not know. `AttentionItem` is parsed at the
   * boundary and `reconcileAttention` takes anything shaped like one; a store
   * written by a newer version of this package is where an eleventh reason kind
   * comes from, and the fail-safe direction is to preserve the item.
   */
  it('preserves an item whose rationale this build does not recognise', () => {
    const rogue = {
      id: 'attn:user_bob:object:obj_q:blocking_question',
      roomId: ROOM,
      userId: BOB,
      objectId: 'obj_q',
      subjectKind: 'object',
      class: 'blocking_question',
      reason: { kind: 'question_from_the_future', question: QUESTION },
      status: 'pending',
      createdAt: at(5),
    } as unknown as AttentionItem;
    const cycle = projectAttention(room(), { now: NOW });
    expect(reconcileAttention([rogue], cycle).map((entry) => entry.status)).toEqual(['pending']);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * §3 — block structure spliced into a stored statement
 * ───────────────────────────────────────────────────────────────────────── */

describe('r11 — a statement may not add block structure its author never wrote', () => {
  /**
   * Each of these is `auto_accept` on r10 and lands in `state.objects` carrying
   * markup Alice never typed. `foldProse` collapses `\p{White_Space}+` to one
   * space in both directions, so a line break put where the author put a space
   * normalizes away and `borne` is true.
   *
   * **Catches**: deleting the `addedBlockStructure` check from
   * `validateProposalProvenance`. Judged on `state.objects` — the returned
   * verdict is not the harm, the stored text is.
   */
  const attacks: { label: string; body: string; statement: string }[] = [
    {
      label: 'a comparison becomes a block quote',
      body: 'Latency > 200ms is unacceptable for the search API.',
      statement: 'Latency\n> 200ms is unacceptable for the search API.',
    },
    {
      label: 'a section number becomes a heading',
      body: 'See section # 4 of the runbook before the deploy.',
      statement: 'See section\n# 4 of the runbook before the deploy.',
    },
    {
      label: 'a colon and an indent become a code block',
      body: 'Do this before the freeze: run the migration script.',
      statement: 'Do this before the freeze:\n    run the migration script.',
    },
    {
      label: 'a dash becomes a list item',
      body: 'Roll back the migration - the freeze starts at noon.',
      statement: 'Roll back the migration\n- the freeze starts at noon.',
    },
    {
      label: 'a pipe becomes a table row',
      body: 'Run the migration | the rollback is documented in the runbook.',
      statement: 'Run the migration\n| the rollback is documented in the runbook.',
    },
  ];

  // One `it`, five inputs, because a templated title cannot be named in the
  // mutant ledger's `catches` and this is the assertion the ledger points at.
  it('refuses a statement that re-breaks the author’s lines into markup', () => {
    for (const attack of attacks) {
      const messages: ProvenanceMessage[] = [
        { id: 'm1', authorId: ALICE, body: attack.body },
        { id: 'm2', authorId: BOB, body: 'Got it, thanks for the heads-up.' },
      ];
      const payload = {
        statement: attack.statement,
        claimant: ALICE,
        verification: 'unverified' as const,
      };
      const staged = proposalEvent({
        id: 'p_block',
        type: 'claim',
        payload,
        cites: ['m1'],
        quote: attack.body,
        at: at(1),
        confidence: 0.95,
      });

      const recorded = appendEvent(
        emptyState(),
        staged.event,
        trustedContext({ actor: model(), messages }),
      );
      expect(recorded.outcome, attack.label).toBe('applied');

      const proposal = recorded.state.proposals.p_block?.proposal;
      if (!proposal) throw new Error('unreachable');
      const verdict = decideAcceptance(proposal, { messages });
      expect(verdict.rule, attack.label).toBe('provenance_failed');
      expect(verdict.verdict, attack.label).toBe('discard');
      expect(verdict.reason, attack.label).toContain(
        'block structure its named author never wrote',
      );
      // A wrong receipt, not an unread window: this one *was* judged.
      expect(verdict.about, attack.label).toBe('the_reading');

      // …and the reducer refuses the model acceptance too, so the two gates do
      // not disagree about one receipt.
      const landed = appendEvent(
        recorded.state,
        acceptEvent({
          objectId: 'obj_block',
          proposalId: 'p_block',
          type: 'claim',
          payload,
          cites: ['m1'],
          at: at(2),
          actor: model(),
        }).event,
        trustedContext({ actor: model(), messages }),
      );
      expect(landed.state.objects.obj_block, attack.label).toBeUndefined();
      expect(
        Object.values(landed.state.objects).map((record) => objectStatement(record.object)),
        attack.label,
      ).toEqual([]);
    }
  });

  /**
   * **Catches**: a guard that refuses *any* block marker in a statement rather
   * than block structure the quote does not carry. An author who really wrote a
   * list, quoted and restated verbatim, is an ordinary reading and must still
   * pass — and a statement that has *fewer* line breaks than the quote drops no
   * word the author wrote, which is the direction `addedLinkStructure` also
   * leaves alone.
   */
  it('leaves the author’s own block structure alone, in both directions', () => {
    const body = 'Before the freeze:\n\n- run the migration\n- verify the backfill';
    const messages: ProvenanceMessage[] = [
      { id: 'm1', authorId: ALICE, body },
      { id: 'm2', authorId: BOB, body: 'Thanks, that is the order I had too.' },
    ];
    const kinds = (statement: string): string[] =>
      validateProposalProvenance(
        {
          type: 'claim',
          provenance: ['m1'],
          quote: body,
          proposer: { kind: 'model' },
          attributedTo: ALICE,
          statement,
        },
        messages,
      ).map((problem) => problem.kind);

    expect(kinds(body)).not.toContain('statement_adds_block_structure');
    // The same words with the author's own list flattened out of them.
    expect(kinds('Before the freeze: - run the migration - verify the backfill')).not.toContain(
      'statement_adds_block_structure',
    );
    // …and one bullet more than the author wrote is one too many.
    expect(kinds(`${body}\n- and page the on-call`)).toContain('statement_adds_block_structure');
  });

  /**
   * **Catches**: reading block markers where the fold would not — inside a code
   * segment, which `normalizeForReceipt` passes through byte for byte, and
   * mid-line, which opens nothing anywhere.
   */
  it('reads a block marker as a block marker only at a line beginning', () => {
    expect(blockStructures('a > b')).toEqual([]);
    expect(blockStructures('a\n> b')).toEqual(['> b']);
    // A code span consumes the line beginning that follows it.
    expect(blockStructures('`x` > b')).toEqual([]);
    // A fenced block's own delimiters count and the `>` inside it does not.
    expect(blockStructures('```\n> b\n```')).toEqual(['```', '```']);
    // Prose that merely starts with a marker character is not a block.
    expect(blockStructures('<3 the new runbook')).toEqual([]);
    expect(blockStructures('#hashtag please')).toEqual([]);
    expect(blockStructures('*emphasis* please')).toEqual([]);
    // Four columns of indent, and three that are not.
    expect(blockStructures('a\n    b')).toEqual(['    b']);
    expect(blockStructures('a\n   b')).toEqual([]);
    // Whitespace inside the line is the fold's to collapse, not a difference.
    expect(addedBlockStructure('a\n> b c', 'a\n>  b   c')).toEqual([]);
    // …and the marker that moved is the one reported.
    expect(addedBlockStructure('a - b', 'a\n- b')).toEqual(['- b']);
  });

  /**
   * **Catches**: reading fences out of the code-segment walk, which is what this
   * round's own probe of `blockStructures` found it doing. `CODE_SPAN`'s
   * double-backtick alternative eats the first two characters of a three-tick
   * opener and re-emits the rest as prose, so a fence was named in the block
   * inventory and invisible to the scanner reading it — a published list the
   * code cannot see, which is the failure the whole inventory is written against.
   */
  it('sees a code fence, which the code-segment walk cannot', () => {
    const tick = String.fromCharCode(96);
    expect(blockStructures(`a\n${tick.repeat(3)}js`)).toEqual([`${tick.repeat(3)}js`]);
    expect(blockStructures(`a\n${tick.repeat(3)}`)).toEqual([tick.repeat(3)]);
    expect(blockStructures('a\n~~~js')).toEqual(['~~~js']);
    // Mid-line, it opens nothing — and it cancels when the author wrote it.
    expect(blockStructures(`a ${tick.repeat(3)} b`)).toEqual([]);
    expect(addedBlockStructure(`a ${tick.repeat(3)} b`, `a\n${tick.repeat(3)} b`)).toEqual([
      `${tick.repeat(3)} b`,
    ]);
  });
});
