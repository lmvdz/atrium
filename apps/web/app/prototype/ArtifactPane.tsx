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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
/* The DIFF renders through the SHIPPED renderer now (#151/#155: shipped wins on
   the diff, the prototype's client `parseDiff` is DELETED). `DiffView` is the
   `ReviewPane` structured-diff view, extracted so both the control plane and this
   pane render THROUGH it — honest empty/truncated states, a forgery-proof CSS
   gutter, control-char neutralisation, none of it re-implemented here. */
import { DiffView } from '@/src/components/control/DiffView';
import { Glyph } from '@/src/components/primitives/Glyph';
import { systemSettlementState } from './conversation-model';
import { ArtifactKindIcon, IconCheck } from './icons';
import styles from './prototype.module.css';
import type { Artifact, Comment, CommentDraft } from './types';
import { NO_AUTOFILL } from './types';

/* markdown component overrides → the pane's own type scale (real react-markdown). */
const MD_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => <h3 className={styles.mdH1}>{children}</h3>,
  h2: ({ children }: { children?: React.ReactNode }) => <h4 className={styles.mdH2}>{children}</h4>,
  h3: ({ children }: { children?: React.ReactNode }) => <h5 className={styles.mdH3}>{children}</h5>,
  p: ({ children }: { children?: React.ReactNode }) => <p className={styles.mdP}>{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className={styles.mdUl}>{children}</ul>,
  li: ({ children }: { children?: React.ReactNode }) => <li className={styles.mdLi}>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className={styles.mdStrong}>{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em className={styles.mdEm}>{children}</em>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className={styles.mdQuote}>{children}</blockquote>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className={styles.mdCode}>{children}</code>
  ),
};

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

  const refreshFromRange = () => {
    const range = rangeRef.current;
    const body = bodyRef.current;
    const md = mdRef.current;
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
    const md = mdRef.current;
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
      <div className={styles.md} ref={mdRef}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
          {artifact.md ?? ''}
        </ReactMarkdown>
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
            “{sel.quote.length > 90 ? `${sel.quote.slice(0, 90)}…` : sel.quote}”
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
                “{c.quote.length > 40 ? `${c.quote.slice(0, 40)}…` : c.quote}”
              </span>
              <span className={styles.artCommentText}>{c.text}</span>
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
}: {
  artifacts: readonly Artifact[];
  activeId: string;
  onSelectArtifact: (id: string) => void;
  comments: readonly Comment[];
  onComment: (artifactId: string, anchor: string, quote: string, text: string) => void;
  onDraft: (d: CommentDraft | null) => void;
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
              title={`${a.title} · ${a.sub}`}
              aria-label={`${a.title} (${a.kind})`}
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
        <span
          className={styles.artFootHint}
          title="certification is a human act, gated by the server (certifySession: a timed arm→confirm hold on the session landing); not reachable from this surface yet (#157)"
        >
          awaiting a human
          <IconCheck size={11} />
        </span>
      </div>
    </section>
  );
}
