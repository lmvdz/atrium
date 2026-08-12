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

/*
 * WHO WAS NAMED HERE HAS ONE REGISTER, AND ONE PROJECTION.
 *
 * A mention becomes attention in exactly one place: `projectMessagePosted`
 * (projections.ts) writes a `mention`-class item, subject the MESSAGE, the
 * instant a `human` or `agent` `message_reference` lands — synchronously, in the
 * same transaction as the message. Decision #92 collapsed the old
 * `messages.mention_user_ids` column into `message_references`; this worker cycle
 * used to ALSO manufacture mention items from that column via a `mentionSignals`
 * helper, attaching them to the proposals and objects a mentioning message
 * produced. That helper was dead for real traffic (the client never filled the
 * column), and reviving it against the reference register — the literal reading
 * of #92/#100 — double-counts every mention: the same @name yields both the live
 * message-subject item AND a worker proposal/object-subject item, which the
 * destination multiplayer scenario's own acceptance assertion catches as a
 * duplicated pending card. So the register is single and its projection is
 * single too: this worker no longer manufactures mentions, and `projectAttention`
 * is called with no `mentions` feed. See the ticket-contradiction note in the
 * #100 report.
 */

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
    // No `mentions` feed: mention → attention is produced once, by the live
    // reference path in projections.ts. See the header note.
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
