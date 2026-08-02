import { describe, expect, it } from 'vitest';
import {
  type AcceptedObjectRef,
  type AttentionItem,
  type AttentionProjection,
  acceptedObjectRef,
  appendEvent,
  autoAcceptable,
  type ComputedAttentionItem,
  canonicalJson,
  compareCursor,
  computeAttention,
  DEFAULT_ACCEPTANCE_RULES,
  decideAcceptance,
  type ExaminedSubject,
  findDuplicate,
  instantKey,
  laterRevision,
  MODEL_ACCEPTANCE_FLOOR,
  normalizeForReceipt,
  orderEvents,
  type Proposal,
  Proposal as ProposalSchema,
  type ProvenanceMessage,
  projectAttention,
  reconcileAttention,
  reduce,
  sortAttention,
  validateProposalProvenance,
} from '../src/index.js';
import { ALICE, at, BOB, event, human, model, ROOM, room } from './fixtures.js';

/**
 * **r8 — one rule, and everything the blind review found under it.**
 *
 * The organizing sentence of the round: *whenever a guarantee is established
 * over a normalized form, every downstream check must consume that same form.*
 * The headline defect is exactly that shape — the receipt proves
 * `normalizeForReceipt(quote) === normalizeForReceipt(statement)` and
 * `readsAsCommitment` read the raw statement — and so is the sed-marker gap in
 * the correction scan, and so is the dedup fold that discarded `10²` as a
 * duplicate of `102`.
 *
 * The rest of the file is the other findings that round executed. Every test
 * here fails on `fix/core-engine-r7` as committed; that is the entry condition
 * for a row in this file, not a hope about it.
 */

const CAROL = 'user_carol';

const claimOf = (statement: string, quote = statement, confidence = 0.95): Proposal =>
  ProposalSchema.parse({
    id: 'prop_r8',
    roomId: ROOM,
    type: 'claim',
    payload: { statement, claimant: BOB },
    confidence,
    proposer: { kind: 'model', model: 'test-model' },
    provenance: ['m1'],
    quote,
    createdAt: at(1),
  }) as Proposal;

const window = (body: string): ProvenanceMessage[] =>
  room({ id: 'm1', authorId: BOB, body }, { id: 'm2', authorId: ALICE, body: 'noted, thanks' });

describe('r8 — the certification predicate reads the form the receipt proved', () => {
  // Deliberately carries **one** commitment shape and no other: no performative,
  // no progressive, no date. A sentence that trips a second entry would still be
  // refused with the fold removed, and the mutant that reverts the fold would
  // escape while the test went on passing — which is how a defence-in-depth
  // suite stops measuring the thing it names.
  const BODY = 'I will land the narrowing fix in the type checker.';
  // One deletable code point, inside the one word that shape reads.
  const POISONED = 'I wi​ll land the narrowing fix in the type checker.';

  it('is a statement the receipt genuinely certifies', () => {
    // The premise, asserted rather than assumed. If this stops holding, the test
    // below stops being about the defect it is named for.
    expect(normalizeForReceipt(POISONED)).toBe(normalizeForReceipt(BODY));
    expect(POISONED).not.toBe(BODY);
    expect(
      validateProposalProvenance(
        {
          type: 'claim',
          provenance: ['m1'],
          quote: BODY,
          statement: POISONED,
          proposer: { kind: 'model' },
          attributedTo: BOB,
        },
        window(BODY),
      ),
    ).toEqual([]);
  });

  it('refuses the spliced statement at the engine, as it refuses the verbatim one', () => {
    const messages = window(BODY);
    expect(decideAcceptance(claimOf(BODY), { messages }).rule).toBe('type_not_certified');
    // r7: `auto_accept`. The whole finite domain of `COMMITMENT_SHAPES` evaded
    // by one code point, because the predicate never saw the fold.
    expect(decideAcceptance(claimOf(POISONED, BODY), { messages }).rule).toBe('type_not_certified');
  });

  it('refuses it at the reducer too, so neither backstops the other by accident', () => {
    // Both enforcement points called the same predicate over the same
    // unnormalized text, so the "two boundaries" claim bought nothing here. This
    // asserts the object does not land, which is the disposition that matters:
    // on r7 it did, with the poisoned text in state.
    const messages = window(BODY);
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_r8',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: POISONED, claimant: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['m1'],
          quote: BODY,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_a',
        at: at(2),
        actor: model(),
        messages,
        type: 'object_accepted',
        object: {
          id: 'obj_r8',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: POISONED, claimant: BOB },
          provenance: { messageIds: ['m1'], proposalId: 'prop_r8' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.objects).toEqual({});
    expect(state.issues.at(-1)?.reason).toContain('undertaking');
  });
});

describe('r8 — the correction scan', () => {
  const STATEMENT = 'The migration completed cleanly on the primary.';
  const CORRECTION = 'Correction: the migration did not complete on the primary.';

  /**
   * Two messages carrying the **same body**. The receipt cannot tell them apart
   * — they are the same text — so which one the proposal cites is the
   * proposer's free choice, and on r7 that choice moved the scan's floor.
   */
  const duplicated: ProvenanceMessage[] = [
    { id: 'm1', authorId: BOB, body: STATEMENT },
    { id: 'm2', authorId: ALICE, body: CORRECTION },
    { id: 'm3', authorId: BOB, body: STATEMENT },
    { id: 'm4', authorId: ALICE, body: 'anyway, standup is at ten' },
  ];

  it('finds the correction whichever copy of the sentence is cited', () => {
    expect(laterRevision(STATEMENT, ['m1'], duplicated).kind).toBe('revision');
    // r7: `scanned` — the correction sat behind `firstCited`, so the identical
    // reading auto-accepted on the strength of citing the later copy.
    expect(laterRevision(STATEMENT, ['m3'], duplicated).kind).toBe('revision');
  });

  it('reads the same disposition end to end for both citations', () => {
    const kinds = (provenance: string[]) =>
      validateProposalProvenance(
        {
          type: 'claim',
          provenance,
          quote: STATEMENT,
          statement: STATEMENT,
          proposer: { kind: 'model' },
          attributedTo: BOB,
        },
        duplicated,
      ).map((problem) => problem.kind);
    expect(kinds(['m1'])).toContain('superseded_by_later_message');
    expect(kinds(['m3'])).toContain('superseded_by_later_message');
  });

  it('sees a correction in the sentence next to the restatement', () => {
    // `"<S> Unless CI is red."` — the exact construction
    // `quote_omits_surrounding_text` cites, one message later. On r7 the
    // per-sentence loop read `<S>` as an exact restatement, `continue`d, failed
    // to align the qualifier against anything, and auto-accepted — while the
    // identical qualifier *inside* one sentence referred.
    const messages: ProvenanceMessage[] = [
      { id: 'm1', authorId: BOB, body: STATEMENT },
      { id: 'm2', authorId: BOB, body: `${STATEMENT} Unless CI is red.` },
      { id: 'm3', authorId: ALICE, body: 'ack' },
    ];
    expect(laterRevision(STATEMENT, ['m1'], messages).kind).toBe('revision');

    const negated: ProvenanceMessage[] = [
      { id: 'm1', authorId: BOB, body: STATEMENT },
      { id: 'm2', authorId: BOB, body: `${STATEMENT} Not.` },
      { id: 'm3', authorId: ALICE, body: 'ack' },
    ];
    expect(laterRevision(STATEMENT, ['m1'], negated).kind).toBe('revision');
  });

  it('reads the sed marker through the fold its neighbours read through', () => {
    // The axis r8's foreign-lineage sweep named: `SED_CORRECTION.test(own)` read
    // the raw body while every retraction marker beside it read
    // `normalizeForRouting(own)`. A `s/…/…/` inside emphasis was invisible to
    // the one and not the other.
    const messages: ProvenanceMessage[] = [
      { id: 'm1', authorId: BOB, body: STATEMENT },
      // Capital `S`, which is how a sentence starts. `SED_CORRECTION` is
      // case-sensitive, so the raw body does not match it and the lowercased
      // routing fold does.
      { id: 'm2', authorId: BOB, body: 'S/completed/failed/' },
      { id: 'm3', authorId: ALICE, body: 'ack' },
    ];
    expect(laterRevision(STATEMENT, ['m1'], messages).kind).toBe('revision');
  });
});

describe('r8 — the canonical order is over the instant, not its spelling', () => {
  const PLAIN = '2026-01-01T00:00:00Z';
  const HALF = '2026-01-01T00:00:00.500Z';

  it('sorts half a second later after, not before', () => {
    // `'.'` (U+002E) sorts before `'Z'` (U+005A), so the lexical comparison put
    // `HALF` first. Appended in real-time order the second event was
    // `rejected / out_of_order`, permanently.
    expect(PLAIN < HALF).toBe(false);
    expect(compareCursor({ at: PLAIN, id: 'a' }, { at: HALF, id: 'a' })).toBeLessThan(0);
  });

  it('reads every spelling `Timestamp` admits as one order', () => {
    const spellings = [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00+01:00',
      '2025-12-31T23:00:00-01:00',
    ];
    for (const spelling of spellings) {
      expect(instantKey(spelling), spelling).toBe(instantKey(PLAIN));
      expect(compareCursor({ at: spelling, id: 'a' }, { at: PLAIN, id: 'a' }), spelling).toBe(0);
    }
    // …and an offset spelling of a genuinely later instant still sorts later.
    expect(
      compareCursor({ at: '2026-01-01T00:00:01+00:00', id: 'a' }, { at: PLAIN, id: 'a' }),
    ).toBeGreaterThan(0);
  });

  it('keeps sub-millisecond precision rather than collapsing it onto the id', () => {
    // `Date.parse` truncates to milliseconds, so two distinct instants would tie
    // and fall through to the id — ordering by id where the caller asked for
    // time. This is why `instantKey` reads the fields itself.
    // The ids are chosen so the tiebreak would sort them the *other* way: if the
    // fraction is truncated the two keys tie, `'a' < 'z'`, and the later instant
    // comes back first — ordering by id where the caller asked for time.
    expect(
      compareCursor({ at: '2026-01-01T00:00:00.0005Z', id: 'a' }, { at: PLAIN, id: 'z' }),
    ).toBeGreaterThan(0);
  });

  const staged = (id: string, at_: string) =>
    event({
      id,
      at: at_,
      actor: model(),
      type: 'proposal_recorded',
      proposal: {
        id: `prop_${id}`,
        roomId: ROOM,
        type: 'claim',
        payload: { statement: 'the backfill completed cleanly', claimant: BOB },
        confidence: 0.6,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: ['m1'],
        quote: 'the backfill completed cleanly',
        createdAt: at_,
      },
    });

  it('orders a log by when things happened', () => {
    const rows = [staged('ev_b', HALF), staged('ev_a', PLAIN)];
    expect(orderEvents(rows).map((row) => row.event.id)).toEqual(['ev_a', 'ev_b']);
  });

  it('does not reject the later event as out of order, unrecoverably', () => {
    // The live disposition, and the reason this is a contract hole rather than
    // a cosmetic one: the cursor had already moved past the later instant, so
    // re-minting the event at that instant fails forever.
    const a = staged('ev_a', PLAIN);
    const b = staged('ev_b', HALF);
    const first = appendEvent(reduce([]), a.event, a);
    expect(first.outcome).toBe('applied');
    const second = appendEvent(first.state, b.event, b);
    expect(second.outcome).toBe('applied');
  });

  it('is total on a string it cannot parse', () => {
    // A sort key must never throw: `CoreEvent.parse` has already refused an
    // unparseable `at` before any fold sees it, and a comparator that threw here
    // would turn a refused row into a crashed reduce.
    expect(() => instantKey('not a timestamp')).not.toThrow();
    expect(compareCursor({ at: 'x', id: 'a' }, { at: 'x', id: 'b' })).toBeLessThan(0);
  });
});

describe('r8 — dedup may not destroy a distinct reading', () => {
  /**
   * A claim payload and the ref that carries it. r10 turned `AcceptedObjectRef`
   * from `{…, text}` into `{…, payload, retractedAt, supersededById}` — the
   * sentence alone could not say who a reading was about, so a second person's
   * commitment was destroyed by the first's. These helpers keep every row below
   * asking the question it was written to ask: same claimant, same verification,
   * so the only thing varying is the text.
   */
  const claimOf = (statement: string) =>
    ({ statement, claimant: ALICE, verification: 'unverified' }) as const;
  const claimRef = (
    objectId: string,
    statement: string,
    messageIds: string[],
  ): AcceptedObjectRef => ({
    objectId,
    type: 'claim',
    payload: claimOf(statement),
    messageIds,
    retractedAt: null,
    supersededById: null,
  });
  const accepted = [claimRef('obj_1', 'the p99 settled at 102 ms after the index landed', ['m1'])];

  it('keeps `10² ms` and `102 ms` apart', () => {
    // NFKC folds the superscript onto a digit, so 100 was discarded as a
    // duplicate of 102 — no proposal, no issue, no trace, and the accepted
    // object it contradicted stayed on the record.
    expect(
      findDuplicate(
        'claim',
        claimOf('the p99 settled at 10² ms after the index landed'),
        ['m1'],
        accepted,
      ),
    ).toBeNull();
  });

  /**
   * **What replaced the pin, and what the pin was covering — r9.**
   *
   * The line under this one used to be its inverse:
   *
   * ```
   * // The case dedup exists for still fires.
   * expect(findDuplicate('claim', 'The p99 settled at 102 MS …', …)).not.toBeNull();
   * ```
   *
   * — a deliberate pin, not an oversight, and r9 deletes the behaviour it pinned
   * (`matching.ts` carries the argument: a comparison whose failure mode is
   * *destruction* may not forgive more than one whose failure mode is
   * *referral*, and `US`/`us`, `Bill`/`bill`, `March`/`march` are the receipt
   * policy's own reasons for refusing the fold).
   *
   * That pin was doing two jobs. The first — *dedup still fires at all*, i.e.
   * `findDuplicate` is not dead code and did not degenerate to "never a
   * duplicate" while the NFKC fix went in — is real coverage and is kept, by the
   * exact re-proposal below. It is strictly better at that job: it does not need
   * a fold to be true, so it survives the next change to what dedup forgives.
   *
   * The second job — asserting the *fold itself* — is the one being deleted, and
   * what it costs is stated rather than hidden: a room where somebody restates a
   * measurement in different case now gets one extra staged proposal, one
   * person's glance. That is the same price this file paid to delete
   * `duplicateThreshold` and again to drop NFKC.
   */
  it('still fires on the same sentence proposed twice', () => {
    expect(
      findDuplicate(
        'claim',
        claimOf('the p99 settled at 102 ms after the index landed'),
        ['m1'],
        accepted,
      )?.objectId,
    ).toBe('obj_1');
  });

  it('r9 — keeps a re-cased literal apart from the literal it is not', () => {
    // The password case, at the unit. `normalizeForReceipt` preserves a code
    // segment byte for byte on the ground that a literal respaced is a literal
    // changed; the dedup fold lower-cased straight through it, so a correction
    // from `Hunter2` to `hunter2` was destroyed and the record kept the old
    // password.
    const password = [
      claimRef('obj_pw', 'Set the deploy password to `Hunter2` before you leave tonight.', ['m1']),
    ];
    expect(
      findDuplicate(
        'claim',
        claimOf('Set the deploy password to `hunter2` before you leave tonight.'),
        ['m1'],
        password,
      ),
    ).toBeNull();
    // …and in prose, where restricting the fold to code segments would have
    // left it: `Bill` is a person and a `bill` is an invoice.
    const invoice = [claimRef('obj_b', 'Send the Bill to Acme', ['m1'])];
    expect(findDuplicate('claim', claimOf('Send the bill to Acme'), ['m1'], invoice)).toBeNull();
  });

  /**
   * **The whole chain, machine-produced — r9.**
   *
   * Not `findDuplicate` in isolation. A model reads ALICE's first message,
   * the engine auto-accepts it, `appendEvent` puts it on the record as `~`.
   * ALICE then corrects the password in a second message; the model reads that
   * one and cites both, which is what the repo's own `sampleLog` does. On r8
   * the second reading came back `duplicate_of_accepted / discard` —
   * `visibility: 'none'`, documented as *"never shown, never stored as a live
   * proposal"* — so the record kept `Hunter2` and the room was shown nothing at
   * all.
   *
   * The assertion is what a person in that room would experience: the
   * correction reaches accepted state and both readings are on the record for
   * them to see.
   */
  it('a machine-accepted reading cannot be destroyed by a re-cased duplicate', () => {
    const FIRST = 'Set the deploy password to `Hunter2` before you leave tonight.';
    const SECOND = 'Set the deploy password to `hunter2` before you leave tonight.';
    // Two windows, because the correction does not exist yet when the first
    // reading is judged — the room is a log, not a snapshot.
    const before: ProvenanceMessage[] = room({ id: 'msg_1', authorId: ALICE, body: FIRST });
    const messages: ProvenanceMessage[] = room(
      { id: 'msg_1', authorId: ALICE, body: FIRST },
      { id: 'msg_2', authorId: ALICE, body: SECOND },
    );

    const stage = (
      id: string,
      text: string,
      cites: string[],
      minute: number,
      window: ProvenanceMessage[] = messages,
    ) =>
      event({
        id: `ev_${id}`,
        at: at(minute),
        actor: model(),
        messages: window,
        type: 'proposal_recorded',
        proposal: {
          id,
          roomId: ROOM,
          type: 'claim',
          payload: { statement: text, claimant: ALICE },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: cites,
          quote: text,
          createdAt: at(minute),
        },
      });
    const accept = (
      id: string,
      proposalId: string,
      text: string,
      cites: string[],
      minute: number,
      window: ProvenanceMessage[] = messages,
    ) =>
      event({
        id: `ev_${id}`,
        at: at(minute),
        actor: model(),
        messages: window,
        type: 'object_accepted',
        object: {
          id,
          roomId: ROOM,
          type: 'claim',
          payload: { statement: text, claimant: ALICE },
          provenance: { messageIds: cites, proposalId },
          createdAt: at(minute),
          updatedAt: at(minute),
        },
      });

    // ── The first reading, machine-accepted ────────────────────────────────
    let state = reduce([stage('prop_a', FIRST, ['msg_1'], 1, before)]);
    const first = state.proposals.prop_a?.proposal;
    if (!first) throw new Error('unreachable');
    expect(decideAcceptance(first, { messages: before }).verdict).toBe('auto_accept');
    const landedA = appendEvent(
      state,
      accept('obj_a', 'prop_a', FIRST, ['msg_1'], 2, before).event,
      { ...accept('obj_a', 'prop_a', FIRST, ['msg_1'], 2, before) },
    );
    expect(landedA.outcome).toBe('applied');
    state = landedA.state;

    // ── The correction, read out of the second message and citing both ─────
    const stagedB = appendEvent(state, stage('prop_b', SECOND, ['msg_1', 'msg_2'], 3).event, {
      ...stage('prop_b', SECOND, ['msg_1', 'msg_2'], 3),
    });
    expect(stagedB.outcome).toBe('applied');
    state = stagedB.state;
    const second = state.proposals.prop_b?.proposal;
    if (!second) throw new Error('unreachable');

    // What a caller judging against the room's accepted state actually asks.
    // `acceptedObjectRef` is the one derivation there is — a caller writing this
    // projection by hand is how the tombstone fields get forgotten.
    const accepted = Object.values(state.objects).map(acceptedObjectRef);
    const verdict = decideAcceptance(second, { messages, acceptedObjects: accepted });
    expect(verdict.rule).not.toBe('duplicate_of_accepted');
    expect(verdict.verdict).toBe('auto_accept');

    // ── …and it lands, so the room has both and can see which is newer ─────
    const landedB = appendEvent(
      state,
      accept('obj_b', 'prop_b', SECOND, ['msg_1', 'msg_2'], 4).event,
      { ...accept('obj_b', 'prop_b', SECOND, ['msg_1', 'msg_2'], 4) },
    );
    expect(landedB.outcome).toBe('applied');
    const statements = Object.values(landedB.state.objects).map(
      (record) => (record.object.payload as { statement: string }).statement,
    );
    expect(statements).toContain(FIRST);
    expect(statements).toContain(SECOND);
  });
});

describe('r8 — a retype cannot reach past an invariant the fold enforces', () => {
  const acceptObject = (id: string, at_: string, object: Record<string, unknown>) =>
    event({
      id,
      at: at_,
      actor: human(),
      type: 'object_accepted',
      object: { roomId: ROOM, createdAt: at_, updatedAt: at_, ...object },
    } as Parameters<typeof event>[0]);

  it('refuses to retype an objective that things are filed under', () => {
    const state = reduce([
      acceptObject('ev_1', at(1), {
        id: 'obj_objective',
        type: 'objective',
        payload: { title: 'Ship the narrowing fix' },
      }),
      acceptObject('ev_2', at(2), {
        id: 'obj_claim',
        type: 'claim',
        objectiveId: 'obj_objective',
        payload: { statement: 'the index landed cleanly', claimant: BOB },
      }),
      event({
        id: 'ev_3',
        at: at(3),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_objective',
        action: 'retype',
        toType: 'decision',
        patch: { decidedBy: ALICE },
      }),
    ]);
    // r7: applied, leaving `obj_claim.objectiveId` pointing at a decision — the
    // state `applyObjectAccepted` refuses to be handed directly.
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('filed under it');
    expect(state.objects.obj_objective?.object.type).toBe('objective');
  });

  it('refuses to retype an answered question out of being a question', () => {
    const state = reduce([
      acceptObject('ev_1', at(1), {
        id: 'obj_q',
        type: 'open_question',
        payload: { question: 'Do we keep the flag after launch?' },
      }),
      acceptObject('ev_2', at(2), {
        id: 'obj_d',
        type: 'decision',
        payload: { statement: 'Drop the flag', decidedBy: ALICE },
      }),
      event({
        id: 'ev_3',
        at: at(3),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_1',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_q',
          to: { kind: 'object', objectId: 'obj_d' },
          createdAt: at(3),
        },
      }),
      event({
        id: 'ev_4',
        at: at(4),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_q',
        action: 'retype',
        toType: 'claim',
        patch: { claimant: BOB },
      }),
    ]);
    // r7: applied — an `answers` edge from a claim, which
    // `applyRelationAdded` refuses to create, and `status: 'answered'` dropped
    // in silence because a claim has no such field.
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('answers');
    expect(state.objects.obj_q?.object.type).toBe('open_question');
    expect(
      state.objects.obj_q?.object.type === 'open_question' &&
        state.objects.obj_q.object.payload.status,
    ).toBe('answered');
  });

  it('allows it once the question is reopened, which is what the refusal says', () => {
    // The remedy has to be real. `reopen` moves the edge onto
    // `reopenedFromAnswers`, and a historical edge is not a live constraint.
    const state = reduce([
      acceptObject('ev_1', at(1), {
        id: 'obj_q',
        type: 'open_question',
        payload: { question: 'Do we keep the flag after launch?' },
      }),
      acceptObject('ev_2', at(2), {
        id: 'obj_d',
        type: 'decision',
        payload: { statement: 'Drop the flag', decidedBy: ALICE },
      }),
      event({
        id: 'ev_3',
        at: at(3),
        actor: human(),
        type: 'relation_added',
        relation: {
          id: 'rel_1',
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: 'obj_q',
          to: { kind: 'object', objectId: 'obj_d' },
          createdAt: at(3),
        },
      }),
      event({
        id: 'ev_4',
        at: at(4),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_q',
        action: 'reopen',
      }),
      event({
        id: 'ev_5',
        at: at(5),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_q',
        action: 'retype',
        toType: 'claim',
        patch: { claimant: BOB },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_q?.object.type).toBe('claim');
  });

  it('refuses a retype that moves a commitment onto a different person', () => {
    // The `amend` refusal states this invariant verbatim — *"moving a commitment
    // onto or off a person is a 'reattribute', so the correction log can be read
    // by verb"* — and a retype round trip walked around it in two hops with no
    // `reattribute` row in the log.
    const state = reduce([
      acceptObject('ev_1', at(1), {
        id: 'obj_c',
        type: 'commitment',
        payload: { statement: 'land the narrowing fix', owner: ALICE },
      }),
      event({
        id: 'ev_2',
        at: at(2),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_c',
        action: 'retype',
        toType: 'claim',
        patch: { claimant: CAROL },
      }),
    ]);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]?.reason).toContain('reattribute');
    expect(
      state.objects.obj_c?.object.type === 'commitment' && state.objects.obj_c.object.payload.owner,
    ).toBe(ALICE);
  });

  it('carries the person across a retype round trip', () => {
    const state = reduce([
      acceptObject('ev_1', at(1), {
        id: 'obj_c',
        type: 'commitment',
        payload: { statement: 'land the narrowing fix', owner: ALICE },
      }),
      event({
        id: 'ev_2',
        at: at(2),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_c',
        action: 'retype',
        toType: 'claim',
      }),
      event({
        id: 'ev_3',
        at: at(3),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_c',
        action: 'retype',
        toType: 'commitment',
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(
      state.objects.obj_c?.object.type === 'commitment' && state.objects.obj_c.object.payload.owner,
    ).toBe(ALICE);
  });
});

describe('r8 — the reducer repeats the answer-binding preconditions it skipped', () => {
  const setup = () => [
    event({
      id: 'ev_1',
      at: at(1),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_q',
        roomId: ROOM,
        type: 'open_question',
        payload: { question: 'Do we keep the flag after launch?' },
        createdAt: at(1),
        updatedAt: at(1),
      },
    }),
    event({
      id: 'ev_2',
      at: at(2),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_d',
        roomId: ROOM,
        type: 'decision',
        payload: { statement: 'Drop the flag', decidedBy: ALICE },
        createdAt: at(2),
        updatedAt: at(2),
      },
    }),
  ];

  const answersEdge = (id: string, at_: string, target: string) =>
    event({
      id: `ev_${id}`,
      at: at_,
      actor: human(),
      type: 'relation_added',
      relation: {
        id,
        roomId: ROOM,
        kind: 'answers',
        fromObjectId: 'obj_q',
        to: { kind: 'object', objectId: target },
        createdAt: at_,
      },
    });

  it('refuses an edge that would settle a retracted question', () => {
    const state = reduce([
      ...setup(),
      event({
        id: 'ev_3',
        at: at(3),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_q',
        action: 'retract',
      }),
      answersEdge('rel_1', at(4), 'obj_d'),
    ]);
    // r7: applied — a question the room withdrew came back `answered`.
    expect(state.issues.at(-1)?.reason).toContain('retracted');
    expect(
      state.objects.obj_q?.object.type === 'open_question' &&
        state.objects.obj_q.object.payload.status,
    ).toBe('open');
  });

  it('refuses a second answer onto one question — round 1’s finding, at the fold', () => {
    const state = reduce([
      ...setup(),
      event({
        id: 'ev_3',
        at: at(3),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_d2',
          roomId: ROOM,
          type: 'decision',
          payload: { statement: 'Keep the flag', decidedBy: BOB },
          createdAt: at(3),
          updatedAt: at(3),
        },
      }),
      answersEdge('rel_1', at(4), 'obj_d'),
      answersEdge('rel_2', at(5), 'obj_d2'),
    ]);
    // r7: both edges landed. The command layer refused this from round 1; the
    // reducer, which is the boundary, did not.
    expect(state.issues.at(-1)?.reason).toContain('already answered');
    expect(state.relations.map((relation) => relation.id)).toEqual(['rel_1']);
  });
});

describe('r8 — supersession is reversible, because the refusal says it is', () => {
  const log = () => [
    event({
      id: 'ev_1',
      at: at(1),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_old',
        roomId: ROOM,
        type: 'decision',
        payload: { statement: 'Ship on Friday', decidedBy: ALICE },
        createdAt: at(1),
        updatedAt: at(1),
      },
    }),
    event({
      id: 'ev_2',
      at: at(2),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_new',
        roomId: ROOM,
        type: 'decision',
        payload: { statement: 'Ship on Monday', decidedBy: ALICE },
        createdAt: at(2),
        updatedAt: at(2),
      },
    }),
    event({
      id: 'ev_3',
      at: at(3),
      actor: human(),
      type: 'relation_added',
      relation: {
        id: 'rel_1',
        roomId: ROOM,
        kind: 'supersedes',
        fromObjectId: 'obj_new',
        to: { kind: 'object', objectId: 'obj_old' },
        createdAt: at(3),
      },
    }),
  ];

  it('un-retires the replaced decision when the replacement is retracted', () => {
    // `applyReopen` refuses to reopen a superseded decision and names this as
    // the route: *"a superseded decision is reopened by retracting the decision
    // that replaced it"*. On r7 that did nothing at all.
    const state = reduce([
      ...log(),
      event({
        id: 'ev_4',
        at: at(4),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_new',
        action: 'retract',
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_old?.supersededById).toBeNull();
    expect(
      state.objects.obj_old?.object.type === 'decision' &&
        state.objects.obj_old.object.payload.status,
    ).toBe('active');
    // The edge itself stays: the log is append-only and the room is entitled to
    // see that the retirement happened and was withdrawn.
    expect(state.relations.map((relation) => relation.id)).toEqual(['rel_1']);
  });

  it('takes the retirement back when the replacement is restored', () => {
    const state = reduce([
      ...log(),
      event({
        id: 'ev_4',
        at: at(4),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_new',
        action: 'retract',
      }),
      event({
        id: 'ev_5',
        at: at(5),
        actor: human(),
        type: 'object_corrected',
        objectId: 'obj_new',
        action: 'restore',
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_old?.supersededById).toBe('obj_new');
    expect(
      state.objects.obj_old?.object.type === 'decision' &&
        state.objects.obj_old.object.payload.status,
    ).toBe('superseded');
  });
});

describe('r8 — the attention panel keeps the promises the engine makes', () => {
  const stagedClaim = () =>
    event({
      id: 'ev_p',
      at: at(1),
      actor: model(),
      type: 'proposal_recorded',
      proposal: {
        id: 'prop_laundered',
        roomId: ROOM,
        type: 'claim',
        payload: { statement: 'We will deploy production Friday afternoon.', claimant: BOB },
        confidence: 0.95,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: ['m1'],
        quote: 'We will deploy production Friday afternoon.',
        createdAt: at(1),
      },
    });

  it('renders the laundered reading the engine sent to Needs-you', () => {
    // `acceptance.ts` promises: *"it goes to Needs-you with its quote for a
    // person to accept or decline"*, and the r7 adjudication rested on that
    // sentence. On r7 the engine said `pending / needs_you` and this projection
    // returned zero items and zero refusals, because the loop dropped every
    // proposal that was not a decision or a commitment before reading the
    // verdict.
    const messages = window('We will deploy production Friday afternoon.');
    const state = reduce([stagedClaim()]);
    expect(
      decideAcceptance(state.proposals.prop_laundered?.proposal as Proposal, { messages })
        .visibility,
    ).toBe('needs_you');

    const projection = projectAttention(state, {
      now: at(5),
      messages,
      members: { [ROOM]: [ALICE, BOB] },
    });
    expect(projection.items.map((item) => item.userId).sort()).toEqual([ALICE, BOB]);
    for (const item of projection.items) {
      expect(item.class).toBe('needs_decision');
      expect(item.subjectKind).toBe('proposal');
      expect(item.objectId).toBe('prop_laundered');
      expect(item.reason.kind).toBe('reading_pending');
    }
  });

  it('does not raise one for a reading the engine accepted', () => {
    // The panel asks the engine; it does not hold a second opinion. An
    // unambiguous assertion auto-accepts and raises nothing.
    const body = 'The backfill completed with 4,218,904 rows and no retries.';
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_plain',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: body, claimant: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['m1'],
          quote: body,
          createdAt: at(1),
        },
      }),
    ]);
    expect(
      projectAttention(state, {
        now: at(5),
        messages: window(body),
        members: { [ROOM]: [ALICE, BOB] },
      }).items,
    ).toEqual([]);
  });
});

describe('r8 — attention bookkeeping', () => {
  const item = (overrides: Partial<AttentionItem> & { id: string }): AttentionItem =>
    ({
      roomId: ROOM,
      userId: ALICE,
      objectId: 'obj_1',
      subjectKind: 'object',
      class: 'owned_commitment',
      reason: { kind: 'commitment_open', statement: 'land the fix', due: null },
      status: 'pending',
      createdAt: at(1),
      ...overrides,
    }) as AttentionItem;

  /**
   * A hand-built cycle. r10 made `reconcileAttention` take the whole
   * `AttentionProjection` rather than its items, because an item list alone
   * cannot say whether the cycle *looked* — so these tests now have to state
   * which subjects were examined, which is the assumption they were making
   * silently before.
   */
  const cycle = (
    items: ComputedAttentionItem[],
    examined: ExaminedSubject[] = [],
  ): AttentionProjection => ({ items, refusals: [], examined });
  // r11: an examination names the producer that made it, because one class can
  // have two of them. `commitment_open` — the rationale these items carry — is
  // `commitmentItems`' work, so this is the declaration that half would make.
  const sawObj1: ExaminedSubject[] = [
    {
      class: 'owned_commitment',
      subjectKind: 'object',
      subjectId: 'obj_1',
      producer: 'open_commitment',
    },
  ];

  it('keeps a dismissal across a cycle that computes nothing', () => {
    // r7 dropped every stored non-pending item that was not recomputed, so a
    // dismissal survived one cycle and not two — and there is a documented path
    // (no `messages`) that empties `computed` wholesale, which wiped every
    // dismissal in the room and re-minted the lot as `pending` next time.
    const computed = [{ ...item({ id: 'attn:a' }), priority: 4 }];
    const afterDismiss = [{ ...item({ id: 'attn:a', status: 'dismissed' }), priority: 4 }];

    const emptyCycle = reconcileAttention(afterDismiss, cycle([], sawObj1));
    expect(emptyCycle.map((entry) => [entry.id, entry.status])).toEqual([['attn:a', 'dismissed']]);

    const backAgain = reconcileAttention(emptyCycle, cycle(computed, sawObj1));
    expect(backAgain.map((entry) => [entry.id, entry.status])).toEqual([['attn:a', 'dismissed']]);
  });

  it('still resolves a pending item that stopped being computed', () => {
    // The cycle looked at `obj_1` and raised nothing: that is rule 2's case and
    // it still fires. Its twin is below — the same input with nothing examined.
    const stored = [item({ id: 'attn:b' })];
    expect(reconcileAttention(stored, cycle([], sawObj1)).map((entry) => entry.status)).toEqual([
      'resolved',
    ]);
  });

  /**
   * **Catches**: reverting rule 2 to `entry.status === 'pending' ? 'resolved' :
   * entry.status` — r10's §2, at the unit. Two cycles that compute nothing are
   * opposite facts about the world: one examined the subject and found it
   * finished, one never got to look. r9 gave both the same answer, and the
   * answer was the destructive one.
   */
  it('leaves a pending item alone when the cycle never examined its subject', () => {
    const stored = [item({ id: 'attn:b' })];
    expect(reconcileAttention(stored, cycle([])).map((entry) => entry.status)).toEqual(['pending']);
    // …and a different subject's examination is not this subject's.
    const elsewhere: ExaminedSubject[] = [
      {
        class: 'owned_commitment',
        subjectKind: 'object',
        subjectId: 'obj_2',
        producer: 'open_commitment',
      },
      // Same subject, different class: an item is `(class, kind, subject)`.
      { class: 'mention', subjectKind: 'object', subjectId: 'obj_1', producer: 'mention_signal' },
      // Same subject and class, different namespace.
      {
        class: 'owned_commitment',
        subjectKind: 'proposal',
        subjectId: 'obj_1',
        producer: 'staged_proposal',
      },
      // **r11**: same subject, same class, same namespace — a *different
      // producer*. `commitmentItems` raised this item and only `commitmentItems`
      // may say it is finished. Without the producer in the key this entry alone
      // would resolve it.
      {
        class: 'owned_commitment',
        subjectKind: 'object',
        subjectId: 'obj_1',
        producer: 'staged_proposal',
      },
    ];
    expect(reconcileAttention(stored, cycle([], elsewhere)).map((entry) => entry.status)).toEqual([
      'pending',
    ]);
  });

  it('sorts an out-of-enum class last instead of above everything', () => {
    // `Number.MAX_SAFE_INTEGER + (exhaustive as unknown as number)` is `NaN`, a
    // comparator returning `NaN` is not an ordering, and the unrecognised class
    // took the top of somebody's Needs-you.
    const rogue = {
      ...item({ id: 'attn:rogue' }),
      class: 'from_the_future',
    } as unknown as AttentionItem;
    const decision = item({
      id: 'attn:decision',
      class: 'needs_decision',
      subjectKind: 'proposal',
      reason: { kind: 'decision_pending', statement: 'ship it', assigned: false },
    });
    expect(sortAttention([rogue, decision]).map((entry) => entry.id)).toEqual([
      'attn:decision',
      'attn:rogue',
    ]);
  });

  it('is byte-identical whichever order the mentions arrive in', () => {
    // Two signals naming one person on one object produced two items with the
    // same id and different rationale text, so a stable sort handed back
    // whichever order the caller supplied — and the projection's whole contract
    // is that it is recomputable byte for byte.
    const state = reduce([
      event({
        id: 'ev_1',
        at: at(1),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: 'obj_1',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: 'the index landed', claimant: BOB },
          createdAt: at(1),
          updatedAt: at(1),
        },
      }),
    ]);
    const a = { roomId: ROOM, objectId: 'obj_1', userId: ALICE, request: 'can you review this?' };
    const b = { roomId: ROOM, objectId: 'obj_1', userId: ALICE, request: 'and the runbook too?' };
    const forwards = computeAttention(state, { now: at(5), mentions: [a, b] });
    const backwards = computeAttention(state, { now: at(5), mentions: [b, a] });
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
    expect(new Set(forwards.map((entry) => entry.id)).size).toBe(forwards.length);
  });

  it('cannot be made to collide across the proposal and object namespaces', () => {
    // The id was `attn:${userId}:${subjectId}:${class}` with no namespace in it,
    // so a staged commitment awaiting Bob's confirm and an accepted commitment
    // Bob owns produced **one id** when the proposal id equalled the object id.
    // `reconcileAttention` keys on the id, so one inherits the other's
    // dismissal, or replaces it in the panel outright.
    const shared = 'thing_1';
    const body = '@user_bob will land the narrowing fix in the type checker.';
    // Alice's sentence, Bob's name on it — the third-party shape that raises a
    // confirm for Bob, beside the commitment he already owns.
    const messages = room(
      { id: 'm1', authorId: ALICE, body },
      { id: 'm2', authorId: ALICE, body: 'noted, thanks' },
    );
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: shared,
          roomId: ROOM,
          type: 'commitment',
          payload: { statement: body, owner: BOB },
          confidence: 0.95,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['m1'],
          quote: body,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_o',
        at: at(2),
        actor: human(),
        type: 'object_accepted',
        object: {
          id: shared,
          roomId: ROOM,
          type: 'commitment',
          payload: { statement: 'land the narrowing fix', owner: BOB },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    const items = computeAttention(state, { now: at(5), messages });
    expect(items.length).toBeGreaterThan(1);
    expect(new Set(items.map((entry) => entry.id)).size).toBe(items.length);
  });

  it('serializes a state with its keys sorted, whatever order they were built in', () => {
    // `state.ts` had no mutant at all until r8, and `canonicalJson` is the
    // instrument every determinism and live≡replay test in this package measures
    // with. Dropping the `.sort()` leaves all of them asserting nothing about
    // key order, and nothing else in the suite noticed — every state those
    // tests build has the same insertion order on both sides.
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(canonicalJson({ a: { c: 3, d: 4 }, b: 1 })).toBe(
      canonicalJson({ b: 1, a: { d: 4, c: 3 } }),
    );
  });
});

describe('r8 — the floor table says what the code does', () => {
  it('is derived from the θ table, entry by entry', () => {
    // `authority.ts` claimed `MODEL_ACCEPTANCE_FLOOR.claim` had been `+Infinity`
    // since r7 in two separate comments. It is 0.7, and a model lands a claim
    // end to end at it — that was r7's *reverted* draft, described in the
    // present tense. A prose claim about a number is checkable against the
    // number, so it is checked.
    for (const [type, rule] of Object.entries(DEFAULT_ACCEPTANCE_RULES)) {
      expect(MODEL_ACCEPTANCE_FLOOR[type as keyof typeof MODEL_ACCEPTANCE_FLOOR], type).toBe(
        autoAcceptable(type as keyof typeof MODEL_ACCEPTANCE_FLOOR)
          ? rule.thetaAuto
          : Number.POSITIVE_INFINITY,
      );
    }
    expect(MODEL_ACCEPTANCE_FLOOR.claim).toBe(0.7);
    expect(Number.isFinite(MODEL_ACCEPTANCE_FLOOR.claim)).toBe(true);
  });

  it('lands a model claim at the floor when the words certify the type', () => {
    const body = 'The backfill completed with 4,218,904 rows and no retries.';
    const messages = window(body);
    const state = reduce([
      event({
        id: 'ev_p',
        at: at(1),
        actor: model(),
        type: 'proposal_recorded',
        proposal: {
          id: 'prop_floor',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: body, claimant: BOB },
          confidence: MODEL_ACCEPTANCE_FLOOR.claim,
          proposer: { kind: 'model', model: 'test-model' },
          provenance: ['m1'],
          quote: body,
          createdAt: at(1),
        },
      }),
      event({
        id: 'ev_a',
        at: at(2),
        actor: model(),
        messages,
        type: 'object_accepted',
        object: {
          id: 'obj_floor',
          roomId: ROOM,
          type: 'claim',
          payload: { statement: body, claimant: BOB },
          provenance: { messageIds: ['m1'], proposalId: 'prop_floor' },
          createdAt: at(2),
          updatedAt: at(2),
        },
      }),
    ]);
    expect(state.issues).toEqual([]);
    expect(state.objects.obj_floor?.object.type).toBe('claim');
  });
});
