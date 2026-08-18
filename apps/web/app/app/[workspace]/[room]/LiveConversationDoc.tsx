'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE CLIENT Y.DOC (E4 read side, #215 / T1) — the FIRST mounted client
 * `ConversationDoc` over Electric Durable Streams.
 *
 * Everything upstream of this file was built and unit-proven but never
 * INSTANTIATED: `electricConversationTransport` (electric-transport.ts) is the
 * rented y-electric wire, `ConversationDoc` (yjs-conversation.ts) is the rented
 * Yjs substrate, and `resolveElectricShapeUrl` / `resolveElectricSendUrl`
 * (src/lib/ws-url.ts) are the same-origin URL resolvers — all with the standing
 * note "not yet wired into a mounted client." This component is that mount, and
 * it does exactly ONE thing: subscribe the room's Electric shape, build a live
 * `ConversationDoc`, and RENDER inbound peer updates as they converge.
 *
 * ## READ-ONLY, deliberately (the T1 scope boundary)
 *
 * This mount NEVER writes. The doc is created EMPTY and unseeded, so the whole
 * conversation is folded in from the durable stream — and because the doc holds
 * no local state, y-electric's connect-time upload is an empty (2-byte) update
 * that its own send loop skips (`pendingChanges.length > 2` is false), so nothing
 * is PUT to the write door. There is no composer, no `append`, no local edit: the
 * local-edit write path is T2 (#216), the verdict/glyph is T3/T4 (#217/#218).
 * `sendUrl` is still provided because the transport factory requires it; it is
 * simply never exercised on this surface.
 *
 * ## WHY THE CONTENT RENDERS AS UNVERIFIED
 *
 * Every line here came off the PEER-WRITABLE Yjs doc, whose `who`/`kind`/`✓` are
 * forgeable (the #183 trust boundary). A live (unseeded) doc records no trust
 * fingerprints, so `ConversationDoc.messages()` carries only content — no
 * authenticated author and no certification. This surface therefore labels every
 * line "unverified · live" and never paints a `✓`: the authenticated envelope and
 * the covenant glyph are #181's gated read and T3/T4, not anything a peer-writable
 * document can mint. Honest fail-closed, exactly as `conversation-model.ts`'s
 * `unverifiedItem` projects the same content.
 *
 * ## THE GATE
 *
 * Mounted only when the caller passes the dev/query gate (see `LiveRoomSession`),
 * so the existing ledger render path for normal rooms is untouched. It also
 * self-disables when the deployment reports no Electric (`electricShapePath` is
 * `null`), rendering an honest "no sync fabric" state rather than retrying a route
 * that would 503 forever. The durable substrate flag `rooms.conversation_substrate`
 * is T2's to add; T1 gates on a query param and disturbs nothing.
 * ═════════════════════════════════════════════════════════════════════════ */

import { useEffect, useRef, useState } from 'react';
import type { ChatMsg } from '@/app/prototype/types';
import type { ConversationDoc } from '@/app/prototype/yjs-conversation';
import { fileText } from '@/src/components/model';
import { loadRuntimeConfig } from '@/src/lib/runtime-config';
import { resolveElectricSendUrl, resolveElectricShapeUrl } from '@/src/lib/ws-url';

type MountStatus = 'connecting' | 'live' | 'no-fabric' | 'error';

interface LiveDocState {
  readonly status: MountStatus;
  readonly messages: readonly ChatMsg[];
  readonly error: string | null;
}

const INITIAL: LiveDocState = { status: 'connecting', messages: [], error: null };

/**
 * The T1 read side, now with the T2 (#216) LOCAL-EDIT WRITE PATH.
 *
 * `write` (off by default, so every T1 caller keeps the read-only surface it had)
 * turns on a composer. A submitted line is `doc.append`ed to the SAME live
 * `ConversationDoc` this mount renders from — which mutates the `Y.Doc`, so the
 * rented y-electric provider observes the update and PUTs it to the authenticated
 * append door (`resolveElectricSendUrl(room)` → `app/api/rooms/[room]/ydoc`, the
 * E2 door rented as-is). Nothing here names an author or a `✓`: the door stamps
 * the writer from the session (never client bytes), and an appended line carries
 * NO authenticated who/kind and NO certification — it renders "unverified · live"
 * exactly like an inbound peer line. Browser A's append therefore reaches browser
 * B purely over Electric, with no server RPC and no ledger write.
 *
 * `viewerName` is a DISPLAY hint only (the `who` shown beside the local line). It
 * is authority-stripped by `encodeDurable` before it ever hits the wire, so a peer
 * can neither trust it nor forge one — the trust envelope is #181's gated read.
 */
export function LiveConversationDoc({
  roomId,
  write = false,
  viewerName,
}: {
  roomId: string;
  write?: boolean;
  viewerName?: string;
}) {
  const [state, setState] = useState<LiveDocState>(INITIAL);
  const [draft, setDraft] = useState('');
  // The live doc, held so the composer can `append` into the SAME instance this
  // mount renders and the transport ships. Set once the mount goes live; cleared
  // on dispose so a submit after unmount is a no-op, never a write to a dead doc.
  const docRef = useRef<ConversationDoc | null>(null);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    setState(INITIAL);

    void (async () => {
      const config = await loadRuntimeConfig();
      if (disposed) return;
      // No Electric configured on this deployment: render honestly, do not mount.
      if (!config.electricShapePath) {
        setState({ status: 'no-fabric', messages: [], error: null });
        return;
      }

      // The electric client (and its y-electric transport) is browser-only, so it
      // is imported here in the effect rather than at module top — a live room is
      // server-rendered first, and this keeps the sync client out of that render.
      const [{ ConversationDoc }, { electricConversationTransport }] = await Promise.all([
        import('@/app/prototype/yjs-conversation'),
        import('@/app/prototype/electric-transport'),
      ]);
      if (disposed) return;

      let shapeUrl: string;
      let sendUrl: string;
      try {
        // The shape proxy authorizes by the `?room=` query param it reads (see
        // `app/electric/v1/shape/route.ts`); y-electric appends its own params but
        // preserves this one, so the room the read is authorized against travels
        // with every request. Same-origin by construction (the resolver refuses an
        // absolute value), so the session cookie rides.
        const base = new URL(resolveElectricShapeUrl(config));
        base.searchParams.set('room', roomId);
        shapeUrl = base.toString();
        sendUrl = resolveElectricSendUrl(roomId);
      } catch (failure) {
        setState({
          status: 'error',
          messages: [],
          error: failure instanceof Error ? failure.message : String(failure),
        });
        return;
      }

      const doc = new ConversationDoc();
      const offChange = doc.onChange(() => {
        if (!disposed) setState((current) => ({ ...current, messages: doc.messages() }));
      });
      let disconnect: (() => void) | undefined;
      try {
        disconnect = doc.connect(
          electricConversationTransport({ room: roomId, shapeUrl, sendUrl }),
        );
      } catch (failure) {
        offChange();
        if (!doc.isDestroyed()) doc.destroy();
        setState({
          status: 'error',
          messages: [],
          error: failure instanceof Error ? failure.message : String(failure),
        });
        return;
      }

      // Publish the initial (empty) projection under the live status; onChange
      // drives every convergence after this.
      docRef.current = doc;
      setState({ status: 'live', messages: doc.messages(), error: null });

      dispose = () => {
        offChange();
        disconnect?.();
        if (!doc.isDestroyed()) doc.destroy();
        docRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [roomId]);

  // THE LOCAL-EDIT WRITE PATH (T2). Append the drafted line to the live doc; the
  // mutation drives both the local re-render (via `onChange`) and the transport's
  // PUT to the authenticated door. A no-op unless the mount is live and writable —
  // there is nothing to append into otherwise, and never a write to a torn-down doc.
  const submitDraft = () => {
    const doc = docRef.current;
    const text = draft.trim();
    if (!write || doc === null || doc.isDestroyed() || text.length === 0) return;
    doc.append({
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      kind: 'human',
      // A DISPLAY hint only — authority-stripped before it reaches the wire.
      ...(viewerName ? { who: viewerName } : {}),
      text,
    });
    setDraft('');
  };

  return (
    <section
      aria-label="live document (Electric)"
      data-live-doc
      data-live-doc-status={state.status}
      data-live-doc-count={state.messages.length}
      style={{
        margin: '1rem',
        padding: '0.75rem 1rem',
        border: '1px solid var(--hairline, rgba(0,0,0,0.15))',
        borderRadius: 8,
        font: '13px/1.5 ui-monospace, monospace',
      }}
    >
      <header style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>live document · Electric</strong>
        <span style={{ opacity: 0.7 }}>
          {write ? 'live substrate (yjs)' : 'read-only (T1)'} · {statusLabel(state.status)} ·{' '}
          {state.messages.length} line
          {state.messages.length === 1 ? '' : 's'}
        </span>
      </header>
      {state.status === 'error' && state.error !== null ? (
        // A diagnostic string, printed through `fileText` — the verbatim-record
        // door: no speech ban (a URL resolver error carries quotes) and, more to
        // the point, it neutralises bidi/control characters so an arbitrary
        // message cannot impersonate the page's own voice.
        <p data-live-doc-error style={{ color: 'crimson' }}>
          {fileText(state.error, 'live document mount error')}
        </p>
      ) : null}
      {state.status === 'no-fabric' ? (
        <p style={{ opacity: 0.7 }}>
          this deployment has no Electric sync service — no live document to mount
        </p>
      ) : null}
      {state.messages.length === 0 && state.status === 'live' ? (
        <p style={{ opacity: 0.7 }} data-live-doc-empty>
          waiting for the room’s document stream…
        </p>
      ) : null}
      <ol style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }}>
        {state.messages.map((message) => (
          <li
            key={message.id}
            data-live-doc-message-id={message.id}
            style={{ padding: '0.25rem 0', borderTop: '1px solid rgba(0,0,0,0.06)' }}
          >
            {/* Every peer string is printed through `fileText`: this is verbatim
               content off the PEER-WRITABLE Yjs doc, so it is record data, not the
               page's voice — and `fileText` neutralises bidi/control characters, so
               a peer cannot smuggle a right-to-left override or a forged newline
               into the feed. */}
            <span style={{ opacity: 0.6 }}>
              {fileText(message.time, 'live document line time')}
            </span>{' '}
            <span
              style={{
                fontSize: '0.85em',
                padding: '0 0.35em',
                borderRadius: 4,
                background: 'rgba(0,0,0,0.06)',
                opacity: 0.8,
              }}
            >
              unverified · live
            </span>{' '}
            <span data-live-doc-message-text>
              {fileText(message.text ?? '', 'live document line body')}
            </span>
          </li>
        ))}
      </ol>
      {write && state.status === 'live' ? (
        <form
          data-live-doc-composer
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
          style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}
        >
          <input
            data-live-doc-input
            aria-label="write a line to the live document"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="type a line — it converges over Electric, no server RPC"
            style={{
              flex: 1,
              padding: '0.35rem 0.5rem',
              border: '1px solid rgba(0,0,0,0.2)',
              borderRadius: 6,
              font: 'inherit',
            }}
          />
          <button
            data-live-doc-send
            type="submit"
            disabled={draft.trim().length === 0}
            style={{
              padding: '0.35rem 0.75rem',
              border: '1px solid rgba(0,0,0,0.2)',
              borderRadius: 6,
              font: 'inherit',
              cursor: draft.trim().length === 0 ? 'default' : 'pointer',
            }}
          >
            send
          </button>
        </form>
      ) : null}
    </section>
  );
}

function statusLabel(status: MountStatus): string {
  switch (status) {
    case 'connecting':
      return 'connecting';
    case 'live':
      return 'live';
    case 'no-fabric':
      return 'no sync fabric';
    case 'error':
      return 'error';
  }
}
