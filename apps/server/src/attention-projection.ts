import { roomMemberIds } from '@atrium/auth';
import {
  AttentionItem,
  attentionItemId,
  type CoreState,
  type MentionSignal,
  type ProvenanceMessage,
  projectAttention,
  reconcileAttention,
} from '@atrium/core';
import type { Database } from '@atrium/db';
import { attentionItems } from '@atrium/db/schema';
import { eq } from 'drizzle-orm';

/** Persist the evidence-bounded attention projection for one worker cycle. */
export async function reconcileStoredAttention(input: {
  db: Database;
  state: CoreState;
  roomId: string;
  messages: readonly ProvenanceMessage[];
  now: string;
}) {
  const [memberRows, storedRows] = await Promise.all([
    roomMemberIds(input.db, input.roomId),
    input.db.select().from(attentionItems).where(eq(attentionItems.roomId, input.roomId)),
  ]);

  const stored = storedRows.map((row) =>
    AttentionItem.parse({
      id: attentionItemId(row.userId, row.subjectKind, row.subjectId, row.class),
      roomId: row.roomId,
      userId: row.userId,
      objectId: row.subjectId,
      subjectKind: row.subjectKind,
      class: row.class,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }),
  );
  const projection = projectAttention(input.state, {
    now: input.now,
    members: { [input.roomId]: memberRows },
    messages: input.messages,
    mentions: mentionSignals(input.state, input.roomId, input.messages, memberRows),
  });
  const reconciled = reconcileAttention(stored, projection);

  await input.db.transaction(async (tx) => {
    for (const item of reconciled) {
      await tx
        .insert(attentionItems)
        .values({
          roomId: item.roomId,
          userId: item.userId,
          subjectKind: item.subjectKind,
          subjectId: item.objectId,
          class: item.class,
          reason: item.reason,
          status: item.status,
          createdAt: new Date(item.createdAt),
          resolvedAt: item.status === 'pending' ? null : new Date(input.now),
        })
        .onConflictDoUpdate({
          target: [
            attentionItems.userId,
            attentionItems.subjectKind,
            attentionItems.subjectId,
            attentionItems.class,
          ],
          set: {
            reason: item.reason,
            status: item.status,
            resolvedAt: item.status === 'pending' ? null : new Date(input.now),
          },
        });
    }
  });

  return { ...projection, items: reconciled };
}

/**
 * Explicit composer mentions, attached to accepted objects borne by the same
 * authored message. `Mention for <user-id>:` is an opt-in request marker, not
 * a scan for bare names; the request remains the author's verbatim suffix.
 */
export function mentionSignals(
  state: CoreState,
  roomId: string,
  messages: readonly ProvenanceMessage[],
  memberIds: readonly string[],
): MentionSignal[] {
  const members = new Set(memberIds);
  const mentioned = new Map<string, { userId: string; request: string }>();
  for (const message of messages) {
    const match = /^Mention for ([0-9a-f-]{36}): (\S[^\r\n]*)$/.exec(message.body);
    if (match?.[1] && match[2] && members.has(match[1])) {
      mentioned.set(message.id, { userId: match[1], request: match[2] });
    }
  }

  return Object.values(state.objects).flatMap((record) => {
    if (record.object.roomId !== roomId) return [];
    return record.object.provenance.messageIds.flatMap((messageId) => {
      const signal = mentioned.get(messageId);
      return signal
        ? [{ roomId, objectId: record.object.id, userId: signal.userId, request: signal.request }]
        : [];
    });
  });
}
