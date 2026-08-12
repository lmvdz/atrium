import { readFileSync } from 'node:fs';
import {
  type Actor,
  type AuthoredEvent,
  authored,
  CoreEvent,
  type ProvenanceMessage,
  reduce,
} from '@atrium/core';
import { describe, expect, it } from 'vitest';
import { contextualReferenceAttention } from '../lib/contextual-reference-attention';
import { liveRoomView, shouldRefreshLiveRoute } from '../lib/live-room-view';
import type { ReplayData } from '../lib/replay-data';
import { reopenQuestion } from '../lib/replay-transitions';
import {
  activeAnswerMatchesClientMessage,
  activeAnswerMessageId,
  replayAt,
  replayReceipt,
  replayView,
} from '../lib/replay-view';
import { needsViewer, withFilter } from '../src/components';
import { glyphFor } from '../src/components/model';
import type { RoomView } from '../src/lib/realtime';
import { workspacePath } from './support/workspace-path';

const at = new Date('2026-08-02T12:00:00.000Z');
/**
 * Mutation: anchor this inspected client boundary to the process cwd. Running
 * the repository-wide suite from the root then fails before the refresh
 * mutations are judged, while the package-local suite misleadingly passes.
 */
const liveRoomSession = workspacePath('apps/web/app/app/[workspace]/[room]/LiveRoomSession.tsx');
const replayDataSource = workspacePath('apps/web/lib/replay-data.ts');

describe('contextual direct-reference placement', () => {
  const mention = (id: string, messageId: string, userId = 'alice') => ({
    id,
    roomId: 'room',
    userId,
    subjectKind: 'message' as const,
    subjectId: messageId,
    subjectObjectId: null,
    subjectProposalId: null,
    subjectMessageId: messageId,
    class: 'mention' as const,
    reason: { kind: 'mention' as const, request: 'direct reference' },
    status: 'pending' as const,
    createdAt: at,
    resolvedAt: null,
  });

  /* CATCHES: filing a reference under the currently open or first objective
     instead of following the persisted object-source edge from its message. */
  it('uses durable objective/object provenance and leaves unsourced chat in conversation', () => {
    const snapshot = data();
    const firstMessage = snapshot.messages[0];
    if (!firstMessage) throw new Error('reference placement fixture has no source message');
    snapshot.messages.push({
      ...firstMessage,
      id: 'm3',
      seq: 3,
      body: 'an unfiled direct reference',
    });
    snapshot.objects.push(
      {
        id: 'objective',
        roomId: 'room',
        type: 'objective',
        payload: { title: 'Ship it', status: 'open' },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        acceptedByKind: 'human',
        humanTouchedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'decision',
        roomId: 'room',
        type: 'decision',
        payload: { statement: 'Use the durable edge.', decidedBy: 'alice', status: 'active' },
        objectiveId: 'objective',
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        acceptedByKind: 'human',
        humanTouchedAt: at,
        createdAt: at,
        updatedAt: at,
      },
    );
    const sources = snapshot.objectSources as unknown as Array<{
      roomId: string;
      objectId: string;
      messageId: string;
    }>;
    sources.push(
      { roomId: 'room', objectId: 'objective', messageId: 'm1' },
      { roomId: 'room', objectId: 'decision', messageId: 'm2' },
    );
    snapshot.attention.push(mention('mention-objective', 'm1'));
    snapshot.attention.push(mention('mention-object', 'm2'));
    snapshot.attention.push(mention('mention-unfiled', 'm3'));

    expect(contextualReferenceAttention(snapshot, 'alice')).toEqual([
      {
        attentionId: 'mention-objective',
        messageId: 'm1',
        location: { kind: 'objective', id: 'objective' },
      },
      {
        attentionId: 'mention-object',
        messageId: 'm2',
        location: { kind: 'object', id: 'decision' },
      },
      {
        attentionId: 'mention-unfiled',
        messageId: 'm3',
        location: { kind: 'conversation', id: null },
      },
    ]);
  });

  /* CATCHES: projecting every pending room mention to every participant, which
     leaks another user's attention and inflates the viewer's row markers. */
  it('projects only the current viewer and only pending direct message references', () => {
    const snapshot = data();
    const participants = snapshot.participants as unknown as Array<{
      id: string;
      name: string;
      avatarUrl: string | null;
    }>;
    participants.push({ id: 'bob', name: 'bob', avatarUrl: null });
    snapshot.attention.push(mention('mine', 'm1'));
    snapshot.attention.push(mention('theirs', 'm1', 'bob'));
    snapshot.attention.push({ ...mention('resolved', 'm2'), status: 'resolved', resolvedAt: at });
    snapshot.attention.push({ ...mention('dismissed', 'm3'), status: 'dismissed', resolvedAt: at });
    expect(contextualReferenceAttention(snapshot, 'alice').map((item) => item.attentionId)).toEqual(
      ['mine'],
    );
  });

  /* CATCHES: guessing a viewer from whichever participant owns a pending
     reference, which leaks that person's attention on an anonymous replay. */
  it('projects no personal attention without an exact current viewer', () => {
    const snapshot = data();
    snapshot.attention.push(mention('alice-private', 'm1'));
    expect(contextualReferenceAttention(snapshot, undefined)).toEqual([]);
    expect(contextualReferenceAttention(snapshot, 'not-a-participant')).toEqual([]);
  });
});

function data(): ReplayData {
  return {
    room: {
      id: 'room',
      name: 'isr-rfc',
      slug: 'nextjs-isr',
      workspaceId: 'workspace',
      workspaceName: 'Atrium replay',
      workspaceSlug: 'replay',
    },
    // A real load selects `users.principal_kind` (NOT NULL), so the fixture
    // carries one too; `participantKindOf` now fails CLOSED to `'unknown'` for an
    // absent value rather than defaulting to a person, and this participant is a
    // person on purpose.
    participants: [{ id: 'alice', name: 'alice', avatarUrl: null, principalKind: 'human' }],
    messages: [
      {
        id: 'm1',
        seq: 1,
        authorId: 'alice',
        author: 'alice',
        body: 'Should regeneration happen in the background?',
        replyToId: null,
        attachments: [],
        createdAt: at,
      },
      {
        id: 'm2',
        seq: 2,
        authorId: 'alice',
        author: 'alice',
        body: 'Yes, while the previous page remains available.',
        clientMessageId: 'client-answer-a',
        replyToId: 'm1',
        attachments: [],
        createdAt: new Date('2026-08-02T12:01:00.000Z'),
      },
    ],
    interpretations: [],
    proposals: [],
    proposalSources: [],
    objects: [],
    objectSources: [],
    relations: [],
    attention: [],
    corrections: [],
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * REACHABLE machine acceptances — folded through @atrium/core, not hand-built.
 *
 * #98 r2, finding 3: a machine may NOT accept directly. The reducer refuses
 * every non-human acceptance whose object carries `proposalId: null`
 * (`reduce.ts` ~733) — a machine's one door to a fact is to stage a proposal and
 * accept THAT proposal, and only one it itself staged (`actorMatchesProposer`).
 * The round-2 M5 rows set `acceptedByKind: 'model'` with `proposalId: null`, an
 * impossible state the engine can never reach, so the fixture proved nothing
 * about the machine path it claimed to cover. These fold real
 * `proposal_recorded` + `object_accepted` events and read the resulting
 * `ObjectRecord` off the reduced state, so every fixture is exactly a state the
 * reducer produces — and the predicate still governs the rendered glyph.
 * ─────────────────────────────────────────────────────────────────────────── */
const ROOM = 'room';
const MODEL: Actor = { kind: 'model', model: 'replay/precomputed-v1' };
const HUMAN: Actor = { kind: 'human', userId: 'alice' };
const CLAIM_TEXT = 'Background regeneration keeps the old page live.';
const QUESTION_TEXT = 'Should regeneration happen in the background?';
const ANSWER_TEXT = 'Yes — the old page stays live during regeneration.';
/** The room the receipts are judged against; every cited message is ALICE's own. */
const WINDOW: readonly ProvenanceMessage[] = [
  { id: 'mc', authorId: 'alice', body: CLAIM_TEXT },
  { id: 'mq', authorId: 'alice', body: QUESTION_TEXT },
  { id: 'ma', authorId: 'alice', body: ANSWER_TEXT },
];
let seq = 0;
function ts(): string {
  seq += 1;
  return new Date(Date.UTC(2026, 7, 2, 12, 0, seq)).toISOString();
}

function ev(raw: Record<string, unknown>, actor: Actor): AuthoredEvent {
  return authored(CoreEvent.parse(raw), { actor, messages: WINDOW });
}

/** Fold a log and project the resulting `ObjectRecord` into the read-model row shape. */
function foldObjectRow(
  events: readonly AuthoredEvent[],
  objectId: string,
): ReplayData['objects'][number] {
  const state = reduce(events);
  const record = state.objects[objectId];
  if (!record) {
    throw new Error(
      `fold did not produce object ${objectId}; issues: ${JSON.stringify(state.issues)}`,
    );
  }
  const acceptedBy =
    record.acceptedBy.kind === 'human' || record.acceptedBy.kind === 'agent'
      ? record.acceptedBy.userId
      : null;
  return {
    id: record.object.id,
    roomId: record.object.roomId,
    type: record.object.type,
    payload: record.object.payload,
    objectiveId: record.object.objectiveId ?? null,
    proposalId: record.object.provenance.proposalId,
    revision: record.revision,
    retractedAt: record.retractedAt === null ? null : new Date(record.retractedAt),
    supersededById: record.supersededById,
    acceptedBy,
    acceptedByKind: record.acceptedBy.kind,
    humanTouchedAt: record.humanTouchedAt === null ? null : new Date(record.humanTouchedAt),
    createdAt: new Date(record.object.createdAt),
    updatedAt: new Date(record.updatedAt),
  } as ReplayData['objects'][number];
}

/** A human directly accepts a claim — the `✓` case, reachable with `proposalId: null`. */
function foldHumanClaim(id: string): ReplayData['objects'][number] {
  return foldObjectRow(
    [
      ev(
        {
          id: `ev_${id}`,
          at: ts(),
          type: 'object_accepted',
          object: {
            id,
            roomId: ROOM,
            type: 'claim',
            payload: { statement: CLAIM_TEXT, claimant: 'alice' },
            provenance: { messageIds: ['mc'], proposalId: null },
            createdAt: ts(),
            updatedAt: ts(),
          },
        },
        HUMAN,
      ),
    ],
    id,
  );
}

/** A model stages a claim proposal and accepts its OWN proposal — the reachable `~` case. */
function foldMachineClaim(id: string): ReplayData['objects'][number] {
  const proposalId = `prop_${id}`;
  return foldObjectRow(
    [
      ev(
        {
          id: `evp_${id}`,
          at: ts(),
          type: 'proposal_recorded',
          proposal: {
            id: proposalId,
            roomId: ROOM,
            type: 'claim',
            payload: { statement: CLAIM_TEXT, claimant: 'alice' },
            confidence: 0.95,
            proposer: MODEL,
            provenance: ['mc'],
            quote: CLAIM_TEXT,
            createdAt: ts(),
          },
        },
        MODEL,
      ),
      ev(
        {
          id: `eva_${id}`,
          at: ts(),
          type: 'object_accepted',
          object: {
            id,
            roomId: ROOM,
            type: 'claim',
            payload: { statement: CLAIM_TEXT, claimant: 'alice' },
            provenance: { messageIds: ['mc'], proposalId },
            createdAt: ts(),
            updatedAt: ts(),
          },
        },
        MODEL,
      ),
    ],
    id,
  );
}

/**
 * An answered open_question whose ACCEPTANCE was `accepter`'s. Answeredness comes
 * from a human `answers` relation (the only actor that may bind one) onto a
 * human-accepted answer claim — and it never touches the QUESTION's acceptance,
 * so a machine-accepted question stays `~` even once answered: the covenant's
 * point that answeredness never mints the tick.
 */
function foldAnsweredQuestion(
  id: string,
  accepter: 'human' | 'model',
): ReplayData['objects'][number] {
  const answerId = `${id}-answer`;
  const events: AuthoredEvent[] = [];
  if (accepter === 'model') {
    const proposalId = `prop_${id}`;
    events.push(
      ev(
        {
          id: `evp_${id}`,
          at: ts(),
          type: 'proposal_recorded',
          proposal: {
            id: proposalId,
            roomId: ROOM,
            type: 'open_question',
            payload: { question: QUESTION_TEXT },
            confidence: 0.95,
            proposer: MODEL,
            provenance: ['mq'],
            quote: QUESTION_TEXT,
            createdAt: ts(),
          },
        },
        MODEL,
      ),
      ev(
        {
          id: `eva_${id}`,
          at: ts(),
          type: 'object_accepted',
          object: {
            id,
            roomId: ROOM,
            type: 'open_question',
            payload: { question: QUESTION_TEXT },
            provenance: { messageIds: ['mq'], proposalId },
            createdAt: ts(),
            updatedAt: ts(),
          },
        },
        MODEL,
      ),
    );
  } else {
    events.push(
      ev(
        {
          id: `eva_${id}`,
          at: ts(),
          type: 'object_accepted',
          object: {
            id,
            roomId: ROOM,
            type: 'open_question',
            payload: { question: QUESTION_TEXT },
            provenance: { messageIds: ['mq'], proposalId: null },
            createdAt: ts(),
            updatedAt: ts(),
          },
        },
        HUMAN,
      ),
    );
  }
  events.push(
    ev(
      {
        id: `evans_${id}`,
        at: ts(),
        type: 'object_accepted',
        object: {
          id: answerId,
          roomId: ROOM,
          type: 'claim',
          payload: { statement: ANSWER_TEXT, claimant: 'alice' },
          provenance: { messageIds: ['ma'], proposalId: null },
          createdAt: ts(),
          updatedAt: ts(),
        },
      },
      HUMAN,
    ),
    ev(
      {
        id: `evrel_${id}`,
        at: ts(),
        type: 'relation_added',
        relation: {
          id: `rel_${id}`,
          roomId: ROOM,
          kind: 'answers',
          fromObjectId: id,
          to: { kind: 'object', objectId: answerId },
          createdAt: ts(),
        },
      },
      HUMAN,
    ),
  );
  return foldObjectRow(events, id);
}

describe('persisted replay view', () => {
  /** CATCHES: hiding a persisted semantic message after staging failed, leaving no retry. */
  it('marks an unstaged authored semantic message for idempotent retry', () => {
    const snapshot: ReplayData = {
      ...data(),
      messages: data().messages.map((message) =>
        message.id === 'm1'
          ? { ...message, body: '/goal Preserve this message', clientMessageId: 'semantic:alice:1' }
          : message,
      ),
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 1,
      head: 1,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    });
    expect(view.entries.find((entry) => entry.id === 'm1')).toMatchObject({
      tag: { label: 'retry semantic staging' },
      note: { text: 'the message is saved; its semantic proposal has not been staged' },
    });
  });

  /** CATCHES: continuing to claim staging failed after provenance was projected. */
  it('removes semantic retry once any proposal cites the message', () => {
    const snapshot: ReplayData = {
      ...data(),
      messages: data().messages.map((message) =>
        message.id === 'm1'
          ? { ...message, body: '/goal Done', clientMessageId: 'semantic:alice:1' }
          : message,
      ),
      proposalSources: [{ roomId: 'room', proposalId: 'p1', messageId: 'm1' }],
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 1,
      head: 1,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    });
    expect(view.entries.find((entry) => entry.id === 'm1')).toMatchObject({ tag: null });
  });
  /**
   * H5/H6, M5/M7 — the rendered ✓ IS core's one certification predicate, for the
   * TWO types a machine can actually accept.
   *
   * `modelMintingGate` lets a machine accept exactly a `claim` and an
   * `open_question` — and those were the two types whose glyph `stateForObject`
   * read from their own payload (`claim.verification`, `question.status`) in a
   * branch that returned before the predicate. So the round-1 M5 test was a
   * false-green: it used a machine-accepted DECISION, a state the reducer
   * refuses, which fell through to the predicate and could never have exposed
   * the bug. This exercises the reachable ones.
   *
   * MUTATION (M5): flip `epistemic.ts`'s `epistemicStateOf` to `return
   * 'confirmed'` and BOTH machine acceptances below render ✓ — every `~`
   * assertion here fails. The character a user sees moves with the predicate,
   * for a claim and for an answered question, off the projected
   * `accepted_by_kind`/`human_touched_at` columns and nothing else.
   */
  it('renders a machine-accepted claim and answered question ~, and the predicate moves the glyph', () => {
    const snapshot = data();
    // Every row below is FOLDED THROUGH THE REDUCER (see foldObjectRow): the
    // machine acceptances cite a same-model staged proposal, exactly as the
    // reducer demands, so no fixture is a hand-built impossibility. A machine may
    // only mint an UNVERIFIED claim (the reducer's `claim_verification` gate is
    // human-only), which is the state the fold produces.
    snapshot.objects.push(
      foldHumanClaim('claim-by-person'),
      foldMachineClaim('claim-by-machine'),
      foldAnsweredQuestion('answer-by-person', 'human'),
      foldAnsweredQuestion('answer-by-machine', 'model'),
    );

    // The reachability the fixtures now assert, made explicit: the machine claim
    // and the machine-accepted answered question both cite a real staged
    // proposal, and the answered question really did flip to `answered`.
    const machine = snapshot.objects.find((object) => object.id === 'claim-by-machine');
    expect(machine?.acceptedByKind).toBe('model');
    expect(machine?.proposalId).not.toBeNull();
    const machineQuestion = snapshot.objects.find((object) => object.id === 'answer-by-machine');
    if (!machineQuestion) throw new Error('machine answered question must fold');
    expect(machineQuestion.acceptedByKind).toBe('model');
    expect(machineQuestion.proposalId).not.toBeNull();
    expect((machineQuestion.payload as { status?: string }).status).toBe('answered');

    const view = replayView(snapshot, 'alice');
    const glyph = (id: string) => {
      const object = view.objects.find((candidate) => candidate.id === id);
      if (!object) throw new Error(`object ${id} must render`);
      return glyphFor(object.state);
    };

    // ── Covenant, DIRECTION ONE: a human-confirmed claim renders ✓ (was ~,
    //    finding 3: the fold said `confirmed`, replay emitted `self_reported`).
    expect(glyph('claim-by-person')).toBe('✓');
    // ── Covenant, DIRECTION TWO: an unconfirmed ANSWERED question renders ~ (was
    //    ✓, finding 2: `status='answered'` minted the tick with no human touch).
    expect(glyph('answer-by-machine')).toBe('~');
    // A human-certified answered question is ✓; a machine-accepted claim is ~.
    expect(glyph('answer-by-person')).toBe('✓');
    expect(glyph('claim-by-machine')).toBe('~');

    // MUTATION anchor: these two `~` come SOLELY from `epistemicStateOf`
    // returning `unconfirmed`. Flip it to `confirmed` and both become `✓`.
    const machineClaim = view.objects.find((object) => object.id === 'claim-by-machine');
    const machineAnswer = view.objects.find((object) => object.id === 'answer-by-machine');
    expect(machineClaim?.state.verification).toBe('self_reported');
    expect(machineAnswer?.state.verification).toBe('proposed');
  });

  /**
   * Mutation: retain final worker rows while scrubbing an earlier message
   * prefix. The replay then presents a conclusion before its source was read.
   */
  it('withholds the worker result until the complete imported corpus is visible', () => {
    const snapshot = data();
    expect(replayAt(snapshot, 0).messages).toEqual([]);
    expect(replayAt(snapshot, 0).objects).toEqual([]);
    expect(replayAt(snapshot, snapshot.messages.length)).toBe(snapshot);
  });

  /**
   * Mutation: source the feed from gallery fixtures or truncate the persisted
   * messages. The two database records no longer produce exactly two message
   * rows beneath the derived replay divider.
   * Mutation: carry reply text separately instead of deriving it from m1. The
   * reply citation no longer names the record whose words it displays.
   * Mutation: hand-write the divider's class totals. Its discussion count no
   * longer follows the two persisted human-authored rows.
   */
  it('derives every conversation row and reply citation from persisted messages', () => {
    const view = replayView(data(), 'alice');
    expect(view.records.map((record) => record.text)).toEqual([
      'Should regeneration happen in the background?',
      'Yes, while the previous page remains available.',
    ]);
    expect(view.entries).toHaveLength(3);
    expect(view.entries[0]).toMatchObject({
      type: 'since-you-left',
      counts: { need: 0, change: 0, discussion: 2, routine: 0 },
      total: 2,
    });
    expect(view.entries[2]?.type).toBe('message');
    if (view.entries[2]?.type !== 'message') throw new Error('third row is not a message');
    expect(view.entries[2].replyTo?.messageId).toBe('m1');
    // The head's members are DERIVED from this single participant source now, not
    // carried a second time on `view.room`; asserting the source is asserting
    // what the head renders.
    expect(view.participants.map((p) => ({ name: p.name, kind: p.kind }))).toEqual([
      { name: 'alice', kind: 'human' },
    ]);
  });

  /**
   * Mutation: copy an accepted object's epistemic state onto its entire source
   * message. A mixed or long human post then appears wholly certified even
   * though the persisted edge proves only the extracted semantic sentence.
   */
  it('keeps a semantic source message as ordinary conversation', () => {
    const snapshot = data();
    snapshot.objects.push({
      id: 'decision',
      roomId: 'room',
      type: 'decision',
      payload: { statement: 'Regenerate in the background.', decidedBy: 'alice', status: 'active' },
      objectiveId: null,
      proposalId: null,
      revision: 0,
      retractedAt: null,
      supersededById: null,
      acceptedBy: 'alice',
      acceptedByKind: 'human',
      humanTouchedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    const objectSources = snapshot.objectSources as unknown as Array<{
      roomId: string;
      objectId: string;
      messageId: string;
    }>;
    objectSources.push({ roomId: 'room', objectId: 'decision', messageId: 'm1' });

    const sourceRow = replayView(snapshot, 'alice').entries[1];
    if (sourceRow?.type !== 'message') throw new Error('source row is not a message');
    expect(sourceRow.state).toEqual({
      kind: 'event',
      verification: 'routine',
      owedToViewer: false,
      irreversible: false,
    });
  });

  /**
   * Mutation: omit staged objectives or present a model proposal as accepted.
   * A corpus with no human certification then either loses its Current-state
   * grouping or paints a machine reading with settled authority.
   */
  it('groups persisted drafts under a proposed objective without certifying them', () => {
    const snapshot = data();
    const proposal = (
      id: string,
      type: 'objective' | 'decision',
      payload: ReplayData['proposals'][number]['payload'],
      quote: string,
    ): ReplayData['proposals'][number] => ({
      id,
      roomId: 'room',
      interpretationId: null,
      type,
      payload,
      confidence: 0.95,
      proposerKind: 'model',
      proposerModel: 'replay/precomputed-v1',
      proposerUserId: null,
      stagedByKind: 'model',
      stagedById: 'replay/precomputed-v1',
      quote,
      status: 'proposed',
      decidedBy: null,
      decidedAt: null,
      rejectedReason: null,
      createdAt: at,
    });
    snapshot.proposals.push(
      proposal(
        'objective-draft',
        'objective',
        {
          title: 'Choose a regeneration strategy.',
          status: 'open',
        } as unknown as ReplayData['proposals'][number]['payload'],
        'Choose a regeneration strategy.',
      ),
      proposal(
        'decision-draft',
        'decision',
        {
          statement: 'Regenerate in the background.',
          decidedBy: null,
          status: 'active',
        } as ReplayData['proposals'][number]['payload'],
        'Regenerate in the background.',
      ),
    );

    const view = replayView(snapshot, 'alice');
    expect(view.objectives).toContainEqual({
      id: 'objective-draft',
      title: 'Choose a regeneration strategy.',
      status: 'proposed',
      open: true,
    });
    const decisionDraft = view.objects.find((object) => object.id === 'decision-draft');
    expect(decisionDraft).toMatchObject({
      state: { verification: 'proposed' },
      objectives: ['objective-draft'],
    });
    if (!decisionDraft) throw new Error('decision draft missing');
    expect(replayReceipt(snapshot, view.records, decisionDraft).acceptable).toBe(true);
  });

  /**
   * Mutation: resolve the first answer edge or the first claim source rather
   * than the exact relation retained by the reopen transition. The receipt
   * quotes m2 instead of the answer selected by relation-good.
   */
  it('resolves a reopened question through its retained answer relation', () => {
    const snapshot = data();
    snapshot.messages.push({
      id: 'm3',
      seq: 3,
      authorId: 'alice',
      author: 'alice',
      body: 'The retained answer is the background regeneration claim.',
      clientMessageId: 'client-answer-b',
      replyToId: 'm1',
      attachments: [],
      createdAt: new Date('2026-08-02T12:02:00.000Z'),
    });
    snapshot.objects.push(
      {
        id: 'question',
        roomId: 'room',
        type: 'open_question',
        payload: { question: 'Should regeneration happen in the background?', status: 'answered' },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        acceptedByKind: 'human',
        humanTouchedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      ...(['wrong-answer', 'retained-answer'] as const).map((id, index) => ({
        id,
        roomId: 'room',
        type: 'claim' as const,
        payload: {
          statement:
            index === 0
              ? 'Yes, while the previous page remains available.'
              : 'The retained answer is the background regeneration claim.',
          claimant: 'alice',
          verification: 'unverified' as const,
        },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        acceptedByKind: 'human' as const,
        humanTouchedAt: at,
        createdAt: at,
        updatedAt: at,
      })),
    );
    const objectSources = snapshot.objectSources as unknown as Array<{
      roomId: string;
      objectId: string;
      messageId: string;
    }>;
    objectSources.push(
      { roomId: 'room', objectId: 'question', messageId: 'm1' },
      { roomId: 'room', objectId: 'wrong-answer', messageId: 'm2' },
      { roomId: 'room', objectId: 'retained-answer', messageId: 'm3' },
    );
    snapshot.relations.push(
      {
        id: 'relation-wrong',
        roomId: 'room',
        kind: 'answers',
        fromObjectId: 'question',
        toObjectId: 'wrong-answer',
        toMessageId: null,
        toUrl: null,
        toFileKey: null,
        note: null,
        createdBy: 'alice',
        createdAt: at,
      },
      {
        id: 'relation-good',
        roomId: 'room',
        kind: 'answers',
        fromObjectId: 'question',
        toObjectId: 'retained-answer',
        toMessageId: null,
        toUrl: null,
        toFileKey: null,
        note: null,
        createdBy: 'alice',
        createdAt: at,
      },
    );

    const view = replayView(snapshot, 'alice');
    const question = view.objects.find((object) => object.id === 'question');
    if (!question) throw new Error('question view missing');
    /** CATCHES: marking a question answered while omitting the accepted answer's exact source. */
    const answeredReceipt = replayReceipt(snapshot, view.records, question);
    expect(answeredReceipt.provenance.map((entry) => entry.excerpt.messageId)).toEqual([
      'm1',
      'm3',
    ]);
    expect(answeredReceipt.provenance[1]?.note?.text).toBe(
      'accepted answer linked to this question',
    );
    snapshot.corrections.push({
      id: 'persisted-reopen',
      roomId: 'room',
      objectId: 'question',
      action: 'reopen',
      before: { status: 'answered', answeredBy: ['relation-wrong'] },
      after: { status: 'open', priorAnswers: ['relation-wrong'] },
      byUserId: 'alice',
      note: null,
      eventId: 'event-reopen',
      createdAt: at,
    });
    /** CATCHES: showing the oldest historical answer after reopen then re-answer. */
    const reansweredReceipt = replayReceipt(snapshot, view.records, question);
    expect(reansweredReceipt.provenance.map((entry) => entry.excerpt.messageId)).toEqual([
      'm1',
      'm3',
    ]);
    expect(activeAnswerMessageId(snapshot, 'question')).toBe('m3');
    /** CATCHES: clearing a losing concurrent answer because somebody else answered first. */
    expect(activeAnswerMatchesClientMessage(snapshot, 'question', 'client-answer-a')).toBe(false);
    expect(activeAnswerMatchesClientMessage(snapshot, 'question', 'client-answer-b')).toBe(true);
    const correction = reopenQuestion(question, '12:03', ['relation-good']);
    const receipt = replayReceipt(snapshot, view.records, correction.after, { correction });

    expect(receipt.provenance.map((entry) => entry.excerpt.messageId)).toEqual(['m1', 'm3']);
    expect(receipt.provenance.map((entry) => entry.excerpt.messageId)).not.toContain('m2');
  });

  /**
   * Mutation: ignore persisted correction rows, trust arbitrary before/after
   * text, or narrate the uncited participant note. Only the allowlisted typed
   * transition appears, and its free-form note remains absent.
   */
  it('renders only typed persisted correction history in system voice', () => {
    const snapshot = data();
    snapshot.corrections.push(
      {
        id: 'valid',
        roomId: 'room',
        objectId: 'decision',
        action: 'retype',
        before: { type: 'decision' },
        after: { type: 'claim' },
        byUserId: 'alice',
        note: 'Alice supposedly said these uncited words',
        eventId: 'event-valid',
        createdAt: at,
      },
      {
        id: 'invalid',
        roomId: 'room',
        objectId: 'decision',
        action: 'retype',
        before: { type: 'invented' },
        after: { type: 'claim' },
        byUserId: 'alice',
        note: 'Another uncited sentence',
        eventId: 'event-invalid',
        createdAt: at,
      },
    );
    const object = {
      id: 'decision',
      kind: 'decision' as const,
      state: {
        kind: 'decision' as const,
        verification: 'accepted' as const,
        owedToViewer: false,
        irreversible: false,
      },
      text: 'Regenerate in the background.',
      facts: [],
      objectives: [],
    };

    const receipt = replayReceipt(snapshot, replayView(snapshot, 'alice').records, object);
    expect(receipt.corrections).toHaveLength(1);
    expect(receipt.corrections[0]?.heading.text).toBe('RECORDED · DECISION → CLAIM');
    expect(JSON.stringify(receipt)).not.toContain('supposedly');
    expect(JSON.stringify(receipt)).not.toContain('Another uncited');
  });

  /**
   * Mutation: turn a nullable author join into a named human. The adapter then
   * invents an identity that is absent from the persisted message record.
   */
  it('a deleted author reads as unavailable AND fails closed to the not-a-person register', () => {
    /* THE DELETED-AUTHOR PATH, FAIL CLOSED (#101, round-2 finding 1). When an
       author's `users` row is gone (`messages.author_id` is ON DELETE SET NULL),
       the join yields no display name and no `principal_kind`. Round 1 mapped the
       absent kind to `'human'`, so an agent's genuine message rendered
       "author unavailable" in the HUMAN register — the exact masquerade AGENTS.md
       forbids. It now fails CLOSED to `'unknown'`: visibly not a person. */
    const snapshot = data();
    const first = snapshot.messages[0];
    if (!first) throw new Error('fixture message missing');
    snapshot.messages[0] = { ...first, author: null, authorKind: null };

    const view = replayView(snapshot, 'alice');
    expect(view.records[0]?.actor).toBe('author unavailable');
    // the kind is 'unknown', NOT 'human' — the record is painted not-a-person
    expect(view.records[0]?.authorKind).toBe('unknown');
    // The room head's members derive from this participant source; assert it.
    expect(view.participants.map((p) => ({ name: p.name, kind: p.kind }))).toEqual([
      { name: 'alice', kind: 'human' },
    ]);
  });

  /**
   * Mutation: render a superseded row, drop either direction of a persisted
   * blocker edge, or derive the room timestamp from only the last message.
   */
  it('projects supersession, relation direction, and the latest semantic timestamp', () => {
    const snapshot = data();
    const changedAt = new Date('2026-08-02T13:05:00.000Z');
    snapshot.objects.push(
      {
        id: 'old-decision',
        roomId: 'room',
        type: 'decision',
        payload: { statement: 'Use the old path.', decidedBy: 'alice', status: 'superseded' },
        objectiveId: null,
        proposalId: null,
        revision: 1,
        retractedAt: null,
        supersededById: 'decision',
        acceptedBy: 'alice',
        acceptedByKind: 'human',
        humanTouchedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'decision',
        roomId: 'room',
        type: 'decision',
        payload: { statement: 'Use the current path.', decidedBy: 'alice', status: 'active' },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        acceptedByKind: 'human',
        humanTouchedAt: at,
        createdAt: at,
        updatedAt: changedAt,
      },
      {
        id: 'claim',
        roomId: 'room',
        type: 'claim',
        payload: {
          statement: 'The migration is safe.',
          claimant: 'alice',
          verification: 'unverified',
        },
        objectiveId: null,
        proposalId: null,
        revision: 0,
        retractedAt: null,
        supersededById: null,
        acceptedBy: 'alice',
        acceptedByKind: 'human',
        humanTouchedAt: at,
        createdAt: at,
        updatedAt: at,
      },
    );
    snapshot.relations.push({
      id: 'blocker',
      roomId: 'room',
      kind: 'blocks',
      fromObjectId: 'decision',
      toObjectId: 'claim',
      toMessageId: null,
      toUrl: null,
      toFileKey: null,
      note: null,
      createdBy: 'alice',
      createdAt: at,
    });

    const view = replayView(snapshot, 'alice');
    expect(view.objects.find((object) => object.id === 'old-decision')).toBeUndefined();
    expect(view.objects.find((object) => object.id === 'decision')?.facts).toContain(
      'blocks: The migration is safe.',
    );
    expect(view.objects.find((object) => object.id === 'claim')?.facts).toContain(
      'blocked by: Use the current path.',
    );
    expect(view.updatedAt).toBe('13:05');
  });

  /**
   * Mutation: replace the structured reason with a class-level generic, or
   * offer an open-source action when no persisted provenance edge exists.
   */
  it('derives attention rationale and actions from the stored reason and source', () => {
    const snapshot = data();
    snapshot.attention.push({
      id: 'confirm',
      roomId: 'room',
      userId: 'alice',
      subjectKind: 'object',
      subjectId: 'missing-commitment',
      subjectObjectId: 'missing-commitment',
      subjectProposalId: null,
      class: 'owned_commitment',
      reason: { kind: 'commitment_confirm', statement: 'Ship the migration.' },
      status: 'pending',
      createdAt: at,
      resolvedAt: null,
    });

    const [item] = replayView(snapshot).attention;
    expect(item?.rationale).toContain('named as owner by somebody else');
    expect(item?.actions.map((action) => action.id)).toEqual(['confirm', 'decline']);
    expect(item?.actions.map((action) => action.id)).not.toContain('open');
  });

  /** CATCHES: attributing every staged reading to a machine after human slash commands exist. */
  it('does not invent an actor for a proposal-review rationale', () => {
    const snapshot = data();
    snapshot.attention.push({
      id: 'review',
      roomId: 'room',
      userId: 'alice',
      subjectKind: 'proposal',
      subjectId: 'missing-proposal',
      subjectObjectId: null,
      subjectProposalId: 'missing-proposal',
      class: 'needs_decision',
      reason: {
        kind: 'reading_pending',
        proposedType: 'objective',
        statement: 'Ship it.',
      },
      status: 'pending',
      createdAt: at,
      resolvedAt: null,
    });
    const rationale = replayView(snapshot).attention[0]?.rationale ?? '';
    expect(rationale).toContain('this was staged as objective');
    expect(rationale).not.toContain('machine');
  });

  /**
   * Mutation: reuse an accepted decision's settled state for its still-pending
   * mention, or resolve the proposal id only among staged records. The mention
   * then vanishes from Needs-you or loses its authored title/source.
   */
  it('keeps an accepted proposal mention owed, sourced, and dismissible', () => {
    const snapshot = data();
    snapshot.proposals.push({
      id: 'decision-proposal',
      roomId: 'room',
      interpretationId: null,
      type: 'decision',
      payload: { statement: 'Regenerate in the background.', decidedBy: null, status: 'active' },
      confidence: 0.95,
      proposerKind: 'model',
      proposerModel: 'test',
      proposerUserId: null,
      stagedByKind: 'model',
      stagedById: 'test',
      quote: 'Regenerate in the background.',
      status: 'accepted',
      decidedBy: 'alice',
      decidedAt: at,
      rejectedReason: null,
      createdAt: at,
    });
    snapshot.objects.push({
      id: 'decision-object',
      roomId: 'room',
      type: 'decision',
      payload: { statement: 'Regenerate in the background.', decidedBy: 'alice', status: 'active' },
      objectiveId: null,
      proposalId: 'decision-proposal',
      revision: 0,
      retractedAt: null,
      supersededById: null,
      acceptedBy: 'alice',
      acceptedByKind: 'human',
      humanTouchedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    const proposalSources = snapshot.proposalSources as unknown as Array<{
      roomId: string;
      proposalId: string;
      messageId: string;
    }>;
    proposalSources.push({
      roomId: 'room',
      proposalId: 'decision-proposal',
      messageId: 'm2',
    });
    snapshot.attention.push({
      id: 'mention',
      roomId: 'room',
      userId: 'alice',
      subjectKind: 'proposal',
      subjectId: 'decision-proposal',
      subjectObjectId: null,
      subjectProposalId: 'decision-proposal',
      class: 'mention',
      reason: { kind: 'mention', request: 'Please check this.' },
      status: 'pending',
      createdAt: at,
      resolvedAt: null,
    });

    const [item] = replayView(snapshot, 'alice').attention;
    expect(item).toMatchObject({
      title: 'Regenerate in the background.',
      state: { verification: 'proposed', owedToViewer: true },
      source: { messageId: 'm2' },
    });
    expect(item && needsViewer(item.state)).toBe(true);
    expect(item?.actions.map((action) => action.id)).toEqual(['open', 'dismiss']);
  });
});

describe('live room view', () => {
  /**
   * Mutation: apply the durable-sequence guard to projection invalidations, or
   * ignore the onChange reason in LiveRoomSession. With an unchanged cursor the
   * authenticated route then never rereads post-worker attention.
   */
  it('refreshes the live route for projection changes at an unchanged cursor', () => {
    expect(shouldRefreshLiveRoute('state', 8, 8)).toBe(false);
    expect(shouldRefreshLiveRoute('state', 9, 8)).toBe(true);
    expect(shouldRefreshLiveRoute('projection', 8, 8)).toBe(true);

    const session = readFileSync(liveRoomSession, 'utf8');
    expect(session).toContain(
      '!shouldRefreshLiveRoute(reason, room.lastSeq, refreshedThrough.current)',
    );
    /**
     * Mutation: advance the guard to the client's cursor before the refreshed
     * Server Component props commit. A concurrent refresh can then absorb a
     * reconnect request, leaving ten durable catch-up rows absent forever while
     * the guard says the route already holds them.
     */
    expect(session).toContain('refreshedThrough.current = persistedThrough');
    expect(session).not.toContain('refreshedThrough.current = client.lastSeq(roomId)');
    /**
     * Mutation: make the reconnect refresh fire only once. Next may coalesce
     * that request with an in-flight projection refresh, after which no socket
     * frame remains to trigger another attempt and the transcript stays stale.
     */
    expect(session).toContain('refreshTarget.current > refreshedThrough.current');
    expect(session).toContain('scheduleRefreshRef.current(75)');
    expect(session).toContain('}, [data.loadReceipt])');
    expect(session).toContain('refreshInFlight.current = true');
    expect(session).toContain('refreshInFlight.current = false');
    expect(session).toContain('refreshTimer.current !== null ||\n        refreshInFlight.current');
    /**
     * Mutation: keep the in-flight latch forever when Next cancels a refresh
     * without committing a load receipt. Every later reconnect target is then
     * recorded but no route read may start.
     */
    expect(session).toContain('refreshLeaseTimer.current = setTimeout');
    expect(session).toContain('}, 5_000)');
    /**
     * Mutation: check the watchdog limit only after issuing refresh 12. Its
     * receipt then schedules refresh 13 and a stuck cursor loops forever.
     */
    expect(session.indexOf('if (refreshAttempts.current >= 12)')).toBeLessThan(
      session.indexOf('refreshInFlight.current = true'),
    );
    /**
     * Mutation: count productive partial commits against the no-progress
     * watchdog. A moving worker tail can then exhaust twelve refreshes while
     * every one advanced, stranding reconnect catch-up behind the target.
     */
    expect(session).toContain(
      'if (advanced || persistedThrough >= refreshTarget.current) refreshAttempts.current = 0',
    );
    /**
     * Mutation: leave a projection-only exhausted watchdog latched when a new
     * authenticated ledger target arrives. Reconnect then records its cursor
     * but refuses every refresh needed to render the new messages.
     */
    expect(session).toContain('if (room.lastSeq > previousTarget) refreshAttempts.current = 0');
    /**
     * Mutation: clear a projection invalidation when any older refresh returns
     * arrays with new identities. That stale response can then swallow the one
     * reread that should reveal a new proposal or attention item.
     */
    expect(session).toContain(
      "if (reason === 'projection' && projectionRefreshRemaining.current === 0)",
    );
    expect(session).toContain('projectionRefreshRemaining.current = 2');
    expect(session).not.toContain('projectionRefreshPending.current = false');
    /**
     * Mutation: carry a high refresh watermark across client-side navigation
     * into a low-cursor room. That room's first events then compare below the
     * previous room's cursor and never refresh its persisted transcript.
     */
    expect(session).toContain('if (refreshRoom.current !== roomId)');
    expect(session).toContain('refreshTarget.current = persistedThrough');

    const loader = readFileSync(replayDataSource, 'utf8');
    /**
     * Mutation: prove refresh completion with the last message position rather
     * than the room ledger cursor. A semantic tail then keeps the route behind
     * forever even when every message is present.
     */
    expect(loader).toContain('loadedThrough: roomCursor[0]?.loadedThrough ?? 0');
    expect(loader).toContain('loadReceipt: randomUUID()');
    expect(loader).toContain('.where(eq(coreEvents.roomId, roomId))');
    /**
     * Mutation: remove the repeatable-read boundary around the loader. The
     * parallel proposal/object/attention reads can then publish an attention
     * subject whose semantic record came from the preceding database fold.
     */
    expect(loader).toContain("{ isolationLevel: 'repeatable read', accessMode: 'read only' }");
    expect(loader.indexOf('database.transaction(')).toBeLessThan(
      loader.indexOf('loadReplayDataSnapshot('),
    );
  });

  /**
   * Mutation: compare the membership cursor with `messages.seq` (a global
   * sequence) or put the divider at the start of the room. The participant who
   * saw m1 but missed m2 is then told they missed the wrong transcript slice.
   */
  it('places the unread divider from persisted room_seq positions', () => {
    const snapshot: ReplayData = {
      ...data(),
      participants: [
        { id: 'alice', name: 'alice', avatarUrl: null },
        { id: 'bob', name: 'bob', avatarUrl: null },
      ],
      messages: data().messages.map((message) =>
        message.id === 'm2' ? { ...message, authorId: 'bob', author: 'bob' } : message,
      ),
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
      ],
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: { alice: 'online' },
      typing: [],
      subscribed: true,
    });

    expect(view.entries.map((entry) => entry.type)).toEqual([
      'message',
      'since-you-left',
      'message',
    ]);
    expect(view.entries[1]).toMatchObject({
      type: 'since-you-left',
      label: 'SINCE YOU LEFT',
      total: 1,
      counts: { need: 0, change: 0, discussion: 1, routine: 0 },
      entryIds: ['m2'],
    });
    expect(view.rooms[0]?.unseen).toBe(1);
    expect(view.participants[0]?.presence).toBe('here');
  });

  /**
   * Mutation: apply a SINCE YOU LEFT chip to every row in the room instead of
   * the divider's persisted unread membership. An older discussion row then
   * claims to be one of the single missed rows the chip counted.
   */
  it('scopes a live divider filter to the exact unread rows it counted', () => {
    const snapshot: ReplayData = {
      ...data(),
      participants: [
        { id: 'alice', name: 'alice', avatarUrl: null },
        { id: 'bob', name: 'bob', avatarUrl: null },
      ],
      messages: data().messages.map((message) =>
        message.id === 'm2' ? { ...message, authorId: 'bob', author: 'bob' } : message,
      ),
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
      ],
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    });
    const divider = view.entries.find((entry) => entry.type === 'since-you-left');
    expect(divider?.entryIds).toEqual(['m2']);

    const filtered = withFilter(view.entries, 'discussion', divider?.entryIds);
    const rows = filtered.filter((entry) => entry.type === 'message');
    expect(rows.map((entry) => [entry.id, entry.filterScoped, entry.matchesFilter])).toEqual([
      ['m1', false, false],
      ['m2', true, true],
    ]);
  });

  /**
   * Mutation: recompute the live divider from the newly advanced seen cursor.
   * Marking its one-row window seen would delete the divider (and turn its
   * selected chip into a room-wide filter) instead of preserving it muted.
   */
  it('keeps a frozen unread window after its durable cursor advances', () => {
    const snapshot: ReplayData = {
      ...data(),
      participants: [
        { id: 'alice', name: 'alice', avatarUrl: null },
        { id: 'bob', name: 'bob', avatarUrl: null },
      ],
      messages: [
        ...data().messages.map((message) =>
          message.id === 'm2' ? { ...message, authorId: 'bob', author: 'bob' } : message,
        ),
        {
          id: 'm3',
          seq: 3,
          authorId: 'bob',
          author: 'bob',
          body: 'This arrived after the frozen missed window.',
          clientMessageId: null,
          replyToId: null,
          attachments: [],
          createdAt: new Date('2026-08-02T12:02:00.000Z'),
        },
      ],
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
        { messageId: 'm3', roomSeq: 5 },
      ],
    };
    const live: RoomView = {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 4,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    };

    const view = liveRoomView(snapshot, 'alice', live, { afterSeq: 1, throughSeq: 4 });
    expect(view.entries.find((entry) => entry.type === 'since-you-left')).toMatchObject({
      seen: true,
      total: 1,
      entryIds: ['m2'],
    });
    // The preserved group is seen, while later traffic remains independently unread.
    expect(view.rooms[0]?.unseen).toBe(1);
  });

  /**
   * Mutation: count every room row after seen_seq without removing messages
   * authored by the viewer. The divider then contradicts its own promise that
   * a person’s activity is never counted back to them as unseen.
   */
  it('does not count the viewer’s own later messages as unseen', () => {
    const snapshot: ReplayData = {
      ...data(),
      messagePositions: [
        { messageId: 'm1', roomSeq: 1 },
        { messageId: 'm2', roomSeq: 4 },
      ],
    };
    const view = liveRoomView(snapshot, 'alice', {
      roomId: 'room',
      lastSeq: 4,
      head: 4,
      seenSeq: 1,
      events: [],
      pending: [],
      presence: {},
      typing: [],
      subscribed: true,
    });
    expect(view.entries.some((entry) => entry.type === 'since-you-left')).toBe(false);
    expect(view.rooms[0]?.unseen).toBe(0);
  });
});
