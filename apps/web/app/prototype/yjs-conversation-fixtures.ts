/* ═══════════════════════════════════════════════════════════════════════════
 * THE SELECTION-BOUND CONVERSATION FIXTURES (#183 / #194) — the `/prototype`
 * design route's drop-ins, split out of `yjs-conversation.ts` (P6F-2).
 *
 * These helpers seed a `ConversationDoc` from the MOCK selection seams, so the
 * fixture route renders off `ConversationDoc` today with no Electric
 * infrastructure. They depend on `seams.ts`, which is `'use client'`, so they
 * live HERE rather than in `yjs-conversation.ts`: the latter is the conversation
 * SUBSTRATE, reused by the SERVER-authoritative replica
 * (`lib/server-room-replica.ts`) on the certify path, and must not drag a client
 * module into the Server Action bundle. This file is imported only by the client
 * hook (`use-conversation-model.ts`) and the fixture tests.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { ParticipantSummary } from '@/src/components/model';
import type { ConversationModel } from './conversation-model';
import { conversationFor, participantsFor, sessionFor } from './seams';
import type { Selection } from './types';
import { ConversationDoc } from './yjs-conversation';

/**
 * A `ConversationDoc` seeded from the selection's mock conversation — the
 * drop-in the surface can render off TODAY, on the fixture route, with no
 * Electric infrastructure. Its `model(...)` output equals `conversationModel`'s
 * for the same selection (proven in the test), so wiring the feed through it
 * changes the substrate without changing a pixel. In production the same doc is
 * caught up from Electric (or the server-authoritative replica) instead of
 * seeded from the mock.
 */
export function conversationDocFor(selection: Selection): ConversationDoc {
  return new ConversationDoc().seed(conversationFor(selection));
}

/** The `room` a selection's conversation belongs to — the model's room field. */
export function roomFor(selection: Selection): string {
  return sessionFor(selection).agent.room;
}

/** The participants a selection's conversation carries — the model's roster. */
export function participantsForSelection(selection: Selection): readonly ParticipantSummary[] {
  return participantsFor(selection);
}

/**
 * Project a `ConversationDoc` to the surface's model for a given selection. The
 * room and roster come from the selection seam; the messages come live from the
 * doc. This is the exact call the feed makes.
 */
export function conversationModelFromDoc(
  doc: ConversationDoc,
  selection: Selection,
): ConversationModel {
  return doc.model(roomFor(selection), participantsForSelection(selection));
}
