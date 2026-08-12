import {
  type AcceptedObject,
  type Actor,
  actorUserId,
  type CoreState,
  type Relation,
} from '@atrium/core';
import {
  acceptedObjects,
  attentionItems,
  corrections,
  messageReferences,
  messages,
  objectRelations,
  objectSources,
  proposalSources,
  proposals,
  attachments as storedAttachments,
} from '@atrium/db/schema';
import { and, eq } from 'drizzle-orm';
import { CommandError, type ProjectionContext, type Tx } from './ledger.js';
import type { RoomEvent } from './room-events.js';

/**
 * The read tables, rebuilt from the ledger one event at a time.
 *
 * Two rules hold this together, and both are about not having a second opinion:
 *
 *  1. **Same transaction as the append.** #12 says projections are derived
 *     transactionally. A ledger row whose projection failed is a database that
 *     disagrees with itself: the fold says the object exists, the table says it
 *     does not, and whichever one the UI happens to read wins.
 *  2. **Read from `after`, never recompute.** Every value written below comes
 *     out of the `CoreState` the reducer just produced. Nothing here re-derives
 *     whether a supersession was legal, whether an amendment validated, or what
 *     an object's revision is now — that is exactly the duplicated judgement
 *     that lets a projection drift from the log it claims to project.
 *
 * Consequence of (2): an event that was consumed but did not do what it asked
 * (`applied_with_issue` — an amendment to a missing object, a proposal already
 * recorded) writes nothing. Each branch checks `after` against `before` and
 * returns when the state did not actually change. The event still occupies its
 * position in the ledger, because it happened; there is simply nothing to
 * project.
 */

/**
 * Side effects that must share the append's transaction but are not read-table
 * writes.
 *
 * There is exactly one, and it is the interpretation enqueue (#23). It is a
 * *hook* rather than a line in `projectMessagePosted` because this module may
 * not import `queue.ts` — `queue.ts` imports the ledger and the projections,
 * and a cycle here would be a cycle in the append path. Passing it in also
 * makes "was the job enqueued in the same transaction as the message?" a
 * question a test can ask by handing over a hook that inspects `tx`.
 *
 * Absent, nothing schedules interpretation and messages accumulate unread. That
 * is the state `merge/foundation` shipped in, and #19's gauntlet routed it:
 * `enqueueInterpretation` existed and nothing called it.
 */
export interface ProjectionHooks {
  /**
   * Called with the append transaction after a message row is inserted, and
   * before the transaction commits. A throw takes the message down with it,
   * which is the point: a message whose interpretation could not be scheduled
   * is a message nothing will ever read.
   */
  onMessagePosted?: (input: { tx: Tx; roomId: string; messageId: string }) => Promise<unknown>;
}

export async function projectRoomEvent(
  context: ProjectionContext<RoomEvent>,
  hooks: ProjectionHooks = {},
): Promise<void> {
  const { event } = context;
  switch (event.type) {
    case 'message_posted':
      return projectMessagePosted(context, event, hooks);
    case 'proposal_recorded':
      return projectProposalRecorded(context, event);
    case 'proposal_rejected':
      return projectProposalRejected(context, event);
    case 'proposal_superseded':
      return projectProposalSuperseded(context, event);
    case 'object_accepted':
      return projectObjectAccepted(context, event);
    case 'object_corrected':
      return projectObjectCorrected(context, event);
    case 'relation_added':
      return projectRelationAdded(context, event);
    case 'attention_resolved':
      return projectAttentionResolved(context, event);
    default: {
      const exhaustive: never = event;
      throw new Error(`no projection for event ${JSON.stringify(exhaustive)}`);
    }
  }
}

type EventOf<T extends RoomEvent['type']> = Extract<RoomEvent, { type: T }>;

/**
 * The user id when a **person** acted, `null` for an agent, a model or the
 * system.
 *
 * The actor comes off the `ProjectionContext` now, not off the event: #21 took
 * it out of the payload, so `event.actor` no longer exists and these columns are
 * written from the ledger row's trusted columns instead. Every `decided_by`,
 * `accepted_by`, `by_user_id` and `author_id` in this file is therefore an
 * authenticated identity or NULL — which is what those columns were always
 * supposed to mean.
 *
 * ## An agent has a user id and still gets NULL here, on purpose
 *
 * The name is the specification: this is the *human's* id, and the columns it
 * feeds all mean "the person whose judgement this was" — `decided_by`,
 * `accepted_by`, `by_user_id`. An agent never reaches those columns at all,
 * because the reducer refuses every event that would write one before a
 * projection runs.
 *
 * `author_id` on `messages` is the one column where an agent legitimately could
 * be written and is not, and that is a deferral rather than an oversight. Making
 * an agent's message carry its author is the *front half* of a change whose back
 * half is a voice register — AGENTS.md's "no synthesized speech" rule says
 * nothing rendered as a person's words may be words they did not write, and the
 * feed's attribution cell is unkinded today (`MessageRecord.actor` is a display
 * name string). Filling in `author_id` alone would render an agent's sentences
 * as a participant's typed words with nothing to distinguish them, which is a
 * worse falsehood than an unattributed row. The two land together, in the ticket
 * that gives the renderer a kind to read; this function is where that ticket
 * starts, and it does not start here.
 *
 * ## What this function is NOT for, learned the expensive way
 *
 * It answers "which person", so every caller must be asking that question.
 * `projectAttentionResolved` was calling it to answer "**whose** item is this",
 * which is a question about *ownership*, and ownership is not a thing only
 * people have. Getting `null` back, it dropped the owner predicate from its
 * UPDATE and resolved anybody's item — a wildcard, from a gate. It asks
 * `actorUserId` now; see the note there. If a call site here means "which
 * identity", it is the wrong function, and the two only look interchangeable
 * because for every actor kind that existed before `agent` they agreed.
 */
function humanId(actor: Actor): string | null {
  return actor.kind === 'human' ? actor.userId : null;
}

async function projectMessagePosted(
  { tx, roomId, actor }: ProjectionContext<RoomEvent>,
  event: EventOf<'message_posted'>,
  hooks: ProjectionHooks,
): Promise<void> {
  await tx.insert(messages).values({
    id: event.messageId,
    roomId,
    authorId: humanId(actor),
    body: event.body,
    replyToId: event.replyToId,
    clientMessageId: event.clientMessageId,
    attachments: event.attachments,
    mentionUserIds: event.mentionUserIds ?? [],
  });
  if (event.attachments.length > 0) {
    await tx.insert(storedAttachments).values(
      event.attachments.map((attachment) => ({
        ...attachment,
        roomId,
        claimedByMessageId: event.messageId,
      })),
    );
  }
  for (const reference of [...(event.references ?? [])].sort((a, b) => a.ordinal - b.ordinal)) {
    const [stored] = await tx
      .insert(messageReferences)
      .values({ ...reference, roomId, messageId: event.messageId })
      .returning({ id: messageReferences.id });
    if (!stored) throw new Error('message reference insert returned no identity');
    if (reference.kind === 'human') {
      await tx
        .insert(attentionItems)
        .values({
          roomId,
          userId: reference.targetId,
          subjectKind: 'message',
          subjectId: event.messageId,
          class: 'mention',
          reason: { kind: 'mention', request: event.body },
          status: 'pending',
          createdAt: new Date(event.at),
        })
        .onConflictDoNothing();
    }
  }
  // Same transaction, same statement batch, no gap. `pg-boss`'s `fromDrizzle`
  // adapter writes the job row through `tx`, so there is no instant at which
  // the message is durable and the job is not.
  await hooks.onMessagePosted?.({ tx, roomId, messageId: event.messageId });
}

/**
 * The polymorphic actor id: the user id for a human or an agent, the model id
 * for a model, NULL for the system actor — the shape `core_events.actor_id`
 * already uses, and what `proposals_staged_by_id_matches_kind` requires.
 *
 * Distinct from `humanId` above and not a variant of it: this one answers "which
 * identity, of whatever sort" and that one answers "which person". They agreed
 * for every kind that existed before agents did, which is why the difference is
 * worth spelling out now that they do not.
 */
function actorId(actor: Actor): string | null {
  switch (actor.kind) {
    case 'human':
      return actor.userId;
    case 'agent':
      return actor.userId;
    case 'model':
      return actor.model;
    case 'system':
      return null;
    default: {
      const exhaustive: never = actor;
      throw new Error(`unknown actor ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function projectProposalRecorded(
  { tx, roomId, before, after }: ProjectionContext<RoomEvent>,
  event: EventOf<'proposal_recorded'>,
): Promise<void> {
  const id = event.proposal.id;
  const record = after.proposals[id];
  if (!record || before.proposals[id]) return;
  const proposal = record.proposal;
  await tx.insert(proposals).values({
    id,
    roomId,
    interpretationId: proposal.interpretationId,
    type: proposal.type,
    payload: proposal.payload,
    confidence: proposal.confidence,
    proposerKind: proposal.proposer.kind,
    proposerModel: proposal.proposer.kind === 'model' ? proposal.proposer.model : null,
    proposerUserId: proposal.proposer.kind === 'human' ? proposal.proposer.userId : null,
    // Read off the reducer's record, not off `context.actor`, for rule (2) at the
    // top of this file: the state is what the fold produced, and taking the actor
    // from the context here would be a second derivation of the same fact, free
    // to disagree with the one the acceptance gate reads (#22 r9, D1).
    stagedByKind: record.stagedBy.kind,
    stagedById: actorId(record.stagedBy),
    quote: proposal.quote,
    status: record.status,
    createdAt: new Date(proposal.createdAt),
  });

  // A staged reading needs the same inspectable source chain as an accepted
  // object. Waiting until acceptance to project provenance leaves the exact
  // proposal that still needs human judgment with no receipt to inspect.
  for (const messageId of proposal.provenance) {
    await tx.insert(proposalSources).values({ roomId, proposalId: id, messageId });
  }
}

async function projectProposalRejected(
  { tx, roomId, actor, before, after }: ProjectionContext<RoomEvent>,
  event: EventOf<'proposal_rejected'>,
): Promise<void> {
  const record = after.proposals[event.proposalId];
  if (record?.status !== 'rejected') return;
  if (before.proposals[event.proposalId]?.status === 'rejected') return;
  await tx
    .update(proposals)
    .set({
      status: 'rejected',
      rejectedReason: record.rejectedReason,
      decidedBy: humanId(actor),
      decidedAt: new Date(event.at),
    })
    .where(and(eq(proposals.id, event.proposalId), eq(proposals.roomId, roomId)));
}

/**
 * A staged reading retired by a newer one (#8, via #21's sixth core event).
 *
 * Deliberately not folded into `projectProposalRejected` even though both write
 * a status: `rejected` means a person judged the reading and said no, and
 * `superseded` means nobody judged it at all — a later interpretation pass
 * replaced it. Collapsing the two would tell the room that somebody declined
 * something no person ever saw, and `decided_by` would name whoever happened to
 * be running the worker. So the decision columns are left alone here, which is
 * the honest record: there was no decision.
 */
async function projectProposalSuperseded(
  { tx, roomId, before, after }: ProjectionContext<RoomEvent>,
  event: EventOf<'proposal_superseded'>,
): Promise<void> {
  const record = after.proposals[event.proposalId];
  if (record?.status !== 'superseded') return;
  if (before.proposals[event.proposalId]?.status === 'superseded') return;
  await tx
    .update(proposals)
    .set({ status: 'superseded' })
    .where(and(eq(proposals.id, event.proposalId), eq(proposals.roomId, roomId)));
}

async function projectObjectAccepted(
  { tx, roomId, actor, before, after }: ProjectionContext<RoomEvent>,
  event: EventOf<'object_accepted'>,
): Promise<void> {
  const id = event.object.id;
  const record = after.objects[id];
  if (!record || before.objects[id]) return;
  const object = record.object;

  await tx.insert(acceptedObjects).values({
    id,
    roomId,
    type: object.type,
    payload: object.payload,
    objectiveId: object.objectiveId,
    proposalId: object.provenance.proposalId,
    revision: record.revision,
    acceptedBy: humanId(actor),
    createdAt: new Date(object.createdAt),
    updatedAt: new Date(record.updatedAt),
  });

  // Provenance rows are the composite-FK story in miniature: `(room_id,
  // object_id)` and `(room_id, message_id)` both, so a fact can never cite a
  // message from a room it does not live in.
  for (const messageId of object.provenance.messageIds) {
    await tx.insert(objectSources).values({ roomId, objectId: id, messageId });
  }

  const proposalId = object.provenance.proposalId;
  if (proposalId !== null) {
    await tx
      .update(proposals)
      .set({
        status: 'accepted',
        decidedBy: humanId(actor),
        decidedAt: new Date(event.at),
      })
      .where(and(eq(proposals.id, proposalId), eq(proposals.roomId, roomId)));
  }
}

async function projectObjectCorrected(
  { tx, roomId, actor, before, after }: ProjectionContext<RoomEvent>,
  event: EventOf<'object_corrected'>,
): Promise<void> {
  // The reducer appends exactly one correction record per correction that
  // actually changed something — and none at all for an amendment that patched
  // nothing, or one it refused. That record is the signal to write, and asking
  // for it is cheaper and more honest than re-deciding the question here.
  if (after.corrections.length === before.corrections.length) return;
  const correction = after.corrections[after.corrections.length - 1];
  if (!correction || correction.eventId !== event.id) return;

  const record = after.objects[event.objectId];
  if (!record) return;

  await tx
    .update(acceptedObjects)
    .set({
      /**
       * **`type` moves too.** It did not until #22 r10, and `retype` is the verb
       * whose entire job is to change it: a `retype` from objective to
       * commitment left the row reading `type = 'objective'` while its payload
       * became a commitment's, permanently, since nothing but the insert ever
       * wrote this column. The fold said one thing and the read model another,
       * and they never reconverged — both partial indexes on `(room_id, type)`
       * filed the object under the type it used to be, and a later
       * `reattribute` that is only legal on a commitment succeeded against a row
       * the database called an objective (r10, D3).
       *
       * Written from `after`, like everything else here (rule 2 at the top of
       * this file). The general audit — every projection that writes a subset of
       * the fold's fields — is #56 and stays there; this is the one field a verb
       * in this event's own vocabulary changes.
       */
      type: record.object.type,
      payload: record.object.payload,
      revision: record.revision,
      retractedAt: record.retractedAt === null ? null : new Date(record.retractedAt),
      supersededById: record.supersededById,
      updatedAt: new Date(record.updatedAt),
    })
    .where(and(eq(acceptedObjects.id, event.objectId), eq(acceptedObjects.roomId, roomId)));

  await tx.insert(corrections).values({
    roomId,
    objectId: event.objectId,
    action: correction.action,
    before: correction.before,
    after: correction.after,
    byUserId: humanId(actor),
    note: correction.note,
    eventId: event.id,
  });
}

async function projectRelationAdded(
  context: ProjectionContext<RoomEvent>,
  event: EventOf<'relation_added'>,
): Promise<void> {
  const { tx, roomId, actor, before, after } = context;
  const relation = event.relation;
  const landed = after.relations.some((existing) => existing.id === relation.id);
  const existed = before.relations.some((existing) => existing.id === relation.id);
  if (!landed || existed) return;

  await tx.insert(objectRelations).values({
    id: relation.id,
    roomId,
    kind: relation.kind,
    fromObjectId: relation.fromObjectId,
    ...targetColumns(relation),
    note: relation.note,
    createdBy: humanId(actor),
    createdAt: new Date(relation.createdAt),
  });

  // `supersedes` and `answers` flip status on the objects they touch. Those
  // flips live in `after`; re-sync both endpoints from it rather than
  // reimplementing which one moved.
  await syncObjectRow(tx, roomId, after, relation.fromObjectId);
  if (relation.to.kind === 'object') {
    await syncObjectRow(tx, roomId, after, relation.to.objectId);
  }
  if (relation.kind === 'answers') {
    await tx
      .update(attentionItems)
      .set({ status: 'resolved', resolvedAt: new Date(event.at) })
      .where(
        and(
          eq(attentionItems.roomId, roomId),
          eq(attentionItems.subjectKind, 'object'),
          eq(attentionItems.subjectId, relation.fromObjectId),
          eq(attentionItems.status, 'pending'),
        ),
      );
  }
}

function targetColumns(relation: Relation): {
  toObjectId: string | null;
  toMessageId: string | null;
  toUrl: string | null;
  toFileKey: string | null;
} {
  const empty = { toObjectId: null, toMessageId: null, toUrl: null, toFileKey: null };
  switch (relation.to.kind) {
    case 'object':
      return { ...empty, toObjectId: relation.to.objectId };
    case 'message':
      return { ...empty, toMessageId: relation.to.messageId };
    case 'url':
      return { ...empty, toUrl: relation.to.url };
    case 'file':
      return { ...empty, toFileKey: relation.to.fileKey };
    default: {
      const exhaustive: never = relation.to;
      throw new Error(`unknown relation target ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Rewrite one object row from state. The only writer of derived object status. */
async function syncObjectRow(
  tx: Tx,
  roomId: string,
  state: CoreState,
  objectId: string,
): Promise<void> {
  const record = state.objects[objectId];
  if (!record) return;
  const object: AcceptedObject = record.object;
  await tx
    .update(acceptedObjects)
    .set({
      // Same reason as `projectObjectCorrected`: this function's contract is
      // "rewrite one object row from state", and a rewrite that skips the
      // discriminator is a row that disagrees with the fold about what it is.
      type: object.type,
      payload: object.payload,
      revision: record.revision,
      retractedAt: record.retractedAt === null ? null : new Date(record.retractedAt),
      supersededById: record.supersededById,
      updatedAt: new Date(record.updatedAt),
    })
    .where(and(eq(acceptedObjects.id, objectId), eq(acceptedObjects.roomId, roomId)));
}

/**
 * Attention is per person, so "resolve" is scoped three ways: the item, its
 * room, and its owner. The check is the UPDATE itself — it matches on all
 * three and reports what it touched, so there is no window between deciding
 * and acting. Nothing matched means nothing to resolve, and the throw rolls the
 * transaction back before the ledger row is durable: an event saying an
 * attention item was resolved, when no such item was, is history that never
 * happened.
 */
async function projectAttentionResolved(
  { tx, roomId, actor }: ProjectionContext<RoomEvent>,
  event: EventOf<'attention_resolved'>,
): Promise<void> {
  // ── Whose item, and the wildcard that used to be here ─────────────────────
  //
  // **#96 r2, finding 2 — both blind critics, independently.** This read
  // `humanId(actor)`, and a null owner *dropped the `userId` predicate from the
  // UPDATE altogether*. While every non-human was anonymous that branch was
  // unreachable in practice; the moment an agent holds a session and a room
  // membership — which is what #96 is — it became a live wildcard: one
  // `resolve_attention` frame from an agent member dismissed **anybody's**
  // Needs-you item, and the ack came back clean.
  //
  // The rule is now the one the command always meant: **an actor may resolve
  // only attention it owns.** It is scoped by identity rather than by humanity,
  // because owning an attention item is not a thing only people do — an agent is
  // an attention target (`attention_items.user_id` is a `users` id, and an agent
  // has one) and resolving its own routed work is ordinary participation, which
  // is why the command layer leaves `resolve_attention` open to it.
  //
  // `actorUserId` is @atrium/core's "does this actor have an identity" predicate,
  // deliberately not `humanId`: this is the one place in this file where the two
  // questions differ and the identity one is the right one. Every other call
  // site here writes a `decided_by` / `accepted_by` / `by_user_id` column, which
  // means "the person whose judgement this was" and stays `humanId`.
  //
  // An **anonymous** actor is refused outright rather than falling through to a
  // wildcard. A `model` or `system` actor owns nothing here — there is no
  // `attention_items` row that could point at it — so the honest answer is that
  // it has no item to resolve, not that it may resolve every one. That is the
  // fail-closed direction, and it is what the null branch should always have
  // said.
  const owner = actorUserId(actor);
  if (owner === null) {
    throw new CommandError(
      'invalid',
      `a ${actor.kind} actor carries no identity and so owns no attention item; "${event.attentionId}" in room "${roomId}" belongs to somebody, and only its owner may resolve it`,
    );
  }
  const touched = await tx
    .update(attentionItems)
    .set({ status: event.status, resolvedAt: new Date(event.at) })
    .where(
      and(
        eq(attentionItems.id, event.attentionId),
        eq(attentionItems.roomId, roomId),
        eq(attentionItems.userId, owner),
      ),
    )
    .returning({ id: attentionItems.id });
  if (touched.length === 0) {
    throw new CommandError(
      'invalid',
      `no pending attention item "${event.attentionId}" for this actor in room "${roomId}"`,
    );
  }
}
