import {
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
} from '@atrium/core';
import type {
  AttentionItem,
  CorrectionEntry,
  EpistemicState,
  HumanSummary,
  MessageRecord,
  ObjectiveRecord,
  ProvenanceEntry,
  ReceiptRecord,
  RoomHeadRecord,
  RoomSummary,
  StateObject,
  TimelineEntry,
} from '../src/components';
import {
  citationFrom,
  happenedKindFor,
  messageEntry,
  owedSummary,
  quotationFrom,
  rationale,
  sinceYouLeft,
  systemStatement,
  trailerFor,
} from '../src/components';
import type { ReplayData } from './replay-data';
import type { ReplayCorrectionTransition } from './replay-transitions';

const TALK: EpistemicState = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
};

/**
 * Replay the import honestly: corpus messages arrived in order, then the
 * precomputed worker pass produced its durable semantic rows. A partial cursor
 * therefore contains only the message prefix; showing final objects beside an
 * earlier prefix would claim the worker knew words it had not read yet.
 */
export function replayAt(data: ReplayData, messageCount: number): ReplayData {
  const count = Math.max(0, Math.min(Math.trunc(messageCount), data.messages.length));
  if (count === data.messages.length) return data;
  const visibleMessages = data.messages.slice(0, count);
  return {
    ...data,
    messages: visibleMessages,
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

/**
 * Adapt a persisted room to the verified component vocabulary.
 *
 * Every human-voice string originates in `data.messages`. Semantic text is
 * rendered as system state, never as something a participant said.
 */
export function replayView(data: ReplayData, viewerId?: string) {
  const participantName = new Map(data.participants.map((person) => [person.id, person.name]));
  const viewer =
    data.participants.find((person) => person.id === viewerId) ?? data.participants[0] ?? null;
  const viewerName = viewer?.name ?? 'replay viewer';
  const viewerAttention = data.attention.filter(
    (item) => item.userId === viewer?.id && item.status === 'pending',
  );

  const records: MessageRecord[] = data.messages.map((message) => ({
    id: message.id,
    at: clock(message.createdAt),
    actor: message.author ?? 'deleted participant',
    text: message.body,
    origin: 'seeded',
    room: data.room.name,
  }));
  const recordById = new Map(records.map((record) => [record.id, record]));

  const pendingBySubject = new Map(viewerAttention.map((item) => [item.subjectId, item]));
  const objectives: ObjectiveRecord[] = data.objects
    .filter((object) => object.type === 'objective' && object.retractedAt === null)
    .map((object) => ({
      id: object.id,
      title: payloadText(object.type, object.payload),
      status:
        ObjectivePayload.parse(object.payload).status === 'achieved'
          ? 'idle'
          : object.supersededById === null
            ? 'active'
            : 'blocked',
      open: true,
    }));

  const accepted: StateObject[] = data.objects
    .filter((object) => object.type !== 'objective' && object.retractedAt === null)
    .map((object) => ({
      id: object.id,
      kind: objectKind(object.type),
      state: stateForObject(object.type, object.payload, pendingBySubject.has(object.id), true),
      text: payloadText(object.type, object.payload),
      facts: objectFacts(object.type, object.payload, participantName, object.createdAt),
      objectives: object.objectiveId ? [object.objectiveId] : [],
    }));

  const staged: StateObject[] = data.proposals
    .filter((proposal) => proposal.status === 'proposed' && proposal.type !== 'objective')
    .map((proposal) => ({
      id: proposal.id,
      kind: objectKind(proposal.type),
      state: stateForObject(
        proposal.type,
        proposal.payload,
        pendingBySubject.has(proposal.id),
        false,
      ),
      text: payloadText(proposal.type, proposal.payload),
      facts: [
        proposal.proposerKind === 'model'
          ? `drafted by ${proposal.proposerModel ?? 'an unrecorded model'}`
          : `drafted by ${participantName.get(proposal.proposerUserId ?? '') ?? 'a participant'}`,
      ],
      objectives: [],
    }));
  const objects = [...accepted, ...staged];

  /* A source message inherits only the semantic state its persisted edges
     prove. Pending attention wins over accepted/change because the divider's
     NEED class answers the stronger question: which rows lead to something the
     viewer still owes. Every other human-authored row remains discussion. */
  const stateByMessage = new Map<string, EpistemicState>();
  for (const source of data.objectSources) {
    const object = accepted.find((candidate) => candidate.id === source.objectId);
    if (object) stateByMessage.set(source.messageId, object.state);
  }
  for (const source of data.proposalSources) {
    const object = objects.find((candidate) => candidate.id === source.proposalId);
    if (object) stateByMessage.set(source.messageId, object.state);
  }
  for (const item of viewerAttention) {
    const sourceId =
      item.subjectKind === 'proposal'
        ? data.proposalSources.find((source) => source.proposalId === item.subjectId)?.messageId
        : data.objectSources.find((source) => source.objectId === item.subjectId)?.messageId;
    const object = objects.find((candidate) => candidate.id === item.subjectId);
    if (sourceId && object) stateByMessage.set(sourceId, { ...object.state, owedToViewer: true });
  }

  const messageEntries: TimelineEntry[] = data.messages.map((message, index) => {
    const record = records[index] as MessageRecord;
    const reply = message.replyToId ? recordById.get(message.replyToId) : undefined;
    return messageEntry(record, {
      state: stateByMessage.get(message.id) ?? TALK,
      replyTo: reply ? quotationFrom(reply) : null,
      viewer: viewerName,
    });
  });
  const entries: TimelineEntry[] =
    messageEntries.length === 0
      ? []
      : [
          sinceYouLeft({
            id: 'replay-history',
            label: 'REPLAYED HISTORY',
            window: `${clock(data.messages[0]?.createdAt ?? new Date(0))} → ${clock(data.messages.at(-1)?.createdAt ?? new Date(0))}`,
            entries: messageEntries,
            seen: false,
            seenAt: null,
            activeFilter: null,
          }),
          ...messageEntries,
        ];

  const sourceFor = (subjectKind: 'object' | 'proposal', subjectId: string) => {
    const sourceId =
      subjectKind === 'proposal'
        ? data.proposalSources.find((source) => source.proposalId === subjectId)?.messageId
        : (data.objectSources.find((source) => source.objectId === subjectId)?.messageId ??
          (() => {
            const proposalId = data.objects.find((object) => object.id === subjectId)?.proposalId;
            return data.proposalSources.find((source) => source.proposalId === proposalId)
              ?.messageId;
          })());
    const source = sourceId ? recordById.get(sourceId) : undefined;
    return source ? citationFrom(source) : null;
  };

  const attention: AttentionItem[] = viewerAttention.map((item) => {
    const subject = objects.find((object) => object.id === item.subjectId);
    return {
      id: item.id,
      state:
        subject?.state ??
        ({
          kind: item.class === 'blocking_question' ? 'question' : 'decision',
          verification: item.class === 'blocking_question' ? 'open' : 'proposed',
          owedToViewer: true,
          irreversible: false,
        } satisfies EpistemicState),
      title: subject?.text ?? 'an item whose semantic record is unavailable',
      rationale: rationale(reasonFor(item.class, viewerName)),
      facts: [`raised ${clock(item.createdAt)}`],
      source: sourceFor(item.subjectKind, item.subjectId),
      actions: actionsFor(item.class),
    };
  });

  const humans: HumanSummary[] = data.participants.map((person) => ({
    id: person.id,
    name: person.name,
    presence: 'away',
    note: null,
    isViewer: person.id === viewer?.id,
  }));
  const viewerRecord: HumanSummary = humans.find((person) => person.isViewer) ?? {
    id: 'replay-viewer',
    name: viewerName,
    presence: 'away',
    note: null,
    isViewer: true,
  };
  const room: RoomHeadRecord = {
    name: data.room.name,
    topic: data.room.workspaceName,
    members: data.participants.map((person) => person.name),
  };
  const rooms: RoomSummary[] = [
    {
      id: data.room.id,
      name: data.room.name,
      unseen: 0,
      owed: owedSummary(attention),
      current: true,
    },
  ];

  return {
    records,
    entries,
    objectives,
    objects,
    attention,
    humans,
    viewer: viewerRecord,
    room,
    rooms,
    trailer: trailerFor({ objects, objectives, overdue: [] }),
    updatedAt: clock(
      data.messages.at(-1)?.createdAt ?? data.objects.at(-1)?.updatedAt ?? new Date(0),
    ),
  };
}

/**
 * Build the inspectable record for one persisted semantic row.
 *
 * The excerpt is minted from the message register, never copied out of a
 * proposal payload. That keeps the receipt's author, clock, words, room and
 * jump target anchored to the same persisted message.
 */
export function replayReceipt(
  data: ReplayData,
  records: readonly MessageRecord[],
  object: StateObject,
  changes: {
    readonly answerMessageId?: string;
    readonly correction?: ReplayCorrectionTransition;
  } = {},
): ReceiptRecord {
  const recordById = new Map(records.map((record) => [record.id, record]));
  const accepted = data.objects.find((candidate) => candidate.id === object.id);
  const proposal = data.proposals.find((candidate) => candidate.id === object.id);
  const proposalId = accepted?.proposalId ?? proposal?.id;
  const sourceIds = [
    ...data.objectSources
      .filter((source) => source.objectId === object.id)
      .map((source) => source.messageId),
    ...data.proposalSources
      .filter((source) => source.proposalId === proposalId)
      .map((source) => source.messageId),
  ];
  const provenance: ProvenanceEntry[] = [...new Set(sourceIds)].flatMap((messageId) => {
    const record = recordById.get(messageId);
    const excerpt = record ? quotationFrom(record) : null;
    return excerpt ? [{ id: `${object.id}:source:${messageId}`, excerpt, note: null }] : [];
  });
  const boundAnswer = changes.answerMessageId ? recordById.get(changes.answerMessageId) : undefined;
  const boundAnswerExcerpt = boundAnswer ? quotationFrom(boundAnswer) : null;
  if (boundAnswerExcerpt) {
    provenance.push({
      id: `${object.id}:bound-answer:${boundAnswerExcerpt.messageId}`,
      excerpt: boundAnswerExcerpt,
      note: systemStatement('answer recorded through the bound composer'),
    });
  }
  const kind = happenedKindFor(object.state);
  const sourceRef = provenance[0]?.excerpt.messageId;
  const correction = changes.correction?.objectId === object.id ? changes.correction : undefined;
  const answerRelation = data.relations.find(
    (relation) =>
      relation.kind === 'answers' &&
      relation.fromObjectId === object.id &&
      relation.toObjectId !== null &&
      (correction?.action !== 'reopen' || correction.priorAnswerRelationIds.includes(relation.id)),
  );
  const answerSourceId = answerRelation?.toObjectId
    ? data.objectSources.find((source) => source.objectId === answerRelation.toObjectId)?.messageId
    : undefined;
  const answerRecord = answerSourceId ? recordById.get(answerSourceId) : undefined;
  const answerExcerpt = answerRecord ? quotationFrom(answerRecord) : null;
  if (correction?.action === 'reopen' && answerExcerpt) {
    provenance.push({
      id: `${object.id}:prior-answer:${answerExcerpt.messageId}`,
      excerpt: answerExcerpt,
      note: systemStatement('prior answer kept after reopen'),
    });
  }
  const corrections: CorrectionEntry[] = [];
  for (const stored of data.corrections.filter((row) => row.objectId === object.id)) {
    const sides = storedCorrectionSides(stored.action, stored.before, stored.after);
    if (!sides) continue;
    corrections.push({
      id: stored.id,
      heading: systemStatement(
        `RECORDED · ${sides.before.toUpperCase()} → ${sides.after.toUpperCase()}`,
      ),
      at: clock(stored.createdAt),
      was: systemStatement(sides.before),
      now: systemStatement(sides.after),
      fact: systemStatement('the correction is preserved in the append-only room record'),
      /* A free correction note has no message citation in this projection. It
         cannot be rendered as the participant's words without one. */
      reason: null,
      link: null,
    });
  }
  if (correction?.action === 'retype') {
    corrections.push({
      id: correction.id,
      heading: systemStatement('CORRECTED · DECISION → CLAIM'),
      at: correction.at,
      was: systemStatement(correction.before.kind),
      now: systemStatement(correction.after.kind),
      fact: systemStatement('the reading was retyped; its source remains attached'),
      reason: null,
      link: sourceRef
        ? {
            label: 'the source message remains in the room →',
            ref: citationFrom(recordById.get(sourceRef) as MessageRecord),
          }
        : null,
    });
  }
  if (correction?.action === 'reopen') {
    corrections.push({
      id: correction.id,
      heading: systemStatement('REOPENED · PRIOR ANSWER KEPT'),
      at: correction.at,
      was: systemStatement(questionStatus(correction.before)),
      now: systemStatement(questionStatus(correction.after)),
      fact: systemStatement('the prior answer remains linked on the record'),
      reason: null,
      link: answerRecord
        ? {
            label: 'the prior answer remains in the room →',
            ref: citationFrom(answerRecord),
          }
        : null,
    });
  }
  const canReopen =
    object.state.kind === 'question' &&
    object.state.verification === 'accepted' &&
    answerRelation !== undefined &&
    correction === undefined;

  return {
    id: object.id,
    state: object.state,
    title: object.text,
    status: [object.kind.toUpperCase(), object.state.verification.replace('_', ' ')],
    happened: object.facts.map((fact, index) => ({
      id: `${object.id}:fact:${index}`,
      kind,
      statement: systemStatement(fact),
    })),
    provenance,
    corrections,
    retypeable:
      object.kind === 'decision' &&
      object.state.verification === 'accepted' &&
      correction === undefined,
    reopenable: canReopen,
    reopenNote:
      correction?.action === 'reopen'
        ? 'pending again · the prior answer remains linked in the correction chain'
        : canReopen
          ? 'answered · reopening returns it to pending and keeps the prior answer on the record'
          : provenance.length === 0
            ? 'no persisted message source is attached to this reading'
            : 'the excerpts above come from the persisted room record',
  };
}

function questionStatus(object: StateObject): string {
  if (object.kind !== 'question') return object.state.verification.replace('_', ' ');
  return object.state.verification === 'accepted' ? 'answered' : 'open';
}

function storedCorrectionSides(
  action: ReplayData['corrections'][number]['action'],
  before: unknown,
  after: unknown,
): { readonly before: string; readonly after: string } | null {
  if (!isRecord(before) || !isRecord(after)) return null;
  if (action === 'retype' && isObjectType(before.type) && isObjectType(after.type)) {
    return { before: before.type, after: after.type };
  }
  if (
    action === 'reopen' &&
    isCorrectionStatus(before.status) &&
    isCorrectionStatus(after.status)
  ) {
    return { before: before.status, after: after.status };
  }
  return null;
}

function isObjectType(value: unknown): value is ReplayData['objects'][number]['type'] {
  return ['decision', 'commitment', 'open_question', 'claim', 'objective'].includes(String(value));
}

function isCorrectionStatus(value: unknown): value is string {
  return ['answered', 'open', 'completed', 'cancelled'].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clock(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function objectKind(type: ReplayData['objects'][number]['type']): StateObject['kind'] {
  if (type === 'open_question') return 'question';
  if (type === 'objective') return 'claim';
  return type;
}

function stateForObject(
  type: ReplayData['objects'][number]['type'],
  payload: ReplayData['objects'][number]['payload'],
  owedToViewer: boolean,
  accepted: boolean,
): EpistemicState {
  if (type === 'open_question') {
    const question = OpenQuestionPayload.parse(payload);
    return {
      kind: 'question',
      verification: question.status === 'answered' ? 'accepted' : 'open',
      owedToViewer,
      irreversible: false,
    };
  }
  if (type === 'claim') {
    const claim = ClaimPayload.parse(payload);
    return {
      kind: 'claim',
      verification: claim.verification === 'verified' ? 'verified' : 'self_reported',
      owedToViewer,
      irreversible: false,
    };
  }
  return {
    kind: objectKind(type),
    verification: accepted ? 'accepted' : 'proposed',
    owedToViewer,
    irreversible: false,
  };
}

function payloadText(
  type: ReplayData['objects'][number]['type'],
  payload: ReplayData['objects'][number]['payload'],
): string {
  switch (type) {
    case 'open_question':
      return OpenQuestionPayload.parse(payload).question;
    case 'objective':
      return ObjectivePayload.parse(payload).title;
    case 'commitment':
      return CommitmentPayload.parse(payload).statement;
    case 'claim':
      return ClaimPayload.parse(payload).statement;
    case 'decision':
      return DecisionPayload.parse(payload).statement;
  }
}

function objectFacts(
  type: ReplayData['objects'][number]['type'],
  payload: ReplayData['objects'][number]['payload'],
  names: ReadonlyMap<string, string>,
  createdAt: Date,
): string[] {
  const facts = [`accepted ${clock(createdAt)}`];
  if (type === 'commitment') {
    const commitment = CommitmentPayload.parse(payload);
    facts.push(`owned by ${names.get(commitment.owner) ?? commitment.owner}`);
  }
  if (type === 'claim') {
    const claim = ClaimPayload.parse(payload);
    facts.push(`claimed by ${names.get(claim.claimant) ?? claim.claimant}`);
  }
  return facts;
}

function reasonFor(
  attentionClass: ReplayData['attention'][number]['class'],
  viewer: string,
): string {
  switch (attentionClass) {
    case 'needs_decision':
      return `${viewer} can settle this decision, and inference cannot certify it`;
    case 'owned_commitment':
      return `${viewer} owns this commitment and it remains open`;
    case 'blocking_question':
      return `${viewer} can answer the question that blocks current work`;
    case 'mention':
      return `${viewer} was named in a message that asks for attention`;
  }
}

function actionsFor(attentionClass: ReplayData['attention'][number]['class']) {
  if (attentionClass === 'needs_decision') {
    return [
      { id: 'answer', label: 'answer', emphasis: 'primary' as const, statement: null },
      { id: 'decline', label: 'decline', emphasis: 'secondary' as const, statement: null },
    ];
  }
  return [{ id: 'open', label: 'open source', emphasis: 'secondary' as const, statement: null }];
}
