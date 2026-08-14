import { randomUUID } from 'node:crypto';
import {
  type AcceptedObject,
  type Actor,
  actorUserId,
  type CoreState,
  type Relation,
} from '@atrium/core';
import {
  acceptedObjects,
  agents,
  attentionItems,
  corrections,
  fundedArms,
  messageReferences,
  messages,
  objectRelations,
  objectSources,
  plans,
  proposalSources,
  proposals,
  sessionSignals,
  sessionSubscriptions,
  sessions,
  attachments as storedAttachments,
} from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
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
    case 'plan_opened':
      return projectPlanOpened(context, event);
    case 'plan_settled':
      return projectPlanSettled(context, event);
    case 'session_opened':
      return projectSessionOpened(context, event);
    case 'session_settled':
      return projectSessionSettled(context, event);
    case 'session_failed':
      return projectSessionFailed(context, event);
    case 'signal_raised':
      return projectSignalRaised(context, event);
    case 'plan_rlimit_set':
      return projectPlanRlimitSet(context, event);
    case 'draw_refused':
      return projectDrawRefused(context, event);
    case 'session_signaled':
      return projectSessionSignaled(context, event);
    case 'session_subscribed':
      return projectSessionSubscribed(context, event);
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
 * ## This is the *judgement* columns' id, and an agent never reaches them
 *
 * The name is the specification: this is the *human's* id, and the columns it
 * feeds all mean "the person whose judgement this was" — `decided_by`,
 * `accepted_by`, `by_user_id`, `created_by`. An agent never reaches those
 * columns at all, because the reducer refuses every event that would write one
 * before a projection runs.
 *
 * `author_id` on `messages` is NOT one of them, and no longer comes from here.
 * Authoring a message is not a judgement; it is speech, and an agent speaks in
 * the conversation as itself. #101 made `projectMessagePosted` write
 * `actorUserId(actor)` — the identity of whoever spoke, agent or person — so an
 * agent's message carries its own author instead of landing NULL and rendering
 * unattributed. That was the *front half*; its *back half* is the web voice
 * register (`MessageRecord.authorKind`, `data-author-kind` on the feed row),
 * which is what keeps AGENTS.md's "no synthesized speech" rule true — an agent's
 * words are attributed to the agent, in a register a reader can tell from a
 * person's typed words, never rendered as a human's. The two landed in one
 * ticket, which is what the pin in `integration/server/agent-principal.test.ts`
 * exists to enforce: attribution here is only ever correct because the register
 * ships with it.
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
    // Not `humanId`: authoring is speech, not judgement. Whoever spoke owns the
    // words — an agent's message carries the agent's own id (its `users` row),
    // so it renders attributed and in the agent voice register rather than as an
    // unattributed NULL. See the note on `humanId` above and #101.
    authorId: actorUserId(actor),
    body: event.body,
    replyToId: event.replyToId,
    clientMessageId: event.clientMessageId,
    // The answer arm's routing receipt (#128). Lands on
    // `messages_cause_same_room_fk`, so a cross-room cause that got past the
    // command and past the ledger trigger still cannot become a row.
    causeMessageId: event.causeMessageId,
    attachments: event.attachments,
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
    // A mention lands as attention for whoever was NAMED — a person or an agent.
    // Both `human` and `agent` reference targets carry a `users` row and a room
    // membership (drizzle/0017), which is what `attention_items.user_id` FKs, so
    // routing is kind-agnostic across the two identity kinds: an agent receiving
    // a mention gets the same pending `mention` item a human does. The other
    // reference kinds — attachment, proposal, object — are room *items*, not
    // participants, and have nothing to pay attention. An allowlist of the two
    // participant kinds, not a denylist of the three item kinds, so a later kind
    // added to the alphabet is not silently routed as attention.
    if (reference.kind === 'human' || reference.kind === 'agent') {
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
    // A human and an agent (#117) both stage as themselves and carry a user id;
    // a model carries a model string instead. `proposals_proposer_identified`
    // requires the id present for both identity kinds.
    proposerUserId:
      proposal.proposer.kind === 'human' || proposal.proposer.kind === 'agent'
        ? proposal.proposer.userId
        : null,
    // Read off the reducer's record, not off `context.actor`, for rule (2) at the
    // top of this file: the state is what the fold produced, and taking the actor
    // from the context here would be a second derivation of the same fact, free
    // to disagree with the one the acceptance gate reads (#22 r9, D1).
    stagedByKind: record.stagedBy.kind,
    stagedById: actorId(record.stagedBy),
    quote: proposal.quote,
    status: record.status,
    sessionId: event.sessionId ?? null,
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
    // The two projected halves of core's one certification predicate. Read off
    // the fold's record, not `context.actor` (rule 2 at the top of this file):
    // `acceptedBy.kind` answers `isHuman` where the `accepted_by` uuid cannot
    // (an agent carries one too, 0017), and `humanTouchedAt` is `null` for a
    // machine acceptance and the acceptance instant for a human one. `~` vs `✓`
    // is derived from exactly these downstream — see `epistemic.ts`.
    acceptedByKind: record.acceptedBy.kind,
    humanTouchedAt: record.humanTouchedAt === null ? null : new Date(record.humanTouchedAt),
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
      // Both halves of the predicate are written from `after`, not just one.
      // `acceptedByKind` is the accepter's kind and a correction does not change
      // it — but writing it (like `type`, `payload`, every field above) keeps
      // this projection convergent with the fold rather than trusting the value
      // the insert left behind; omitting it was the divergence-repair gap a
      // blind critic named (#98 r2, finding 6).
      acceptedByKind: record.acceptedBy.kind,
      // A correction by a person promotes `~`→`✓`: the reducer moves
      // `humanTouchedAt` off `null` (reduce.ts `commitPlan`), and this is the
      // one field in this event's own vocabulary that carries that promotion
      // into the read model. Omitting it — as this projection omitted every
      // field it did not think changed until #22 r10 — left a corrected object
      // still rendering `~`, the covenant's second clause invisible. Written
      // from `after`, like everything else here.
      humanTouchedAt: record.humanTouchedAt === null ? null : new Date(record.humanTouchedAt),
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

/* ── the agent/plan/session lifecycle projections (#116) ─────────────────────
 *
 * These six mirror `projectMessagePosted`: a ledger-only event the reducer never
 * folds, projected straight from its own payload into a read table. There is no
 * `after`/`before` diff to consult, because `isCoreEvent` is false for all six
 * and so `before === after` — nothing folded them. The `plans` and `sessions`
 * tables ARE the state; the projection is the only writer of it.
 *
 * The pstree invariant is not re-checked here — it is the schema's job, four
 * ways (composite FKs, the missing parent column, the room and kind triggers),
 * and duplicating it in application code would be a second opinion that could
 * drift. A projection that violates it aborts the transaction on the constraint,
 * exactly as every other projection in this file does. And nothing here writes a
 * judgement column: a session settling or failing touches only its `sessions`
 * row, so the covenant's `~`→`✓` is out of reach by construction (#114 T3).
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * CLAIM THE CAUSE MESSAGE'S ONE FUNDED ARM (#128, #124 resolution 4) — the
 * projection layer's half, called by the two draw-taking appends and by nothing
 * else.
 *
 * Three layers, as always, and they bind three different writers:
 *
 *   1. `commands.ts`'s `requireUnfundedCause` — the legible refusal on the
 *      command path.
 *   2. This read — binds a writer that reached the projection without passing
 *      the command (a direct `ledger.append` of a `session_opened`).
 *   3. `funded_arms_room_cause_pk` — binds a writer that reached the table
 *      without passing either, and is the authority the other two describe.
 *
 * The sentence below is this layer's alone, deliberately unlike the command's:
 * a shared string would make each layer's red-on-revert test assert the
 * disjunction, so deleting this read would leave its own witness green on the
 * command's catch (#122's standing lesson, which has now fired four times).
 *
 * A null cause claims nothing. `at most one arm per cause` says nothing about an
 * append that names no cause, and a person opening a session by hand names none.
 */
async function claimFundedArm(
  tx: Tx,
  roomId: string,
  eventId: string,
  arm: 'spawn' | 'continue',
  sessionId: string,
  causeMessageId: string | null,
  at: string,
): Promise<void> {
  if (causeMessageId === null) return;
  const [claimed] = await tx
    .select({ sessionId: fundedArms.sessionId, arm: fundedArms.arm })
    .from(fundedArms)
    .where(and(eq(fundedArms.roomId, roomId), eq(fundedArms.causeMessageId, causeMessageId)))
    .for('share');
  if (claimed) {
    throw new CommandError(
      'invalid',
      `message "${causeMessageId}" already funded a ${claimed.arm} into session "${claimed.sessionId}" — refused at the PROJECTION's funded-arm claim, which is the guard that binds a writer appending a draw without passing open_session or resume_session`,
    );
  }
  await tx.insert(fundedArms).values({
    roomId,
    causeMessageId,
    arm,
    sessionId,
    drawnByEventId: eventId,
    createdAt: new Date(at),
  });
}

async function projectPlanOpened(
  { tx, roomId, event: { id } }: ProjectionContext<RoomEvent>,
  event: EventOf<'plan_opened'>,
): Promise<void> {
  await tx.insert(plans).values({
    id: event.planId,
    roomId,
    agentUserId: event.agentUserId,
    title: event.title,
    status: 'open',
    budgetLimitMicros: event.budgetLimitMicros,
    // Provenance only — a plan never draws, so NO `funded_arms` claim (#124
    // resolution 2). The absence of a claim here is deliberate and load-bearing:
    // adding one would refuse a second free board from one message, which is
    // enforcement nobody decided and which the purse does not need.
    causeMessageId: event.causeMessageId,
    openedByEventId: id,
    createdAt: new Date(event.at),
    updatedAt: new Date(event.at),
  });
}

async function projectPlanSettled(
  { tx, roomId, event: { id } }: ProjectionContext<RoomEvent>,
  event: EventOf<'plan_settled'>,
): Promise<void> {
  // A plan may NOT settle while a child session is still `open` (#119) — the
  // mirror of F-A (`projectSessionOpened` below refuses OPENING a session under
  // an already-settled plan). The map #113 destination is "the plan settles to a
  // receipt INDEXING ITS SESSIONS' RECEIPTS", and a receipt cannot index a child
  // receipt that does not exist yet, so every child must have taken its exit
  // before the plan takes its own. This reads the children under the append
  // lock, the same guarded-read shape F-A uses (`.for('share')`): a zero-open
  // result passes; any open child throws and aborts the append, so `settle_plan`
  // `nack`s and writes NO ledger row while an open child exists.
  //
  // Concurrency (mirrors #118/F-A): a session opening AS the plan settles cannot
  // slip through. Both this read and `projectSessionOpened`'s insert run inside
  // the append transaction under the ONE global advisory lock
  // (`pg_advisory_xact_lock`, ledger.ts), so they serialize: either the
  // `session_opened` commits first — and this read sees the open child and
  // refuses — or this settle commits first — and F-A's settled-parent check
  // refuses the later `session_opened`. There is no interleaving in which both
  // win.
  const openChild = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.planId, event.planId),
        eq(sessions.roomId, roomId),
        eq(sessions.status, 'open'),
      ),
    )
    .for('share');
  if (openChild.length > 0) {
    throw new CommandError(
      'invalid',
      `plan "${event.planId}" has ${openChild.length} open child session(s) and may not settle — every session must settle or fail first, so the plan's receipt can index its children's receipts`,
    );
  }

  // One exit, once (#116 fix r2, mirroring `projectAttentionResolved`'s owner
  // scope). The UPDATE is scoped to an `open` plan IN THIS ROOM, `.returning()`s
  // what it touched, and a zero-row result throws — which aborts the append
  // transaction, so a `plan_settled` naming a nonexistent, cross-room, or
  // already-settled plan leaves NO ledger row and the caller gets a `nack`
  // instead of an `ack` for a settle that did not happen. Without the
  // `status = 'open'` predicate a re-settle would flip a settled plan's fields
  // again; with it, a plan settles at most once.
  const settled = await tx
    .update(plans)
    .set({ status: 'settled', settledByEventId: id, updatedAt: new Date(event.at) })
    .where(and(eq(plans.id, event.planId), eq(plans.roomId, roomId), eq(plans.status, 'open')))
    .returning({ id: plans.id });
  if (settled.length === 0) {
    throw new CommandError(
      'invalid',
      `no open plan "${event.planId}" to settle in room "${roomId}" — it does not exist here or has already settled`,
    );
  }
}

async function projectSessionOpened(
  { tx, roomId, event: { id } }: ProjectionContext<RoomEvent>,
  event: EventOf<'session_opened'>,
): Promise<void> {
  // `planId` lands on the `sessions_plan_same_room_fk` composite FK: a parent
  // in another room, or no such plan, aborts here. One parent, one room, by DDL.
  //
  // But a composite FK checks EXISTENCE, not STATUS — it accepts a parent that
  // has already settled (#116 fix r3, F-A). A settled plan's receipt has closed;
  // grafting a fresh `open` session onto it re-opens work under a board that
  // reported done. So this reads `plans.status` under the append lock, the same
  // guarded-write shape `projectPlanSettled` / `projectSessionExit` use: a
  // zero-row match throws and aborts the append, so a `session_opened` naming a
  // settled/failed or absent plan leaves NO ledger row and the caller gets a
  // `nack`. A session may open only under a plan that is still `open`.
  const [parent] = await tx
    .select({ status: plans.status })
    .from(plans)
    .where(and(eq(plans.id, event.planId), eq(plans.roomId, roomId)))
    .for('share');
  if (!parent) {
    throw new CommandError(
      'invalid',
      `no plan "${event.planId}" to open a session under in room "${roomId}" — it does not exist here`,
    );
  }
  if (parent.status !== 'open') {
    throw new CommandError(
      'invalid',
      `plan "${event.planId}" is ${parent.status}, not open — a session may open only under an open plan, and this plan's receipt has already closed`,
    );
  }
  // ── THE EXECUTION-AUTHORITY RECORD, WRITTEN WITH THE DRAW (#120 round-6 F1) ──
  //
  // The session's whole execution authority is stamped in THIS transaction — the
  // same append that inserts the row and increments `authorized_draws` — so a
  // granted draw is born with determinate authority and there is no window in
  // which a spent draw has none. Round 5's campaign-stopping F1 was exactly that
  // window: the draw committed here, then `runGranted` claimed the lease
  // separately, and a kill between the two left a spent, UNLEASED, never-
  // reconciled session (reconciliation only touches leased sessions).
  //
  //   * `execution_mode`/`execution_owner` ride the EVENT (decided at grant by the
  //     command service from whether a provider is wired), so replay reconstructs
  //     grant-time authority deterministically.
  //   * `execution_authority` — the capability token — is minted HERE, row-only:
  //     it must never reach the wire (`toWire` broadcasts the whole event), and its
  //     exact value need not survive replay (a replayed session is already terminal
  //     or is a wedge the reconciler reads the row for). Minting it in the
  //     projection is what keeps a secret off the event. `provider` only.
  //   * `execution_heartbeat_at` is stamped at grant for a provider session, so an
  //     unclaimed-but-granted session is reconcilable the moment its granting
  //     process dies — closing the F1 wedge for real.
  const providerOwned = event.executionMode === 'provider';
  await tx.insert(sessions).values({
    id: event.sessionId,
    roomId,
    planId: event.planId,
    harness: event.harness,
    model: event.model,
    status: 'open',
    openedByEventId: id,
    executionMode: event.executionMode,
    executionOwner: providerOwned ? event.executionOwner : null,
    executionAuthority: providerOwned ? randomUUID() : null,
    executionHeartbeatAt: providerOwned ? new Date(event.at) : null,
    executionClaimedAt: null,
    // The new-work arm's routing receipt (#128). Lands on
    // `sessions_cause_same_room_fk`.
    causeMessageId: event.causeMessageId,
    createdAt: new Date(event.at),
    updatedAt: new Date(event.at),
  });
  // A SPAWN IS A DRAW, so it claims the cause message's one funded arm — in this
  // same transaction, before the increment below, so a colliding retry aborts
  // the whole append and moves `authorized_draws` by nothing at all.
  await claimFundedArm(tx, roomId, id, 'spawn', event.sessionId, event.causeMessageId, event.at);
  // The draw is now GRANTED — record it in the committed authorized-draw
  // accounting (#118). One increment per session_opened, in this same append
  // transaction under the global ledger lock, so `authorized_draws` equals
  // `count(sessions)` for the plan by construction. This is the quantity the
  // spawn gate (in `commands.ts`, read under the same lock before the event was
  // built) enforces the slice against — never the adapter-reported spend. A
  // draw that would exceed the slice never reaches here: it is built as a
  // `draw_refused` instead, so no session rows up and this counter does not move.
  await tx
    .update(plans)
    .set({
      authorizedDraws: sql`${plans.authorizedDraws} + 1`,
      updatedAt: new Date(event.at),
    })
    .where(and(eq(plans.id, event.planId), eq(plans.roomId, roomId)));
}

/**
 * The one writer of a session's exit receipt, for both spellings of it. Writes
 * `sessions.status/exit_summary/spend_micros/context_pct` and NOTHING else —
 * the non-epistemic half of #114's two receipts. There is no `accepted_objects`
 * statement anywhere in this function, which is what makes "a session settling
 * flips no `~`" true by construction rather than by a guard.
 */
async function projectSessionExit(
  tx: Tx,
  roomId: string,
  eventId: string,
  event: EventOf<'session_settled'> | EventOf<'session_failed'>,
  status: 'settled' | 'failed',
): Promise<void> {
  // One exit per session, once (#116 fix r2). Scoped to an `open` session IN THIS
  // ROOM, `.returning()`ing what it touched. A zero-row result throws and aborts
  // the append, so a settle of a random/cross-room session id writes nothing and
  // `nack`s. The `status = 'open'` predicate is the load-bearing half: without
  // it a second exit would rewrite a session's receipt, and repeated
  // settled/failed frames would flip `settled ↔ failed`, two contradictory exit
  // receipts for one process. With it, a session takes exactly one exit.
  const exited = await tx
    .update(sessions)
    .set({
      status,
      exitSummary: event.exitSummary,
      spendMicros: event.spendMicros ?? 0,
      contextPct: event.contextPct,
      // THE PRODUCED ARTIFACT LANDS IN THE ROW HERE — the #120×#121 seam, enriched
      // by #145. #120's ExecutionProvider mints the verified artifact (`{branch,
      // commit, remote}`) and #145 carries the REAL structured diff and the test
      // results ALONGSIDE it on the exit event; #121's control-plane review pane
      // certifies `sessions.artifact` (`SessionArtifact`) and renders exactly this.
      // The settle projection is the writer: it persists the event's branch+commit
      // AND the diff/tests into the column so the produced artifact is exactly what
      // the human reviews and lands. `remote` is #120's internal scratch pointer and
      // is not a review fact, so it is dropped. `diff`/`tests` are copied ONLY when
      // the event carried them — a merge/branch-only artifact carries neither, and
      // the column leaves them ABSENT (undefined), which the render distinguishes
      // from a present-but-empty diff the producer vouched for (#145's honest-empty).
      // Null exit artifact leaves the slot null — an external/audit/failed exit.
      //
      // PINNED WRITE-SET (#127/#128): the enrichment rides the SAME jsonb column
      // this projection already wrote. It touches NOTHING on `accepted_objects`,
      // `plans.rlimit_slice`, or `plans.authorized_draws` — a settle is non-epistemic
      // and carries no route to a `✓` or a draw. `settle-writeset.test.ts` folds a
      // settle carrying a full diff+tests and asserts those three tables byte-stable.
      artifact: event.artifact
        ? {
            branch: event.artifact.branch,
            commit: event.artifact.commit,
            ...(event.artifact.diff !== undefined ? { diff: event.artifact.diff } : {}),
            ...(event.artifact.tests !== undefined ? { tests: event.artifact.tests } : {}),
          }
        : null,
      settledByEventId: eventId,
      updatedAt: new Date(event.at),
    })
    .where(
      and(
        eq(sessions.id, event.sessionId),
        eq(sessions.roomId, roomId),
        eq(sessions.status, 'open'),
      ),
    )
    .returning({ id: sessions.id });
  if (exited.length === 0) {
    throw new CommandError(
      'invalid',
      `no open session "${event.sessionId}" to ${status} in room "${roomId}" — it does not exist here or has already exited`,
    );
  }

  // ── AN EXIT DISPOSES THE SESSION'S WAITS (#127; #123 resolution 6) ─────────
  //
  // A subscription outlives nothing: once the process it was registered against
  // has published its exit receipt, there is nothing left to wake, and a
  // `waiting` row pointing at a settled session is a wait whose only possible
  // futures are a resume that will be refused and an expiry escalation about a
  // session nobody can do anything with. So the exit disposes them, in the SAME
  // transaction as the exit itself — there is no instant at which the session is
  // terminal and its waits still say `waiting`.
  //
  // Scoped to `waiting`, so a wait already matched or already expired keeps the
  // disposition it earned; this rewrites nothing that has one.
  await tx
    .update(sessionSubscriptions)
    .set({ status: 'disposed', updatedAt: new Date(event.at) })
    .where(
      and(
        eq(sessionSubscriptions.roomId, roomId),
        eq(sessionSubscriptions.sessionId, event.sessionId),
        eq(sessionSubscriptions.status, 'waiting'),
      ),
    );
}

async function projectSessionSettled(
  { tx, roomId, event: { id } }: ProjectionContext<RoomEvent>,
  event: EventOf<'session_settled'>,
): Promise<void> {
  await projectSessionExit(tx, roomId, id, event, 'settled');
}

async function projectSessionFailed(
  { tx, roomId, event: { id } }: ProjectionContext<RoomEvent>,
  event: EventOf<'session_failed'>,
): Promise<void> {
  await projectSessionExit(tx, roomId, id, event, 'failed');
}

/**
 * A signal escalates to a participant's attention (#112 reuse). One
 * `attention_items` row for the named target, pointing at the existing room
 * subject the signal names — the same shape a mention lands, `onConflictDoNothing`
 * against the `(user, subject, class)` key so a re-raised signal is idempotent.
 * The row's composite subject FK refuses a subject from another room; the
 * `reason` is core's own structured `RationaleReason`, so it renders through
 * `renderRationale` unchanged.
 */
async function projectSignalRaised(
  { tx, roomId, event: { at } }: ProjectionContext<RoomEvent>,
  event: EventOf<'signal_raised'>,
): Promise<void> {
  await tx
    .insert(attentionItems)
    .values({
      roomId,
      userId: event.targetUserId,
      subjectKind: event.subjectKind,
      subjectId: event.subjectId,
      class: event.class,
      reason: event.reason,
      status: 'pending',
      createdAt: new Date(at),
    })
    .onConflictDoNothing();
}

/* ── the budget/rlimit enforcement projections (#118) ────────────────────────*/

/**
 * A plan's slice, set or raised — the human act that funds the plan (#118, #115
 * decision 4). The human-only gate is one layer up (`commands.ts` refuses a
 * non-human `set_plan_rlimit` before the append); this is the projection, the
 * ONLY writer of `plans.rlimit_slice`, which is what makes "no machine-authored
 * path raises a slice" true by construction — there is no other path to the
 * column.
 *
 * Scoped to an `open` plan IN THIS ROOM and guarded the same way
 * `projectPlanSettled` / `projectSessionOpened` are: a zero-row UPDATE throws and
 * aborts the append, so a `set_plan_rlimit` naming a nonexistent, cross-room, or
 * already-settled plan leaves NO ledger row and the caller gets a `nack`. A
 * settled plan's contract is closed; its slice cannot be moved after the fact.
 */
async function projectPlanRlimitSet(
  { tx, roomId, event: { at } }: ProjectionContext<RoomEvent>,
  event: EventOf<'plan_rlimit_set'>,
): Promise<void> {
  // MED-6 (#118 fix r2): a human setting `slice < authorized_draws` is legitimate
  // clawback, not an error — further draws refuse (`authorized_draws + 1 > slice`)
  // while the sessions already granted stay open. So no floor is enforced here; the
  // human may lower the ceiling below the count already drawn on purpose.
  const set = await tx
    .update(plans)
    .set({ rlimitSlice: event.slice, updatedAt: new Date(at) })
    .where(and(eq(plans.id, event.planId), eq(plans.roomId, roomId), eq(plans.status, 'open')))
    .returning({ id: plans.id });
  if (set.length === 0) {
    throw new CommandError(
      'invalid',
      `no open plan "${event.planId}" to set an rlimit slice on in room "${roomId}" — it does not exist here or has already settled`,
    );
  }
}

/**
 * A draw refused at the authorization boundary (#118, #115 decision 2). The
 * durable receipt IS this ledger row: `reason=budget`, carrying the slice and the
 * committed draw count it was checked against. It writes NOTHING to `plans` or
 * `sessions` — no session rows up and `authorized_draws` does not move, because
 * the draw was not granted. That absence is the enforcement: the spawn that would
 * have exceeded the slice leaves a visible refusal and no session, rather than a
 * session the slice could not fund.
 *
 * A no-op projection is deterministic on replay by construction. The decision
 * that produced this event — slice read, `authorized_draws + 1 > slice` — was
 * made under the append lock in `commands.ts` before the event was built; it is
 * not re-made here, exactly as no projection re-checks the pstree invariant.
 */
async function projectDrawRefused(
  _context: ProjectionContext<RoomEvent>,
  _event: EventOf<'draw_refused'>,
): Promise<void> {
  // Intentionally empty: the durable ledger row is the whole receipt.
}

/* ── the signal/interrupt projections (#127, from #123's resolution) ─────────
 *
 * ## THE PINNED WRITE-SET, and it is the point of this comment
 *
 * These two write `session_signals` and `session_subscriptions` — their OWN
 * tables — and, for a granted `resume` only, the matched subscription's
 * disposition and the plan's committed draw count. They contain NO statement
 * against `accepted_objects`, so a steer can no more flip a `~` to a `✓` than a
 * settle can (#114 T3), and they contain NO statement against
 * `plans.rlimit_slice`, whose only writer is and stays `projectPlanRlimitSet`
 * (the human-only `set_plan_rlimit`). `plans.authorized_draws` is untouched by
 * `steer` and `interrupt`; a GRANTED `resume` moves it by exactly one, because a
 * resume IS a draw (#115 decision 2) and the alternative is a free wake path
 * around #118's boundary. `integration/server/signal-events.test.ts` folds a
 * burst of steers and interrupts and asserts all three byte-stable.
 *
 * ## Why the open-session check is HERE as well as in the command
 *
 * The 0025 trigger freezes a terminal `sessions` row; it structurally cannot
 * refuse a later LEDGER APPEND that merely names one. And the command's own
 * check binds the command path only. So the rule is enforced twice, in the two
 * places that bind different writers, exactly as `projectSessionOpened` re-reads
 * its parent plan's status after `open_session` already looked at it.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A signal appended into a running session.
 *
 * Writes ONE `session_signals` row and, for a `resume`, marks the wait it paid
 * out and increments the plan's committed draw count. Nothing else, anywhere.
 */
async function projectSessionSignaled(
  { tx, roomId, actor, event: { id } }: ProjectionContext<RoomEvent>,
  event: EventOf<'session_signaled'>,
): Promise<void> {
  // Signals target OPEN sessions only, read under the append lock so the session
  // cannot exit underneath the check. A zero-row / non-open result throws, which
  // aborts the append: a `session_signaled` against a terminal session leaves NO
  // ledger row and the caller gets a `nack`. This is the projection half of #123
  // resolution 3 — the command asked the same question one step earlier, and both
  // are needed because they bind different writers.
  const [target] = await tx
    .select({ status: sessions.status, planId: sessions.planId })
    .from(sessions)
    .where(and(eq(sessions.id, event.sessionId), eq(sessions.roomId, roomId)))
    .for('share');
  if (!target) {
    throw new CommandError(
      'invalid',
      `no session "${event.sessionId}" in room "${roomId}" to signal — refused at the PROJECTION; a signal names a process this room is running`,
    );
  }
  if (target.status !== 'open') {
    throw new CommandError(
      'invalid',
      // Deliberately NOT the command's sentence. The two guards are different
      // clauses binding different writers, and a shared string would make each
      // one's red-on-revert test assert the DISJUNCTION — delete the command
      // check and its own test stays green because this one catches the same
      // input (#122's standing lesson, and it caught exactly that here).
      `session "${event.sessionId}" is ${target.status}, not open — refused at the PROJECTION, which is the guard that binds a writer reaching this table without passing the command`,
    );
  }

  // ── THE SLICE BOUNDARY, RE-READ HERE FOR A RESUME (#127 fix round 2, A) ────
  //
  // Round 1 checked the boundary in `resume_session` ONLY, and both foreign
  // lineages found the same hole: a direct `ledger.append` of a
  // `session_signaled {kind:'resume'}` never passes that command, so it reached
  // the increment below and moved `authorized_draws` past a spent slice with no
  // `draw_refused` receipt anywhere. That is the free wake path #118's boundary
  // exists to close, one layer down.
  //
  // So the question is asked again HERE, from this transaction's own read, for
  // exactly the reason the target-open question is asked again above: the two
  // guards bind DIFFERENT WRITERS. `FOR SHARE` on the plan row, so the committed
  // count and the human-set ceiling cannot move between this read and the
  // increment eight lines down — and a NULL slice reads as a ceiling of ZERO,
  // fail-closed, the same way `open_session` and `resume_session` read it.
  //
  // The refusal throws, which aborts the append: an over-slice resume that got
  // here leaves NO signal row, NO increment, and NO ledger event.
  if (event.kind === 'resume') {
    const [funding] = await tx
      .select({ slice: plans.rlimitSlice, authorizedDraws: plans.authorizedDraws })
      .from(plans)
      .where(and(eq(plans.id, target.planId), eq(plans.roomId, roomId)))
      .for('share');
    if (!funding) {
      throw new CommandError(
        'invalid',
        `no plan "${target.planId}" in room "${roomId}" to draw against — refused at the PROJECTION's slice re-check; a continuation is a draw and a draw needs a plan`,
      );
    }
    const slice = funding.slice ?? 0;
    if (funding.authorizedDraws + 1 > slice) {
      throw new CommandError(
        'invalid',
        // Its OWN sentence, distinct from every other refusal in this file and
        // from the command's `draw_refused` receipt (#122's standing lesson): a
        // shared string would let this clause be deleted while its witness
        // stayed green on a neighbour's catch.
        `resuming session "${event.sessionId}" would take draw ${funding.authorizedDraws + 1} of a slice of ${slice} — refused at the PROJECTION's slice re-check, which is the guard that binds a writer appending a resume without passing resume_session`,
      );
    }
  }

  await tx.insert(sessionSignals).values({
    id: event.signalId,
    roomId,
    sessionId: event.sessionId,
    kind: event.kind,
    body: event.body,
    causeMessageId: event.causeMessageId,
    supersedesEventId: event.supersedesEventId,
    subscriptionId: event.subscriptionId,
    // The TRUSTED actor off the ledger row, never the payload (#21's contract).
    // The interrupt-authorization trigger in drizzle/0045 reads this column, so a
    // direct writer cannot dodge the command's lookup by writing a different one.
    raisedByUserId: actorUserId(actor),
    signaledByEventId: id,
    createdAt: new Date(event.at),
  });

  if (event.kind !== 'resume') return;

  // A CONTINUE IS A DRAW TOO, so it claims the cause message's one funded arm,
  // in this same transaction and before the increment (#128, #124 resolution 4).
  // `steer` and `interrupt` never reach here: they spend nothing, so they claim
  // nothing and a channel may steer one session a hundred times from one
  // message. The uniqueness is about the PURSE, not about the conversation.
  await claimFundedArm(tx, roomId, id, 'continue', event.sessionId, event.causeMessageId, event.at);

  // ── A RESUME IS A DRAW, AND THIS IS WHERE IT IS SPENT (#115 decision 2) ────
  //
  // The boundary check ran in `commands.ts` under this same append lock, against
  // this same committed count, and decided that this event is a grant rather than
  // a `draw_refused`. So the grant is recorded here in the same transaction, one
  // increment, exactly as `projectSessionOpened` records a spawn's. Without it the
  // slice would bound spawns only and every continuation would be free — the
  // campaign-stopping shape #123's gauntlet named.
  await tx
    .update(plans)
    .set({ authorizedDraws: sql`${plans.authorizedDraws} + 1`, updatedAt: new Date(event.at) })
    .where(and(eq(plans.id, target.planId), eq(plans.roomId, roomId)));

  if (event.subscriptionId === null) return;
  // The wait paid out. Scoped to `waiting` and to this session, `.returning()`ing
  // what it touched: a zero-row result throws and aborts the append, so a resume
  // naming an already-matched, expired, disposed or foreign wait leaves no row.
  const matched = await tx
    .update(sessionSubscriptions)
    .set({ status: 'matched', matchedByEventId: id, updatedAt: new Date(event.at) })
    .where(
      and(
        eq(sessionSubscriptions.id, event.subscriptionId),
        eq(sessionSubscriptions.roomId, roomId),
        eq(sessionSubscriptions.sessionId, event.sessionId),
        eq(sessionSubscriptions.status, 'waiting'),
      ),
    )
    .returning({ id: sessionSubscriptions.id });
  if (matched.length === 0) {
    throw new CommandError(
      'invalid',
      `subscription "${event.subscriptionId}" is not a waiting subscription of session "${event.sessionId}" in room "${roomId}" — a continuation pays out a wait that is still waiting`,
    );
  }
}

/**
 * A durable wait registered against a running session.
 *
 * Writes ONE `session_subscriptions` row. `expires_at` is NOT NULL in the table
 * and mandatory in the event, so there is no spelling of a wait without a
 * horizon — which is what stops an unmatched subscribe from holding a session
 * open forever and blocking #119's plan-settle with nothing owed to anybody.
 */
async function projectSessionSubscribed(
  { tx, roomId, actor, event: { id } }: ProjectionContext<RoomEvent>,
  event: EventOf<'session_subscribed'>,
): Promise<void> {
  // Subscriptions target open sessions only, for the same reason and by the same
  // read as `projectSessionSignaled` above: a wait registered against a process
  // that has already exited can never be matched and can only ever escalate.
  //
  // The lineage comes back on the same read (#127 fix round 2, B) because the
  // authorization below needs it: `plans.agent_user_id` → `agents.owner_user_id`,
  // the same two principals `requireSessionControl` compares against in the
  // command and the same two the 0046 trigger looks up for the row.
  const [target] = await tx
    .select({
      status: sessions.status,
      agentUserId: plans.agentUserId,
      ownerUserId: agents.ownerUserId,
    })
    .from(sessions)
    .innerJoin(plans, and(eq(plans.id, sessions.planId), eq(plans.roomId, sessions.roomId)))
    .innerJoin(agents, eq(agents.userId, plans.agentUserId))
    .where(and(eq(sessions.id, event.sessionId), eq(sessions.roomId, roomId)))
    .for('share', { of: sessions });
  if (!target) {
    throw new CommandError(
      'invalid',
      `no session "${event.sessionId}" in room "${roomId}" to subscribe — a wait names a process this room is running`,
    );
  }
  if (target.status !== 'open') {
    throw new CommandError(
      'invalid',
      `session "${event.sessionId}" is ${target.status}, not open — a wait registered against a process that has already exited can never be matched, only escalated`,
    );
  }

  // ── A WAIT IS CONTROL, RE-CHECKED HERE (#127 fix round 2, B) ───────────────
  //
  // Round 1 authorized a subscribe in `subscribe_session` and NOWHERE else, so a
  // bystander's wait landed through any writer that did not pass that command —
  // and grok proved the point by deleting the command clause and watching every
  // test stay green. Registering a wait decides how long a session stays open and
  // therefore how long its plan cannot settle (#119), which is control over
  // somebody else's plan, so it belongs to the plan's agent principal or that
  // agent's human owner.
  //
  // The actor is the TRUSTED envelope actor, never the payload (#21). A `model`
  // or `system` append carries no user id and therefore fails CLOSED here — the
  // same direction 0018 named and the same one the 0046 trigger takes for a NULL
  // `raised_by_user_id`.
  const raisedByUserId = actorUserId(actor);
  if (raisedByUserId !== target.agentUserId && raisedByUserId !== target.ownerUserId) {
    throw new CommandError(
      'invalid',
      // Its own sentence, sharing NO asserted phrase with
      // `sessionControlAuthorizationRefusal` — the command's wording was reused
      // here at first and the bystander-at-the-command witness stayed GREEN with
      // its clause deleted, because this guard caught the same input and said the
      // same thing. That is #122's standing lesson reproduced exactly, caught by
      // running the revert, and fixed by making the two sentences different.
      `the wait registered on session "${event.sessionId}" names a raiser who neither holds nor owns the process — refused at the PROJECTION, which is the guard that binds a writer registering a wait without passing subscribe_session`,
    );
  }

  await tx.insert(sessionSubscriptions).values({
    id: event.subscriptionId,
    roomId,
    sessionId: event.sessionId,
    source: event.source,
    matcher: event.matcher,
    expiresAt: new Date(event.expiresAt),
    status: 'waiting',
    // The TRUSTED actor off the ledger row, exactly as `session_signals` carries
    // its raiser. The 0046 authorization trigger reads this column, so a direct
    // writer cannot dodge the lookup by writing a different one.
    raisedByUserId,
    subscribedByEventId: id,
    createdAt: new Date(event.at),
    updatedAt: new Date(event.at),
  });
}
