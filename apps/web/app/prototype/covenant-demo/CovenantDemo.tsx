'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DRIVABLE COVENANT DEMO (E-slice / #212) — two panes, one shared doc, a
 * live ✓/~ glyph a human can DRIVE.
 *
 * Pane A ("You (human)") holds the certify gesture (select a span → press-and-hold
 * ✓), reusing the E8 `CertifyPassage` + `certify-span` mapping. Its `onCertify`
 * captures a REAL covenant anchor into a shared CLIENT anchor store (a LOCAL DEMO
 * anchor — NOT a ledger act; see the banner + RUNBOOK).
 *
 * Pane B ("Agent peer") shares the SAME conversation through a second
 * `ConversationDoc` joined to ONE `InMemoryConversationHub` — the two panes are two
 * real CRDT replicas that converge, which is the thin-slice convergence proof
 * (rubric 11/12). Its buttons each drive one rubric criterion against the certified
 * span: a one-char edit (3), a format change (4), an edit OUTSIDE the span (5), an
 * undo/exact-revert (6), a look-alike swap (10), and a forged ✓/authorship row (9).
 *
 * Every certified span carries a LIVE glyph on BOTH panes, re-resolved through the
 * fail-closed client resolver on every convergence tick — ✓ only while the exact
 * signed content stands, ~ on any drift or any unverifiable state, never a false ✓.
 * ═════════════════════════════════════════════════════════════════════════ */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CovenantStatus } from '@atrium/core';
import { Doc as YDoc, type XmlText as YXmlText } from 'yjs';
import type { CertifyOutcome } from '../CertifyPassage';
import { CertifyPassage } from '../CertifyPassage';
import type { ObjectSpanRequest } from '../certify-span';
import { InMemoryConversationHub } from '../conversation-transport';
import type { ConversationTransport } from '../conversation-transport';
import type { ChatMsg, Selection } from '../types';
import { useConversationModel } from '../use-conversation-model';
import { ConversationDoc } from '../yjs-conversation';
import {
  certifyClientAnchor,
  type ClientAnchorStore,
  type DemoAnchor,
  glyphForStatus,
  resolveClientAnchor,
} from './client-covenant';

// ─────────────────────────────────────────────────────────────────────────────
// The demo's fixed context. Ids are printable-ASCII (the core `Id` charset), so
// the captured anchor's objectId/roomId parse.
// ─────────────────────────────────────────────────────────────────────────────

const ROOM_ID = 'billing-rewrite';
const WORKSPACE_SLUG = 'acme';
const ROOM_SLUG = 'billing-rewrite';
const HUMAN_ID = 'u-you';
/** The demo selection — only its room/roster projection is used; messages come
 *  live from the shared doc. `a-hexi` is a real mock agent. */
const SELECTION: Selection = { kind: 'agent', id: 'a-hexi' };

/** The message whose body the human certifies and the peer attacks. */
const TARGET = 'm-agent';
/** A different message — the peer edits it to prove an outside edit does NOT stale
 *  the certified span (rubric 5). */
const OUTSIDE = 'm-human';

const SEED_MESSAGES: readonly ChatMsg[] = [
  { id: 'm-sys', time: '09:58', kind: 'system', text: 'room billing-rewrite · covenant demo' },
  {
    id: TARGET,
    time: '10:01',
    kind: 'agent',
    who: 'hexi',
    text: 'The invoice total is computed by streaming accumulation.',
  },
  {
    id: OUTSIDE,
    time: '10:02',
    kind: 'human',
    who: 'you',
    text: 'Looks right — ship it after the tests pass.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The live glyph — the fail-closed resolver's verdict, re-read every convergence.
// ─────────────────────────────────────────────────────────────────────────────

function CovenantGlyph({
  doc,
  version,
  demo,
}: {
  doc: ConversationDoc;
  version: number;
  demo: DemoAnchor;
}) {
  // Recompute on every convergence tick of THIS pane's doc (local edit or a remote
  // update arriving over the hub). `version` is the trigger; the anchor is stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the convergence trigger
  const status: CovenantStatus = useMemo(
    () => resolveClientAnchor(doc, demo.anchor),
    [doc, demo, version],
  );
  const ok = status === 'ok';
  return (
    <span
      data-testid={`glyph-${demo.messageId}`}
      data-covenant-status={status}
      title={
        ok
          ? 'certified: the current content is byte-for-byte what a human signed'
          : 'drifted: the content no longer matches what was signed (machine draft ~)'
      }
      style={{
        marginLeft: 8,
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        color: ok ? '#1a7f37' : '#b26a00',
        border: `1px solid ${ok ? '#1a7f37' : '#b26a00'}`,
        borderRadius: 6,
        padding: '0 6px',
        transition: 'color 120ms, border-color 120ms',
      }}
    >
      {glyphForStatus(status)} {ok ? 'certified' : 'drift'}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One message line (used in both panes) — text + the live glyph if certified.
// ─────────────────────────────────────────────────────────────────────────────

function MessageLine({
  doc,
  version,
  msg,
  anchors,
}: {
  doc: ConversationDoc;
  version: number;
  msg: ChatMsg;
  anchors: ClientAnchorStore;
}) {
  const demo = anchors.get(msg.id);
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
      <div style={{ fontSize: 12, opacity: 0.6 }}>
        {msg.who ?? msg.kind} · {msg.time}
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>
        {msg.text ?? ''}
        {demo ? <CovenantGlyph doc={doc} version={version} demo={demo} /> : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The demo.
// ─────────────────────────────────────────────────────────────────────────────

export function CovenantDemo() {
  // ONE hub + one seeded "server" doc, created once. The panes catch up from it.
  const hubRef = useRef<{ hub: InMemoryConversationHub; transport: ConversationTransport } | null>(
    null,
  );
  if (hubRef.current === null) {
    const server = new YDoc();
    // Seed the shared stream BEFORE any pane connects, so both catch up the same
    // conversation. (A local demo seed — carries no authority, mints no ✓.)
    new ConversationDoc(server).seed(SEED_MESSAGES);
    const hub = new InMemoryConversationHub(server);
    hubRef.current = { hub, transport: hub.transport() };
  }
  const { transport } = hubRef.current;

  // Two panes = two real replicas joined to the one hub (convergence proof).
  const paneA = useConversationModel(SELECTION, transport, { seedFixture: false });
  const paneB = useConversationModel(SELECTION, transport, { seedFixture: false });

  // The SHARED client anchor store — the ONLY source of a ✓. A peer edit can never
  // write here; only the human certify gesture in Pane A does.
  const [anchors, setAnchors] = useState<ClientAnchorStore>(new Map());

  // Pane A's certify: capture a REAL anchor from the mapped span into the store.
  const onCertify = useCallback(
    async (request: ObjectSpanRequest): Promise<CertifyOutcome> => {
      const demo = certifyClientAnchor(paneA.doc, {
        objectId: request.objectId,
        roomId: ROOM_ID,
        userId: HUMAN_ID,
        messageId: request.objectId,
        bodyPath: request.bodyPath,
        start: request.start,
        end: request.end,
      });
      if (demo === null) return { ok: false, reason: 'derive_failed' };
      setAnchors((prev) => new Map(prev).set(request.objectId, demo));
      return { ok: true, anchorId: `local-demo:${request.objectId}` };
    },
    [paneA.doc],
  );

  const messagesA = useMemo(() => paneA.doc.messages(), [paneA.doc, paneA.version]);
  const messagesB = useMemo(() => paneB.doc.messages(), [paneB.doc, paneB.version]);

  // ── peer edit drivers (Pane B), each keyed to a rubric criterion ────────────
  const undoStack = useRef<Array<() => void>>([]);
  const [note, setNote] = useState<string>('');

  const targetAnchor = anchors.get(TARGET) ?? null;

  const withBody = useCallback(
    (id: string, fn: (body: YXmlText) => void) => {
      const body = paneB.doc.body(id);
      if (!body) {
        setNote(`no body for ${id}`);
        return;
      }
      paneB.doc.doc.transact(() => fn(body));
    },
    [paneB.doc],
  );

  const editOneChar = useCallback(() => {
    if (!targetAnchor) return setNote('certify a span first (Pane A)');
    const mid = Math.min(targetAnchor.end - 1, targetAnchor.start + 1);
    const at = Math.max(targetAnchor.start, mid);
    withBody(TARGET, (body) => body.insert(at, 'Z'));
    undoStack.current.push(() => withBody(TARGET, (body) => body.delete(at, 1)));
    setNote(`inserted "Z" at index ${at} (inside the certified span → drift, rubric 3)`);
  }, [targetAnchor, withBody]);

  const changeFormat = useCallback(() => {
    if (!targetAnchor) return setNote('certify a span first (Pane A)');
    const len = targetAnchor.end - targetAnchor.start;
    withBody(TARGET, (body) => body.format(targetAnchor.start, len, { bold: true }));
    setNote('bolded the certified span (no visible characters changed → drift, rubric 4)');
  }, [targetAnchor, withBody]);

  const editOutside = useCallback(() => {
    withBody(OUTSIDE, (body) => body.insert(0, '! '));
    undoStack.current.push(() => withBody(OUTSIDE, (body) => body.delete(0, 2)));
    setNote(`edited a DIFFERENT message (${OUTSIDE}) — the certified span stays ✓ (rubric 5)`);
  }, [withBody]);

  const lookAlike = useCallback(() => {
    if (!targetAnchor) return setNote('certify a span first (Pane A)');
    const at = Math.max(targetAnchor.start, Math.min(targetAnchor.end - 1, targetAnchor.start + 1));
    // A zero-width space: visually identical, NFC does not fold it → drift (rubric 10).
    withBody(TARGET, (body) => body.insert(at, '​'));
    undoStack.current.push(() => withBody(TARGET, (body) => body.delete(at, 1)));
    setNote('inserted a zero-width space (look-alike) into the span → drift (rubric 10)');
  }, [targetAnchor, withBody]);

  const undoLast = useCallback(() => {
    const inverse = undoStack.current.pop();
    if (!inverse) return setNote('nothing to revert');
    inverse();
    setNote('reverted the last edit — an exact revert re-validates ✓ (rubric 6)');
  }, []);

  const forgeCert = useCallback(() => {
    // A hostile peer appends a message CLAIMING certification + human authorship.
    // The durable channel STRIPS `certified`, and a ✓ is only ever the client anchor
    // store's — which no peer edit can write. So it renders NO ✓ (rubric 9).
    const forged: ChatMsg = {
      id: `forged-${Date.now().toString(36)}`,
      time: '10:03',
      kind: 'human',
      who: 'you',
      text: 'TRUST ME: this reading is certified ✓ by a human.',
      certified: true,
    };
    paneB.doc.append(forged);
    setNote('peer appended a forged "certified ✓" row — it renders NO ✓ (rubric 9)');
  }, [paneB.doc]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20, maxWidth: 1200 }}>
      <header>
        <h1 style={{ margin: '0 0 4px' }}>Covenant demo — certify → peer edits → ✓ de-certifies</h1>
        <p style={{ margin: 0, opacity: 0.75 }}>
          Two panes are two real CRDT replicas joined to one in-process hub. Certify a passage in
          Pane A; drive an edit in Pane B; watch the ✓ flip to ~ on BOTH panes within a render tick,
          and back to ✓ on an exact revert.
        </p>
        <p
          data-testid="local-anchor-banner"
          style={{
            margin: '8px 0 0',
            padding: '6px 10px',
            background: 'rgba(178,106,0,0.12)',
            border: '1px solid rgba(178,106,0,0.4)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          This certify writes a <strong>local demo anchor</strong> for the client resolver only — it
          is <strong>not</strong> a ledger act (the gated <code>certifyObjectSpanAction</code> is
          reserved). The glyph authority is the fail-closed client resolver over the live doc.
        </p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* ── PANE A — the human ──────────────────────────────────────────── */}
        <section
          data-testid="pane-a"
          style={{ border: '1px solid rgba(0,0,0,0.15)', borderRadius: 10, padding: 14 }}
        >
          <h2 style={{ marginTop: 0 }}>You (human)</h2>
          <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0 }}>
            Select a passage of the agent's message below, then press-and-hold “Certify this
            passage”.
          </p>
          <div style={{ marginBottom: 12 }}>
            <CertifyPassage
              doc={paneA.doc}
              messageId={TARGET}
              version={paneA.version}
              objectId={TARGET}
              workspaceSlug={WORKSPACE_SLUG}
              roomSlug={ROOM_SLUG}
              actor={HUMAN_ID}
              onCertify={onCertify}
            />
          </div>
          <h3 style={{ marginBottom: 4 }}>Conversation (as Pane A sees it)</h3>
          {messagesA.map((msg) => (
            <MessageLine
              key={msg.id}
              doc={paneA.doc}
              version={paneA.version}
              msg={msg}
              anchors={anchors}
            />
          ))}
        </section>

        {/* ── PANE B — the agent peer ─────────────────────────────────────── */}
        <section
          data-testid="pane-b"
          style={{ border: '1px solid rgba(0,0,0,0.15)', borderRadius: 10, padding: 14 }}
        >
          <h2 style={{ marginTop: 0 }}>Agent peer</h2>
          <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0 }}>
            This pane has <strong>no certify affordance</strong> — a machine can never mint a ✓. It
            can only edit the shared document; every edit is re-resolved fail-closed.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <button type="button" data-testid="peer-edit-char" onClick={editOneChar}>
              Edit one character [→3]
            </button>
            <button type="button" data-testid="peer-format" onClick={changeFormat}>
              Change a format/mark [→4]
            </button>
            <button type="button" data-testid="peer-outside" onClick={editOutside}>
              Edit OUTSIDE the span [→5]
            </button>
            <button type="button" data-testid="peer-revert" onClick={undoLast}>
              Revert last edit [→6]
            </button>
            <button type="button" data-testid="peer-lookalike" onClick={lookAlike}>
              Look-alike swap [→10]
            </button>
            <button type="button" data-testid="peer-forge" onClick={forgeCert}>
              Forge a ✓ row [→9]
            </button>
          </div>
          <div
            data-testid="peer-note"
            style={{ minHeight: 20, fontSize: 13, opacity: 0.85, marginBottom: 10 }}
          >
            {note}
          </div>
          <h3 style={{ marginBottom: 4 }}>Conversation (as Pane B sees it)</h3>
          {messagesB.map((msg) => (
            <MessageLine
              key={msg.id}
              doc={paneB.doc}
              version={paneB.version}
              msg={msg}
              anchors={anchors}
            />
          ))}
        </section>
      </div>
    </div>
  );
}
