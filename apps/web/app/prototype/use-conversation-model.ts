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
 *
 * ## Three source modes (#183 F3 + round-2 honest-surface)
 *   - A transport → the live/production path: the doc is UNSEEDED and CATCHES UP
 *     from the durable stream. It must not seed, or two clients each seeding the
 *     same fixture would duplicate the whole history in the shared stream (Yjs
 *     keeps same-id insertions as distinct — idempotency by id does not dedupe).
 *   - NO transport, `seedFixture` true → the `/prototype` fixture route: the doc
 *     is SEEDED from the mock seam and renders exactly as before, a local demo.
 *   - NO transport, `seedFixture` false → a LIVE room whose conversation source
 *     is not wired yet (round-2 SHIP-BLOCKER #3). The doc is EMPTY — it must NOT
 *     seed the mock, because presenting fixture history on a real authenticated
 *     room as if it were that room's live conversation is a lie. The surface
 *     renders an honest "not wired" state instead (see ChatBlock). The real
 *     shipped-surface + Electric wiring is the filed follow-up.
 *
 * ## Doc lifecycle (#183 F6)
 * The doc is owned in a ref, recreated only when the thread changes or the
 * current instance was destroyed — NEVER destroyed in the effect cleanup, so a
 * Strict-Mode remount (mount → cleanup → mount, no render between) can never
 * reuse a dead `Y.Doc`. The effect only attaches/detaches the change listener and
 * the transport; it does not own the doc's life.
 * ═════════════════════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationModel } from './conversation-model';
import type { ConversationTransport } from './conversation-transport';
import type { ChatMsg, Selection } from './types';
import { ConversationDoc } from './yjs-conversation';
import { conversationDocFor, conversationModelFromDoc } from './yjs-conversation-fixtures';

/** What `ChatBlock` reads and writes the conversation through. */
export interface ConversationHandle {
  /** The current projected model — recomputed on every convergence. */
  readonly model: ConversationModel;
  /** Bumps on every convergence (local append or remote update) — the remeasure signal. */
  readonly version: number;
  /**
   * Append a line the viewer TYPED into the converging doc (#183 F4). A real
   * authored message that ships over the transport, converges to every peer, and
   * survives reload (a fresh client catches it up from the stream). Carries NO
   * authority — a typed line is never certified.
   */
  readonly say: (text: string) => void;
}

/** A process-wide monotonic counter, mixed into typed-message ids for uniqueness. */
let TYPED_SEQ = 0;

/** A globally-unique id for a typed line, so two clients' appends never collide. */
function typedMessageId(): string {
  TYPED_SEQ += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `typed-${Date.now().toString(36)}-${TYPED_SEQ.toString(36)}-${rand}`;
}

function clockLabel(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * The conversation model for a selection, read live off a Yjs document. Pass a
 * `transport` to join the doc to a replication fabric (Electric's durable stream,
 * or an in-process hub) — the doc is then unseeded and catches up from the stream;
 * omit it for the local fixture route, where the doc is seeded from the mock seam
 * and renders exactly as before.
 */
export function useConversationModel(
  selection: Selection,
  transport?: ConversationTransport,
  options: { readonly seedFixture?: boolean } = {},
): ConversationHandle {
  // Seed the mock fixture only when explicitly allowed (the `/prototype` route).
  // A live room without a transport passes `seedFixture:false` so it renders an
  // honest empty state rather than mock history masquerading as the room's own.
  const seedFixture = options.seedFixture ?? true;
  const key = `${selection.kind}:${selection.id}`;
  const live = transport !== undefined;

  // The doc is owned here, NOT in the effect (F6). Recreate it only when the
  // thread changes, when the seed/live mode flips, when the TRANSPORT IDENTITY
  // changes, or when the current instance was torn down — and never hand back a
  // destroyed doc. The outgoing instance is no longer active by the time we replace
  // it, so destroying it is safe; the ACTIVE instance is never destroyed here.
  //
  // KEYING BY TRANSPORT IDENTITY (#183 round-3 — lifecycle isolation). A doc keyed
  // only by selection/live/seed is REUSED across a transport swap (room A's stream
  // → room B's), so room A's content — already in the doc — gets fanned into room
  // B on connect (a cross-room leak). Keying by the transport object identity too
  // means a stream change gets a FRESH, empty doc that catches up from B alone,
  // never the old doc reconnected. The disposer for the outgoing connection is run
  // BEFORE the outgoing doc is destroyed (disconnect-before-destroy), so a torn-down
  // doc is never left registered in a hub's member set.
  const holder = useRef<{
    key: string;
    live: boolean;
    seedFixture: boolean;
    transport: ConversationTransport | undefined;
    doc: ConversationDoc;
    disconnect?: () => void;
  } | null>(null);
  if (
    holder.current === null ||
    holder.current.key !== key ||
    holder.current.live !== live ||
    holder.current.seedFixture !== seedFixture ||
    holder.current.transport !== transport ||
    holder.current.doc.isDestroyed()
  ) {
    if (holder.current !== null) {
      // Disconnect the outgoing doc from its fabric BEFORE destroying it, so it is
      // never a destroyed member still registered in a hub (which a fan-out would
      // otherwise try to write into). Then destroy it if it is still alive.
      holder.current.disconnect?.();
      if (!holder.current.doc.isDestroyed()) holder.current.doc.destroy();
    }
    holder.current = {
      key,
      live,
      seedFixture,
      transport,
      // Live path catches up from the stream (unseeded, F3). Otherwise the
      // fixture route SEEDS the mock demo; a live room without a transport stays
      // EMPTY (honest — no mock history on a real room).
      doc: live || !seedFixture ? new ConversationDoc() : conversationDocFor(selection),
    };
  }
  const holderRef = holder.current;
  const doc = holderRef.doc;

  // A version tick that bumps whenever the CRDT converges (local or remote).
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const offChange = doc.onChange(() => setVersion((current) => current + 1));
    const offTransport = transport ? doc.connect(transport) : undefined;
    // Record the live disposer on the holder so a doc swap can disconnect this doc
    // from its fabric BEFORE destroying it (disconnect-before-destroy), even though
    // that swap happens during render, before this effect's own cleanup runs.
    if (holderRef.doc === doc) holderRef.disconnect = offTransport;
    // NOTE: no doc.destroy() here — that is what let a Strict-Mode remount reuse a
    // dead doc (F6). The doc's life is owned by the ref above, not this effect.
    return () => {
      offChange();
      offTransport?.();
      if (holderRef.doc === doc && holderRef.disconnect === offTransport) {
        holderRef.disconnect = undefined;
      }
    };
  }, [doc, transport, holderRef]);

  const say = useCallback(
    (text: string) => {
      const body = text.trim();
      if (body.length === 0) return;
      const message: ChatMsg = {
        id: typedMessageId(),
        time: clockLabel(),
        kind: 'human',
        who: 'you',
        text: body,
      };
      doc.append(message);
    },
    [doc],
  );

  // `version` is the convergence signal: recompute the projection when the doc
  // changes. Selection identity is already captured by `doc`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the convergence trigger; selection identity is captured by doc
  const model = useMemo(() => conversationModelFromDoc(doc, selection), [doc, version]);

  return { model, version, say };
}
