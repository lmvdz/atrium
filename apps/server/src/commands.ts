import { randomUUID } from 'node:crypto';
import {
  type AcceptedObject,
  type Actor,
  ClaimPayload,
  CommitmentPayload,
  CorrectionAction,
  DecisionPayload,
  Id,
  ObjectivePayload,
  OpenQuestionPayload,
  type Proposal,
  Proposer,
  type Relation,
} from '@atrium/core';
import type { Database } from '@atrium/db';
import { memberships } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CommandError, type Ledger } from './ledger.js';
import { projectRoomEvent } from './projections.js';
import { MessageAttachment, type RoomEvent } from './room-events.js';
import type { Authorizer, Session } from './session.js';

/**
 * The command layer — #12's client→server verbs.
 *
 * Every command follows one shape, and the order of the steps is the contract:
 *
 *   1. **Membership.** Checked against the database, per command, before
 *      anything is built. Not once at connect: a socket outlives a membership.
 *   2. **Append.** The event is built at the position the ledger assigns it and
 *      folded through @atrium/core's `appendEvent` in the same transaction as
 *      the INSERT. A rejection aborts the transaction — no row, no `room_seq`,
 *      an error to the caller (#22's invariant; see `ledger.ts`).
 *   3. **Project.** The derived tables are written in that same transaction.
 *   4. **Broadcast.** Only after commit, tagged `(room, room_seq)`.
 *
 * Two commands deliberately skip steps 2–3 entirely:
 *
 *  - `set_presence` / `set_typing` are ephemeral. #14: presence churn is
 *    exactly the routine noise the compression model exists to exclude, so it
 *    is broadcast and never written. An integration test floods presence and
 *    asserts the ledger gained zero rows — the assertion, not the intention, is
 *    what keeps this true.
 *  - `advance_seen` moves a per-user read cursor. It is *not* room history: it
 *    says where one person got to, nobody else's replay depends on it, and
 *    putting it in the log would make every room's history proportional to how
 *    often people scrolled.
 *
 * `record_proposal` and `reject_proposal` are not in #12's six. They are here
 * because `accept_proposal` is otherwise unreachable — a proposal has to exist
 * before it can be accepted, and the interpretation pipeline that will mint
 * them is #21's. They are the seam that pipeline will call, and nothing in them
 * interprets anything: the caller supplies the reading, the reducer still
 * refuses to let it arrive pre-accepted.
 */

const AttachmentList = z.array(MessageAttachment).max(20).default([]);

/** A proposal as a caller submits it: the reading, without a position or an id. */
const draftBase = {
  confidence: z.number().min(0).max(1),
  proposer: Proposer,
  /** Message ids this reading was drawn from. */
  provenance: z.array(Id).default([]),
  interpretationId: Id.nullable().default(null),
};

export const ProposalDraft = z.discriminatedUnion('type', [
  z.object({ ...draftBase, type: z.literal('decision'), payload: DecisionPayload }),
  z.object({ ...draftBase, type: z.literal('commitment'), payload: CommitmentPayload }),
  z.object({ ...draftBase, type: z.literal('open_question'), payload: OpenQuestionPayload }),
  z.object({ ...draftBase, type: z.literal('claim'), payload: ClaimPayload }),
  z.object({ ...draftBase, type: z.literal('objective'), payload: ObjectivePayload }),
]);
export type ProposalDraft = z.infer<typeof ProposalDraft>;

export const PresenceState = z.enum(['online', 'away', 'offline']);
export type PresenceState = z.infer<typeof PresenceState>;

export const Command = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('send_message'),
    roomId: Id,
    body: z.string().min(1).max(20_000),
    /** Idempotency key; also what the sender's own optimistic echo matches on. */
    clientMessageId: z.string().min(1).max(128).nullable().default(null),
    replyToId: Id.nullable().default(null),
    attachments: AttachmentList,
  }),
  z.object({ name: z.literal('record_proposal'), roomId: Id, proposal: ProposalDraft }),
  z.object({
    name: z.literal('accept_proposal'),
    roomId: Id,
    proposalId: Id,
    objectiveId: Id.nullable().default(null),
  }),
  z.object({
    name: z.literal('reject_proposal'),
    roomId: Id,
    proposalId: Id,
    reason: z.string().max(2000).nullable().default(null),
  }),
  z.object({
    name: z.literal('correct'),
    roomId: Id,
    objectId: Id,
    action: CorrectionAction,
    patch: z.record(z.string(), z.unknown()).default({}),
    note: z.string().max(2000).nullable().default(null),
  }),
  z.object({
    name: z.literal('answer_bind'),
    roomId: Id,
    /** The open question being answered. */
    questionId: Id,
    /** The decision or claim that answers it. */
    answerObjectId: Id,
    note: z.string().max(2000).nullable().default(null),
  }),
  z.object({
    name: z.literal('resolve_attention'),
    roomId: Id,
    attentionId: Id,
    status: z.enum(['resolved', 'dismissed']).default('resolved'),
  }),
  z.object({ name: z.literal('set_presence'), roomId: Id, state: PresenceState }),
  z.object({ name: z.literal('set_typing'), roomId: Id, typing: z.boolean() }),
  z.object({ name: z.literal('advance_seen'), roomId: Id, roomSeq: z.number().int().min(0) }),
]);
export type Command = z.infer<typeof Command>;
export type CommandName = Command['name'];

/** What a command did, and therefore what the socket layer should fan out. */
export type CommandResult =
  | {
      kind: 'appended';
      roomId: string;
      seq: number;
      roomSeq: number;
      event: RoomEvent;
      /** Business problems the reducer recorded. The event still happened. */
      issues: string[];
    }
  | { kind: 'presence'; roomId: string; userId: string; state: PresenceState; at: string }
  | { kind: 'typing'; roomId: string; userId: string; typing: boolean; at: string }
  | { kind: 'seen'; roomId: string; userId: string; seenSeq: number };

export interface CommandServiceOptions {
  db: Database;
  ledger: Ledger;
  authorizer: Authorizer;
}

export interface CommandService {
  execute: (session: Session, command: Command) => Promise<CommandResult>;
  /** Membership check for the plain reads — subscribe and since. */
  requireMembership: (session: Session, roomId: string) => Promise<{ seenSeq: number }>;
}

export function createCommandService({
  db,
  ledger,
  authorizer,
}: CommandServiceOptions): CommandService {
  async function requireMembership(session: Session, roomId: string) {
    const membership = await authorizer.authorize(session, roomId);
    if (!membership) {
      // Same message whether the room is missing or merely not yours. A
      // membership check that distinguishes the two is a room-existence oracle.
      throw new CommandError('not_a_member', `no membership for room "${roomId}"`);
    }
    return membership;
  }

  function actorOf(session: Session): Actor {
    return { kind: 'human', userId: session.userId };
  }

  /** The append path every non-ephemeral command funnels through. */
  async function appendAndProject(
    roomId: string,
    build: (assigned: { id: string; at: string }) => RoomEvent,
  ): Promise<CommandResult> {
    const appended = await ledger.append({
      roomId,
      build,
      project: (context) => projectRoomEvent(context),
    });
    const issues =
      appended.outcome?.outcome === 'applied_with_issue'
        ? appended.outcome.issues.map((issue) => issue.reason)
        : [];
    return {
      kind: 'appended',
      roomId: appended.roomId,
      seq: appended.seq,
      roomSeq: appended.roomSeq,
      event: appended.event,
      issues,
    };
  }

  async function execute(session: Session, command: Command): Promise<CommandResult> {
    const membership = await requireMembership(session, command.roomId);
    const actor = actorOf(session);

    switch (command.name) {
      case 'send_message':
        return appendAndProject(command.roomId, ({ id, at }) => ({
          id,
          at,
          actor,
          type: 'message_posted',
          roomId: command.roomId,
          messageId: randomUUID(),
          body: command.body,
          replyToId: command.replyToId,
          clientMessageId: command.clientMessageId,
          attachments: command.attachments,
        }));

      case 'record_proposal':
        return appendAndProject(command.roomId, ({ id, at }) => ({
          id,
          at,
          actor,
          type: 'proposal_recorded',
          proposal: draftToProposal(command.proposal, command.roomId, at),
        }));

      case 'reject_proposal':
        return appendAndProject(command.roomId, ({ id, at }) => ({
          id,
          at,
          actor,
          type: 'proposal_rejected',
          proposalId: command.proposalId,
          reason: command.reason,
        }));

      case 'accept_proposal': {
        return appendAndProject(command.roomId, ({ id, at }) => {
          // Read inside `build`, which the ledger calls after catching up under
          // the append lock: the proposal this cites must be the one the state
          // holds *now*, not the one it held when the socket frame arrived.
          const record = ledger.coreState().proposals[command.proposalId];
          if (!record) {
            throw new CommandError('invalid', `unknown proposal "${command.proposalId}"`);
          }
          if (record.proposal.roomId !== command.roomId) {
            throw new CommandError(
              'invalid',
              `proposal "${command.proposalId}" belongs to another room`,
            );
          }
          const object = objectFromProposal(record.proposal, command.objectiveId, at);
          return { id, at, actor, type: 'object_accepted', object };
        });
      }

      case 'correct':
        return appendAndProject(command.roomId, ({ id, at }) => ({
          id,
          at,
          actor,
          type: 'object_corrected',
          objectId: command.objectId,
          action: command.action,
          patch: command.patch,
          note: command.note,
        }));

      case 'answer_bind':
        return appendAndProject(command.roomId, ({ id, at }) => {
          const relation: Relation = {
            id: randomUUID(),
            roomId: command.roomId,
            kind: 'answers',
            fromObjectId: command.questionId,
            to: { kind: 'object', objectId: command.answerObjectId },
            note: command.note,
            createdAt: at,
          };
          return { id, at, actor, type: 'relation_added', relation };
        });

      case 'resolve_attention':
        return appendAndProject(command.roomId, ({ id, at }) => ({
          id,
          at,
          actor,
          type: 'attention_resolved',
          roomId: command.roomId,
          attentionId: command.attentionId,
          status: command.status,
        }));

      // ── ephemeral: broadcast, never appended (#14) ─────────────────────────
      case 'set_presence':
        return {
          kind: 'presence',
          roomId: command.roomId,
          userId: session.userId,
          state: command.state,
          at: new Date().toISOString(),
        };

      case 'set_typing':
        return {
          kind: 'typing',
          roomId: command.roomId,
          userId: session.userId,
          typing: command.typing,
          at: new Date().toISOString(),
        };

      // ── per-user cursor: a row, but not room history ───────────────────────
      case 'advance_seen': {
        const head = await ledger.head(command.roomId);
        if (command.roomSeq > head) {
          throw new CommandError(
            'invalid',
            `cannot mark seen up to ${command.roomSeq}: room "${command.roomId}" is only at ${head}`,
          );
        }
        // GREATEST, so a cursor never goes backwards — two tabs racing must not
        // let the slower one un-read what the faster one read.
        const [row] = await db
          .update(memberships)
          .set({ seenSeq: sql`greatest(${memberships.seenSeq}, ${command.roomSeq})` })
          .where(
            and(eq(memberships.roomId, command.roomId), eq(memberships.userId, session.userId)),
          )
          .returning({ seenSeq: memberships.seenSeq });
        return {
          kind: 'seen',
          roomId: command.roomId,
          userId: session.userId,
          seenSeq: Number(row?.seenSeq ?? membership.seenSeq),
        };
      }

      default: {
        const exhaustive: never = command;
        throw new CommandError('invalid', `unknown command ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return { execute, requireMembership };
}

/**
 * A draft becomes a proposal at the position the ledger assigned it: the server
 * mints the id and the timestamp, so a client cannot choose either. `status` is
 * not taken from the caller at all — the reducer would coerce it back to
 * `proposed` and record the coercion, and offering a field whose value is
 * always overridden invites someone to believe it.
 */
function draftToProposal(draft: ProposalDraft, roomId: string, at: string): Proposal {
  return {
    id: randomUUID(),
    roomId,
    type: draft.type,
    payload: draft.payload,
    confidence: draft.confidence,
    proposer: draft.proposer,
    provenance: draft.provenance,
    interpretationId: draft.interpretationId,
    status: 'proposed',
    createdAt: at,
  } as Proposal;
}

/** The object an acceptance mints, carrying the proposal's provenance forward. */
function objectFromProposal(
  proposal: Proposal | Omit<Proposal, 'status'>,
  objectiveId: string | null,
  at: string,
): AcceptedObject {
  return {
    id: randomUUID(),
    roomId: proposal.roomId,
    type: proposal.type,
    payload: proposal.payload,
    objectiveId,
    provenance: {
      messageIds: proposal.provenance,
      proposalId: proposal.id,
      interpretationId: proposal.interpretationId,
    },
    createdAt: at,
    updatedAt: at,
  } as AcceptedObject;
}
