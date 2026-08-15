import { z } from 'zod';

/**
 * The Atrium wire contract, re-declared on the CLIENT side.
 *
 * apps/loop is a protocol-only client (#148, #139): it may talk to the server
 * only over the wire, exactly as a browser does, and a lint rule forbids it from
 * importing `apps/server` internals. So it cannot `import { ServerFrame } from
 * '../../server/src/protocol.js'` — it re-declares the frames and commands it
 * actually uses, the way any external client coded against a documented protocol
 * would.
 *
 * The obvious hazard of a second copy is drift: this file could quietly disagree
 * with the server's real schema and nobody would notice until a frame failed to
 * parse in production. That hazard is PINNED, not hoped away —
 * `integration/loop/channel-loop-daemon.test.ts` parses this daemon's outgoing
 * commands with the SERVER's real `Command` zod, and parses the server's real
 * frames with the schemas here. If the two dialects drift, that test reds. See
 * the `contract drift` block there.
 *
 * Only the subset the daemon uses is modelled. Frames and event types it does
 * not act on are parsed leniently (they still have to be valid JSON with a
 * `type`) and ignored, so a new server event never crashes the loop.
 */

/** A uuid, as the server's `Id` accepts it. Kept liberal on purpose: the server
 *  is the authority on shape; this client only has to carry the string back. */
export const Id = z.string().min(1);
export const Timestamp = z.string().min(1);

/**
 * The trusted author, from the ledger row's own columns — NEVER the payload.
 * Mirrors `@atrium/core`'s `Actor`: a human/agent carries a `userId`, a model
 * carries a `model`, the system carries neither.
 */
export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: Id }),
  z.object({ kind: z.literal('agent'), userId: Id }),
  z.object({ kind: z.literal('model'), model: z.string().min(1) }),
  z.object({ kind: z.literal('system') }),
]);
export type Actor = z.infer<typeof Actor>;

/** The userId of a human/agent actor, or `null` for a model/system actor. */
export function actorUserId(actor: Actor): string | null {
  return actor.kind === 'human' || actor.kind === 'agent' ? actor.userId : null;
}

// ── The room events the daemon reads ────────────────────────────────────────
//
// Every ledger event carries `{ id, at, roomId }` beside its `type` discriminant
// (the actor rides on the WireEvent, not in here). Unknown keys are stripped:
// this client reads only the fields it routes on.

const eventBase = { id: Id, at: Timestamp, roomId: Id };

export const MessagePosted = z.object({
  ...eventBase,
  type: z.literal('message_posted'),
  messageId: Id,
  body: z.string(),
  replyToId: Id.nullable().default(null),
  clientMessageId: z.string().nullable().default(null),
  causeMessageId: Id.nullable().default(null),
});

export const PlanOpened = z.object({
  ...eventBase,
  type: z.literal('plan_opened'),
  planId: Id,
  agentUserId: Id,
  title: z.string(),
  causeMessageId: Id.nullable().default(null),
});

export const PlanSettled = z.object({
  ...eventBase,
  type: z.literal('plan_settled'),
  planId: Id,
});

export const PlanRlimitSet = z.object({
  ...eventBase,
  type: z.literal('plan_rlimit_set'),
  planId: Id,
  slice: z.number().int().nonnegative(),
});

export const SessionOpened = z.object({
  ...eventBase,
  type: z.literal('session_opened'),
  sessionId: Id,
  planId: Id,
  causeMessageId: Id.nullable().default(null),
});

export const DrawRefused = z.object({
  ...eventBase,
  type: z.literal('draw_refused'),
  planId: Id,
  reason: z.literal('budget'),
  slice: z.number().int().nonnegative(),
  authorizedDraws: z.number().int().nonnegative(),
});

const sessionExit = {
  ...eventBase,
  sessionId: Id,
  exitSummary: z.string().nullable().default(null),
  artifact: z.unknown().nullable().default(null),
};
export const SessionSettled = z.object({ ...sessionExit, type: z.literal('session_settled') });
export const SessionFailed = z.object({ ...sessionExit, type: z.literal('session_failed') });

export const SessionSignaled = z.object({
  ...eventBase,
  type: z.literal('session_signaled'),
  sessionId: Id,
  signalId: Id,
  kind: z.enum(['steer', 'interrupt', 'resume']),
  causeMessageId: Id.nullable().default(null),
});

const HandledEvent = z.discriminatedUnion('type', [
  MessagePosted,
  PlanOpened,
  PlanSettled,
  PlanRlimitSet,
  SessionOpened,
  DrawRefused,
  SessionSettled,
  SessionFailed,
  SessionSignaled,
]);

/** An event whose `type` the daemon does not route on — carried, not crashed. */
const OtherEvent = z.object({ ...eventBase, type: z.string() });

export const RoomEvent = z.union([HandledEvent, OtherEvent]);
export type RoomEvent = z.infer<typeof RoomEvent>;
export type MessagePosted = z.infer<typeof MessagePosted>;
export type SessionOpened = z.infer<typeof SessionOpened>;
export type DrawRefused = z.infer<typeof DrawRefused>;
export type PlanOpened = z.infer<typeof PlanOpened>;

/** One ledger entry as the wire carries it. `issues` non-empty ⇒ the reducer
 *  refused the row: it is not an event that happened, and is dropped. */
export const WireEvent = z.object({
  roomId: Id,
  roomSeq: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  actor: Actor,
  event: RoomEvent,
  issues: z.array(z.string()).default([]),
});
export type WireEvent = z.infer<typeof WireEvent>;

// ── Server → client frames (the subset the daemon acts on) ──────────────────

export const DrawOutcome = z.union([
  z.object({ outcome: z.literal('granted'), sessionId: Id }),
  z.object({
    outcome: z.literal('refused'),
    reason: z.literal('budget'),
    slice: z.number().int().nonnegative(),
    authorizedDraws: z.number().int().nonnegative(),
  }),
]);
export type DrawOutcome = z.infer<typeof DrawOutcome>;

export const WelcomeFrame = z.object({
  type: z.literal('welcome'),
  connectionId: z.string(),
  userId: Id,
  heartbeatIntervalMs: z.number(),
});
export const SubscribedFrame = z.object({
  type: z.literal('subscribed'),
  roomId: Id,
  head: z.number().int().nonnegative(),
  seenSeq: z.number().int(),
});
export const EventFrame = z.object({ type: z.literal('event'), entry: WireEvent });
export const CatchupFrame = z.object({
  type: z.literal('catchup'),
  roomId: Id,
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
  more: z.boolean(),
  entries: z.array(WireEvent),
});
export const HeadFrame = z.object({
  type: z.literal('head'),
  roomId: Id,
  head: z.number().int().nonnegative(),
});
export const AckFrame = z.object({
  type: z.literal('ack'),
  commandId: z.string(),
  roomId: Id.nullable(),
  seq: z.number().int().nullable(),
  roomSeq: z.number().int().nullable(),
  eventId: Id.nullable(),
  issues: z.array(z.string()).default([]),
  draw: DrawOutcome.optional(),
});
export const NackFrame = z.object({
  type: z.literal('nack'),
  commandId: z.string(),
  code: z.string(),
  message: z.string(),
});
export type AckFrame = z.infer<typeof AckFrame>;
export type NackFrame = z.infer<typeof NackFrame>;
export type CatchupFrame = z.infer<typeof CatchupFrame>;
export type SubscribedFrame = z.infer<typeof SubscribedFrame>;
export type WelcomeFrame = z.infer<typeof WelcomeFrame>;

const KnownFrame = z.discriminatedUnion('type', [
  WelcomeFrame,
  SubscribedFrame,
  EventFrame,
  CatchupFrame,
  HeadFrame,
  AckFrame,
  NackFrame,
]);

/** Any other server frame (pong, presence, typing, seen, projection_changed,
 *  error, …) — valid, but not something the daemon routes on. */
const OtherFrame = z.object({ type: z.string() });

export const ServerFrame = z.union([KnownFrame, OtherFrame]);
export type ServerFrame = z.infer<typeof KnownFrame>;

/**
 * Parse a raw wire string into a server frame.
 *
 * Returns the typed frame when it is one the daemon handles, `{ type: 'unknown'
 * }` when it is a well-formed frame the daemon ignores, and throws only when the
 * bytes are not a JSON object with a string `type` — a genuinely unreadable
 * frame the caller should log, not a routine one it should swallow.
 */
export function parseServerFrame(raw: string): ServerFrame | { type: 'unknown' } {
  const json: unknown = JSON.parse(raw);
  const parsed = ServerFrame.safeParse(json);
  if (!parsed.success) {
    throw new Error(`unreadable server frame: ${parsed.error.message}`);
  }
  const frame = parsed.data;
  if (isKnownFrame(frame)) return frame;
  return { type: 'unknown' };
}

const KNOWN_TYPES = new Set(['welcome', 'subscribed', 'event', 'catchup', 'head', 'ack', 'nack']);
function isKnownFrame(frame: { type: string }): frame is ServerFrame {
  return KNOWN_TYPES.has(frame.type);
}

// ── Client → server commands (only what the deterministic conductor emits) ──
//
// These are the WRITE side. The daemon builds minimal command objects — omitting
// the fields the server's zod fills by default — and the server applies the
// defaults. Every field named here is one the loop deliberately sets; the funded
// -arm claim, the answer-dedupe, and the steer receipt all ride on `causeMessage
// Id` / `clientMessageId`, so those are always explicit.

export interface OpenPlanCommand {
  name: 'open_plan';
  roomId: string;
  agentUserId: string;
  title: string;
  causeMessageId: string;
}
export interface OpenSessionCommand {
  name: 'open_session';
  roomId: string;
  planId: string;
  harness: string;
  model: string;
  causeMessageId: string;
}
export interface SettlePlanCommand {
  name: 'settle_plan';
  roomId: string;
  planId: string;
}
export interface SignalSessionCommand {
  name: 'signal_session';
  roomId: string;
  sessionId: string;
  kind: 'steer';
  body: string | null;
  causeMessageId: string;
}
export interface SendMessageCommand {
  name: 'send_message';
  roomId: string;
  body: string;
  clientMessageId: string;
  causeMessageId: string;
}

export type LoopCommand =
  | OpenPlanCommand
  | OpenSessionCommand
  | SettlePlanCommand
  | SignalSessionCommand
  | SendMessageCommand;

/** A frame the daemon sends. `commandId` is the per-connection idempotency-free
 *  correlation id the ack echoes; it is NOT the durable idempotency key (that is
 *  `clientMessageId` / `causeMessageId`). */
export interface CommandFrame {
  type: 'command';
  commandId: string;
  command: LoopCommand;
}
