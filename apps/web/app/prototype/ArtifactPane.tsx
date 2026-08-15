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

import { Highlight, type PrismTheme } from 'prism-react-renderer';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArtifactKindIcon, IconCheck, IconCommentPlus } from './icons';
import styles from './prototype.module.css';
import type { Artifact, Comment, CommentDraft } from './types';
import { NO_AUTOFILL } from './types';

/* A prism theme in the WIRE palette — colours are the design tokens themselves,
   so the code reads in the same operator surface as everything else. */
const CODE_THEME: PrismTheme = {
  plain: { color: 'var(--tx1)', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'cdata'], style: { color: 'var(--tx3)', fontStyle: 'italic' } },
    {
      types: ['keyword', 'boolean', 'tag', 'operator', 'selector', 'atrule'],
      style: { color: 'var(--blu2)' },
    },
    {
      types: ['string', 'char', 'attr-value', 'inserted', 'template-string'],
      style: { color: 'var(--grn2)' },
    },
    { types: ['number', 'symbol', 'unit'], style: { color: 'var(--amb2)' } },
    { types: ['function', 'method', 'function-variable'], style: { color: 'var(--blu2)' } },
    {
      types: ['class-name', 'maybe-class-name', 'builtin', 'constant'],
      style: { color: 'var(--amb2)' },
    },
    { types: ['punctuation'], style: { color: 'var(--tx3)' } },
    { types: ['property', 'attr-name', 'variable', 'parameter'], style: { color: 'var(--tx0)' } },
  ],
};

/* one syntax-highlighted line of code (prism), no per-line block wrapper. */
function CodeLine({ text }: { text: string }) {
  return (
    <Highlight code={text} language="tsx" theme={CODE_THEME}>
      {({ tokens, getTokenProps }) => (
        <span className={styles.dcode}>
          {tokens[0]?.map((token, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: single static line, stable order
            <span key={k} {...getTokenProps({ token })} />
          ))}
        </span>
      )}
    </Highlight>
  );
}

/* ---- a real unified-diff parser: `git diff` text → files → hunks → rows ----
   SEAM(#155): DELETE this parser and render the shipped `ReviewPane` `DiffView`
   fed a server pre-structured `SessionDiff` (`packages/db` schema →
   `lib/control-plane-data.ts`) — the server already parses the diff, so the
   client never should. Kept here only while the artifact is a mock string. */
interface DRow {
  kind: 'ctx' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}
interface DHunk {
  header: string;
  rows: DRow[];
}
interface DFile {
  path: string;
  offScope: boolean;
  adds: number;
  dels: number;
  hunks: DHunk[];
}
function parseDiff(src: string): DFile[] {
  const files: DFile[] = [];
  let file: DFile | null = null;
  let hunk: DHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of src.split('\n')) {
    if (raw.startsWith('diff --git')) {
      file = { path: '', offScope: false, adds: 0, dels: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+++ b/')) {
      file.path = raw.slice(6);
      file.offScope = file.path.startsWith('src/auth/');
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('+++ ')) continue;
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: raw, rows: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('+')) {
      hunk.rows.push({ kind: 'add', oldNo: null, newNo, text: raw.slice(1) });
      newNo += 1;
      file.adds += 1;
    } else if (raw.startsWith('-')) {
      hunk.rows.push({ kind: 'del', oldNo, newNo: null, text: raw.slice(1) });
      oldNo += 1;
      file.dels += 1;
    } else {
      hunk.rows.push({ kind: 'ctx', oldNo, newNo, text: raw.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
  }
  return files;
}

/* DIFF VIEW — a real diff renderer over `git diff` text: two line-number gutters,
   per-file counts, syntax highlight, and a line-anchored comment on hover-click
   (GitHub-style) that threads inline AND lands in the chat.
   SEAM(#155): replace with the shipped `ReviewPane` `DiffView`. */
function DiffView({
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
  const files = useMemo(() => parseDiff(artifact.diff ?? ''), [artifact.diff]);
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const totalAdd = files.reduce((n, f) => n + f.adds, 0);
  const totalDel = files.reduce((n, f) => n + f.dels, 0);

  const open = (anchor: string, quote: string) => {
    setOpenAt(anchor);
    setDraft('');
    onDraft({ quote, text: '' }); // mirror into the chat the moment we start
  };
  const close = () => {
    setOpenAt(null);
    setDraft('');
    onDraft(null);
  };
  const submit = (anchor: string, quote: string) => {
    if (draft.trim().length === 0) return;
    onComment(artifact.id, anchor, quote, draft.trim());
    setDraft('');
    setOpenAt(null);
  };

  return (
    <div className={styles.diffv}>
      <div className={styles.diffSummary}>
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <span className={styles.statAdd}>+{totalAdd}</span>
        <span className={styles.statDel}>−{totalDel}</span>
      </div>
      {files.map((file) => (
        <div key={file.path} className={styles.dfile} data-off={file.offScope || undefined}>
          <div className={styles.dfileHead}>
            <span className={styles.dpath}>{file.path}</span>
            {file.offScope ? <span className={styles.doffPill}>off-scope</span> : null}
            <span className={styles.grow} />
            <span className={styles.statAdd}>+{file.adds}</span>
            <span className={styles.statDel}>−{file.dels}</span>
          </div>
          {file.hunks.map((h) => (
            <div key={h.header} className={styles.dhunk}>
              <div className={styles.dhunkHead}>{h.header}</div>
              {h.rows.map((row, ri) => {
                const anchor = `${file.path}:${row.newNo ?? row.oldNo ?? ri}`;
                const rowComments = comments.filter((c) => c.anchor === anchor);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional within a static hunk
                  <div key={ri}>
                    <div className={styles.drow} data-kind={row.kind}>
                      <button
                        type="button"
                        className={styles.dAdd}
                        onClick={() => open(anchor, row.text.trim())}
                        aria-label={`comment on line ${row.newNo ?? row.oldNo}`}
                        title="comment on this line"
                      >
                        <IconCommentPlus size={12} />
                      </button>
                      <span className={styles.dnum}>{row.oldNo ?? ''}</span>
                      <span className={styles.dnum}>{row.newNo ?? ''}</span>
                      <span className={styles.dsign} aria-hidden>
                        {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
                      </span>
                      <CodeLine text={row.text} />
                    </div>
                    {rowComments.map((c) => (
                      <div key={c.id} className={styles.dthread}>
                        <span className={`${styles.face} ${styles.faceHuman}`} aria-hidden>
                          yo
                        </span>
                        <span className={styles.dthreadText}>{c.text}</span>
                      </div>
                    ))}
                    {openAt === anchor ? (
                      <form
                        className={styles.dcompose}
                        onSubmit={(e) => {
                          e.preventDefault();
                          submit(anchor, row.text.trim());
                        }}
                      >
                        <input
                          className={styles.commentInput}
                          // biome-ignore lint/a11y/noAutofocus: focus the line comment the moment it opens
                          autoFocus
                          placeholder={`comment on ${anchor}…`}
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            onDraft({ quote: row.text.trim(), text: e.target.value });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') close();
                          }}
                          {...NO_AUTOFILL}
                        />
                        <button type="submit" className={styles.dcomposeSend}>
                          comment
                        </button>
                      </form>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

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
          <DiffView artifact={active} comments={here} onComment={onComment} onDraft={onDraft} />
        ) : (
          <DocView artifact={active} comments={here} onComment={onComment} onDraft={onDraft} />
        )}
      </div>
      {/* footer status — height-matched to the other bottom bars via --foot-h.
          SEAM(#157): certify ✓ / "awaiting a human" wire to the human
          certification gate (`certified_by`) — the machine never certifies. */}
      <div className={styles.artFoot}>
        {active.mark ? <span className={styles.mark}>{active.mark}</span> : null}
        <span className={styles.artFootStatus}>
          {active.kind === 'diff' ? 'proposed' : active.kind} · draft
        </span>
        <span className={styles.grow} />
        <span className={styles.artFootHint}>
          awaiting a human
          <IconCheck size={11} />
        </span>
      </div>
    </section>
  );
}
