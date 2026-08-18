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

import type { CovenantReadStatus } from '@atrium/core';
import { useEffect, useRef, useState } from 'react';
import { CertifyPassage } from '@/app/prototype/CertifyPassage';
import type { ChatMsg } from '@/app/prototype/types';
import type { ConversationDoc } from '@/app/prototype/yjs-conversation';
import { anchorCertifies } from '@/lib/covenant-read';
import { DisplayFreshnessGate } from '@/lib/display-freshness';
import { useLiveGlyphResolver } from '@/lib/use-live-glyph-resolver';
import { fileText } from '@/src/components/model';
import { type Glyph, glyphFor } from '@/src/components/model/glyph';
import { loadRuntimeConfig } from '@/src/lib/runtime-config';
import { resolveElectricSendUrl, resolveElectricShapeUrl } from '@/src/lib/ws-url';
import { certifyYjsSpanAction, pokeCovenantSweepAction } from './control/covenant-actions';

type MountStatus = 'connecting' | 'live' | 'no-fabric' | 'error';

interface LiveDocState {
  readonly status: MountStatus;
  readonly messages: readonly ChatMsg[];
  readonly error: string | null;
}

const INITIAL: LiveDocState = { status: 'connecting', messages: [], error: null };

/**
 * How often the covenant surface pokes the server sweep (#220 / T6). The rubric's
 * flip window is "≤1 render tick" (≤1 s); a sub-second poke keeps the `✓`→`~` flip and
 * its exact-revert `~`→`✓` inside that bound after a peer edit reaches the durable
 * stream. Cheap (a membership check + an idempotent replica catch-up).
 */
const POKE_INTERVAL_MS = 600;

/**
 * The covenant markers, DERIVED through `glyphFor` (never a hand-written glyph literal —
 * the one-source-of-truth rule `glyph-source.test.ts` enforces). A live-resolved `ok`
 * span renders the SETTLED `✓`; anything else — never certified, drifted, verifying, or
 * a dead shape — renders the UNSETTLED `~`. `anchorCertifies` is the gate that decides
 * which; these only NAME the two outcomes.
 */
const CERTIFIED_GLYPH: Glyph = glyphFor({
  kind: 'claim',
  verification: 'accepted',
  owedToViewer: false,
  irreversible: false,
});
const UNVERIFIED_GLYPH: Glyph = glyphFor({
  kind: 'claim',
  verification: 'unverified',
  owedToViewer: false,
  irreversible: false,
});

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
  covenantReads,
  workspaceSlug,
  roomSlug,
  viewerId,
}: {
  roomId: string;
  write?: boolean;
  viewerName?: string;
  /**
   * The SSR covenant verdict seed (`data.covenantReads`, keyed by object id = message
   * id — the T6 binding). Its PRESENCE turns on the COVENANT surface (#220 / T6): the
   * live `✓`/`~` glyph over `covenant_status` and the span-certify affordance. Absent
   * (the T1 read-only mount) keeps the surface exactly as it was — no glyph, no certify.
   */
  covenantReads?: Readonly<Record<string, CovenantReadStatus>>;
  /** The room's workspace slug — the certify action + sweep poke's membership locator. */
  workspaceSlug?: string;
  /** The room's slug — same. */
  roomSlug?: string;
  /** The authenticated viewer id — the certify actor when no display name is set. */
  viewerId?: string;
}) {
  const [state, setState] = useState<LiveDocState>(INITIAL);
  const [draft, setDraft] = useState('');
  // The live doc, held so the composer can `append` into the SAME instance this
  // mount renders and the transport ships. Set once the mount goes live; cleared
  // on dispose so a submit after unmount is a no-op, never a write to a dead doc.
  const docRef = useRef<ConversationDoc | null>(null);
  // A re-render trigger + the live doc as STATE, so the certify affordance mounts once
  // the doc is ready and CertifyPassage recomputes its rendered span on every
  // convergence (its `version` prop, E8 finding #1).
  const [docInstance, setDocInstance] = useState<ConversationDoc | null>(null);
  const [version, setVersion] = useState(0);
  // The COVENANT surface is on only when the seed AND the membership locators are all
  // present (a real yjs room load). The read-only T1 mount passes none of these and
  // stays untouched. `write` is required too: certify is a human act on a writable doc.
  const covenant =
    write && covenantReads !== undefined && workspaceSlug !== undefined && roomSlug !== undefined;
  // The live covenant glyph resolver (T4, #218) — subscribes the room's `covenant_status`
  // Electric shape and folds each streamed verdict, so a certified span's glyph flips
  // `✓`→`~` on a peer edit and back on an exact revert, liveness-gated fail-closed (`✓`
  // ONLY while the shape is live + up-to-date + `ok`). Called unconditionally (rules of
  // hooks); a `undefined` seed (the T1 mount) subscribes nothing and every glyph is `~`.
  const glyphResolver = useLiveGlyphResolver(roomId, covenant ? covenantReads : undefined);
  // Which message's certify panel is open (at most one).
  const [openCertifyId, setOpenCertifyId] = useState<string | null>(null);

  /* THE CLIENT FRESHNESS GATE (#220 / T6 — the stale-`✓` window closer; the durable
     freshness-witness is #209/#211, referenced not duplicated). A verdict on the
     `covenant_status` shape is computed against the content the server replica had caught
     up to; the client's own doc can be AHEAD of it (a local/remote edit not yet re-swept),
     so a live `✓` could stand over already-edited text for the sub-second window before the
     poke → sweep → projection round-trips. {@link DisplayFreshnessGate} closes it: it binds
     each folded verdict (a new `glyphResolver` identity) to the body text displayed at fold
     time, and `✓` is served ONLY while the text shown now is byte-identical to it. An edit
     changes the text with the SAME verdict token ⇒ the gate withholds `✓` (`~`) until a
     genuinely newer verdict re-snapshots the current text. Snapshotted SYNCHRONOUSLY in
     render, so the flip has no stale frame. */
  const freshnessRef = useRef<DisplayFreshnessGate>(new DisplayFreshnessGate());
  freshnessRef.current.onRender(glyphResolver, state.messages);
  // POKE HEALTH (#220 / T6). The yjs surface has no `router.refresh()`; the poke is what
  // drives the server re-verdict. If it FAILS, the verdict can no longer be trusted to be
  // current — so a failed poke degrades every glyph to `~` (an error → not-live), rather
  // than swallowing it and leaving a stale `✓` painted. Reset to healthy on a success.
  const [pokeHealthy, setPokeHealthy] = useState(true);

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
        if (disposed) return;
        setState((current) => ({ ...current, messages: doc.messages() }));
        // Bump the convergence tick so the certify panel recomputes its rendered span
        // (E8 finding #1: a span captured against a stale body must never be certified).
        setVersion((current) => current + 1);
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
      setDocInstance(doc);
      setState({ status: 'live', messages: doc.messages(), error: null });

      dispose = () => {
        offChange();
        disconnect?.();
        if (!doc.isDestroyed()) doc.destroy();
        docRef.current = null;
        setDocInstance(null);
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

  // THE YJS DRIFT SCHEDULER (#220 / T6). The yjs surface is pure Electric — no
  // `router.refresh()` — so the server-authoritative replica has no trigger to
  // re-consume peer edits and re-run the drift sweep that projects `covenant_status`.
  // While the covenant surface is live, poll the membership-gated poke action: each
  // call re-acquires the replica (idempotent), folding any new durable ops, which fires
  // the sweep → `upsertCovenantStatus` → the glyph shape. Without this a certified span
  // would show `✓` and never flip on a peer edit. Fail-safe: the poke mints no verdict,
  // it only re-runs the fail-closed sweep.
  useEffect(() => {
    if (!covenant || state.status !== 'live') return;
    if (workspaceSlug === undefined || roomSlug === undefined) return;
    let stopped = false;
    const poke = () => {
      void pokeCovenantSweepAction({ workspaceSlug, roomSlug })
        .then((outcome) => {
          if (stopped) return;
          // A refused poke (not signed in / not a member / torn-down room) means the
          // server re-verdict is NOT running — treat it as a loss of verdict freshness
          // and degrade every glyph to `~`, never leave a stale `✓` standing.
          setPokeHealthy(outcome.ok);
        })
        .catch(() => {
          // A THROWN poke (network / server error) is likewise a loss of freshness — the
          // sweep did not run, so no glyph may keep its last `✓`. Fail-closed to `~` until
          // a poke succeeds again. NOT swallowed (the gauntlet MEDIUM: a swallowed poke
          // error let a live `✓` stand over already-edited text).
          if (!stopped) setPokeHealthy(false);
        });
    };
    poke(); // an immediate first pass so a fresh mount verdicts without waiting a tick
    const timer = setInterval(() => {
      if (!stopped) poke();
    }, POKE_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [covenant, state.status, workspaceSlug, roomSlug]);

  // THE HARNESS PEER-EDIT / CERTIFY SEAM (#220 / T6 acceptance scaffolding). The
  // rubric-12 flip needs an IN-RANGE peer edit of a certified span and an EXACT undo —
  // in-body co-editing that this thin slice does not yet ship as a user affordance. So,
  // ONLY behind an explicit `?covenant-e2e=1` gate, expose the live doc's edit + certify
  // to the acceptance harness (a legitimate peer): editing a body is already a
  // peer-writable capability, and certify still goes through the human-gated server
  // action. Never exposed on the normal surface.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-bind when the doc, tick, or membership locators change so the hooks close over the live instance
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('covenant-e2e') !== '1') return;
    const doc = docRef.current;
    if (doc === null || workspaceSlug === undefined || roomSlug === undefined) return;
    (window as unknown as { __atriumYjsTest?: unknown }).__atriumYjsTest = {
      /** The current message ids + their body plaintext, for the harness to target. */
      messages: (): Array<{ id: string; text: string }> =>
        doc.messages().map((message) => ({ id: message.id, text: message.text ?? '' })),
      /** A peer edit: insert `text` at char `index` inside a message's body. */
      edit: (messageId: string, index: number, text: string): boolean => {
        const body = doc.body(messageId);
        if (body === null) return false;
        body.insert(index, text);
        return true;
      },
      /**
       * THE F1 MID-REMAP FORGE, driven as a peer with ydoc write access (#220 / T6
       * acceptance). Append a hostile block carrying `mid=victimId` with `hostile` text and
       * retarget the genuine block's `mid` AWAY — so `body(victimId)` now displays the
       * hostile text while the anchor's frozen relative positions still resolve the untouched
       * genuine span. The FIX must make this show `~`, never a `✓` over unsigned content. Uses
       * only the peer-writable content share + Yjs constructors reflected off live nodes (no
       * privileged surface); gated behind `?covenant-e2e=1` exactly like `edit`/`deleteRange`.
       */
      remapMid: (victimId: string, hostile: string): boolean => {
        // Loose structural views of the Yjs nodes — the harness reaches the peer-writable
        // content share through the doc's public surface without importing Yjs.
        interface YBlock {
          getAttribute(k: string): unknown;
          setAttribute(k: string, v: string): void;
          insert(i: number, c: unknown[]): void;
          toArray(): unknown[];
          constructor: new (name?: string) => YBlock;
        }
        interface YFrag {
          insert(i: number, c: unknown[]): void;
          toArray(): unknown[];
          length: number;
        }
        const frag = doc.contentFragment() as unknown as YFrag;
        let victim: YBlock | undefined;
        for (const child of frag.toArray() as YBlock[]) {
          if (typeof child.getAttribute === 'function' && child.getAttribute('mid') === victimId) {
            victim = child;
            break;
          }
        }
        if (victim === undefined) return false;
        const seedChild = victim.toArray()[0] as
          | { constructor: new () => { insert(i: number, s: string): void } }
          | undefined;
        if (seedChild === undefined) return false;
        // Reflect the Yjs constructors off live nodes so the harness needs no Yjs import.
        const XmlElementCtor = victim.constructor;
        const XmlTextCtor = seedChild.constructor;
        const victimBlock = victim;
        doc.doc.transact(() => {
          const block = new XmlElementCtor('message');
          const xtext = new XmlTextCtor() as { insert(i: number, s: string): void };
          frag.insert(frag.length, [block]);
          block.setAttribute('mid', victimId);
          block.insert(0, [xtext]);
          if (hostile.length > 0) xtext.insert(0, hostile);
          // Retarget the genuine block away: the ONLY `mid=victimId` block is now the hostile one.
          victimBlock.setAttribute('mid', `${victimId}-evicted`);
        });
        return true;
      },
      /** The exact undo of an insert: delete `len` chars at `index` (restores the items). */
      deleteRange: (messageId: string, index: number, len: number): boolean => {
        const body = doc.body(messageId);
        if (body === null) return false;
        body.delete(index, len);
        return true;
      },
      /** Certify a span through the REAL human-gated action (scaffolding mint). */
      certify: async (
        messageId: string,
        start: number,
        end: number,
      ): Promise<{ ok: boolean; reason?: string }> => {
        const bodyPath = doc.bodyPath(messageId);
        if (bodyPath === null) return { ok: false, reason: 'no_body' };
        const outcome = await certifyYjsSpanAction({
          workspaceSlug,
          roomSlug,
          objectId: messageId,
          bodyPath,
          start,
          end,
        });
        return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
      },
    };
    return () => {
      delete (window as unknown as { __atriumYjsTest?: unknown }).__atriumYjsTest;
    };
  }, [docInstance, version, workspaceSlug, roomSlug]);

  // THE SPAN-CERTIFY ACT (#220 / T6) — CertifyPassage's `onCertify`, wired to the
  // human-gated `certifyYjsSpanAction`. The machine NEVER mints `✓`: this awaits the
  // server's answer and maps it to the panel's outcome; a refusal is surfaced verbatim,
  // never dressed as success. The object id IS the message id — the one-object-per-span
  // binding — so no client-forgeable object reference crosses.
  const runCertify = async (request: {
    workspaceSlug: string;
    roomSlug: string;
    objectId: string;
    bodyPath: number[];
    start: number;
    end: number;
  }): Promise<{ ok: true; anchorId: string } | { ok: false; reason: string }> => {
    const outcome = await certifyYjsSpanAction(request);
    return outcome.ok
      ? { ok: true, anchorId: outcome.anchorId }
      : { ok: false, reason: outcome.reason };
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
        {state.messages.map((message) => {
          // THE LIVE COVENANT GLYPH (#220 / T6). `✓` ONLY when the read authority
          // positively resolves this object (`covenant_status === 'ok'`) over a LIVE
          // shape — `anchorCertifies` is the single fail-closed gate, keyed by object id
          // = message id (the T6 binding). Anything else — never certified, drifted,
          // not-yet-synced, or a dead shape — is `~`. The machine never mints `✓`; a peer
          // edit flips it to `~` within a render tick and an exact revert flips it back.
          // `✓` requires ALL of: the covenant surface is on; the read authority resolves
          // this object `ok` over a LIVE shape (`anchorCertifies`); the poke that drives the
          // server re-verdict is HEALTHY; and the body displayed NOW is byte-identical to the
          // body content the last folded verdict was captured against (the freshness gate —
          // no `✓` over content newer than the verdict). Any miss ⇒ the honest `~`.
          const fresh = freshnessRef.current.fresh(message.id, message.text ?? '');
          const certified =
            covenant && pokeHealthy && fresh && anchorCertifies(glyphResolver, message.id);
          const canCertify =
            covenant &&
            docInstance !== null &&
            workspaceSlug !== undefined &&
            roomSlug !== undefined;
          const panelOpen = openCertifyId === message.id;
          return (
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
              {covenant ? (
                // The covenant marker. `data-glyph="✓"` ONLY on a live-resolved `ok`
                // (the acceptance cardinal keys on it); a `~` is the honest
                // not-certified / drifted / verifying state.
                <span
                  data-glyph={certified ? CERTIFIED_GLYPH : UNVERIFIED_GLYPH}
                  title={
                    certified
                      ? 'a human certification stands over a span of this line'
                      : 'no live human certification stands over this line'
                  }
                  style={{
                    fontSize: '0.85em',
                    padding: '0 0.35em',
                    borderRadius: 4,
                    background: certified ? 'rgba(16,128,64,0.14)' : 'rgba(0,0,0,0.06)',
                    color: certified ? 'rgb(16,110,56)' : 'inherit',
                    opacity: 0.9,
                  }}
                >
                  {certified ? `${CERTIFIED_GLYPH} certified` : `${UNVERIFIED_GLYPH} unverified`}
                </span>
              ) : (
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
                </span>
              )}{' '}
              <span data-live-doc-message-text>
                {fileText(message.text ?? '', 'live document line body')}
              </span>
              {canCertify && (message.text ?? '').length > 0 ? (
                <>
                  {' '}
                  <button
                    type="button"
                    data-live-doc-certify-toggle={message.id}
                    onClick={() =>
                      setOpenCertifyId((current) => (current === message.id ? null : message.id))
                    }
                    style={{
                      fontSize: '0.8em',
                      padding: '0 0.4em',
                      border: '1px solid rgba(0,0,0,0.2)',
                      borderRadius: 6,
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    {panelOpen ? 'close' : 'certify a passage'}
                  </button>
                </>
              ) : null}
              {canCertify && panelOpen && docInstance !== null ? (
                <CertifyPassage
                  doc={docInstance}
                  messageId={message.id}
                  version={version}
                  // THE BINDING: the object id IS the message id (one object per span).
                  objectId={message.id}
                  workspaceSlug={workspaceSlug as string}
                  roomSlug={roomSlug as string}
                  actor={viewerName ?? viewerId ?? 'viewer'}
                  onCertify={runCertify}
                />
              ) : null}
            </li>
          );
        })}
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
