import { randomUUID } from 'node:crypto';
import { roomMemberIds } from '@atrium/auth';
import type { Database } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  corrections,
  interpretations,
  messageReferences,
  messages,
  objectRelations,
  objectSources,
  proposalSources,
  proposals,
  attachments as roomAttachments,
  rooms,
  users,
  workspaces,
} from '@atrium/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

/**
 * The persisted input to replay.
 *
 * This is deliberately a database record, not the component view model. The
 * replay adapter may derive presentation from it, but it may not invent a
 * message, an acceptance, or a provenance edge that is absent here.
 */
export async function loadReplayData(database: Database, roomId: string) {
  return database.transaction(
    async (transaction) =>
      // Drizzle's transaction handle deliberately omits the ability to begin a
      // nested transaction, but exposes the same schema-bound query surface
      // this loader uses. Keeping the cast at this boundary prevents any caller
      // from accidentally treating the handle as a general Database.
      loadReplayDataSnapshot(transaction as unknown as Database, roomId),
    // CATCHES: publishing an attention row from the new fold beside proposals
    // or accepted objects read from the prior fold. A live refresh must render
    // one database fact, not a READ COMMITTED collage of consecutive facts.
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function loadReplayDataSnapshot(database: Database, roomId: string) {
  const [room] = await database
    .select({
      id: rooms.id,
      name: rooms.name,
      slug: rooms.slug,
      workspaceId: rooms.workspaceId,
      workspaceName: workspaces.name,
      workspaceSlug: workspaces.slug,
    })
    .from(rooms)
    .innerJoin(workspaces, eq(workspaces.id, rooms.workspaceId))
    .where(eq(rooms.id, roomId))
    .limit(1);

  if (!room) return null;

  const roomMessages = await database
    .select({
      id: messages.id,
      seq: messages.seq,
      authorId: messages.authorId,
      author: users.displayName,
      body: messages.body,
      clientMessageId: messages.clientMessageId,
      replyToId: messages.replyToId,
      attachments: messages.attachments,
      mentionUserIds: messages.mentionUserIds,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(eq(messages.roomId, roomId))
    .orderBy(asc(messages.seq));

  const messageIds = roomMessages.map((message) => message.id);
  const references =
    messageIds.length === 0
      ? []
      : await database
          .select()
          .from(messageReferences)
          .where(inArray(messageReferences.messageId, messageIds))
          .orderBy(asc(messageReferences.messageId), asc(messageReferences.ordinal));
  const referencedHumanIds = [
    ...new Set(references.filter((reference) => reference.kind === 'human').map((r) => r.targetId)),
  ];
  const referencedAttachmentIds = [
    ...new Set(
      references.filter((reference) => reference.kind === 'attachment').map((r) => r.targetId),
    ),
  ];

  const participantIds = await roomMemberIds(database, roomId);
  const [
    participants,
    roomInterpretations,
    roomProposals,
    objects,
    relations,
    attention,
    fixes,
    messageEvents,
    roomCursor,
    referenceHumans,
    referenceAttachments,
  ] = await Promise.all([
    participantIds.length === 0
      ? Promise.resolve([])
      : database
          .select({ id: users.id, name: users.displayName, avatarUrl: users.avatarUrl })
          .from(users)
          .where(inArray(users.id, participantIds))
          .orderBy(asc(users.displayName), asc(users.id)),
    messageIds.length === 0
      ? Promise.resolve([])
      : database
          .select()
          .from(interpretations)
          .where(inArray(interpretations.messageId, messageIds))
          .orderBy(asc(interpretations.createdAt), asc(interpretations.id)),
    database
      .select()
      .from(proposals)
      .where(eq(proposals.roomId, roomId))
      .orderBy(asc(proposals.createdAt), asc(proposals.id)),
    database
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.roomId, roomId))
      .orderBy(asc(acceptedObjects.createdAt), asc(acceptedObjects.id)),
    database
      .select()
      .from(objectRelations)
      .where(eq(objectRelations.roomId, roomId))
      .orderBy(asc(objectRelations.createdAt), asc(objectRelations.id)),
    database
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.roomId, roomId))
      .orderBy(asc(attentionItems.createdAt), asc(attentionItems.id)),
    database
      .select()
      .from(corrections)
      .where(eq(corrections.roomId, roomId))
      .orderBy(asc(corrections.createdAt), asc(corrections.id)),
    database
      .select({ roomSeq: coreEvents.roomSeq, payload: coreEvents.payload })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, roomId), eq(coreEvents.type, 'message_posted')))
      .orderBy(asc(coreEvents.roomSeq)),
    database
      .select({ loadedThrough: coreEvents.roomSeq })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, roomId))
      .orderBy(desc(coreEvents.roomSeq))
      .limit(1),
    referencedHumanIds.length === 0
      ? Promise.resolve([])
      : database
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, referencedHumanIds)),
    referencedAttachmentIds.length === 0
      ? Promise.resolve([])
      : database
          .select({
            id: roomAttachments.id,
            name: roomAttachments.name,
            contentType: roomAttachments.contentType,
            size: roomAttachments.size,
          })
          .from(roomAttachments)
          .where(
            and(
              eq(roomAttachments.roomId, roomId),
              inArray(roomAttachments.id, referencedAttachmentIds),
            ),
          ),
  ]);

  const messagePositions = messageEvents.flatMap((event) => {
    const messageId = event.payload.messageId;
    return typeof messageId === 'string' ? [{ messageId, roomSeq: event.roomSeq }] : [];
  });

  const proposalIds = roomProposals.map((proposal) => proposal.id);
  const objectIds = objects.map((object) => object.id);
  const [proposalProvenance, directObjectProvenance] = await Promise.all([
    proposalIds.length === 0
      ? Promise.resolve([])
      : database
          .select()
          .from(proposalSources)
          .where(
            and(
              eq(proposalSources.roomId, roomId),
              inArray(proposalSources.proposalId, proposalIds),
            ),
          )
          .orderBy(asc(proposalSources.proposalId), asc(proposalSources.messageId)),
    objectIds.length === 0
      ? Promise.resolve([])
      : database
          .select()
          .from(objectSources)
          .where(and(eq(objectSources.roomId, roomId), inArray(objectSources.objectId, objectIds)))
          .orderBy(asc(objectSources.objectId), asc(objectSources.messageId)),
  ]);

  return {
    loadReceipt: randomUUID(),
    room,
    participants,
    messages: roomMessages,
    messageReferences: references,
    referenceHumans,
    referenceAttachments,
    interpretations: roomInterpretations,
    proposals: roomProposals,
    proposalSources: proposalProvenance,
    objects,
    objectSources: directObjectProvenance,
    relations,
    attention,
    corrections: fixes,
    messagePositions,
    loadedThrough: roomCursor[0]?.loadedThrough ?? 0,
  };
}

type LoadedReplayData = NonNullable<Awaited<ReturnType<typeof loadReplayData>>>;
type LoadedReplayMessage = LoadedReplayData['messages'][number];
type LoadedReplayAttention = LoadedReplayData['attention'][number];
export type ReplayData = Omit<
  LoadedReplayData,
  | 'loadReceipt'
  | 'loadedThrough'
  | 'messagePositions'
  | 'messages'
  | 'messageReferences'
  | 'referenceHumans'
  | 'referenceAttachments'
  | 'attention'
> & {
  /** Optional only for hand-built fixtures; every server load mints a fresh commit receipt. */
  readonly loadReceipt?: string;
  /** Optional only for hand-built fixtures created before live client ids existed. */
  messages: (Omit<LoadedReplayMessage, 'clientMessageId' | 'mentionUserIds'> & {
    readonly clientMessageId?: string | null;
    /** Optional only for hand-built fixtures created before structured mentions existed. */
    readonly mentionUserIds?: readonly string[];
  })[];
  /** Optional only for hand-built fixtures and pre-0015 snapshots. */
  readonly messageReferences?: LoadedReplayData['messageReferences'];
  readonly referenceHumans?: LoadedReplayData['referenceHumans'];
  readonly referenceAttachments?: LoadedReplayData['referenceAttachments'];
  /** Generated FK columns are database enforcement plumbing, not view input. */
  readonly attention: Array<
    Omit<LoadedReplayAttention, 'subjectObjectId' | 'subjectProposalId' | 'subjectMessageId'> & {
      readonly subjectObjectId?: string | null;
      readonly subjectProposalId?: string | null;
      readonly subjectMessageId?: string | null;
    }
  >;
  /** Optional only so hand-built unit fixtures can describe pre-ledger imports. */
  readonly messagePositions?: LoadedReplayData['messagePositions'];
  /** Optional only for hand-built fixtures created before live route coordination. */
  readonly loadedThrough?: number;
};

export async function loadReplayDataByLocation(
  database: Database,
  workspaceSlug: string,
  roomSlug: string,
) {
  const [match] = await database
    .select({ roomId: rooms.id })
    .from(rooms)
    .innerJoin(workspaces, eq(workspaces.id, rooms.workspaceId))
    .where(and(eq(workspaces.slug, workspaceSlug), eq(rooms.slug, roomSlug)))
    .limit(1);
  return match ? loadReplayData(database, match.roomId) : null;
}
