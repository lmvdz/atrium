import {
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  epistemicStateFromAcceptance,
  ObjectivePayload,
  OpenQuestionPayload,
} from '@atrium/core';
import type {
  AttentionItem,
  BodySegment,
  CorrectionEntry,
  EpistemicState,
  MessageRecord,
  ObjectiveRecord,
  ParticipantSummary,
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
  participantKindOf,
  quotationFrom,
  rationale,
  sinceYouLeft,
  systemStatement,
  trailerFor,
} from '../src/components';
import type { MessageReference, MessageReferenceKind } from '../src/lib/typed-references';
import { contextualReferenceAttention } from './contextual-reference-attention';
import type { ReplayData } from './replay-data';
import type { ReplayCorrectionTransition } from './replay-transitions';

export interface ReferenceResolution {
  readonly kind: MessageReferenceKind;
  readonly targetId: string;
  readonly label?: string;
  readonly state?: string;
}

/** Mark exact stored spans; resolution is metadata and never replaces authored words. */
export function typedReferenceBody(
  text: string,
  references: readonly MessageReference[],
  resolve: (kind: MessageReferenceKind, targetId: string) => ReferenceResolution | undefined,
): readonly BodySegment[] | undefined {
  if (references.length === 0) return undefined;
  const ordered = [...references].sort((left, right) => left.ordinal - right.ordinal);
  const body: BodySegment[] = [];
  let cursor = 0;
  for (const reference of ordered) {
    if (
      !reference.surface.startsWith('@') ||
      reference.start < cursor ||
      reference.end <= reference.start ||
      reference.end > text.length ||
      text.slice(reference.start, reference.end) !== reference.surface
    ) {
      // A corrupt projection must not turn unproved metadata into authored markup.
      return undefined;
    }
    if (reference.start > cursor) {
      body.push({ kind: 'text', text: text.slice(cursor, reference.start) });
    }
    const resolution = resolve(reference.kind, reference.targetId);
    body.push({
      kind: 'mention',
      text: reference.surface.startsWith('@') ? reference.surface.slice(1) : reference.surface,
      referenceKind: reference.kind,
      targetId: reference.targetId,
      resolution:
        resolution === undefined
          ? `${reference.kind} unavailable`
          : [resolution.label, resolution.state].filter(Boolean).join(' · '),
    });
    cursor = reference.end;
  }
  if (cursor < text.length) body.push({ kind: 'text', text: text.slice(cursor) });
  return body;
}

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
    messageReferences: (data.messageReferences ?? []).filter((reference) =>
      visibleMessages.some((message) => message.id === reference.messageId),
    ),
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
  const defaultViewerId = data.attention.find((item) => item.status === 'pending')?.userId;
  const viewer =
    data.participants.find((person) => person.id === viewerId) ??
    data.participants.find((person) => person.id === defaultViewerId) ??
    data.participants[0] ??
    null;
  const viewerName = viewer?.name ?? 'replay viewer';
  const viewerAttention = data.attention.filter(
    (item) => item.userId === viewer?.id && item.status === 'pending',
  );

  const records: MessageRecord[] = data.messages.map((message) => ({
    id: message.id,
    at: clock(message.createdAt),
    actor: message.author ?? 'author unavailable',
    text: message.body,
    origin: 'seeded',
    // The author's kind decides the voice register (#101), read through
    // `participantKindOf` so it FAILS CLOSED: a value that cannot be read — and
    // a NULL from a deleted author row (`messages.author_id` is ON DELETE SET
    // NULL, so the join yields no `principal_kind`) — becomes `'unknown'`, a
    // visibly-not-a-person register, NEVER softened to a person. Always set,
    // never omitted: a deleted agent's genuine message must not fall through to
    // a human default. `users.principal_kind` is NOT NULL, so a live author is
    // always `'human'`/`'agent'` and only a gone author reads as `'unknown'`.
    authorKind: participantKindOf(message.authorKind),
    room: data.room.name,
    attachments: message.attachments,
  }));
  const recordById = new Map(records.map((record) => [record.id, record]));

  const pendingBySubject = new Map(viewerAttention.map((item) => [item.subjectId, item]));
  const acceptedObjectives: ObjectiveRecord[] = data.objects
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
  const stagedObjectives: ObjectiveRecord[] = data.proposals
    .filter((proposal) => proposal.type === 'objective' && proposal.status === 'proposed')
    .map((proposal) => ({
      id: proposal.id,
      title: payloadText(proposal.type, proposal.payload),
      status: 'proposed',
      open: true,
    }));
  const objectives = [...acceptedObjectives, ...stagedObjectives];

  const accepted: StateObject[] = data.objects
    .filter(
      (object) =>
        object.type !== 'objective' &&
        object.retractedAt === null &&
        object.supersededById === null,
    )
    .map((object) => ({
      id: object.id,
      kind: objectKind(object.type),
      state: stateForObject(
        object.type,
        object.payload,
        pendingBySubject.has(object.id),
        acceptanceOf(object),
      ),
      text: payloadText(object.type, object.payload),
      facts: [
        ...objectFacts(object.type, object.payload, participantName, object.createdAt),
        ...relationFacts(data, object.id),
      ],
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
        null,
      ),
      text: payloadText(proposal.type, proposal.payload),
      facts: [
        proposal.proposerKind === 'model'
          ? `drafted by ${proposal.proposerModel ?? 'an unrecorded model'}`
          : `drafted by ${participantName.get(proposal.proposerUserId ?? '') ?? 'a participant'}`,
      ],
      objectives: objectives.map((objective) => objective.id),
    }));
  const objects = [...accepted, ...staged];
  const currentParticipantName = new Map(
    (data.referenceParticipants ?? data.participants).map((person) => [person.id, person.name]),
  );
  const currentParticipantIds = new Set(data.participants.map((person) => person.id));
  const attachmentById = new Map(
    (data.referenceAttachments ?? []).map((attachment) => [attachment.id, attachment]),
  );
  const referencesByMessage = new Map<string, MessageReference[]>();
  for (const reference of data.messageReferences ?? []) {
    const current = referencesByMessage.get(reference.messageId) ?? [];
    current.push(reference);
    referencesByMessage.set(reference.messageId, current);
  }
  const resolveReference = (
    kind: MessageReferenceKind,
    targetId: string,
  ): ReferenceResolution | undefined => {
    if (kind === 'human' || kind === 'agent') {
      // A person and an agent are both `users` rows and both resolve to a
      // display name off the same map; the reference kind is preserved so the
      // renderer can still distinguish them, but neither is stamped the other.
      const label = currentParticipantName.get(targetId);
      return label === undefined
        ? undefined
        : {
            kind,
            targetId,
            label,
            state: currentParticipantIds.has(targetId) ? undefined : 'no longer in room',
          };
    }
    if (kind === 'attachment') {
      const attachment = attachmentById.get(targetId);
      return attachment === undefined
        ? undefined
        : { kind, targetId, label: attachment.name, state: attachment.contentType };
    }
    if (kind === 'proposal') {
      const proposal = data.proposals.find((candidate) => candidate.id === targetId);
      return proposal === undefined
        ? undefined
        : {
            kind,
            targetId,
            label: payloadText(proposal.type, proposal.payload),
            state: proposal.status,
          };
    }
    const object = data.objects.find((candidate) => candidate.id === targetId);
    return object === undefined
      ? undefined
      : {
          kind,
          targetId,
          label: payloadText(object.type, object.payload),
          state:
            object.retractedAt !== null
              ? 'retracted'
              : object.supersededById !== null
                ? 'superseded'
                : 'accepted',
        };
  };

  const messageEntries: TimelineEntry[] = data.messages.map((message, index) => {
    const record = records[index] as MessageRecord;
    const reply = message.replyToId ? recordById.get(message.replyToId) : undefined;
    return messageEntry(record, {
      /* The semantic edge certifies the extracted object, never every sentence
         in its source message. Human speech stays discussion; the Current-state
         object and its receipt carry the derived epistemic status. */
      state: TALK,
      // Mentions render from the ONE register: authored `message_references`
      // spans (decision #92). A message with no references is plain speech; there
      // is no second `mention_user_ids` column to fall back to or to disclose.
      body: referencesByMessage.has(message.id)
        ? typedReferenceBody(
            message.body,
            referencesByMessage.get(message.id) ?? [],
            resolveReference,
          )
        : undefined,
      replyTo: reply ? quotationFrom(reply) : null,
      viewer: viewerName,
      note: null,
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

  const sourceFor = (subjectKind: 'object' | 'proposal' | 'message', subjectId: string) => {
    const sourceId =
      subjectKind === 'message'
        ? subjectId
        : subjectKind === 'proposal'
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
    const proposalSubject =
      item.subjectKind === 'proposal'
        ? data.proposals.find((proposal) => proposal.id === item.subjectId)
        : undefined;
    const acceptedFromProposal = proposalSubject
      ? data.objects.find((object) => object.proposalId === proposalSubject.id)
      : undefined;
    const subject = objects.find((object) => object.id === item.subjectId);
    const source = sourceFor(item.subjectKind, item.subjectId);
    const subjectState =
      (acceptedFromProposal
        ? stateForObject(
            acceptedFromProposal.type,
            acceptedFromProposal.payload,
            true,
            acceptanceOf(acceptedFromProposal),
          )
        : subject
          ? { ...subject.state, owedToViewer: true }
          : proposalSubject
            ? // A proposal still staged here (its accepted object, if any, was
              // caught by `acceptedFromProposal` above): a machine's reading, `~`.
              stateForObject(proposalSubject.type, proposalSubject.payload, true, null)
            : undefined) ??
      ({
        kind: item.class === 'blocking_question' ? 'question' : 'decision',
        verification: item.class === 'blocking_question' ? 'open' : 'proposed',
        owedToViewer: true,
        irreversible: false,
      } satisfies EpistemicState);
    return {
      id: item.id,
      state:
        item.reason.kind === 'mention'
          ? {
              ...subjectState,
              verification: subjectState.verification === 'open' ? 'open' : 'proposed',
              owedToViewer: true,
              irreversible: false,
            }
          : subjectState,
      title:
        (item.subjectKind === 'message'
          ? 'direct reference in a message'
          : acceptedFromProposal
            ? payloadText(acceptedFromProposal.type, acceptedFromProposal.payload)
            : subject?.text) ??
        (proposalSubject
          ? payloadText(proposalSubject.type, proposalSubject.payload)
          : 'an item whose semantic record is unavailable'),
      rationale: rationale(reasonFor(item.reason, viewerName)),
      facts: [`raised ${clock(item.createdAt)}`],
      source,
      actions: actionsFor(item.class, item.reason.kind, source !== null),
    };
  });
  const referenceAttention = contextualReferenceAttention(data, viewer?.id);

  const participants: ParticipantSummary[] = data.participants.map((person) => ({
    id: person.id,
    // An allowlist, not `=== 'agent' ? … : …`: an unreadable kind renders a
    // person, and that default is only ever safe because this is a monogram and
    // not a certification gate. The gates that must fail closed read the `Actor`
    // server-side, never this record.
    kind: participantKindOf(person.principalKind),
    name: person.name,
    presence: 'away',
    note: null,
    isViewer: person.id === viewer?.id,
  }));
  const viewerRecord: ParticipantSummary = participants.find((person) => person.isViewer) ?? {
    id: 'replay-viewer',
    // The viewer is whoever loaded the page, and an agent does not load a page —
    // it holds a session the harness drives. The fallback viewer is a person.
    kind: 'human',
    name: viewerName,
    presence: 'away',
    note: null,
    isViewer: true,
  };
  /* Name and topic only. The head's member chips are derived from `participants`
     by `RoomFrame` — one source, read once through `participantKindOf` above —
     rather than mapped a second time here. Mapping the same rows twice was the
     round-1 gauntlet's finding 3: two member registers that nothing kept in
     step. `Omit<RoomHeadRecord, 'members'>` is what the frame's `room` prop
     takes now, so the second map has nowhere to go. */
  const room: Omit<RoomHeadRecord, 'members'> = {
    name: data.room.name,
    topic: data.room.workspaceName,
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
    referenceAttention,
    participants,
    viewer: viewerRecord,
    room,
    rooms,
    trailer: trailerFor({ objects, objectives, overdue: [] }),
    updatedAt: clock(latestReplayChange(data)),
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
  object: StateObject | (Omit<StateObject, 'kind'> & { readonly kind: 'objective' }),
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
  const answerRelation = answerRelationFor(data, object.id, correction);
  const answerSourceId = answerRelation?.toObjectId
    ? data.objectSources.find((source) => source.objectId === answerRelation.toObjectId)?.messageId
    : undefined;
  const answerRecord = answerSourceId ? recordById.get(answerSourceId) : undefined;
  const answerExcerpt = answerRecord ? quotationFrom(answerRecord) : null;
  if (
    answerExcerpt &&
    !provenance.some((entry) => entry.excerpt.messageId === answerExcerpt.messageId)
  ) {
    provenance.push({
      id: `${object.id}:${correction?.action === 'reopen' ? 'prior-answer' : 'answer'}:${answerExcerpt.messageId}`,
      excerpt: answerExcerpt,
      note: systemStatement(
        correction?.action === 'reopen'
          ? 'prior answer kept after reopen'
          : 'accepted answer linked to this question',
      ),
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
    (answerRelation !== undefined || boundAnswer !== undefined) &&
    (correction === undefined || boundAnswer !== undefined);

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
    acceptable: object.state.verification === 'proposed',
    answerable: object.kind === 'question' && object.state.verification === 'open',
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

/** Resolve receipt subjects that are represented as objective group headers. */
export function replayReceiptSubject(
  data: ReplayData,
  objects: readonly StateObject[],
  subjectId: string | null,
): StateObject | (Omit<StateObject, 'kind'> & { readonly kind: 'objective' }) | undefined {
  if (subjectId === null) return undefined;
  const ordinary = objects.find((object) => object.id === subjectId);
  if (ordinary) return ordinary;
  const participantName = new Map(data.participants.map((person) => [person.id, person.name]));
  const acceptedFromProposal = data.objects.find((candidate) => candidate.proposalId === subjectId);
  if (acceptedFromProposal) {
    const acceptedObject = objects.find((object) => object.id === acceptedFromProposal.id);
    if (acceptedObject) return acceptedObject;
    if (acceptedFromProposal.type === 'objective') {
      return {
        id: acceptedFromProposal.id,
        kind: 'objective',
        state: stateForObject(
          'objective',
          acceptedFromProposal.payload,
          false,
          acceptanceOf(acceptedFromProposal),
        ),
        text: payloadText('objective', acceptedFromProposal.payload),
        facts: objectFacts(
          'objective',
          acceptedFromProposal.payload,
          participantName,
          acceptedFromProposal.createdAt,
        ),
        objectives: [],
      };
    }
  }
  const proposal = data.proposals.find(
    (candidate) =>
      candidate.id === subjectId &&
      candidate.type === 'objective' &&
      candidate.status === 'proposed',
  );
  if (proposal) {
    return {
      id: proposal.id,
      kind: 'objective',
      state: stateForObject('objective', proposal.payload, false, null),
      text: payloadText('objective', proposal.payload),
      facts: [
        proposal.proposerKind === 'model'
          ? `drafted by ${proposal.proposerModel ?? 'an unrecorded model'}`
          : `drafted by ${participantName.get(proposal.proposerUserId ?? '') ?? 'a participant'}`,
      ],
      objectives: [],
    };
  }
  const accepted = data.objects.find(
    (candidate) => candidate.id === subjectId && candidate.type === 'objective',
  );
  if (!accepted) return undefined;
  return {
    id: accepted.id,
    kind: 'objective',
    state: stateForObject('objective', accepted.payload, false, acceptanceOf(accepted)),
    text: payloadText('objective', accepted.payload),
    facts: objectFacts('objective', accepted.payload, participantName, accepted.createdAt),
    objectives: [],
  };
}

function historicalAnswerRelationIds(data: ReplayData, questionId: string): Set<string> {
  const historical = new Set<string>();
  for (const correction of data.corrections) {
    if (correction.objectId !== questionId || correction.action !== 'reopen') continue;
    if (!isRecord(correction.after) || !Array.isArray(correction.after.priorAnswers)) continue;
    for (const relationId of correction.after.priorAnswers) {
      if (typeof relationId === 'string') historical.add(relationId);
    }
  }
  return historical;
}

function answerRelationFor(
  data: ReplayData,
  questionId: string,
  correction?: ReplayCorrectionTransition,
): ReplayData['relations'][number] | undefined {
  const eligible = data.relations.filter(
    (relation) =>
      relation.kind === 'answers' &&
      relation.fromObjectId === questionId &&
      relation.toObjectId !== null,
  );
  if (correction?.action === 'reopen') {
    return eligible.find((relation) => correction.priorAnswerRelationIds.includes(relation.id));
  }
  const historical = historicalAnswerRelationIds(data, questionId);
  return eligible.findLast((relation) => !historical.has(relation.id));
}

/** The exact persisted message supporting the currently active answer edge. */
export function activeAnswerMessageId(data: ReplayData, questionId: string): string | undefined {
  const answerObjectId = answerRelationFor(data, questionId)?.toObjectId;
  if (!answerObjectId) return undefined;
  return data.objectSources.find((source) => source.objectId === answerObjectId)?.messageId;
}

/** True only when this exact optimistic submission became the active answer. */
export function activeAnswerMatchesClientMessage(
  data: ReplayData,
  questionId: string,
  clientMessageId: string,
): boolean {
  const messageId = activeAnswerMessageId(data, questionId);
  return (
    data.messages.find((message) => message.id === messageId)?.clientMessageId === clientMessageId
  );
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

/**
 * The two projected columns core's one certification predicate reads, or `null`
 * for a thing no acceptance has touched (a staged proposal). Passing the row's
 * own `accepted_by_kind` and `human_touched_at` — rather than the old "does a
 * row exist" boolean — is what makes the rendered `✓` the ENFORCED one.
 */
type ObjectAcceptance = {
  readonly acceptedByKind: ReplayData['objects'][number]['acceptedByKind'];
  readonly humanTouchedAt: string | null;
};

/** The acceptance descriptor for a persisted accepted-object row. */
function acceptanceOf(object: ReplayData['objects'][number]): ObjectAcceptance {
  return {
    acceptedByKind: object.acceptedByKind,
    humanTouchedAt: object.humanTouchedAt === null ? null : object.humanTouchedAt.toISOString(),
  };
}

/**
 * `~` vs `✓` — CERTIFICATION — is core's one predicate for EVERY type, read off
 * the projected columns via `epistemicStateFromAcceptance`, which delegates to
 * `epistemicStateOf`, the SAME function the reducer's supersession gate enforces.
 * A machine's acceptance is `~` (unconfirmed) and stays `~` until a person
 * touches it; a thing with no acceptance (`null`, a staged proposal) is a
 * machine's reading, `~`. `confirmed` is derived here FIRST, before any type
 * branches, so it governs the glyph uniformly.
 */
function certified(acceptance: ObjectAcceptance | null): boolean {
  return (
    acceptance !== null &&
    epistemicStateFromAcceptance(acceptance.acceptedByKind, acceptance.humanTouchedAt) ===
      'confirmed'
  );
}

/**
 * The three axes of a semantic object, kept apart on purpose (init.md §5,
 * `@atrium/core`'s `epistemic.ts`):
 *
 *   1. CERTIFICATION (`~`/`✓`) — did a PERSON take this? The predicate, and the
 *      ONLY source of the tick. Governs every type here.
 *   2. CLAIM-TRUTH (`verified`/`self_reported`) — has anything OUTSIDE the
 *      claimant checked the claim? Orthogonal to (1). A machine cannot mint a
 *      `verified` claim (the reducer's `claim_verification` gate), so `verified`
 *      only ever refines an already-certified `✓` — it rides SUBORDINATE to the
 *      glyph (a green "verified" flavour of the tick), never a second `✓` source.
 *   3. QUESTION-STATUS (`open`/`answered`) — the `?` glyph is for a question with
 *      no answer yet. Answeredness never mints the tick either: an ANSWERED
 *      question is `✓` only when a person certified it, and `~` otherwise.
 *
 * Before this, a `claim` read its own `verification` and an `open_question` its
 * own `status` in branches that RETURNED before the predicate — so exactly the
 * two types a machine can accept (`modelMintingGate`) rendered the tick from
 * payload, never from who accepted. That was the covenant breach, both ways:
 * an answered-but-uncertified question showed `✓`, a human-confirmed claim `~`.
 */
function stateForObject(
  type: ReplayData['objects'][number]['type'],
  payload: ReplayData['objects'][number]['payload'],
  owedToViewer: boolean,
  acceptance: ObjectAcceptance | null,
): EpistemicState {
  const confirmed = certified(acceptance);
  if (type === 'open_question') {
    const question = OpenQuestionPayload.parse(payload);
    // A question with no answer is `?` — that is question-STATUS, not the tick.
    // Once answered, CERTIFICATION alone decides `✓` vs `~`: an answer a person
    // did not take stays a machine's reading.
    if (question.status !== 'answered') {
      return { kind: 'question', verification: 'open', owedToViewer, irreversible: false };
    }
    return {
      kind: 'question',
      verification: confirmed ? 'accepted' : 'proposed',
      owedToViewer,
      irreversible: false,
    };
  }
  if (type === 'claim') {
    const claim = ClaimPayload.parse(payload);
    // CERTIFICATION gates the tick FIRST. `verified` only distinguishes the
    // FLAVOUR of an already-certified `✓` (checked-by-another vs merely taken);
    // it is never reached for an uncertified claim, so it cannot be the tick.
    return {
      kind: 'claim',
      verification: confirmed
        ? claim.verification === 'verified'
          ? 'verified'
          : 'accepted'
        : 'self_reported',
      owedToViewer,
      irreversible: false,
    };
  }
  return {
    kind: objectKind(type),
    verification: confirmed ? 'accepted' : 'proposed',
    owedToViewer,
    irreversible: false,
  };
}

/**
 * A human's local, optimistic acceptance in the replay UI, run through the ONE
 * predicate so the rendered `✓` has a single source. `ReplaySession` used to
 * hand-set `verification: 'accepted'` on accept — a second tick source that
 * agreed with the covenant only by luck. Routing an explicit `human` acceptance
 * through `epistemicStateFromAcceptance` means a mutation of `epistemicStateOf`
 * moves this glyph the same way it moves every other.
 */
export function locallyAcceptedState(state: EpistemicState, at: string): EpistemicState {
  const confirmed = epistemicStateFromAcceptance('human', at) === 'confirmed';
  return {
    ...state,
    verification: confirmed ? 'accepted' : state.verification,
    owedToViewer: false,
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

function relationFacts(data: ReplayData, objectId: string): string[] {
  const objects = new Map(
    data.objects.map((object) => [object.id, payloadText(object.type, object.payload)]),
  );
  return data.relations.flatMap((relation) => {
    if (relation.kind === 'answers' || relation.kind === 'evidence') return [];
    if (relation.fromObjectId === objectId && relation.toObjectId) {
      const target = objects.get(relation.toObjectId) ?? relation.toObjectId;
      if (relation.kind === 'blocks') return [`blocks: ${target}`];
      if (relation.kind === 'depends_on') return [`depends on: ${target}`];
      if (relation.kind === 'supersedes') return [`supersedes: ${target}`];
    }
    if (relation.toObjectId === objectId) {
      const source = objects.get(relation.fromObjectId) ?? relation.fromObjectId;
      if (relation.kind === 'blocks') return [`blocked by: ${source}`];
      if (relation.kind === 'depends_on') return [`required by: ${source}`];
    }
    return [];
  });
}

function reasonFor(reason: ReplayData['attention'][number]['reason'], viewer: string): string {
  switch (reason.kind) {
    case 'decision_pending':
      return reason.assigned
        ? `${viewer} is named to settle this decision; inference cannot certify it`
        : 'no owner is named; any room member can settle this decision';
    case 'commitment_overdue':
      return `${viewer} owns this commitment and its recorded due time has passed`;
    case 'commitment_open':
      return `${viewer} owns this open commitment`;
    case 'commitment_confirm':
      return `${viewer} was named as owner by somebody else and must confirm or decline`;
    case 'commitment_self_stated':
      return `${viewer} authored words staged as a commitment and must confirm or decline`;
    case 'question_blocks_commitment':
      return `${viewer} owns the commitment blocked by this open question`;
    case 'question_blocks_objective':
      return 'this open question blocks an unowned objective; any room member can answer';
    case 'question_names_you':
      return `${viewer} is named on this open question`;
    case 'mention':
      return `${viewer} has a direct request routed here for action`;
    case 'reading_pending':
      return `this was staged as ${reason.proposedType}; a person must file or decline it`;
    case 'receipt_review':
      return `this was staged as ${reason.proposedType}, but its cited receipt did not certify it; review the source and file or decline it`;
  }
}

function actionsFor(
  attentionClass: ReplayData['attention'][number]['class'],
  reason: ReplayData['attention'][number]['reason']['kind'],
  hasSource: boolean,
) {
  if (reason === 'mention') {
    return [
      ...(hasSource
        ? [{ id: 'open', label: 'open source', emphasis: 'secondary' as const, statement: null }]
        : []),
      { id: 'dismiss', label: 'dismiss', emphasis: 'secondary' as const, statement: null },
    ];
  }
  if (attentionClass === 'needs_decision') {
    return [
      { id: 'answer', label: 'answer', emphasis: 'primary' as const, statement: null },
      { id: 'decline', label: 'decline', emphasis: 'secondary' as const, statement: null },
    ];
  }
  if (attentionClass === 'blocking_question') {
    return [
      { id: 'answer', label: 'answer', emphasis: 'primary' as const, statement: null },
      ...(hasSource
        ? [{ id: 'open', label: 'open source', emphasis: 'secondary' as const, statement: null }]
        : []),
    ];
  }
  if (reason === 'commitment_confirm' || reason === 'commitment_self_stated') {
    return [
      { id: 'confirm', label: 'confirm', emphasis: 'primary' as const, statement: null },
      { id: 'decline', label: 'decline', emphasis: 'secondary' as const, statement: null },
    ];
  }
  return hasSource
    ? [{ id: 'open', label: 'open source', emphasis: 'secondary' as const, statement: null }]
    : [];
}

function latestReplayChange(data: ReplayData): Date {
  const times: Date[] = [
    ...data.messages.map((row) => row.createdAt),
    ...data.interpretations.flatMap((row) => [row.createdAt, row.completedAt].filter(isDate)),
    ...data.proposals.flatMap((row) => [row.createdAt, row.decidedAt].filter(isDate)),
    ...data.objects.map((row) => row.updatedAt),
    ...data.relations.map((row) => row.createdAt),
    ...data.attention.flatMap((row) => [row.createdAt, row.resolvedAt].filter(isDate)),
    ...data.corrections.map((row) => row.createdAt),
  ];
  return times.reduce((latest, value) => (value > latest ? value : latest), new Date(0));
}

function isDate(value: Date | null): value is Date {
  return value instanceof Date;
}
