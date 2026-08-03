import { roomMemberIds } from '@atrium/auth';
import {
  AttentionItem,
  attentionItemId,
  type CoreState,
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
