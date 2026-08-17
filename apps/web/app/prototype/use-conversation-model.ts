'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * useConversationModel (#183) — the feed's live read of the Yjs-backed source.
 *
 * `ChatBlock` used to compute its model synchronously from the mock seam
 * (`useMemo(() => conversationModel(sel))`). It now reads a `ConversationDoc` —
 * a real `Y.Doc` — through this hook. On the fixture route the doc is seeded from
 * the same mock messages, so the FIRST render is byte-identical to the old path
 * and every existing test stays green; the difference is that the feed now
 * re-renders when the CRDT converges, so a message arriving over a transport
 * (Electric in production, the in-memory hub in tests) appears live with no
 * component change. "Components do not know the difference" — this hook is where
 * that promise is kept.
 * ═════════════════════════════════════════════════════════════════════════ */

import { useEffect, useMemo, useState } from 'react';
import type { ConversationModel } from './conversation-model';
import type { ConversationTransport } from './conversation-transport';
import type { Selection } from './types';
import { conversationDocFor, conversationModelFromDoc } from './yjs-conversation';

/**
 * The conversation model for a selection, read live off a Yjs document. Pass a
 * `transport` to join the doc to a replication fabric (Electric's durable stream,
 * or an in-process hub); omit it for the local fixture route, where the doc is
 * seeded from the mock seam and renders exactly as before.
 */
export function useConversationModel(
  selection: Selection,
  transport?: ConversationTransport,
): ConversationModel {
  // One doc per selection, seeded synchronously so the first render matches the
  // mock path exactly. Re-created when the thread changes — keyed on the
  // selection's identity fields, not the object, whose reference changes each render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on selection.kind/id by design, not the unstable object reference
  const doc = useMemo(() => conversationDocFor(selection), [selection.kind, selection.id]);

  // A version tick that bumps whenever the CRDT converges (local or remote).
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const offChange = doc.onChange(() => setVersion((current) => current + 1));
    const offTransport = transport ? doc.connect(transport) : undefined;
    return () => {
      offChange();
      offTransport?.();
      doc.destroy();
    };
  }, [doc, transport]);

  // `version` is the convergence signal: recompute the projection when the doc
  // changes. Selection identity is already captured by `doc`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the convergence trigger; selection identity is captured by doc
  return useMemo(() => conversationModelFromDoc(doc, selection), [doc, version]);
}
