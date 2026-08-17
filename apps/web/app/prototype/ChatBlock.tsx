'use client';

/* CHAT BLOCK — the room's conversation and the ONLY text input. `@mention` an
   agent to delegate. The composer is ONLY chat: it never intercepts a covenant
   act. Steer/interrupt is a STRUCTURED control on the running session
   (ThreadStatus), not inferred from what is typed here (#157 r3).
 *
 * #155 marriage, THROUGH THE CONVERSATION MODEL (conversation-model.ts):
 *   - The feed no longer reads `ChatMsg[]`. It reads a `ConversationModel` — real
 *     ledger `MessageRecord`s and pre-shaped feed `items` — and renders it inside
 *     an `<AttributionLedger>`, the register the shipped `TimelineRow` resolves
 *     every citation against. That interface is the Phase-6 swap seam: a
 *     CRDT-backed impl replaces the model's SOURCE without touching this feed.
 *   - A plain human/agent line renders through the shipped `TimelineRow` (mentions
 *     become typed references, the machine voice register is honoured, the body is
 *     reconciled against the record). A system line renders through `SystemRow`,
 *     its glyph DERIVED from state. The prototype's hand-rolled `ChatMessage`
 *     plain-row + `RichText` regex + `parseDiff` are DELETED.
 *   - A turn stays the design accordion shell (blocked on the live channel #159 —
 *     the prototype's `Turn`/`TurnStep` has no backend), and an inline image stays
 *     a design row. Both are hosted INSIDE this feed beside the shipped rows, which
 *     is why the design feed shell (scroll container, minimap, composer) stays. */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { type EpistemicState, fileText, systemStatement } from '@/src/components/model';
import { AttributionLedger } from '@/src/components/model/ledger';
import { MessageBody } from '@/src/components/primitives/MessageBody';
import { SystemRow } from '@/src/components/timeline/SystemRow';
import { TimelineRow } from '@/src/components/timeline/TimelineRow';
import { type CertifyOutcome, CertifyPassage } from './CertifyPassage';
import { ChatTopBar } from './ChatChrome';
import type { ObjectSpanRequest } from './certify-span';
import { type ConversationItem, type Echo, echoItem, messageBody } from './conversation-model';
import type { ConversationTransport } from './conversation-transport';
import { IconChevron, IconDot } from './icons';
import { MessageText } from './MessageText';
import styles from './prototype.module.css';
import {
  type ChatKind,
  type CommentDraft,
  type DiffLine,
  MENTION_TARGETS,
  NO_AUTOFILL,
  type Selection,
  SLASH_COMMANDS,
  STEP_TAG,
  type TurnData,
  type TurnStep,
} from './types';
import { useConversationModel } from './use-conversation-model';
import type { ConversationDoc } from './yjs-conversation';

/* The honest "conversation not wired" notice's state — a routine `·` system
   notice (a status fact, not a failed action), used when a live room mounts with
   no conversation transport (#183 round-2 SHIP-BLOCKER #3). */
const NOT_DELIVERED_NOTICE: EpistemicState = {
  kind: 'event',
  verification: 'routine',
  owedToViewer: false,
  irreversible: false,
};

/* PRIMITIVE: a stream of diff hunks. Rendered identically whether it has the
   floor or is materialized inside a tree node — that sameness IS the algebra.
   This is the DESIGN TURN's inline edit block (blocked on #159), not the artifact
   diff — the artifact diff renders through the shipped `DiffView` now. */
function DiffLines({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream, index is stable
          key={i}
          className={[
            styles.dline,
            styles[`d_${line.kind}`],
            line.offScope ? styles.offScope : '',
          ].join(' ')}
        >
          <span className={styles.gutter} aria-hidden>
            {line.kind === 'add'
              ? '+'
              : line.kind === 'del'
                ? '−'
                : line.kind === 'file'
                  ? '›'
                  : ' '}
          </span>
          <span className={styles.dtext}>{line.text}</span>
        </div>
      ))}
    </>
  );
}

function stepPreview(s: TurnStep): string {
  if (s.edit) return `${s.edit.file}`;
  if (s.command) return s.command;
  return (s.text ?? '').replace(/[`=]/g, '');
}

/* one step inside an opened turn — full detail (edit block, command, or prose) */
function TurnStepRow({ step }: { step: TurnStep }) {
  return (
    <div className={styles.turnStep}>
      <span className={styles.stepTag} data-step={step.kind}>
        {STEP_TAG[step.kind]}
      </span>
      <span className={styles.stepBody}>
        {step.edit ? (
          <div className={styles.editBlock}>
            <div className={styles.editHead}>
              <span className={styles.editLabel}>edit</span>
              <span className={styles.branch}>{step.edit.file}</span>
            </div>
            <div className={styles.editDiff}>
              <DiffLines lines={step.edit.lines} />
            </div>
          </div>
        ) : step.command ? (
          <pre className={styles.cmdBlock}>{step.command}</pre>
        ) : (
          <MessageText text={step.text ?? ''} />
        )}
      </span>
    </div>
  );
}

/* A TURN — the agent's whole tool-call history for one session turn, folded into
   a skewed accordion. Hover peeks; click opens a scrollable inner pane that is
   itself resizable (drag its bottom edge). This is what keeps the chat uncluttered:
   a hundred tool calls read as ONE row until you want them.
   #151: keep this design shell (blocked on the live channel #159). */
function Turn({ turn }: { turn: TurnData }) {
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(240);
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    const sy = e.clientY;
    const start = h;
    const move = (ev: PointerEvent) => setH(Math.min(560, Math.max(120, start + ev.clientY - sy)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={styles.turn} data-open={open ? 'true' : undefined}>
      <button type="button" className={styles.turnBar} onClick={() => setOpen((o) => !o)}>
        <span className={styles.mark}>~</span>
        <span className={styles.turnSummary}>{turn.summary}</span>
        <span className={styles.grow} />
        <span className={styles.turnMeta}>
          {turn.steps.length} steps · {turn.spend}
        </span>
        <span className={styles.turnGlyph} aria-hidden>
          <IconChevron open={open} />
        </span>
      </button>

      {/* THE MIDDLE — the tool-call history. This is the only part that folds. */}
      {open ? (
        <div className={styles.turnPane} style={{ height: `${h}px` }}>
          <div className={styles.turnScroll}>
            {turn.steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed step list
              <TurnStepRow key={i} step={s} />
            ))}
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pane resize grip */}
          <div className={styles.turnResize} onPointerDown={startResize} aria-hidden />
        </div>
      ) : (
        // the folded, skewed stack — peeks on hover, whole area opens on click
        <button
          type="button"
          className={styles.turnStackBtn}
          onClick={() => setOpen(true)}
          aria-label="open turn history"
        >
          <span className={styles.turnStack} aria-hidden>
            {turn.steps.slice(0, 3).map((s, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed preview list
                key={i}
                className={styles.turnStackRow}
                style={{ ['--i' as string]: i }}
              >
                <span className={styles.stepTag} data-step={s.kind}>
                  {STEP_TAG[s.kind]}
                </span>
                <span className={styles.turnStackText}>{stepPreview(s)}</span>
              </span>
            ))}
          </span>
        </button>
      )}

      {/* THE CONCLUSION — always shown, part of the same thread; only the middle
          above collapses. */}
      {turn.conclusion ? (
        <div className={styles.turnConcl}>
          <span className={styles.mark}>~</span>
          <span className={styles.chatBody}>
            <MessageText text={turn.conclusion.text} />
            {turn.conclusion.reply ? (
              <div className={styles.threadReply}>
                <span className={`${styles.logWho} ${styles.human}`}>
                  {turn.conclusion.reply.who}
                </span>
                <span className={styles.threadText}>{turn.conclusion.reply.text}</span>
              </div>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* an author monogram in the left gutter — groups a message's content under it */
function Avatar({ who, kind }: { who?: string; kind: ChatKind }) {
  if (kind === 'system') {
    return (
      <span className={styles.avatarSys} aria-hidden>
        <IconDot size={7} />
      </span>
    );
  }
  return (
    <span
      className={`${styles.avatar} ${kind === 'human' ? styles.avatarHuman : styles.avatarAgent}`}
      aria-hidden
    >
      {(who ?? '').slice(0, 2)}
    </span>
  );
}

/* A design TURN row — the agent's turn accordion, under its author gutter. Kept
   as the design shell (#159); its conclusion prose renders through the shipped
   `MessageBody` via `MessageText`. */
function TurnRow({ item }: { item: Extract<ConversationItem, { kind: 'turn' }> }) {
  return (
    <div className={styles.chatRow} data-kind="agent">
      <Avatar who={item.who} kind="agent" />
      <div className={styles.chatContent}>
        <div className={styles.chatMeta}>
          <span className={`${styles.chatWho} ${styles.agent}`}>{item.who}</span>
          <span className={styles.chatTime}>{item.at}</span>
        </div>
        <Turn turn={item.turn} />
      </div>
    </div>
  );
}

/* A design INLINE-IMAGE row (a chart/screenshot the agent posted). Kept as the
   design shell — real message attachments are a later lane (#156/attachments) —
   but the prose beside the image renders through the shipped `MessageBody`. */
function ImageRow({ item }: { item: Extract<ConversationItem, { kind: 'image' }> }) {
  const kind: ChatKind = item.authorKind === 'agent' ? 'agent' : 'human';
  return (
    <div className={styles.chatRow} data-kind={kind}>
      <Avatar who={item.who} kind={kind} />
      <div className={styles.chatContent}>
        <div className={styles.chatMeta}>
          <span className={`${styles.chatWho} ${kind === 'agent' ? styles.agent : styles.human}`}>
            {item.who}
          </span>
          <span className={styles.chatTime}>{item.at}</span>
        </div>
        {item.body.length > 0 ? (
          <div className={styles.chatBody}>
            <MessageBody body={item.body} />
          </div>
        ) : null}
        {/* biome-ignore lint/nursery/noImgElement: inline chat image (mock data URI) */}
        <img className={styles.chatImage} src={item.image.src} alt={item.image.alt} />
      </div>
    </div>
  );
}

/* ONE FEED ROW. The `message`/`system` kinds render through the SHIPPED grammar;
   `turn`/`image` are the design shells. Every row is wrapped in a thin element
   carrying the minimap's `data-mm-*` datum, so the design minimap keeps measuring
   the feed regardless of which grammar painted the row. */
function FeedItem({ item }: { item: ConversationItem }) {
  return (
    <div
      className={styles.feedItem}
      data-mm-id={item.id}
      data-mm-kind={item.mm.kind}
      data-mm-who={item.mm.who}
      data-mm-excerpt={item.mm.excerpt}
    >
      {item.kind === 'message' ? (
        <TimelineRow entry={item.entry} />
      ) : item.kind === 'system' ? (
        <SystemRow entry={item.entry} />
      ) : item.kind === 'turn' ? (
        <TurnRow item={item} />
      ) : (
        <ImageRow item={item} />
      )}
    </div>
  );
}

/* CHAT MINIMAP — a VSCode-style scrubber in the chat's right gutter. Each message
   is a proportional tick (width ∝ length, coloured by author); a draggable window
   shows the viewport; click/drag scrubs the thread; hover previews the message;
   ⌘-click bookmarks it. Everything is measured live from the scroll container. */
interface MMTick {
  id: string;
  top: number;
  height: number;
  who: string;
  kind: string;
  excerpt: string;
}
function ChatMinimap({
  scrollRef,
  revision,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  revision: string;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [ticks, setTicks] = useState<MMTick[]>([]);
  const [view, setView] = useState({ top: 0, height: 0, scrollable: false });
  const [hover, setHover] = useState<MMTick | null>(null);
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => new Set());

  const syncView = () => {
    const sc = scrollRef.current;
    const rail = railRef.current;
    if (!sc || !rail) return;
    const total = sc.scrollHeight || 1;
    const H = rail.clientHeight;
    setView({
      top: (sc.scrollTop / total) * H,
      height: Math.max(18, (sc.clientHeight / total) * H),
      scrollable: sc.scrollHeight > sc.clientHeight + 8,
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: remeasure whenever content revision changes
  useEffect(() => {
    const sc = scrollRef.current;
    const rail = railRef.current;
    if (!sc || !rail) return;
    const measure = () => {
      const total = sc.scrollHeight || 1;
      const H = rail.clientHeight;
      const scTop = sc.getBoundingClientRect().top;
      const rows = Array.from(sc.querySelectorAll('[data-mm-id]')) as HTMLElement[];
      setTicks(
        rows.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.dataset.mmId ?? '',
            // a thin tick at the message's proportional position — a clean message
            // map, not a proportional block that reads as a blob for tall turns
            top: ((r.top - scTop + sc.scrollTop) / total) * H,
            height: 3,
            who: el.dataset.mmWho ?? '',
            kind: el.dataset.mmKind ?? 'agent',
            excerpt: (el.dataset.mmExcerpt || el.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 140),
          };
        }),
      );
      syncView();
    };
    measure();
    sc.addEventListener('scroll', syncView, { passive: true });
    return () => sc.removeEventListener('scroll', syncView);
  }, [scrollRef, revision]);

  const scrubTo = (clientY: number) => {
    const rail = railRef.current;
    const sc = scrollRef.current;
    if (!rail || !sc) return;
    const r = rail.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    sc.scrollTop = frac * (sc.scrollHeight - sc.clientHeight);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.metaKey || e.ctrlKey) return; // ⌘-click is a bookmark, handled on the tick
    scrubTo(e.clientY);
    const move = (ev: PointerEvent) => scrubTo(ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const toggleMark = (id: string) =>
    setMarks((m) => {
      const n = new Set(m);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const width = (t: MMTick) => Math.round(Math.min(30, Math.max(7, t.excerpt.length * 0.42)));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrubber rail
    <div
      className={styles.minimap}
      ref={railRef}
      onPointerDown={onPointerDown}
      onPointerLeave={() => setHover(null)}
    >
      {ticks.map((t) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: minimap tick
        <div
          key={t.id}
          className={styles.mmTick}
          data-kind={t.kind}
          data-mark={marks.has(t.id) ? 'true' : undefined}
          style={{ top: `${t.top}px`, height: `${t.height}px`, width: `${width(t)}px` }}
          onPointerEnter={() => setHover(t)}
          onClickCapture={(e) => {
            if (e.metaKey || e.ctrlKey) {
              e.stopPropagation();
              // SEAM(#156): ⌘-click bookmark should persist to the ledger.
              toggleMark(t.id);
            }
          }}
        />
      ))}
      {view.scrollable ? (
        <div
          className={styles.mmView}
          style={{ top: `${view.top}px`, height: `${view.height}px` }}
          aria-hidden
        />
      ) : null}
      {hover ? (
        <div
          className={styles.mmPreview}
          style={{
            top: `${Math.max(0, Math.min(hover.top, (railRef.current?.clientHeight ?? 0) - 96))}px`,
          }}
        >
          <div className={styles.mmPreviewText}>
            {hover.excerpt.length > 120 ? `${hover.excerpt.slice(0, 120)}…` : hover.excerpt}
          </div>
          <div className={styles.mmPreviewMeta}>
            <span
              className={`${styles.face} ${hover.kind === 'human' ? styles.faceHuman : styles.faceAgent}`}
              aria-hidden
            >
              {(hover.who || '··').slice(0, 2)}
            </span>
            <span className={styles.mmPreviewWho}>{hover.who || 'system'}</span>
            <span className={styles.grow} />
            <span className={styles.mmPreviewHint}>⌘-click to bookmark</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* COMPOSER — delta.dev-simple: the input is the last row of the thread. Your
   avatar, a field that blends in, a blinking cursor. No toolbar, no send button.
   Typing `@` or `/` still opens a popover ABOVE the field. Enter sends.
   SEAM(#155): send / `@mention` delegate → a real durable room message. This
   composer is ONLY chat — it does not read the text for covenant cues (#157 r3). */
function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  const slashMatch = /^\/(\S*)$/.exec(value);
  const mentionMatch = /(^|\s)@([\w-]*)$/.exec(value);
  const commands = SLASH_COMMANDS.filter(([c]) =>
    c.slice(1).startsWith(slashMatch?.[1]?.toLowerCase() ?? ''),
  );
  const mentions = MENTION_TARGETS.filter(([n]) =>
    n.startsWith(mentionMatch?.[2]?.toLowerCase() ?? ''),
  );
  const kind =
    slashMatch !== null && commands.length > 0
      ? 'slash'
      : mentionMatch !== null && mentions.length > 0
        ? 'mention'
        : null;
  const list = kind === 'slash' ? commands : kind === 'mention' ? mentions : [];
  const open = kind !== null && dismissed !== value;
  const activeIdx = Math.min(active, Math.max(0, list.length - 1));

  const select = (i: number) => {
    const item = list[i];
    if (!item) return;
    if (kind === 'slash') onChange(`${item[0]} `);
    else {
      const next = mentionMatch
        ? value.slice(0, mentionMatch.index) + (mentionMatch[1] ?? '') + `@${item[0]} `
        : `${value}@${item[0]} `;
      onChange(next);
    }
    setActive(0);
    inputRef.current?.focus();
  };

  return (
    <div className={styles.chatRow} data-kind="human">
      <Avatar who="you" kind="human" />
      <div className={styles.composeWrap}>
        {open ? (
          <div className={styles.popover} role="listbox">
            <div className={styles.popHead}>{kind === 'slash' ? 'commands' : 'reference'}</div>
            {list.map(([a, d], i) => (
              <button
                key={a}
                type="button"
                role="option"
                aria-selected={i === activeIdx}
                className={`${styles.popItem} ${i === activeIdx ? styles.popActive : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => select(i)}
              >
                <span className={kind === 'slash' ? styles.popCmd : styles.mention}>
                  {kind === 'slash' ? a : `@${a}`}
                </span>
                <span className={styles.popDesc}>{d}</span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          className={styles.composeField}
          name="atrium-message"
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the caret at the thread's end IS the affordance
          autoFocus
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            grow(e.target);
          }}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, list.length - 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                select(activeIdx);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(value);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          {...NO_AUTOFILL}
        />
      </div>
    </div>
  );
}

/* the comment being written in the artifact pane, mirrored into the chat live —
   as you type over there, it materialises here as a draft line. */
function DraftComment({ draft }: { draft: CommentDraft }) {
  /* The quote is VERBATIM doc content (a slice of the artifact) → the `fileText`
     content door; the draft text is the viewer's OWN words → the shipped
     `MessageBody`. Same discipline the artifact pane's comment list uses (#158),
     so the live mirror never raw-prints a caller string. */
  const quote = fileText(
    draft.quote.length > 52 ? `${draft.quote.slice(0, 52)}…` : draft.quote,
    'DraftComment quote',
  );
  return (
    <div className={`${styles.chatRow} ${styles.draftRow}`} data-kind="human">
      <Avatar who="you" kind="human" />
      <div className={styles.chatContent}>
        <div className={styles.chatMeta}>
          <span className={`${styles.chatWho} ${styles.human}`}>you</span>
          <span className={styles.draftTag}>commenting…</span>
        </div>
        <div className={styles.draftBody}>
          <span className={styles.draftQuote}>“{quote}”</span>
          {draft.text ? (
            <span className={styles.draftText}>
              <MessageBody body={messageBody(draft.text)} />
            </span>
          ) : (
            <span className={styles.draftPlaceholder}>start typing your comment…</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* who else is typing — multiplayer presence, shown just above the composer.
   SEAM(#156): bind to real room presence. */
function TypingRow({ who }: { who: string }) {
  return (
    <div className={styles.chatRow} data-kind="agent">
      <Avatar who={who} kind="human" />
      <div className={styles.chatContent}>
        <span className={styles.typing}>
          {who} is typing
          <span className={styles.typingDots} aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </span>
      </div>
    </div>
  );
}

/* ── RANGE-SELECT CERTIFY (E8 / #197) ────────────────────────────────────────
 * The opt-in configuration that lets a human certify a SPAN of a message body.
 * Absent (every existing call site) ⇒ the feed renders exactly as before, no
 * affordance. Present ⇒ each message row gains a ✓ toggle that opens the
 * certify-passage surface; the reserved ✓ act is driven through
 * {@link onCertifySpan} (wired to `certifyObjectSpanAction`). The machine never
 * certifies — the hold is the human's act, and the server answer is the only
 * thing the glyph reflects. */
export interface CertifyConfig {
  readonly workspaceSlug: string;
  readonly roomSlug: string;
  /** Who is pressing (the authenticated human). */
  readonly actor: string;
  /**
   * The accepted covenant OBJECT a message's body maps to, or `null` when the
   * surface has none bound (the fixture route). `null` keeps the ✓ disabled — the
   * span still maps and shows, but there is nothing to certify against.
   */
  readonly objectIdFor: (messageId: string) => string | null;
  /** Drives the reserved certify ACT — wired by the caller to `certifyObjectSpanAction`. */
  readonly onCertifySpan: (request: ObjectSpanRequest) => Promise<CertifyOutcome>;
}

/* One message row's certify affordance: a ✓ toggle that reveals the certify
   passage below the row. Kept beside `FeedItem` (a Fragment sibling, no wrapper
   node) so the feed's `[data-mm-id]` structure the minimap measures is unchanged. */
function MessageCertify({
  doc,
  messageId,
  config,
  open,
  onToggle,
}: {
  doc: ConversationDoc;
  messageId: string;
  config: CertifyConfig;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.certifyRowWrap}>
      <button
        type="button"
        className={styles.certifyToggle}
        data-open={open ? 'true' : undefined}
        aria-expanded={open}
        onClick={onToggle}
      >
        certify a passage
      </button>
      {open ? (
        <CertifyPassage
          doc={doc}
          messageId={messageId}
          objectId={config.objectIdFor(messageId)}
          workspaceSlug={config.workspaceSlug}
          roomSlug={config.roomSlug}
          actor={config.actor}
          onCertify={config.onCertifySpan}
        />
      ) : null}
    </div>
  );
}

export function ChatBlock({
  selected,
  echoes,
  draftComment,
  onSay,
  transport,
  liveMount = false,
  certify,
}: {
  selected: Selection;
  echoes: readonly Echo[];
  draftComment: CommentDraft | null;
  onSay: (text: string) => void;
  /**
   * The replication fabric this room's doc joins (#183 F4). When present, the
   * conversation is LIVE: the doc catches up from the stream, and a typed line is
   * appended straight into the converging doc (so a peer sees it and it survives
   * reload) instead of becoming a local `echo`. Omitted on the `/prototype`
   * fixture route, where the composer keeps the local echo behaviour.
   */
  transport?: ConversationTransport;
  /**
   * Whether this is a LIVE room mount (a real control plane / room), as opposed
   * to the `/prototype` fixture demo (#183 round-2 SHIP-BLOCKER #3). On a live
   * mount with NO transport wired, the conversation must NOT seed the mock
   * fixture — presenting mock history on a real room as its live conversation is
   * a lie. The feed renders an honest "not wired yet" notice instead. The real
   * shipped-surface + Electric wiring is the filed follow-up.
   */
  liveMount?: boolean;
  /**
   * Opt-in range-select certify (E8 / #197). When provided, each message row can
   * be expanded into a certify-passage surface where a human selects a span and
   * holds ✓ to drive `certifyObjectSpanAction`. Omitted ⇒ no affordance (the feed
   * is unchanged), which is every current call site.
   */
  certify?: CertifyConfig;
}) {
  // A live room whose conversation source is not wired: no transport, but not the
  // fixture demo either. The feed is honestly empty + a notice, never mock seed.
  const unwired = liveMount && transport === undefined;
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  /* cross-fade the thread on selection change: the old conversation dematerializes
     and the new one materializes in place, so switching threads never snaps. */
  const [shownSel, setShownSel] = useState(selected);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (shownSel.kind === selected.kind && shownSel.id === selected.id) return;
    setFading(true);
    const t = window.setTimeout(() => {
      setShownSel(selected);
      setFading(false);
    }, 170);
    return () => window.clearTimeout(t);
  }, [selected, shownSel]);

  /* SEAM(#155/#183): the conversation, THROUGH the model interface — now read
     live off a Yjs document (`useConversationModel` → `ConversationDoc`). The
     feed renders the same shipped records/entries; the CRDT-backed source swaps
     in without changing anything below, and the feed re-renders as the document
     converges. On the fixture route the doc is seeded from the mock seam, so this
     is byte-identical to the prior `conversationModel(shownSel)`. Echoes
     (locally-sent lines) are the viewer typing — real typed records on the SAME
     register, so they render as shipped rows too. */
  const { model, doc, version, say } = useConversationModel(shownSel, transport, {
    // Live room without a transport ⇒ do NOT seed the mock fixture (honest empty).
    seedFixture: !liveMount,
  });
  /* Which message's certify-passage is open (E8). At most one at a time — the
     certify surface is a focused act, not a per-row toggle grid. */
  const [certifyOpenId, setCertifyOpenId] = useState<string | null>(null);
  const { records, items } = useMemo(() => {
    const echoes_ = echoes.map((echo, index) => echoItem(echo, index, model.room));
    return {
      // Only `said` echoes carry a record; a NOT-delivered notice is not the
      // viewer's speech, so it never enters the attribution ledger.
      records: [...model.records, ...echoes_.flatMap((e) => (e.record ? [e.record] : []))],
      items: [...model.items, ...echoes_.map((e) => e.item)],
    };
  }, [model, echoes]);

  /* keep the input focused: clicking anywhere in the thread (that isn't a control
     or a text selection) returns the caret to the composer. */
  const refocus = (e: React.MouseEvent) => {
    if ((window.getSelection()?.toString().length ?? 0) > 0) return;
    if ((e.target as HTMLElement).closest('button, a, textarea, input')) return;
    inputRef.current?.focus();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-refocus the composer
    <section className={styles.chat} aria-label="conversation" onMouseUp={refocus}>
      <ChatTopBar selected={selected} />
      <ChatMinimap
        scrollRef={logRef}
        // `version` bumps whenever the live doc converges (a remote line arrives),
        // so the minimap remeasures the feed then too, not only on local changes
        // (#183 secondary: minimap re-measure on live model version bump).
        revision={`${shownSel.kind}:${shownSel.id}|${echoes.length}|${draftComment ? draftComment.text.length : -1}|${fading ? 1 : 0}|v${version}`}
      />
      {/* The feed renders inside the register every shipped `TimelineRow` resolves
          its citation against — one ledger for the whole thread. */}
      <AttributionLedger messages={records} room={model.room}>
        <div className={styles.chatLog} ref={logRef}>
          <div className={`${styles.chatConvo} ${fading ? styles.chatConvoOut : ''}`}>
            {items.map((item) =>
              certify && item.kind === 'message' ? (
                <Fragment key={item.id}>
                  <FeedItem item={item} />
                  <MessageCertify
                    doc={doc}
                    messageId={item.id}
                    config={certify}
                    open={certifyOpenId === item.id}
                    onToggle={() =>
                      setCertifyOpenId((current) => (current === item.id ? null : item.id))
                    }
                  />
                </Fragment>
              ) : (
                <FeedItem key={item.id} item={item} />
              ),
            )}
            {/* HONEST UNWIRED STATE (#183 round-2 SHIP-BLOCKER #3). On a live room
                with no conversation transport wired, the feed does not fabricate a
                converging conversation from mock seed — it says, plainly, that the
                live conversation is not yet on this surface. A typed line here is
                a local draft, not delivered (see the composer + MoldingSurface). */}
            {unwired ? (
              <div className={styles.chatRow} data-kind="system">
                <Avatar kind="system" />
                <div className={styles.chatContent}>
                  <SystemRow
                    entry={{
                      type: 'system',
                      id: 'conversation-unwired',
                      at: 'now',
                      statement: systemStatement(
                        'the live conversation is not yet wired to this surface — messages typed here are local drafts, not delivered to the room',
                      ),
                      state: NOT_DELIVERED_NOTICE,
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>
          {/* the comment being composed in the artifact pane, portaled here live */}
          {draftComment ? <DraftComment draft={draftComment} /> : null}
          {/* multiplayer: someone else is typing, right above your input */}
          <TypingRow who="dane" />
          {/* the input is just the next line of the thread — your avatar + a cursor */}
          <Composer
            inputRef={inputRef}
            value={value}
            onChange={setValue}
            onSubmit={() => {
              if (value.trim().length > 0) {
                // LIVE: the typed line enters the converging doc, so a peer sees
                // it and it survives reload (#183 F4). FIXTURE: the local echo
                // path, unchanged (the `/prototype` design demo).
                if (transport) say(value);
                else onSay(value);
                setValue('');
              }
            }}
          />
        </div>
      </AttributionLedger>
    </section>
  );
}
