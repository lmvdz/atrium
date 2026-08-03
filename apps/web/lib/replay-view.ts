import type {
  AttentionItem,
  EpistemicState,
  HumanSummary,
  MessageRecord,
  ObjectiveRecord,
  RoomHeadRecord,
  RoomSummary,
  StateObject,
  TimelineEntry,
} from '../src/components';
import {
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
} from '@atrium/core';
import {
  citationFrom,
  messageEntry,
  owedSummary,
  quotationFrom,
  rationale,
  trailerFor,
} from '../src/components';
import type { ReplayData } from './replay-data';

const TALK: EpistemicState = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
};

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

  const entries: TimelineEntry[] = data.messages.map((message, index) => {
    const record = records[index] as MessageRecord;
    const reply = message.replyToId ? recordById.get(message.replyToId) : undefined;
    return messageEntry(record, {
      state: TALK,
      replyTo: reply ? quotationFrom(reply) : null,
      viewer: viewerName,
    });
  });

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

  const sourceFor = (subjectKind: 'object' | 'proposal', subjectId: string) => {
    const sourceId =
      subjectKind === 'proposal'
        ? data.proposalSources.find((source) => source.proposalId === subjectId)?.messageId
        : data.objectSources.find((source) => source.objectId === subjectId)?.messageId ??
          (() => {
            const proposalId = data.objects.find((object) => object.id === subjectId)?.proposalId;
            return data.proposalSources.find((source) => source.proposalId === proposalId)?.messageId;
          })();
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
  const viewerRecord: HumanSummary =
    humans.find((person) => person.isViewer) ?? {
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
