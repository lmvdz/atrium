'use client';

/* ARTIFACT PANE — the right split, an artifact HOST. The switcher lists the open
   artifacts by name; the active one renders through the renderer its kind selects
   (diff → git diff, doc/plan → markdown). Comments anchor where they're made and
   echo to the chat.
 *
 * #151 marriage table:
 *   - Diff render is **bind-shipped** (#155): the shipped `ReviewPane` `DiffView`
 *     wins (the server pre-structures the diff) and the prototype's `parseDiff`
 *     is deleted. See the SEAM on `DiffView` below — the shipped `DiffView` is
 *     module-internal to `ReviewPane` and `ReviewPane` also carries the covenant
 *     certify/arm door (#157), so the swap lands in #155/#157 against a real
 *     `SessionDiff`, not in this mock-only scaffold, where it would regress the
 *     design's line-anchored comment composer + off-scope pills the gauntlet
 *     checks for parity. The prototype renderer stays behind the seam meanwhile.
 *   - DocView / ArtifactPane are **port + projection** (#158): the CSS is the
 *     design's; the doc/plan projection binds later.
 *   - The line-anchored comment write is **bind-shipped** to ledger comments
 *     (#156). */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CERTIFY_HOLD_MS } from '@/lib/certify-hold';
import { MessageBody, RichMessageBody } from '@/src/components';
/* The DIFF renders through the SHIPPED renderer now (#151/#155: shipped wins on
   the diff, the prototype's client `parseDiff` is DELETED). `DiffView` is the
   `ReviewPane` structured-diff view, extracted so both the control plane and this
   pane render THROUGH it — honest empty/truncated states, a forgery-proof CSS
   gutter, control-char neutralisation, none of it re-implemented here. */
import { DiffView } from '@/src/components/control/DiffView';
import { AttributionLedger, fileText, offeredText } from '@/src/components/model';
import { systemText } from '@/src/components/model/quotation';
import { Glyph } from '@/src/components/primitives/Glyph';
import { HoldToAct } from '@/src/components/primitives/HoldToAct';
import {
  ARTIFACT_DOC_ROOM,
  artifactDocModel,
  messageBody,
  systemSettlementState,
} from './conversation-model';
import type { GateOutcome, LiveCovenant } from './covenant';
import { ArtifactKindIcon, IconCheck } from './icons';
import styles from './prototype.module.css';
import type { Artifact, Comment, CommentDraft } from './types';
import { NO_AUTOFILL } from './types';

/* THE CERTIFY BINDING (#168 B2) — the live covenant, the SESSION the pane's
   landing belongs to, and the REAL `artifactDigest` of the reading being shown.
   Present only on a real room route with a settled/reviewable session; absent on
   the fixture route, where certify stays the inert "awaiting a human" hint. */
export interface CertifyBinding {
  readonly covenant: LiveCovenant;
  readonly sessionId: string;
  /** The server's `md5(artifact::text)` for the reading on screen — the signature
      binds to THIS, so you certify the reading you were shown, never a stale one. */
  readonly artifactDigest: string;
  readonly viewerId: string;
}

/* THE LIVE CERTIFY CONTROL — the session-landing arm→confirm hold. Drives
   `primitives/HoldToAct` exactly as `ReviewPane` does: `onBegin` fires the server
   ARM (binding the signature to `artifactDigest`), `onAct` fires the CONFIRM on a
   completed hold, `onCancel` DISARMS a released one. `reached:true` is painted
   ONLY on the server's awaited `ok` — never a local flag. The machine never
   certifies; the server refuses a non-human before any append (`commands.ts`). */
function CertifyControl({ certify }: { certify: CertifyBinding }) {
  const [result, setResult] = useState<GateOutcome | null>(null);
  const [working, setWorking] = useState(false);
  return (
    <span className={styles.artCertify}>
      <HoldToAct
        actionId={`certify-${certify.sessionId}`}
        actor={certify.viewerId}
        describe="put a human signature on this session's landing"
        holdMs={CERTIFY_HOLD_MS}
        label="Certify this session"
        onBegin={() => {
          setResult(null);
          setWorking(true);
          certify.covenant.certifyArm(certify.sessionId, certify.artifactDigest);
        }}
        onAct={() => {
          void certify.covenant.certifyConfirm(certify.sessionId).then((outcome) => {
            setWorking(false);
            setResult(outcome);
          });
        }}
        onCancel={() => {
          setWorking(false);
          certify.covenant.certifyDisarm(certify.sessionId);
        }}
        resetOnComplete
      />
      {working ? (
        <span className={styles.artCertifyNote}>certifying…</span>
      ) : result === null ? null : result.reached ? (
        // The `✓` is a STATE, never a literal glyph in copy (the glyph-source
        // covenant) — the footer's derived `<Glyph>` already carries the mark; this
        // line only states, in words, that the human signature landed.
        <span className={styles.artCertifyOk}>certified</span>
      ) : (
        // The server's own refusal, in the page's system voice (the reason is a
        // closed `CertifyRefusal` code, never somebody's words) — through the
        // `systemText` door, the same check every stated string on the page takes.
        <span
          className={styles.artCertifyRefused}
          title={systemText(result.refusal ?? 'the server refused it', 'certify refusal')}
        >
          not certified — {systemText(result.refusal ?? 'the server refused it', 'certify refusal')}
        </span>
      )}
    </span>
  );
}

/* find the text caret (node + offset) under a viewport point — the boundary the
   dragged selection handle should snap to. Chromium exposes caretRangeFromPoint. */
function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  return null;
}

interface DocSel {
  quote: string;
  rects: { top: number; left: number; width: number; height: number }[];
  start: { x: number; y: number; h: number };
  end: { x: number; y: number; h: number };
  blockBottom: number;
}

/* the top-level markdown block element (a direct child of the md container) that
   contains a node — the element we push down to make room for the composer. */
function blockOf(node: Node | null, md: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== md) {
    if (n.parentNode === md) return n as HTMLElement;
    n = n.parentNode;
  }
  return null;
}

/* DOC VIEW — real markdown (react-markdown + gfm). Selecting prose keeps the
   quote highlighted with draggable end-handles (extend/shrink the range) and
   opens an INLINE composer beneath it that PUSHES the following text down to make
   room (never an overlay), and mirrors into the chat live as you type. */
function DocView({
  artifact,
  comments,
  onComment,
  onDraft,
}: {
  artifact: Artifact;
  comments: readonly Comment[];
  onComment: (artifactId: string, anchor: string, quote: string, text: string) => void;
  onDraft: (d: CommentDraft | null) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const mdRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLFormElement>(null);
  const rangeRef = useRef<Range | null>(null);
  const blockRef = useRef<HTMLElement | null>(null);
  const draftRef = useRef('');
  const [sel, setSel] = useState<DocSel | null>(null);
  const [draft, setDraft] = useState('');

  /* The doc/plan artifact, as an attributed record the SHIPPED `RichMessageBody`
     cites (#158). Null for a diff artifact or an empty body — those never reach
     this renderer. */
  const doc = useMemo(() => artifactDocModel(artifact), [artifact]);

  /* The shipped body wraps its markdown in one `[data-rich-message]` container
     whose DIRECT children are the top-level blocks. The select-to-comment
     machinery pushes the block holding the selection down for the composer, so
     it must walk to THAT container, not to the `styles.md` wrapper above it. */
  const richEl = (): HTMLElement | null =>
    (mdRef.current?.querySelector('[data-rich-message]') as HTMLElement | null) ?? mdRef.current;

  const refreshFromRange = () => {
    const range = rangeRef.current;
    const body = bodyRef.current;
    const md = richEl();
    if (!range || !body || !md) return;
    const b = body.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        top: r.top - b.top + body.scrollTop,
        left: r.left - b.left,
        width: r.width,
        height: r.height,
      }));
    if (rects.length === 0) return;
    const first = rects[0]!;
    const last = rects[rects.length - 1]!;
    const q = range.toString().replace(/\s+/g, ' ').trim();
    const block = blockOf(range.endContainer, md);
    blockRef.current = block;
    const blockBottom = block
      ? block.getBoundingClientRect().bottom - b.top + body.scrollTop
      : Math.max(...rects.map((r) => r.top + r.height));
    setSel({
      quote: q,
      rects,
      start: { x: first.left, y: first.top, h: first.height },
      end: { x: last.left + last.width, y: last.top, h: last.height },
      blockBottom,
    });
    onDraft({ quote: q, text: draftRef.current }); // mirror into the chat live
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const md = richEl();
    const composer = composeRef.current;
    if (!md) return;
    // selecting inside the composer (its quote line or textarea) is NOT a new
    // anchor — only text within the rendered markdown counts as a quote.
    if (composer && composer.contains(e.target as Node)) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return;
    const range = s.getRangeAt(0);
    if (!md.contains(range.commonAncestorContainer) || range.toString().trim().length === 0) return;
    rangeRef.current = range.cloneRange();
    s.removeAllRanges(); // our own amber overlay replaces the native highlight
    draftRef.current = '';
    setDraft('');
    refreshFromRange();
  };

  /* drag a handle to move one boundary of the quote, growing/shrinking it. */
  const dragHandle = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: PointerEvent) => {
      const pt = caretFromPoint(ev.clientX, ev.clientY);
      const range = rangeRef.current;
      const body = bodyRef.current;
      if (!pt || !range || !body || !body.contains(pt.node)) return;
      const cand = range.cloneRange();
      try {
        if (which === 'start') cand.setStart(pt.node, pt.offset);
        else cand.setEnd(pt.node, pt.offset);
      } catch {
        return;
      }
      if (cand.collapsed || cand.toString().trim().length === 0) return;
      rangeRef.current = cand;
      refreshFromRange();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* reserve space — push the block holding the selection down by the composer's
     height so the composer sits in the gap and the text makes room for it. */
  useLayoutEffect(() => {
    const block = blockRef.current;
    const form = composeRef.current;
    if (!sel || !block || !form) return;
    block.style.marginBottom = `${form.offsetHeight + 16}px`;
    return () => {
      block.style.marginBottom = '';
    };
  }, [sel, draft]);

  const close = () => {
    if (blockRef.current) blockRef.current.style.marginBottom = '';
    blockRef.current = null;
    rangeRef.current = null;
    draftRef.current = '';
    setSel(null);
    setDraft('');
    onDraft(null);
  };
  // reset when the hosted artifact changes (doc ↔ plan share this renderer)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on artifact swap
  useEffect(() => close, [artifact.id]);

  const submit = () => {
    if (!sel || draft.trim().length === 0) return;
    onComment(artifact.id, sel.quote.slice(0, 24), sel.quote, draft.trim());
    close();
  };
  const onType = (v: string) => {
    draftRef.current = v;
    setDraft(v);
    if (sel) onDraft({ quote: sel.quote, text: v });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: select-to-comment surface
    <div className={styles.docBody} ref={bodyRef} onMouseUp={onMouseUp}>
      {/* THE DOC/PLAN BODY, THROUGH THE SHIPPED `RichMessageBody` GRAMMAR (#158).
          The prototype's hand-rolled `react-markdown` + `MD_COMPONENTS` is
          DELETED: the shipped body renders GFM, refuses authored HTML, tokenises
          code, and — the reason it retires the printed-strings finding this pane
          owned — resolves every printed span from the attribution register
          (`useAttribution`) instead of raw-printing `artifact.md`. It is cited
          against a one-record `<AttributionLedger>` built from the artifact. */}
      <div className={styles.md} ref={mdRef}>
        {doc ? (
          <AttributionLedger messages={[doc.record]} room={ARTIFACT_DOC_ROOM}>
            <RichMessageBody citation={doc.citation} />
          </AttributionLedger>
        ) : null}
      </div>

      {/* the persistent quote highlight + draggable end-handles */}
      {sel
        ? sel.rects.map((r, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: positional highlight rects
              key={i}
              className={styles.docHl}
              style={{
                top: `${r.top}px`,
                left: `${r.left}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
              }}
            />
          ))
        : null}
      {sel ? (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: selection resize handle */}
          <div
            className={`${styles.docHandle} ${styles.docHandleStart}`}
            style={{
              top: `${sel.start.y}px`,
              left: `${sel.start.x}px`,
              height: `${sel.start.h}px`,
            }}
            onPointerDown={dragHandle('start')}
            role="slider"
            aria-label="drag to adjust the start of the quote"
            aria-valuenow={0}
            tabIndex={0}
          />
          {/* biome-ignore lint/a11y/noStaticElementInteractions: selection resize handle */}
          <div
            className={`${styles.docHandle} ${styles.docHandleEnd}`}
            style={{ top: `${sel.end.y}px`, left: `${sel.end.x}px`, height: `${sel.end.h}px` }}
            onPointerDown={dragHandle('end')}
            role="slider"
            aria-label="drag to adjust the end of the quote"
            aria-valuenow={0}
            tabIndex={0}
          />
        </>
      ) : null}

      {/* the inline composer, sitting in the space the text made below the block */}
      {sel ? (
        <form
          ref={composeRef}
          className={styles.docCompose}
          style={{ top: `${sel.blockBottom + 8}px` }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className={styles.docComposeQuote}>
            {/* The selection is VERBATIM doc content — a slice of `artifact.md` —
                so it is painted through the `fileText` content door (control-char
                neutralised), never raw. */}
            “
            {fileText(
              sel.quote.length > 90 ? `${sel.quote.slice(0, 90)}…` : sel.quote,
              'DocView selection quote',
            )}
            ”
          </div>
          <textarea
            className={styles.docComposeArea}
            // biome-ignore lint/a11y/noAutofocus: focus the comment the moment it opens
            autoFocus
            placeholder="comment on the selection…"
            value={draft}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={2}
            {...NO_AUTOFILL}
          />
          <div className={styles.docComposeRow}>
            <span className={styles.docComposeHint}>
              appears in the chat as you type · ⌘⏎ to comment
            </span>
            <span className={styles.grow} />
            <button type="button" className={styles.docComposeCancel} onClick={close}>
              cancel
            </button>
            <button
              type="submit"
              className={styles.docComposeSend}
              disabled={draft.trim().length === 0}
            >
              comment
            </button>
          </div>
        </form>
      ) : null}

      {comments.length > 0 ? (
        <div className={styles.artComments}>
          {comments.map((c) => (
            <div key={c.id} className={styles.artComment}>
              <span className={styles.artCommentQuote}>
                {/* the anchored quote is verbatim doc content → the `fileText`
                    door; the comment is the viewer's OWN words → the shipped
                    `MessageBody`, whose runs render through `segmentText` (the
                    same read the attribution model reconciles a body against). */}
                “
                {fileText(
                  c.quote.length > 40 ? `${c.quote.slice(0, 40)}…` : c.quote,
                  'DocView comment quote',
                )}
                ”
              </span>
              <span className={styles.artCommentText}>
                <MessageBody body={messageBody(c.text)} />
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ARTIFACT PANE — hosts the active artifact through the renderer its kind selects. */
export function ArtifactPane({
  artifacts,
  activeId,
  onSelectArtifact,
  comments,
  onComment,
  onDraft,
  certify,
}: {
  artifacts: readonly Artifact[];
  activeId: string;
  onSelectArtifact: (id: string) => void;
  comments: readonly Comment[];
  onComment: (artifactId: string, anchor: string, quote: string, text: string) => void;
  onDraft: (d: CommentDraft | null) => void;
  /* #168 B2: the live session-landing certify binding. Present only on a real
     room route (with a reviewable session); absent on the fixture route. */
  certify?: CertifyBinding;
}) {
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[0]!;
  const here = comments.filter((c) => c.artifactId === active.id);
  return (
    <section className={styles.artifact} aria-label="artifact">
      {/* one header row, height-matched to the chat top bar for aligned columns.
          Icons only — each artifact's name lives on its hover tooltip. */}
      <div className={styles.artHead}>
        <div className={styles.artIcons}>
          {artifacts.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`${styles.artIconBtn} ${a.id === active.id ? styles.artIconBtnOn : ''}`}
              onClick={() => onSelectArtifact(a.id)}
              /* the switcher label is the copy ON a control (this button), so it
                 goes through the `offeredText` door — the one that keeps its
                 pronouns but is bounded to a control's own copy. */
              title={offeredText(`${a.title} · ${a.sub}`, 'ArtifactPane switcher title')}
              aria-label={offeredText(`${a.title} (${a.kind})`, 'ArtifactPane switcher label')}
              aria-pressed={a.id === active.id}
            >
              <ArtifactKindIcon kind={a.kind} />
            </button>
          ))}
        </div>
        <span className={styles.grow} />
      </div>
      <div className={styles.artBody}>
        {active.kind === 'diff' ? (
          /* The SHIPPED structured-diff view, fed the server-pre-structured
             `SessionDiff` — no client `parseDiff`, and (per #153, deferred to
             Phase-6 fog) no line-anchored comments on the diff. */
          <DiffView artifact={{ diff: active.sessionDiff }} />
        ) : (
          <DocView artifact={active} comments={here} onComment={onComment} onDraft={onDraft} />
        )}
      </div>
      {/* footer status — height-matched to the other bottom bars via --foot-h.
          SEAM(#157): certify is honestly INERT here. This pane hosts a SESSION
          LANDING, so the gated door is `certifySession` — the SQL-timed
          arm→confirm hold (`lib/certify-session.ts`, driven by `HoldToAct`),
          which measures its own arm→confirm interval and writes a human
          signature on the session row — NOT `correctObject('amend',…)`, which
          certifies a semantic claim, not a landing (#157 r1 D2). Either way it is
          a HUMAN act the server refuses for a machine. On int/phase5 this route
          holds no live client or real session id, so there is NO certify control
          that could mutate anything: the `✓`/`~` is DERIVED from
          `active.certified` through the shipped `<Glyph>` (never a literal glyph,
          never a local `certified = true`), and the footer only states that it is
          awaiting a human. When app-integration binds a live client, a
          hold-to-certify affordance (`primitives/HoldToAct`) routes through
          `covenant.certify(sessionId)` (arm→confirm) and paints `✓` only on the
          server's ack. A doc note carries no epistemic mark. */}
      <div className={styles.artFoot}>
        {active.kind === 'doc' ? null : (
          <Glyph state={systemSettlementState(active.certified === true)} />
        )}
        <span className={styles.artFootStatus}>
          {active.kind === 'diff' ? 'proposed' : active.kind} · draft
        </span>
        <span className={styles.grow} />
        {/* #168 B2: the LIVE certify control — the session-landing arm→confirm hold
            — is offered ONLY when a live binding exists, the pane hosts a landing
            (a diff), and the reading is not already certified. Otherwise (the
            fixture route, a doc note, or an already-certified landing) the footer
            states it is awaiting a human — the inert design shell, unchanged. */}
        {certify !== undefined && active.kind === 'diff' && active.certified !== true ? (
          /* KEYED BY SESSION (#168 B2 fix1, F2). Without the key this one control
             instance survives a session switch and its local `result` ("certified")
             migrates onto the newly-selected, uncertified session. Keying by
             `sessionId` REMOUNTS it on every session change, so its transient
             arm/confirm state is born fresh for each landing and an in-flight
             confirm for session A that resolves after the switch resolves into an
             UNMOUNTED A control (its `setResult` is dropped), never painting
             "certified" next to B. The authoritative `<Glyph sessionCertified>`
             above stays derived from `active.certified`, so it is always correct. */
          <CertifyControl key={certify.sessionId} certify={certify} />
        ) : (
          <span
            className={styles.artFootHint}
            title="certification is a human act, gated by the server (certifySession: a timed arm→confirm hold on the session landing); the server refuses a machine before any append"
          >
            awaiting a human
            <IconCheck size={11} />
          </span>
        )}
      </div>
    </section>
  );
}
