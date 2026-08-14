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
  plans,
  proposalSources,
  proposals,
  attachments as roomAttachments,
  rooms,
  sessions,
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
      // The author's kind, off the same join the name comes from. #101: an
      // agent authors in its own voice register, and the register is read from
      // this column — NULL only when the author row is gone (a deleted user),
      // which the view constructor reads as `'unknown'` through `participantKindOf`.
      authorKind: users.principalKind,
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
  const references =
    messageIds.length === 0
      ? []
      : await database
          .select()
          .from(messageReferences)
          .where(inArray(messageReferences.messageId, messageIds))
          .orderBy(asc(messageReferences.messageId), asc(messageReferences.ordinal));
  // Both participant reference kinds resolve to a `users` row — an agent holds
  // one exactly as a person does (drizzle/0017) — so a `@`-mention of either
  // renders with the target's current display name. Item references (attachment,
  // proposal, object) are resolved separately below.
  const referencedParticipantIds = [
    ...new Set(
      references
        .filter((reference) => reference.kind === 'human' || reference.kind === 'agent')
        .map((r) => r.targetId),
    ),
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
    referenceParticipants,
    referenceAttachments,
    roomSessions,
  ] = await Promise.all([
    participantIds.length === 0
      ? Promise.resolve([])
      : database
          .select({
            id: users.id,
            name: users.displayName,
            avatarUrl: users.avatarUrl,
            // What the identity IS, read from the same row its name is. The view
            // constructors translate this into the participant record's `kind`,
            // so the roster, the presence marker, the monogram and the counts
            // render an agent member as an agent instead of stamping it a person.
            principalKind: users.principalKind,
          })
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
    referencedParticipantIds.length === 0
      ? Promise.resolve([])
      : database
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, referencedParticipantIds)),
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
    // The fourth attention subject is a SESSION (#127), and an attention row can
    // only be TITLED from the thing it is about. Without these rows a
    // subscription-expiry escalation rendered as "an item whose semantic record
    // is unavailable" — a true sentence about the wrong table, since the record
    // exists and is simply a process rather than a proposition. Four columns and
    // the parent plan's title: enough to name the process honestly, and nothing
    // that would make the replay view a second control plane (that surface is
    // `control-plane-data.ts`, and polish is #129's).
    database
      .select({
        id: sessions.id,
        planId: sessions.planId,
        planTitle: plans.title,
        harness: sessions.harness,
        model: sessions.model,
        status: sessions.status,
      })
      .from(sessions)
      .innerJoin(plans, and(eq(plans.id, sessions.planId), eq(plans.roomId, sessions.roomId)))
      .where(eq(sessions.roomId, roomId))
      .orderBy(asc(sessions.createdAt), asc(sessions.id)),
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
    referenceParticipants,
    referenceAttachments,
    interpretations: roomInterpretations,
    proposals: roomProposals,
    proposalSources: proposalProvenance,
    objects,
    objectSources: directObjectProvenance,
    relations,
    attention,
    sessions: roomSessions,
    corrections: fixes,
    messagePositions,
    loadedThrough: roomCursor[0]?.loadedThrough ?? 0,
  };
}

type LoadedReplayData = NonNullable<Awaited<ReturnType<typeof loadReplayData>>>;
type LoadedReplayMessage = LoadedReplayData['messages'][number];
type LoadedReplayAttention = LoadedReplayData['attention'][number];
type LoadedReplayParticipant = LoadedReplayData['participants'][number];
export type ReplayData = Omit<
  LoadedReplayData,
  | 'loadReceipt'
  | 'loadedThrough'
  | 'messagePositions'
  | 'messages'
  | 'messageReferences'
  | 'referenceParticipants'
  | 'referenceAttachments'
  | 'attention'
  | 'participants'
  | 'sessions'
> & {
  /**
   * Optional `principalKind` only for hand-built fixtures created before an
   * identity carried a kind; a real load always selects it (the column is NOT
   * NULL). The view constructor reads it through `participantKindOf`, which fails
   * CLOSED — an absent or unreadable value renders as `'unknown'` (a neutral
   * marker, visibly not a person), never silently as a human. So a fixture that
   * forgets to set a kind shows up as unknown on screen rather than joining the
   * people count, which is the round-1 gauntlet's finding 1.
   */
  participants: (Omit<LoadedReplayParticipant, 'principalKind'> & {
    readonly principalKind?: LoadedReplayParticipant['principalKind'];
  })[];
  /** Optional only for hand-built fixtures; every server load mints a fresh commit receipt. */
  readonly loadReceipt?: string;
  /**
   * `clientMessageId` optional for fixtures created before live client ids;
   * `authorKind` optional for fixtures created before an author carried a kind
   * (#101). A real load always selects `authorKind` off the author join; the
   * view constructor reads it through `participantKindOf`, so a fixture that
   * omits it — or an author row that is gone — renders as `'unknown'`, never
   * silently as a person.
   */
  messages: (Omit<LoadedReplayMessage, 'clientMessageId' | 'authorKind'> & {
    readonly clientMessageId?: string | null;
    readonly authorKind?: LoadedReplayMessage['authorKind'];
  })[];
  /** Optional only for hand-built fixtures and pre-0015 snapshots. */
  readonly messageReferences?: LoadedReplayData['messageReferences'];
  readonly referenceParticipants?: LoadedReplayData['referenceParticipants'];
  readonly referenceAttachments?: LoadedReplayData['referenceAttachments'];
  /** Generated FK columns are database enforcement plumbing, not view input. */
  readonly attention: Array<
    Omit<
      LoadedReplayAttention,
      'subjectObjectId' | 'subjectProposalId' | 'subjectMessageId' | 'subjectSessionId'
    > & {
      readonly subjectObjectId?: string | null;
      readonly subjectProposalId?: string | null;
      readonly subjectMessageId?: string | null;
      /** The fourth subject edge (#127) — a subscription-expiry escalation. */
      readonly subjectSessionId?: string | null;
    }
  >;
  /**
   * The room's processes, for titling a `session`-subject attention row (#127).
   * Optional only so hand-built fixtures written before the fourth subject
   * existed still typecheck; a real load always selects them. A `session` item
   * whose session is absent falls back to the honest unavailable-record sentence
   * rather than inventing a name.
   */
  readonly sessions?: LoadedReplayData['sessions'];
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
