/**
 * THE DETERMINISTIC RUN-ZERO CONDUCTOR (#148, #124 trichotomy).
 *
 * One turn per inbound message: classify it into exactly ONE arm — steer,
 * open-work, or answer — or decline it. That is the whole conductor. It is a pure
 * function of the message and the loop's current state, which is what makes it
 * testable and what the first dogfood run needs.
 *
 * A MODEL-BASED CONDUCTOR IS EXPLICITLY OUT OF SCOPE (#148 scope boundary). The
 * run-zero loop does not ask a model what an inbound message means; it applies
 * the deterministic rules below. A model conductor — reading intent, disambiguat
 * ing, planning multi-message — is a later ticket. Stating it here so the absence
 * reads as a decision, not an omission.
 *
 * The rules, in order (first match wins):
 *
 *  0. IGNORE the loop's OWN output. A message the daemon itself authored (its
 *     answers, its own posts) is never routed — a loop that answered its own
 *     answers would never terminate.
 *  1. STEER when the message REPLIES to the goal that opened a still-running
 *     session. `replyToId` is the tell: a human following up on work in flight is
 *     steering it, and a steer is `session_signaled{steer}` against that session.
 *  2. OPEN-WORK when the body NAMES A TICKET (`#123`). Heavy work is a session,
 *     and the tell of heavy work in run-zero is a goal that cites a ticket. Each
 *     such message is its own cause — two goals naming the same ticket are two
 *     plans, one funded arm each (the flip-the-input acceptance).
 *  3. ANSWER when the body is a QUESTION (ends with `?`). A question directed at
 *     the channel is answered in-band, carrying the deterministic idempotency key
 *     so a replay does not double-post.
 *  4. IGNORE everything else.
 */

export type Route =
  | { kind: 'open_work'; ticket: string }
  | { kind: 'steer'; sessionId: string }
  | { kind: 'answer' }
  | { kind: 'ignore' };

export interface InboundMessage {
  /** The message's own id (`messageId`), which is the `causeMessageId` a routed
   *  append cites — NOT the ledger event id. */
  messageId: string;
  body: string;
  replyToId: string | null;
  /** The trusted author's userId, or null for a model/system actor. */
  authorUserId: string | null;
}

export interface ConductorContext {
  /** This daemon's own agent principal userId. */
  ownUserId: string;
  /** The still-running session opened for `goalMessageId`, if any. A session is
   *  "running" until the daemon has journaled its terminal exit. */
  runningSessionForGoal: (goalMessageId: string) => string | null;
}

const TICKET = /#(\d+)/;

export function classify(message: InboundMessage, context: ConductorContext): Route {
  // 0. Never route our own output.
  if (message.authorUserId !== null && message.authorUserId === context.ownUserId) {
    return { kind: 'ignore' };
  }

  // 1. A reply to a running session's goal is a steer to that session.
  if (message.replyToId !== null) {
    const sessionId = context.runningSessionForGoal(message.replyToId);
    if (sessionId !== null) return { kind: 'steer', sessionId };
  }

  // 2. A message naming a ticket is open-work.
  const ticketMatch = TICKET.exec(message.body);
  if (ticketMatch?.[1]) return { kind: 'open_work', ticket: ticketMatch[1] };

  // 3. A question is answered.
  if (message.body.trim().endsWith('?')) return { kind: 'answer' };

  // 4. Otherwise, nothing.
  return { kind: 'ignore' };
}

/**
 * The deterministic idempotency key for an answer (#139 resolution 2b).
 *
 * The server dedupes a `send_message` on its `clientMessageId`. So the daemon
 * derives that key deterministically from the cause: a replay that re-posts the
 * same answer presents the same key and the server drops the duplicate. The key
 * is a pure function of the cause message id, so it is stable across a restart
 * with no daemon-side dedupe cache.
 */
export function answerClientMessageId(causeMessageId: string): string {
  return `loop-answer:${causeMessageId}`;
}
