import { roomMemberIds } from '@atrium/auth';
import type { Database } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  corrections,
  interpretations,
  messages,
  objectRelations,
  objectSources,
  proposalSources,
  proposals,
  rooms,
  users,
  workspaces,
} from '@atrium/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

/**
 * The persisted input to replay.
 *
 * This is deliberately a database record, not the component view model. The
 * replay adapter may derive presentation from it, but it may not invent a
 * message, an acceptance, or a provenance edge that is absent here.
 */
export async function loadReplayData(database: Database, roomId: string) {
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
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(eq(messages.roomId, roomId))
    .orderBy(asc(messages.seq));

  const messageIds = roomMessages.map((message) => message.id);

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
    room,
    participants,
    messages: roomMessages,
    interpretations: roomInterpretations,
    proposals: roomProposals,
    proposalSources: proposalProvenance,
    objects,
    objectSources: directObjectProvenance,
    relations,
    attention,
    corrections: fixes,
    messagePositions,
  };
}

type LoadedReplayData = NonNullable<Awaited<ReturnType<typeof loadReplayData>>>;
type LoadedReplayMessage = LoadedReplayData['messages'][number];
export type ReplayData = Omit<LoadedReplayData, 'messagePositions' | 'messages'> & {
  /** Optional only for hand-built fixtures created before live client ids existed. */
  messages: (Omit<LoadedReplayMessage, 'clientMessageId'> & {
    readonly clientMessageId?: string | null;
  })[];
  /** Optional only so hand-built unit fixtures can describe pre-ledger imports. */
  readonly messagePositions?: LoadedReplayData['messagePositions'];
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
