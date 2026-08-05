import { describe, expect, it } from 'vitest';
import {
  type AcceptedObjectRef,
  acceptedObjectRef,
  addedLinkStructure,
  appendEvent,
  decideAcceptance,
  emptyState,
  linkStructures,
  objectStatement,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  projectAttention,
  reconcileAttention,
  reduce,
  trustedContext,
  validateProposalProvenance,
} from '../src/index.js';
import { ALICE, at, BOB, event, human, model, ROOM } from './fixtures.js';

/**
 * **r10 — the instrument answered a narrower question than the decision it
 * drove.**
 *
 * Three findings, one shape. In each of them a check was correct about the
 * question it asked, and the question was smaller than the thing it decided:
 *
 *  - `findDuplicate` asked *"is this the same sentence?"* and decided *"destroy
 *    this reading, silently"* — so one message naming two people put one
 *    person's obligation on the record and deleted the other's, because the
 *    comparison's input had no field for who a reading was **about**.
 *  - `reconcileAttention` asked *"was this item computed?"* and decided *"is it
 *    finished?"* — so a cycle that could not compute an item marked it resolved
 *    forever, and an ordinary sliding window is enough to trigger it.
 *  - `borne` asked *"do these two texts normalize alike?"* and decided *"this is
 *    the author's own sentence"* — so a statement could add Markdown link
 *    structure built out of the author's own words and land as their words.
 *
 * Every test in this file fails on `fix/core-engine-r9` as committed. Each names
 * the mutation it catches; the source fixes are a type, a projection field and a
 * receipt check, not three more special cases.
 */

const CARL = 'user_carol';

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
 * §1 — a comparison that cannot see who a reading is about
 * ───────────────────────────────────────────────────────────────────────── */

describe('r10 — dedup consults the whole payload, not the sentence', () => {
  const BODY = 'Alice and Bob will each run the backfill before the Friday freeze.';
  const messages: ProvenanceMessage[] = [
    { id: 'm1', authorId: CARL, body: BODY },
    { id: 'm2', authorId: BOB, body: 'Sounds good, thanks for sorting that out.' },
  ];
  const commitmentFor = (owner: string) => ({
    statement: BODY,
    owner,
    due: null,
    status: 'open' as const,
  });

  /**
   * **Catches**: reverting `AcceptedObjectRef` to `{objectId, type, text,
   * messageIds}`, or dropping `payloadsMatch` from `findDuplicate`.
   *
   * The whole chain, machine-produced, judged on `state.objects` rather than on
   * a returned verdict. One message names two people; a person accepts the first
   * reading; the second is re-read on the next pass over the same window, which
   * is what #8's re-interpretation does. On r9 the second came back
   * `discard / duplicate_of_accepted` — `visibility: 'none'`, no proposal, no
   * attention item, no issue — so Bob was never asked and the room held Alice's
   * commitment and nothing else.
   */
  it('does not destroy a second person’s commitment drawn from one sentence', () => {
    let state = emptyState();
    for (const [index, owner] of [ALICE, BOB].entries()) {
      const staged = proposalEvent({
        id: `p_${owner}`,
        type: 'commitment',
        payload: commitmentFor(owner),
        cites: ['m1'],
        quote: BODY,
        at: at(index + 1),
      });
      const result = appendEvent(state, staged.event, trustedContext({ actor: model(), messages }));
      expect(result.outcome).toBe('applied');
      state = result.state;
    }

    const acceptedAlice = appendEvent(
      state,
      acceptEvent({
        objectId: 'obj_alice',
        proposalId: `p_${ALICE}`,
        type: 'commitment',
        payload: commitmentFor(ALICE),
        cites: ['m1'],
        at: at(3),
        actor: human(CARL),
      }).event,
      trustedContext({ actor: human(CARL), messages }),
    );
    expect(acceptedAlice.outcome).toBe('applied');
    state = acceptedAlice.state;

    // Exactly what a caller derives for the engine — through the one derivation
    // there is, so the tombstone fields cannot be forgotten on the way.
    const acceptedObjects = Object.values(state.objects).map(acceptedObjectRef);
    const bob = state.proposals[`p_${BOB}`]?.proposal;
    if (!bob) throw new Error('unreachable');

    const verdict = decideAcceptance(bob, { messages, acceptedObjects });
    expect(verdict.rule).not.toBe('duplicate_of_accepted');
    expect(verdict.duplicateOf).toBeNull();
    expect(verdict.awaitingConfirmFrom).toBe(BOB);

    // …and it reaches the record, which is the assertion that matters: the room
    // holds both obligations and Bob can be asked about his.
    const acceptedBob = appendEvent(
      state,
      acceptEvent({
        objectId: 'obj_bob',
        proposalId: `p_${BOB}`,
        type: 'commitment',
        payload: commitmentFor(BOB),
        cites: ['m1'],
        at: at(4),
        actor: human(BOB),
      }).event,
      trustedContext({ actor: human(BOB), messages }),
    );
    expect(acceptedBob.outcome).toBe('applied');
    const owners = Object.values(acceptedBob.state.objects).map((record) =>
      record.object.type === 'commitment' ? record.object.payload.owner : null,
    );
    expect(owners.sort()).toEqual([ALICE, BOB]);
    expect(acceptedBob.state.issues).toEqual([]);
  });

  /**
   * **Catches**: removing the `retractedAt` / `supersededById` guard from
   * `findDuplicate`, end to end. A retraction is the room saying *withdraw
   * this*; on r9 the tombstone went on matching, so the next pass over the same
   * window read the sentence again and the reading died against the thing it
   * would have restored — a retracted object could never be re-proposed.
   */
  it('lets a retracted reading be proposed again', () => {
    const CLAIM = 'The migration is reversible on every shard.';
    const claimMessages: ProvenanceMessage[] = [
      { id: 'm1', authorId: ALICE, body: CLAIM },
      { id: 'm2', authorId: BOB, body: 'Thanks, that is good to know.' },
    ];
    const payload = { statement: CLAIM, claimant: ALICE, verification: 'unverified' as const };

    const state = reduce([
      proposalEvent({
        id: 'p_claim',
        type: 'claim',
        payload,
        cites: ['m1'],
        quote: CLAIM,
        at: at(1),
      }),
      acceptEvent({
        objectId: 'obj_claim',
        proposalId: 'p_claim',
        type: 'claim',
        payload,
        cites: ['m1'],
        at: at(2),
        actor: human(ALICE),
      }),
      event({
        id: 'ev_retract',
        at: at(3),
        actor: human(ALICE),
        type: 'object_corrected',
        objectId: 'obj_claim',
        action: 'retract',
      } as Parameters<typeof event>[0]),
    ]);
    expect(state.objects.obj_claim?.retractedAt).toBe(at(3));

    const again = ProposalSchema.parse({
      id: 'p_claim_again',
      roomId: ROOM,
      type: 'claim',
      payload,
      confidence: 0.95,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['m1'],
      quote: CLAIM,
      createdAt: at(4),
    });
    const verdict = decideAcceptance(again, {
      messages: claimMessages,
      acceptedObjects: Object.values(state.objects).map(acceptedObjectRef),
    });
    expect(verdict.rule).not.toBe('duplicate_of_accepted');
    expect(verdict.verdict).toBe('auto_accept');
  });

  /**
   * **Catches**: a `findDuplicate` that ignores a payload key it does not know
   * about — the enumeration-by-hand repair. `payloadsMatch` unions the schema's
   * keys with the keys each side actually carries, so a field no version of this
   * package has heard of still makes two readings distinct rather than making
   * one of them disappear.
   */
  it('treats a payload field it has never heard of as a difference', () => {
    const ref: AcceptedObjectRef = {
      objectId: 'obj_old',
      type: 'commitment',
      payload: { ...commitmentFor(ALICE), escalationTier: 'page-the-oncall' } as never,
      messageIds: ['m1'],
      retractedAt: null,
      supersededById: null,
    };
    const proposal = ProposalSchema.parse({
      id: 'p_new',
      roomId: ROOM,
      type: 'commitment',
      payload: commitmentFor(ALICE),
      confidence: 0.95,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['m1'],
      quote: BODY,
      createdAt: at(5),
    });
    expect(decideAcceptance(proposal, { messages, acceptedObjects: [ref] }).rule).not.toBe(
      'duplicate_of_accepted',
    );
  });

  /**
   * **Catches**: `payloadText(type, candidate.payload)` without the object
   * guard. A JS caller still building r9's `{objectId, type, text, messageIds}`
   * reaches `findDuplicate` with no payload, and an unguarded read throws inside
   * a path whose contract is that it is total. It is not a duplicate and it is
   * not a crash.
   */
  it('is total on a ref shaped the way r9 shaped them', () => {
    const legacy = {
      objectId: 'obj_old',
      type: 'commitment',
      text: BODY,
      messageIds: ['m1'],
    } as unknown as AcceptedObjectRef;
    const proposal = ProposalSchema.parse({
      id: 'p_legacy',
      roomId: ROOM,
      type: 'commitment',
      payload: commitmentFor(ALICE),
      confidence: 0.95,
      proposer: { kind: 'model', model: 'test-model' },
      provenance: ['m1'],
      quote: BODY,
      createdAt: at(6),
    });
    expect(() => decideAcceptance(proposal, { messages, acceptedObjects: [legacy] })).not.toThrow();
    expect(decideAcceptance(proposal, { messages, acceptedObjects: [legacy] }).rule).not.toBe(
      'duplicate_of_accepted',
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * §2 — one cycle that could not compute an item marked it resolved forever
 * ───────────────────────────────────────────────────────────────────────── */

describe('r10 — a cycle that went blind does not resolve anybody’s item', () => {
  const BODY = 'Bob will run the backfill before the Friday freeze, please.';
  const m1: ProvenanceMessage = { id: 'm1', authorId: CARL, body: BODY };
  const m2: ProvenanceMessage = { id: 'm2', authorId: BOB, body: 'Ack, noted.' };
  /**
   * Uncited, and it has to be there — r11.
   *
   * A window that ends at the newest message a proposal cites is
   * `window_ends_at_the_citations`, a `refer`, so cycle 1 would raise nothing at
   * all and the sequence below would test a room where nobody was ever asked
   * anything. `UNCITED_TAIL`'s docblock is the general form of this.
   */
  const m3: ProvenanceMessage = {
    id: 'm3',
    authorId: ALICE,
    body: 'Anything else for the release week?',
  };
  const full: ProvenanceMessage[] = [m1, m2, m3];
  /** The ordinary shape of "the room's last N messages", one slide on. */
  const slid: ProvenanceMessage[] = [m2, m3];
  const members = { [ROOM]: [ALICE, BOB, CARL] };
  const NOW = at(30);

  /**
   * **Two citations, and r11 is why.**
   *
   * This proposal cited **one** message when r10 wrote it, which is exactly the
   * boundary where r10's repair already worked and the only count at which the
   * defect it was written for cannot reproduce. With the sole citation gone the
   * surviving `cited` list is empty, every quote check inside
   * `validateProposalProvenance` is skipped, and `unknown_message` at `refer` is
   * the only finding — so `decideAcceptance` answers `receipt_not_certifiable`
   * and `proposalItems` refuses on that arm.
   *
   * With two, one survives. The quote checks *run*, over the survivor, and
   * `quote_not_found` at `reject` shadows the referral: `discard /
   * provenance_failed`, which r10's `proposalItems` read as a conclusion and
   * turned into a permanent `resolved`. The repo's own canonical fixture cites
   * two (`fixtures.ts`, `prop_1`). Measured on r10: `['m1']` preserved the item
   * and `['m1','m2']` resolved it.
   */
  const staged = reduce([
    proposalEvent({
      id: 'p_bob',
      type: 'commitment',
      payload: { statement: BODY, owner: BOB, due: null, status: 'open' },
      cites: ['m1', 'm2'],
      quote: BODY,
      at: at(1),
    }),
  ]);
  const ITEM = 'attn:user_bob:proposal:p_bob:owned_commitment';

  /** The one-citation form, kept for the test below that still needs it. */
  const stagedOne = reduce([
    proposalEvent({
      id: 'p_bob_one',
      type: 'commitment',
      payload: { statement: BODY, owner: BOB, due: null, status: 'open' },
      cites: ['m1'],
      quote: BODY,
      at: at(1),
    }),
  ]);

  /**
   * **Catches**: `status: entry.status === 'pending' ? 'resolved' :
   * entry.status` in `reconcileAttention` — rule 2 without the examination
   * check — and, since r11, `proposalItems` concluding from `visibility !==
   * 'needs_you'`. Sequence B from r10's brief, end to end and over three cycles:
   * the window slides past one of the cited messages, the projection computes
   * nothing about a proposal that is still `proposed`, and on r9 *and on r10*
   * Bob's confirm was resolved permanently with zero items and zero refusals to
   * say so.
   */
  it('keeps a pending item pending across a slid window', () => {
    const cycle1 = projectAttention(staged, { now: NOW, messages: full, members });
    let stored = reconcileAttention([], cycle1);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[ITEM, 'pending']]);

    const cycle2 = projectAttention(staged, { now: NOW, messages: slid, members });
    expect(cycle2.items).toEqual([]);
    // Half two of the fix: the window not reaching the message is now *said*.
    expect(cycle2.refusals.map((refusal) => refusal.proposalId)).toEqual(['p_bob']);
    expect(cycle2.refusals[0]?.reason).toContain('window');
    stored = reconcileAttention(stored, cycle2);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[ITEM, 'pending']]);

    const cycle3 = projectAttention(staged, { now: NOW, messages: full, members });
    stored = reconcileAttention(stored, cycle3);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[ITEM, 'pending']]);
    // The proposal never moved, which is the point: nothing about the room
    // changed, only what one cycle could see.
    expect(staged.proposals.p_bob?.status).toBe('proposed');
  });

  /**
   * The one-citation form, kept beside its replacement rather than deleted —
   * **it pins a different arm**, and it is the arm r10 actually built.
   *
   * **Catches**: `unknown_message` going back to `reject` (which makes this
   * `provenance_failed / discard`), and the `receipt_not_certifiable` branch of
   * `proposalItems` concluding instead of refusing. Neither of those is the
   * `about` guard the test above pins, and neither is reachable from the
   * two-citation shape, which is why both cases are here.
   */
  it('keeps a pending item pending when the window dropped its only citation', () => {
    const ONE = 'attn:user_bob:proposal:p_bob_one:owned_commitment';
    const cycle1 = projectAttention(stagedOne, { now: NOW, messages: full, members });
    let stored = reconcileAttention([], cycle1);
    expect(stored.map((entry) => [entry.id, entry.status])).toEqual([[ONE, 'pending']]);

    const cycle2 = projectAttention(stagedOne, { now: NOW, messages: slid, members });
    expect(cycle2.items).toEqual([]);
    expect(cycle2.refusals[0]?.reason).toContain('not in the window');
    stored = reconcileAttention(stored, cycle2);
    expect(stored.map((entry) => entry.status)).toEqual(['pending']);
  });

  /**
   * **Catches**: the same mutation on the documented path — a projection with no
   * `messages` at all, which `attention.ts` calls deliberate and correct. r8
   * fixed the `dismissed` half of this sequence and left `pending` on rule 2.
   */
  it('keeps a pending item pending across a cycle with no window', () => {
    const cycle1 = projectAttention(staged, { now: NOW, messages: full, members });
    let stored = reconcileAttention([], cycle1);
    const blind = projectAttention(staged, { now: NOW, members });
    expect(blind.items).toEqual([]);
    expect(blind.refusals).toHaveLength(1);
    stored = reconcileAttention(stored, blind);
    expect(stored.map((entry) => entry.status)).toEqual(['pending']);
  });

  /**
   * **Catches**: `needsYouOutcome`'s refusal arm being counted as a conclusion.
   * A missing member list is not evidence that anybody acted, so the item stays
   * where it is — the refusal is the receipt, not the resolution.
   */
  it('keeps a pending item pending when there is nobody left to ask', () => {
    const DECISION = 'We ship the scaffold behind a flag, default off.';
    const decisionMessages: ProvenanceMessage[] = [
      { id: 'm1', authorId: ALICE, body: DECISION },
      { id: 'm2', authorId: BOB, body: 'Works for me, thanks.' },
    ];
    const room = reduce([
      proposalEvent({
        id: 'p_decision',
        type: 'decision',
        payload: { statement: DECISION },
        cites: ['m1'],
        quote: DECISION,
        at: at(1),
      }),
    ]);
    const withRoster = projectAttention(room, {
      now: NOW,
      messages: decisionMessages,
      members: { [ROOM]: [ALICE, BOB] },
    });
    let stored = reconcileAttention([], withRoster);
    expect(stored.map((entry) => entry.status)).toEqual(['pending', 'pending']);

    const withoutRoster = projectAttention(room, { now: NOW, messages: decisionMessages });
    expect(withoutRoster.items).toEqual([]);
    expect(withoutRoster.refusals).toHaveLength(1);
    stored = reconcileAttention(stored, withoutRoster);
    expect(stored.map((entry) => entry.status)).toEqual(['pending', 'pending']);
  });

  /**
   * **Catches**: `severity: 'reject'` on `unknown_message`. The root cause under
   * the sequence above — a citation the window does not reach was classed as
   * *the reading is wrong* rather than *the window did not read it*, which is
   * the opposite of what this package applies everywhere else
   * (`quote_span_unscanned`, `statement_uncheckable`, `laterRevision`). `reject`
   * is what `acceptance.ts` turns into `discard`, and a discard produces no
   * item, no refusal and no trace.
   */
  it('classes an unreached citation as unscanned rather than wrong', () => {
    // The one-citation proposal, on purpose: this test is about the *severity*
    // `unknown_message` carries, and that finding only reaches a return when no
    // `reject` outranks it. With two citations one survives, the quote checks
    // run over it, and `quote_not_found` wins — which is r11's finding and is
    // pinned above, not here.
    const proposal = stagedOne.proposals.p_bob_one?.proposal;
    if (!proposal) throw new Error('unreachable');

    const problems = validateProposalProvenance(
      {
        type: 'commitment',
        provenance: ['m1'],
        quote: BODY,
        proposer: { kind: 'model' },
        attributedTo: BOB,
        statement: BODY,
      },
      slid,
    );
    const unknown = problems.find((problem) => problem.kind === 'unknown_message');
    expect(unknown?.severity).toBe('refer');

    const verdict = decideAcceptance(proposal, { messages: slid });
    expect(verdict.rule).toBe('receipt_not_certifiable');
    expect(verdict.verdict).toBe('pending');
    // …and it is still above everything that can accept: a window that did not
    // reach the message never licenses a machine acceptance.
    expect(verdict.visibility).toBe('quiet');
  });

  /**
   * **Catches**: a `mentionItems` that declares examinations it did not make. A
   * mention is a caller signal and this source reads no state, so "no item for
   * `obj_7`" cannot be told apart from "nobody told this cycle about `obj_7`" —
   * the slid window produces the second while looking like the first.
   */
  it('keeps a mention pending when the cycle was handed no signals', () => {
    // …on an object the room really holds, which is the realistic shape and the
    // one that makes the fail-open version visible: a state walk that declared
    // `mention` alongside its own class would resolve this item, because the
    // object is right there in `state.objects`.
    const CLAIM = 'The rollback needs somebody to own it before Friday.';
    const payload = { statement: CLAIM, claimant: ALICE, verification: 'unverified' as const };
    const room = reduce([
      proposalEvent({
        id: 'p_claim',
        type: 'claim',
        payload,
        cites: ['m1'],
        quote: CLAIM,
        at: at(1),
      }),
      acceptEvent({
        objectId: 'obj_claim',
        proposalId: 'p_claim',
        type: 'claim',
        payload,
        cites: ['m1'],
        at: at(2),
        actor: human(ALICE),
      }),
    ]);
    expect(room.objects.obj_claim).toBeDefined();

    const mention = {
      roomId: ROOM,
      objectId: 'obj_claim',
      userId: BOB,
      request: 'can you take the rollback?',
    };
    const withSignal = projectAttention(room, { now: NOW, mentions: [mention] });
    let stored = reconcileAttention([], withSignal);
    expect(stored.map((entry) => [entry.class, entry.status])).toEqual([['mention', 'pending']]);
    stored = reconcileAttention(stored, projectAttention(room, { now: NOW }));
    expect(stored.map((entry) => [entry.class, entry.status])).toEqual([['mention', 'pending']]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * §3 — link structure spliced into a stored statement
 * ───────────────────────────────────────────────────────────────────────── */

describe('r10 — a statement may not add link markup its author never wrote', () => {
  /**
   * The five the r10 review ran, each one `auto_accept` on r9 and each one
   * landing in `state.objects` with markup Alice never typed. The fold unfolds
   * `[label](dest "title")` to `label dest title`, so every one of these
   * normalizes to the author's own sentence and `borne` was true.
   *
   * **Catches**: deleting the `addedLinkStructure` check from
   * `validateProposalProvenance`. Judged on `state.objects` — the returned
   * verdict is not the harm, the stored text is.
   */
  const attacks: { label: string; body: string; statement: string }[] = [
    {
      label: 'a phishing link built out of the author’s own two URLs',
      body: 'Use https://safe.example and never https://evil.example for the runbook.',
      statement: 'Use [https://safe.example and never](https://evil.example) for the runbook.',
    },
    {
      label: 'the author’s warning becomes link text, her warned-against host the href',
      body: 'Do not use https://evil.example, the runbook lives at https://safe.example now.',
      statement:
        '[Do not use]( ) [https://evil.example, the runbook lives at](https://safe.example) now.',
    },
    {
      label: 'empty link punctuation spliced into the statement',
      body: 'The migration is reversible and can be rolled back cleanly.',
      statement: 'The migration is[]() reversible and can be rolled back cleanly.',
    },
    {
      label: 'the whole sentence wrapped as a link to a word from the sentence',
      body: 'Roll back the migration before the freeze deadline tonight.',
      statement: '[Roll back the migration before the freeze deadline](tonight).',
    },
    {
      label: 'the link title forged out of the trailing words',
      body: 'Read the runbook at https://safe.example do not run step 4.',
      statement: 'Read the runbook at [https://safe.example]( "do not run step 4").',
    },
  ];

  // One `it`, five inputs, because a templated title cannot be named in the
  // mutant ledger's `catches` and this is the assertion the ledger points at.
  it('refuses a statement that splices link markup into the author’s own words', () => {
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
        id: 'p_link',
        type: 'claim',
        payload,
        cites: ['m1'],
        quote: attack.body,
        at: at(1),
      });

      const recorded = appendEvent(
        emptyState(),
        staged.event,
        trustedContext({ actor: model(), messages }),
      );
      expect(recorded.outcome, attack.label).toBe('applied');

      const proposal = recorded.state.proposals.p_link?.proposal;
      if (!proposal) throw new Error('unreachable');
      const verdict = decideAcceptance(proposal, { messages });
      expect(verdict.rule, attack.label).toBe('provenance_failed');
      expect(verdict.verdict, attack.label).toBe('discard');
      // r12: was `'link markup the quote does not'`. The old sentence caught a
      // refusal that fired without naming what it had found; the new one catches
      // that **and** a guard that has drifted back to comparing the statement
      // against the proposer's own quote field, because the refusal now names
      // the message it was actually read against.
      expect(verdict.reason, attack.label).toContain('link markup message "m1" does not');

      // …and the reducer refuses the model acceptance too, so the two gates do
      // not disagree about one receipt.
      const landed = appendEvent(
        recorded.state,
        acceptEvent({
          objectId: 'obj_link',
          proposalId: 'p_link',
          type: 'claim',
          payload,
          cites: ['m1'],
          at: at(2),
          actor: model(),
        }).event,
        trustedContext({ actor: model(), messages }),
      );
      expect(landed.state.objects.obj_link, attack.label).toBeUndefined();
      expect(
        Object.values(landed.state.objects).map((record) => objectStatement(record.object)),
        attack.label,
      ).toEqual([]);
    }
  });

  /**
   * **Catches**: a guard that refuses *any* link in a statement rather than link
   * markup the quote does not carry. A message that really does contain a link,
   * quoted and restated verbatim, is an ordinary reading and must still pass —
   * and a statement that drops the markup keeps the destination and the title as
   * words, which is r4's and r7's disposition and is deliberately unchanged.
   */
  it('leaves a link the author actually wrote alone, in both directions', () => {
    const body = 'The [runbook](https://safe.example "step 4 is destructive") is current.';
    const messages: ProvenanceMessage[] = [
      { id: 'm1', authorId: ALICE, body },
      { id: 'm2', authorId: BOB, body: 'Thanks for keeping it up to date.' },
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

    expect(kinds(body)).not.toContain('statement_adds_link_structure');
    expect(
      kinds('The runbook https://safe.example step 4 is destructive is current.'),
    ).not.toContain('statement_adds_link_structure');
    // …and one more link than the author wrote is one too many.
    expect(kinds(`${body} Also [the dashboard](https://evil.example).`)).toContain(
      'statement_adds_link_structure',
    );
  });

  /**
   * **Catches**: scanning code segments for link structure. A backticked span is
   * mention, not use — `normalizeForReceipt` passes one through byte for byte
   * and never unfolds a link inside one, so counting it here would refuse a
   * statement that quotes a literal correctly.
   */
  it('reads link markup as markup only where the fold would', () => {
    expect(linkStructures('see [docs](https://x.example)')).toEqual(['[docs](https://x.example)']);
    expect(linkStructures('type `[docs](https://x.example)` verbatim')).toEqual([]);
    expect(linkStructures('![shot](https://x.example)')).toEqual(['![shot](https://x.example)']);
    // Whitespace inside a link is the fold's to collapse, not a difference.
    expect(addedLinkStructure('a [b](c) d', 'a [b](  c  ) d')).toEqual([]);
    // …and the image marker is not the link marker.
    expect(addedLinkStructure('a [b](c) d', 'a ![b](c) d')).toEqual(['![b](c)']);
  });
});
