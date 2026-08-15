'use client';

/* ---------------------------------------------------------------------------
 * ONE AREA THAT MOLDS INTO WHAT NEEDS TO BE SEEN.
 *
 * Not a dashboard of panes — a single terminal/IRC surface. At rest it is the
 * room's log. The moment an agent starts turning a plan into a diff, the SAME
 * area molds: the diff takes the floor and streams in as it is written, the log
 * recedes behind it. When the agent drifts off-scope (the scripted auth-file
 * moment), the surface foregrounds the one thing that matters — a covenant-native
 * "steer" — so the wrong 70% is caught BEFORE it is written, not reviewed after.
 * When it settles it is a `~` draft; only a human hold certifies it `✓`. Nothing
 * here is machine-certified, ever.
 * ------------------------------------------------------------------------- */

import { Highlight, type PrismTheme } from 'prism-react-renderer';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AGENTS, type DiffLine, fmtMicros, INVOICE_DIFF, type StreamState, useMockPRStream } from './mock';
import styles from './prototype.module.css';

/* Keep password managers off the chat field. `data-1p-ignore` is 1Password's own
   opt-out, `data-lpignore` LastPass's; `autoComplete=off` + a non-credential name
   covers the rest. */
const NO_AUTOFILL = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const;

/* ── icons ──────────────────────────────────────────────────────────────
   True SVG marks, currentColor, no ASCII glyphs. Brand logos (Anthropic /
   OpenAI / xAI) are the official paths; the rest are thin-stroke WIRE icons. */
function IconChevron({ open, size = 12 }: { open?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.12s ease' }}>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconPanel({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ transform: open ? undefined : 'scaleX(-1)' }}>
      <path d="M13 6l-5 6 5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCheck({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconWarn({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.4 22.2 20.4H1.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 10v4.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="17.6" r="0.5" fill="currentColor" stroke="currentColor" strokeWidth="0.9" />
    </svg>
  );
}
function IconDot({ size = 8 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" fill="none" aria-hidden>
      <circle cx="4" cy="4" r="2.4" fill="currentColor" />
    </svg>
  );
}
function IconPlay({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 5.2v13.6L18.4 12z" />
    </svg>
  );
}
function IconClose({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconCommentPlus({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 5h16v11H9l-5 4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 8v5M9.5 10.5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function IconBase({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M10 7 6 12l4 5M6 12h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18" cy="12" r="1.7" fill="currentColor" />
    </svg>
  );
}
function IconAnthropic({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  );
}
function IconOpenAI({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}
function IconXai({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M6.469 8.776 16.512 23h-4.464L2.005 8.776zm-.004 7.9 2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764zM22 1l-9.952 14.095-2.233-3.163L17.533 1z" />
    </svg>
  );
}
function IconUpDown({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 10l4-4 4 4M8 14l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconUser({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.5 20c0-3.6 2.9-5.6 6.5-5.6s6.5 2 6.5 5.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function IconSettings({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h8M20 7h-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="15" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.7" />
      <path d="M20 17h-8M4 17h2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9" cy="17" r="2.4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
function IconSignOut({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 4H6v16h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 12h9M16 8l4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* USER BAR — who you are, at the foot of the left pane. Click for the account
   menu (profile / preferences / sign out). This is the prototype's own identity
   affordance, replacing the global top bar. */
function UserBar() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={styles.userBar} ref={wrapRef}>
      {open ? (
        <div className={styles.userMenu} role="menu" aria-label="account">
          <div className={styles.userMenuHead}>
            <span className={`${styles.face} ${styles.faceHuman}`} aria-hidden>
              op
            </span>
            <div className={styles.userMenuId}>
              <span className={styles.userName}>Operator</span>
              <span className={styles.userEmail}>operator@atrium.dev</span>
            </div>
          </div>
          <button type="button" className={styles.userMenuItem} role="menuitem" onClick={() => setOpen(false)}>
            <IconUser size={14} />
            Profile
          </button>
          <button type="button" className={styles.userMenuItem} role="menuitem" onClick={() => setOpen(false)}>
            <IconSettings size={14} />
            Preferences
          </button>
          <div className={styles.userMenuDiv} />
          <button type="button" className={`${styles.userMenuItem} ${styles.userMenuDanger}`} role="menuitem" onClick={() => setOpen(false)}>
            <IconSignOut size={14} />
            Sign out
          </button>
        </div>
      ) : null}
      <button type="button" className={styles.userBtn} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className={`${styles.face} ${styles.faceHuman}`} aria-hidden>
          op
        </span>
        <span className={styles.userMeta}>
          <span className={styles.userName}>Operator</span>
          <span className={styles.userSub}>you · online</span>
        </span>
        <span className={styles.grow} />
        <span className={styles.userCaret}>
          <IconUpDown size={12} />
        </span>
      </button>
    </div>
  );
}

/* A node in the tree. Selecting one molds the center to its associated block. */
type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'plan'; id: string }
  | { kind: 'session'; id: string };

/* The right split pane HOSTS artifacts. An artifact's KIND selects its renderer
   (diff → a real git-diff viewer, doc/plan → markdown); switching artifacts is
   switching what's hosted, never picking a renderer type. */
type ArtifactKind = 'diff' | 'doc' | 'plan';
interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string; // the artifact's own name (a branch, a doc, a plan)
  sub: string; // a short qualifier shown beside the title
  mark?: '~' | '✓';
  diff?: string; // a unified git diff, when kind === 'diff'
  md?: string; // markdown source, when kind === 'doc' | 'plan'
}
/* A comment is ANCHORED — to a diff line (`path:newNo`) or to a prose quote —
   so it lives where it was made, not in an undifferentiated pile at the bottom. */
interface Comment {
  id: number;
  artifactId: string;
  anchor: string;
  quote: string;
  text: string;
}
/* a comment being composed — portaled live into the chat as the user types. */
interface CommentDraft {
  quote: string;
  text: string;
}

/* Panes are freely positioned rects the user can move (drag the bar) and resize
   (drag the bottom-right corner) — a lightweight windowing model over the canvas.
   Locking a pane pins its rect. */
/* the snap grid — pane rects round to this on move/resize. */


/** hold-to-arm: the covenant idiom — a deliberate press, not a click, commits. */

/* the diff lines belonging to one file — the drill-in slice of the stream */

const PHASE_LABEL: Record<string, string> = {
  planning: 'reading',
  writing: 'writing',
  testing: 'running tests',
  proposed: 'proposed',
  steering: 'paused — you have the floor',
};

/* Which lab a model/harness belongs to — so the tree can show one small mark
   instead of "opus-5 · claude-code". */
type Provider = 'anthropic' | 'openai' | 'xai' | 'other';
function providerOf(name: string): Provider {
  const m = name.toLowerCase();
  if (/opus|sonnet|claude|haiku|fable/.test(m)) return 'anthropic';
  if (/gpt|codex|o[134]\b/.test(m)) return 'openai';
  if (/grok/.test(m)) return 'xai';
  return 'other';
}
function ProviderMark({ model, title }: { model: string; title?: string }) {
  const p = providerOf(model);
  const cls =
    p === 'anthropic'
      ? styles.pAnthropic
      : p === 'openai'
        ? styles.pOpenai
        : p === 'xai'
          ? styles.pXai
          : styles.pOther;
  return (
    <span className={`${styles.pMark} ${cls}`} title={title ?? model} aria-label={p}>
      {p === 'anthropic' ? <IconAnthropic /> : p === 'openai' ? <IconOpenAI /> : p === 'xai' ? <IconXai /> : <IconDot size={9} />}
    </span>
  );
}

export function MoldingSurface() {
  const [steering, setSteering] = useState(false);
  const [redirect, setRedirect] = useState('');
  const [sent, setSent] = useState(false);
  const [echoes, setEchoes] = useState<readonly string[]>([]);
  /* WHERE YOU ARE in the tree — which thread the main view shows. */
  const [selected, setSelected] = useState<Selection>({ kind: 'session', id: 's-live' });
  /* the tree is a collapsible, resizable left pane — its width is remembered. */
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [sideW, setSideW] = useState(300);
  useEffect(() => {
    const saved = Number(localStorage.getItem('atrium-side-w'));
    if (saved >= 200 && saved <= 620) setSideW(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem('atrium-side-w', String(sideW));
  }, [sideW]);
  const startSideResize = (e: React.PointerEvent) => {
    const sx = e.clientX;
    const start = sideW;
    const move = (ev: PointerEvent) => setSideW(Math.min(620, Math.max(200, start + ev.clientX - sx)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /* the right split — an artifact host (diff / plan / doc) you comment on. */
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<string>(ARTIFACTS[0]!.id);
  const [chatFrac, setChatFrac] = useState(0.5);
  const [comments, setComments] = useState<readonly Comment[]>([]);
  /* the in-progress comment, portaled live into the chat while it's composed. */
  const [draftComment, setDraftComment] = useState<CommentDraft | null>(null);
  const startColResize = (e: React.PointerEvent) => {
    const row = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!row) return;
    const move = (ev: PointerEvent) =>
      setChatFrac(Math.min(0.8, Math.max(0.25, (ev.clientX - row.left) / row.width)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const stream = useMockPRStream(steering);
  const concern = !steering && stream.concern !== null;

  /* The chat is the only input. A message that @-addresses an agent is a
     delegation; anything else is just said in the room. "@hexi stop" steers. */
  const say = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) return;
    const low = text.toLowerCase();
    const isDelegation = text.startsWith('@') || /^(hexi|mira|vale|dane|iris|omar|noor)\b/.test(low);
    setEchoes((e) => [...e, isDelegation ? `→ ${text}` : text]);
    if (/hexi/.test(low) && /(stop|drop|steer|halt|pause)/.test(low)) {
      setSteering(true);
      setSent(true);
    }
  };

  /* commenting on an artifact anchors the note there AND appends it to the thread
     in real time — the anchor (a diff line or a quote) travels with it. */
  const addComment = (artifactId: string, anchor: string, quote: string, text: string) => {
    setComments((c) => [...c, { id: c.length + 1, artifactId, anchor, quote, text }]);
    const q = quote.length > 46 ? `${quote.slice(0, 46)}…` : quote;
    setEchoes((e) => [...e, `💬 ${anchor} · “${q}” — ${text}`]);
    setDraftComment(null); // the live draft becomes a permanent line
  };

  return (
    <div className={styles.surface}>
      {/* the tree toggle floats at the top-left — no wasted rail when collapsed */}
      <button
        type="button"
        className={styles.railToggle}
        onClick={() => setSideCollapsed((c) => !c)}
        aria-label={sideCollapsed ? 'show threads' : 'hide threads'}
        title={sideCollapsed ? 'show threads' : 'hide threads'}
      >
        <IconPanel open={!sideCollapsed} />
      </button>

      {/* the artifact toggle floats at the top-right, mirroring the tree toggle */}
      <button
        type="button"
        className={`${styles.artToggle} ${artifactOpen ? styles.artToggleOn : ''}`}
        onClick={() => setArtifactOpen((o) => !o)}
        aria-pressed={artifactOpen}
        aria-label={artifactOpen ? 'close artifact' : 'open artifact'}
        title={artifactOpen ? 'close artifact' : 'open artifact (PR · diff · plan)'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M14 4v16" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>

      {/* LEFT — the process tree, gone entirely when collapsed, resizable when open. */}
      {sideCollapsed ? null : (
        <>
          <aside className={styles.side} style={{ width: `${sideW}px` }}>
            <div className={styles.sideHead}>
              <span className={styles.sideTitle}>threads</span>
            </div>
            <div className={styles.sideBody}>
              <NavTree stream={stream} selected={selected} onSelect={setSelected} concern={concern} />
            </div>
            <UserBar />
          </aside>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pane width resizer */}
          <div className={styles.sideResizer} onPointerDown={startSideResize} role="separator" aria-orientation="vertical" />
        </>
      )}

      {/* MAIN — one LLM thread; the L/R gutters are room for what comes next
          (subagents, comments, a timeline/minimap). */}
      <main className={styles.thread} data-split={artifactOpen ? 'true' : undefined}>
        <div className={styles.split}>
          <div className={styles.chatCol} style={{ flexGrow: artifactOpen ? chatFrac : 1 }}>
            <ChatBlock
              selected={selected}
              echoes={echoes}
              draftComment={draftComment}
              steering={steering && !sent}
              redirect={redirect}
              setRedirect={setRedirect}
              onSteerSend={() => setSent(true)}
              onSay={say}
            />
            {/* the status strip is the CHAT's footer — contained to this column,
                it stops at the split rather than running under the artifact. */}
            <ThreadStatus selected={selected} stream={stream} />
          </div>
          {artifactOpen ? (
            <>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: split resizer */}
              <div className={styles.colResizer} onPointerDown={startColResize} role="separator" aria-orientation="vertical" />
              <div className={styles.artifactCol} style={{ flexGrow: 1 - chatFrac }}>
                <ArtifactPane
                  artifacts={ARTIFACTS}
                  activeId={activeArtifact}
                  onSelectArtifact={setActiveArtifact}
                  comments={comments}
                  onComment={addComment}
                  onDraft={setDraftComment}
                />
              </div>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/* PRIMITIVE: a stream of diff hunks. Rendered identically whether it has the
   floor or is materialized inside a tree node — that sameness IS the algebra. */
function DiffLines({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream, index is stable
          key={i}
          className={[styles.dline, styles[`d_${line.kind}`], line.offScope ? styles.offScope : ''].join(
            ' ',
          )}
        >
          <span className={styles.gutter} aria-hidden>
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'file' ? '›' : ' '}
          </span>
          <span className={styles.dtext}>{line.text}</span>
        </div>
      ))}
    </>
  );
}

/* BLOCK: call = presence + live-time + mic, as a persistent-minimal strip. It
   stays put while other compositions take the floor above it (the user's choice)
   and never becomes primary unless summoned. */

/* BLOCK: tree = STREAM(NEST(node)), now COMPOSED. The live session OVERLAYs call
   presence (tree×call) and FOLDs its own developing diff — peek on hover,
   materialize on click (tree×diff) — reusing the DiffLines primitive above. */
/* NAV: the tree you move through. Selecting a node is what molds the center —
   no mode is typed. The live session keeps its call-presence OVERLAY (tree×call)
   and pulse, so structure and liveness read at a glance. */
function NavTree({
  stream,
  selected,
  onSelect,
  concern,
}: {
  stream: StreamState;
  selected: Selection;
  onSelect: (s: Selection) => void;
  concern: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (k: string) =>
    setCollapsed((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const inCall = ['EB', 'OP'];
  const on = (kind: Selection['kind'], id: string) => selected.kind === kind && selected.id === id;

  /* The flat list of VISIBLE nodes, in render order, for single-tab-stop arrow
     nav. ↑↓ move selection (which also molds the chat/graph), ←→ collapse/expand
     or step to parent/child, enter focuses. */
  interface FlatNode {
    sel: Selection;
    key: string;
    hasChildren: boolean;
    expanded: boolean;
    parentKey: string | null;
  }
  const flat: FlatNode[] = [];
  for (const agent of AGENTS) {
    const aKey = `agent:${agent.id}`;
    const aOpen = !collapsed.has(agent.id);
    flat.push({ sel: { kind: 'agent', id: agent.id }, key: aKey, hasChildren: agent.plans.length > 0, expanded: aOpen, parentKey: null });
    if (!aOpen) continue;
    for (const plan of agent.plans) {
      const pKey = `plan:${plan.id}`;
      const pOpen = !collapsed.has(plan.id);
      flat.push({ sel: { kind: 'plan', id: plan.id }, key: pKey, hasChildren: plan.sessions.length > 0, expanded: pOpen, parentKey: aKey });
      if (!pOpen) continue;
      for (const s of plan.sessions) {
        flat.push({ sel: { kind: 'session', id: s.id }, key: `session:${s.id}`, hasChildren: false, expanded: false, parentKey: pKey });
      }
    }
  }
  const curIdx = flat.findIndex((n) => n.key === `${selected.kind}:${selected.id}`);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (flat.length === 0) return;
    const i = curIdx < 0 ? 0 : curIdx;
    const node = flat[i];
    if (!node) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        onSelect(flat[Math.min(i + 1, flat.length - 1)]?.sel ?? node.sel);
        break;
      case 'ArrowUp':
        e.preventDefault();
        onSelect(flat[Math.max(i - 1, 0)]?.sel ?? node.sel);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (node.hasChildren && !node.expanded) toggle(node.sel.id);
        else if (node.hasChildren && node.expanded && i + 1 < flat.length) onSelect(flat[i + 1]!.sel);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (node.hasChildren && node.expanded) toggle(node.sel.id);
        else if (node.parentKey) {
          const p = flat.find((n) => n.key === node.parentKey);
          if (p) onSelect(p.sel);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(node.sel);
        break;
      default:
        break;
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: single-tab-stop tree pattern
    <nav
      className={styles.nav}
      aria-label="agents, plans and sessions"
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {AGENTS.map((agent) => {
        const aOpen = !collapsed.has(agent.id);
        const spend = agent.plans.reduce((s, p) => s + p.spentMicros, 0);
        return (
          <div key={agent.id}>
            <div className={`${styles.navRow} ${styles.tAgent} ${on('agent', agent.id) ? styles.navOn : ''}`}>
              <button className={styles.twisty} type="button" onClick={() => toggle(agent.id)} aria-label={aOpen ? 'collapse' : 'expand'}>
                <IconChevron open={aOpen} />
              </button>
              <button className={styles.navMain} type="button" onClick={() => onSelect({ kind: 'agent', id: agent.id })}>
                <span className={styles.tGlyphAgent}>
                  <ProviderMark model={agent.model} />
                </span>
                <span className={styles.tName}>{agent.name}</span>
                <span className={styles.tHandle}>@{agent.name}</span>
                <span className={styles.grow} />
                <span className={styles.tDim}>{fmtMicros(spend)}</span>
                <span className={styles.tRoom}>#{agent.room}</span>
              </button>
            </div>

            {aOpen
              ? agent.plans.map((plan) => {
                  const pOpen = !collapsed.has(plan.id);
                  const unfunded = plan.drawsCeiling === null;
                  const over = plan.drawsCeiling !== null && plan.drawsUsed > plan.drawsCeiling;
                  const draws = unfunded
                    ? `${plan.drawsUsed} draws · unfunded`
                    : `${plan.drawsUsed}/${plan.drawsCeiling} draws`;
                  return (
                    <div key={plan.id}>
                      <div className={`${styles.navRow} ${styles.tPlan} ${on('plan', plan.id) ? styles.navOn : ''}`}>
                        <button className={styles.twisty} type="button" onClick={() => toggle(plan.id)} aria-label={pOpen ? 'collapse' : 'expand'}>
                          <IconChevron open={pOpen} />
                        </button>
                        <button className={styles.navMain} type="button" onClick={() => onSelect({ kind: 'plan', id: plan.id })}>
                          <span className={styles.mark}>~</span>
                          <span className={styles.tName}>{plan.title}</span>
                          <span className={`${styles.chip} ${over || unfunded ? styles.chipWarn : ''}`}>{draws}</span>
                          <span className={styles.grow} />
                          <span className={styles.tDim}>
                            {fmtMicros(plan.spentMicros)}
                            {plan.budgetMicros !== null ? ` / ${fmtMicros(plan.budgetMicros)}` : ''}
                          </span>
                        </button>
                      </div>

                      {pOpen ? (
                        <div className={styles.tSessionGroup}>
                          {plan.sessions.map((session) => {
                            const liveHexi = session.id === 's-live';
                            const running = session.status === 'running';
                            const needsYou = liveHexi && concern;
                            const statusLabel = liveHexi ? PHASE_LABEL[stream.phase] ?? stream.phase : session.status;
                            return (
                              <button
                                key={session.id}
                                type="button"
                                className={[
                                  styles.navRow,
                                  styles.tSession,
                                  on('session', session.id) ? styles.navOn : '',
                                  needsYou ? styles.navAlert : '',
                                ].join(' ')}
                                onClick={() => onSelect({ kind: 'session', id: session.id })}
                              >
                                <span className={styles.tSessionMain}>
                                  {needsYou ? (
                                    <span className={styles.warnGlyph} aria-hidden><IconWarn /></span>
                                  ) : session.certified ? (
                                    <span className={styles.markOk} title="human-certified"><IconCheck /></span>
                                  ) : running ? (
                                    <span className={`${styles.tRunDot} atr-pulse`} aria-hidden title="running" />
                                  ) : (
                                    <span className={styles.tGlyphIdle} aria-hidden><IconDot size={6} /></span>
                                  )}
                                  <span className={styles.branch}>{session.branch}</span>
                                  {liveHexi ? (
                                    <span className={styles.tCall} title="in the call">
                                      {inCall.map((p) => (
                                        <span key={p} className={styles.tCallFace}>{p}</span>
                                      ))}
                                    </span>
                                  ) : null}
                                </span>
                                <span className={styles.tSub}>
                                  {statusLabel}
                                  {session.ctxPct !== null ? ` · ctx ${Math.round(session.ctxPct * 100)}%` : ''}
                                  {` · ${fmtMicros(session.spendMicros)} · ${session.ageMin}m`}
                                  {session.certified ? ' · certified' : ''}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </nav>
  );
}

/* CENTER when a plan is selected. */

/* Rich text: `backtick` → inline code, @mention → handle, ==text== → highlight. */
function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /(`[^`]+`|@[\w-]+|==[^=]+==)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > last) parts.push(<span key={last}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith('`')) {
      parts.push(
        <code key={m.index} className={styles.inlineCode}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('==')) {
      parts.push(
        <mark key={m.index} className={styles.hl}>
          {tok.slice(2, -2)}
        </mark>,
      );
    } else {
      parts.push(
        <span key={m.index} className={styles.mention}>
          {tok}
        </span>,
      );
    }
    last = m.index + tok.length;
    m = re.exec(text);
  }
  if (last < text.length) parts.push(<span key={last}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

type ChatKind = 'system' | 'agent' | 'human';
type StepKind = 'thought' | 'search' | 'read' | 'edit' | 'command' | 'output' | 'message';
const STEP_TAG: Record<StepKind, string> = {
  thought: 'think',
  search: 'grep',
  read: 'read',
  edit: 'edit',
  command: 'run',
  output: 'out',
  message: 'says',
};
interface TurnStep {
  kind: StepKind;
  text?: string;
  edit?: { file: string; lines: readonly DiffLine[] };
  command?: string;
}
interface TurnData {
  summary: string;
  spend: string;
  steps: readonly TurnStep[];
  /** the turn's final message — ALWAYS shown, connected to the thread; the middle
      (steps) is what folds, not this. */
  conclusion?: { text: string; reply?: { who: string; text: string } };
}
interface ChatMsg {
  id: string;
  time: string;
  kind: ChatKind;
  who?: string;
  text?: string;
  /** an agent TURN — its whole tool-call history, folded into one accordion */
  turn?: TurnData;
  /** an inline image (screenshot, chart, paste) */
  image?: { src: string; alt: string };
  /** a threaded reply pinned under this message, on a specific span */
  reply?: { who: string; text: string };
}

/* a mock inline chart (data-URI SVG, WIRE palette) so images render with no network */
const MOCK_CHART = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="330" height="132" viewBox="0 0 330 132">' +
    '<rect width="330" height="132" rx="4" fill="#0d1010" stroke="#2c3335"/>' +
    '<text x="12" y="20" fill="#7e8982" font-family="monospace" font-size="10">rerank p95 latency (ms)</text>' +
    '<line x1="30" y1="60" x2="250" y2="60" stroke="#c99a3f" stroke-dasharray="4 4"/>' +
    '<text x="256" y="63" fill="#c99a3f" font-family="monospace" font-size="9">40 target</text>' +
    '<rect x="46" y="38" width="56" height="72" fill="#3f464b"/>' +
    '<text x="74" y="124" fill="#7e8982" font-family="monospace" font-size="9" text-anchor="middle">before 62</text>' +
    '<rect x="150" y="66" width="56" height="44" fill="#5cb27a"/>' +
    '<text x="178" y="124" fill="#9bb3a0" font-family="monospace" font-size="9" text-anchor="middle">after 38</text>' +
    '</svg>',
)}`;

const EDIT_INVOICE: readonly DiffLine[] = [
  { kind: 'del', text: 'let total = 0' },
  { kind: 'add', text: 'const totals = new StreamingTotal()' },
  { kind: 'add', text: 'for (const line of invoice.lines) totals.add(line.amountMicros)' },
  { kind: 'ctx', text: 'return totals.settle()' },
];
const CONVO_LIVE: readonly ChatMsg[] = [
  { id: 'c1', time: '14:01', kind: 'system', text: 'plan opened · streaming invoice totals · 3/8 draws' },
  { id: 'c2', time: '14:03', kind: 'human', who: 'you', text: 'can we do streaming totals without a running mutable? keep it in `billing`' },
  {
    id: 'c3',
    time: '14:05',
    kind: 'agent',
    who: 'hexi',
    turn: {
      summary: 'streaming invoice totals · edited 1 file',
      spend: '$0.34',
      steps: [
        { kind: 'thought', text: 'the running `let total` mutates across the loop, so the fold is not pure' },
        { kind: 'search', text: 'grep `total` across `src/billing` — 3 hits' },
        { kind: 'read', text: '`src/billing/invoice.ts` · 142 lines' },
        { kind: 'read', text: '`src/billing/ledger.ts` · 88 lines' },
        {
          kind: 'thought',
          text: 'considered: running mutable · `reduce()` · a `StreamingTotal` accumulator. reduce() re-allocates each step; the accumulator amortizes and stays testable',
        },
        { kind: 'edit', edit: { file: 'src/billing/invoice.ts', lines: EDIT_INVOICE } },
        { kind: 'command', command: '$ pnpm test billing 2>&1 | tail -3' },
        { kind: 'output', text: '✓ 47 passed · 2 new · 1.2s' },
      ],
      conclusion: {
        text: 'done — totals stream without a mutable, and ==a repeated fold over unchanged lines is a pure cache hit==. all 47 tests pass, incl. two new ones.',
        reply: { who: 'you', text: 'do we have a benchmark proving this?' },
      },
    },
  },
  {
    id: 'c5',
    time: '14:12',
    kind: 'system',
    text: '⚠ drift · touching `src/auth/session.ts` — outside `billing` scope',
  },
];
const CONVO_SCOUT: readonly ChatMsg[] = [
  { id: 'sc1', time: '13:20', kind: 'system', text: 'plan opened · invoice schema scout' },
  {
    id: 'sc2',
    time: '13:24',
    kind: 'agent',
    who: 'hexi',
    turn: {
      summary: 'map the invoice schema · read 4 files',
      spend: '$0.12',
      steps: [
        { kind: 'read', text: '`src/billing/invoice.ts` · 142 lines' },
        { kind: 'read', text: '`src/billing/schema.ts` · 60 lines' },
        { kind: 'search', text: 'grep `SummaryCache` — 0 hits' },
        { kind: 'output', text: 'schema is flat; no cache layer yet' },
      ],
      conclusion: { text: 'schema mapped — a `SummaryCache` keyed by a generation counter would fit. handing to the build session.' },
    },
  },
  { id: 'sc3', time: '13:41', kind: 'system', text: '✓ settled · certified by you' },
];
const CONVO_RANK: readonly ChatMsg[] = [
  { id: 'r1', time: '11:02', kind: 'system', text: 'plan opened · re-rank on embeddings · 6/6 draws' },
  { id: 'r2', time: '11:05', kind: 'human', who: 'you', text: 'rerank the top-50 by cosine, keep p95 under 40ms' },
  {
    id: 'r3',
    time: '11:08',
    kind: 'agent',
    who: 'mira',
    turn: {
      summary: 'embedding rerank · edited 2 files',
      spend: '$2.91',
      steps: [
        { kind: 'thought', text: 'batch the embedding calls; cache by doc id' },
        { kind: 'search', text: 'grep `rerank` across `src/search`' },
        { kind: 'edit', edit: { file: 'src/search/rerank.ts', lines: [{ kind: 'add', text: 'const scored = embed(batch).map(cosine)' }] } },
        { kind: 'command', command: '$ pnpm bench rerank' },
        { kind: 'output', text: 'p95 38ms · +6% ndcg' },
      ],
      conclusion: { text: 'reranker in place — ==p95 38ms, ndcg +6%==. context is at 71%, may compact soon.' },
    },
  },
  { id: 'r4', time: '11:15', kind: 'human', who: 'you', text: 'do we have a benchmark proving this?' },
  {
    id: 'r5',
    time: '11:16',
    kind: 'agent',
    who: 'mira',
    text: 'yes — `after` sits under the 40ms line:',
    image: { src: MOCK_CHART, alt: 'rerank p95 latency: before 62ms, after 38ms, 40ms target' },
  },
];
const CONVO_AUDIT: readonly ChatMsg[] = [
  { id: 'au1', time: '13:55', kind: 'system', text: 'plan opened · sweep env reads · unfunded' },
  {
    id: 'au2',
    time: '13:58',
    kind: 'agent',
    who: 'vale',
    turn: {
      summary: 'sweep `process.env` reads',
      spend: '$0.04',
      steps: [
        { kind: 'search', text: 'grep `process.env` across `src/**`' },
        { kind: 'output', text: '60/60 reads found · 0 hallucinations' },
      ],
      conclusion: { text: '60 env reads enumerated; ==3 are unguarded==. want a ticket per unguarded read?' },
    },
  },
];
const CONVERSATIONS: Record<string, readonly ChatMsg[]> = {
  's-live': CONVO_LIVE,
  's-scout': CONVO_SCOUT,
  's-rank': CONVO_RANK,
  's-audit': CONVO_AUDIT,
};

/* the chat follows the tree: a session shows its own thread; a plan or agent
   shows their primary session's thread. */
function conversationFor(sel: Selection): readonly ChatMsg[] {
  if (sel.kind === 'session') return CONVERSATIONS[sel.id] ?? CONVO_LIVE;
  const plan =
    sel.kind === 'plan'
      ? AGENTS.flatMap((a) => a.plans).find((p) => p.id === sel.id)
      : AGENTS.find((a) => a.id === sel.id)?.plans[0];
  const sid = plan?.sessions[0]?.id;
  return (sid ? CONVERSATIONS[sid] : undefined) ?? CONVO_LIVE;
}

/* the session (and its agent) the thread is currently on — a plan/agent resolves
   to its primary session. */
function sessionFor(sel: Selection) {
  for (const agent of AGENTS) {
    for (const plan of agent.plans) {
      for (const session of plan.sessions) {
        if (sel.kind === 'session' && session.id === sel.id) return { agent, session };
      }
    }
  }
  const plan =
    sel.kind === 'plan'
      ? AGENTS.find((a) => a.plans.some((p) => p.id === sel.id))?.plans.find((p) => p.id === sel.id)
      : AGENTS.find((a) => a.id === sel.id)?.plans[0];
  const agent = AGENTS.find((a) => a.plans.includes(plan as (typeof a.plans)[number]));
  const session = plan?.sessions[0];
  return agent && session ? { agent, session } : { agent: AGENTS[0]!, session: AGENTS[0]!.plans[0]!.sessions[0]! };
}

/* the thread's identity — its title and the room it lives in. */
function threadHeadFor(sel: Selection): { title: string; sub: string } {
  const { agent, session } = sessionFor(sel);
  const plan = agent.plans.find((p) => p.sessions.some((s) => s.id === session.id)) ?? agent.plans[0];
  return { title: plan?.title ?? session.branch, sub: `#${agent.room}` };
}

/* who is on this thread — the human, the agents that have spoken, plus the live
   collaborator. Derived from the conversation, so avatars match the room. */
interface Participant {
  who: string;
  kind: ChatKind;
}
function participantsFor(sel: Selection): Participant[] {
  const seen = new Map<string, ChatKind>();
  seen.set('you', 'human');
  for (const m of conversationFor(sel)) {
    if (m.kind === 'system' || !m.who) continue;
    if (!seen.has(m.who)) seen.set(m.who, m.kind);
  }
  seen.set('dane', 'human'); // the collaborator currently typing
  return [...seen].map(([who, kind]) => ({ who, kind }));
}

/* SHARE — invite by email or hand out a link. A popover off the top bar; the
   invite list and copy state are local (a prototype of the real share flow). */
function SharePopover({ people, onClose }: { people: readonly Participant[]; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [invited, setInvited] = useState<readonly string[]>([]);
  const [copied, setCopied] = useState(false);
  const link = 'https://atrium.dev/t/streaming-invoice-totals#k=9f3ac1';
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const copy = () => {
    navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };
  return (
    <div className={styles.sharePop} role="dialog" aria-label="share this thread">
      <div className={styles.shareHead}>
        <span className={styles.shareTitle}>Share this thread</span>
        <button type="button" className={styles.shareClose} onClick={onClose} aria-label="close">
          <IconClose />
        </button>
      </div>
      <form
        className={styles.shareInvite}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setInvited((v) => [...v, email]);
          setEmail('');
        }}
      >
        <input
          className={styles.shareInput}
          type="email"
          placeholder="invite by email…"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          {...NO_AUTOFILL}
        />
        <button type="submit" className={styles.shareInviteBtn} disabled={!valid}>
          Invite
        </button>
      </form>
      <div className={styles.shareList}>
        {people.map((p, i) => (
          <div key={p.who} className={styles.shareRow}>
            <span className={`${styles.face} ${p.kind === 'human' ? styles.faceHuman : styles.faceAgent}`} aria-hidden>
              {p.who.slice(0, 2)}
            </span>
            <span className={styles.shareName}>{p.who === 'you' ? 'you' : p.who}</span>
            <span className={styles.grow} />
            <span className={styles.shareRole}>{i === 0 ? 'owner' : p.kind === 'agent' ? 'agent' : 'editor'}</span>
          </div>
        ))}
        {invited.map((e) => (
          <div key={e} className={styles.shareRow}>
            <span className={`${styles.face} ${styles.facePending}`} aria-hidden>
              @
            </span>
            <span className={styles.shareName}>{e}</span>
            <span className={styles.grow} />
            <span className={styles.shareRolePending}>invited</span>
          </div>
        ))}
      </div>
      <div className={styles.shareLink}>
        <input className={styles.shareLinkInput} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className={styles.shareCopy} onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}

/* CHAT TOP BAR — the thread's header: its title, the faces of everyone on it, and
   share. Contained to the chat column, sharing the chat's L/R gutters. */
function ChatTopBar({ selected }: { selected: Selection }) {
  const head = threadHeadFor(selected);
  const people = participantsFor(selected);
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <div className={styles.chatTop}>
      <div className={styles.chatTopId}>
        <span className={styles.chatTopName}>{head.title}</span>
        <span className={styles.chatTopSub}>{head.sub}</span>
      </div>
      <span className={styles.grow} />
      <div className={styles.chatFaces}>
        {people.map((p) => (
          <span
            key={p.who}
            className={`${styles.face} ${p.kind === 'human' ? styles.faceHuman : styles.faceAgent}`}
            title={p.who}
            aria-label={p.who}
          >
            {p.who.slice(0, 2)}
          </span>
        ))}
      </div>
      <div className={styles.shareWrap}>
        <button
          type="button"
          className={`${styles.shareBtn} ${shareOpen ? styles.shareBtnOn : ''}`}
          onClick={() => setShareOpen((o) => !o)}
          aria-expanded={shareOpen}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="18" cy="5" r="2.6" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="6" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="18" cy="19" r="2.6" stroke="currentColor" strokeWidth="1.7" />
            <path d="M8.3 10.8l7.4-4.3M8.3 13.2l7.4 4.3" stroke="currentColor" strokeWidth="1.7" />
          </svg>
          share
        </button>
        {shareOpen ? <SharePopover people={people} onClose={() => setShareOpen(false)} /> : null}
      </div>
    </div>
  );
}

/* THREAD STATUS BAR — the bottom strip: branch · base · diff · model · host · run.
   Sits inside the thread, so it shares the chat's L/R gutters. */
function ThreadStatus({ selected, stream }: { selected: Selection; stream: StreamState }) {
  const { agent, session } = sessionFor(selected);
  const live = session.id === 's-live';
  const added = live ? stream.added : Math.round(session.spendMicros / 90_000) + 3;
  const removed = live ? stream.removed : (session.ageMin % 4) + 1;
  const branch = session.branch.split('/').pop() ?? session.branch;
  const running = session.status === 'running';
  return (
    <footer className={styles.status}>
      <span className={styles.statItem}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="18" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.8" />
          <path d="M6 8.4v7.2M18 8.4c0 4-4 4-8.6 4.2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        <span className={styles.statBranch}>{branch}</span>
      </span>
      <span className={styles.statSep} aria-label="based on">
        <IconBase size={13} />
      </span>
      <span className={styles.statDim}>main</span>
      <span className={styles.statDiff}>
        <span className={styles.statAdd}>+{added}</span>
        <span className={styles.statDel}>−{removed}</span>
      </span>
      {running ? <span className={`${styles.statDot} atr-pulse`} aria-hidden /> : null}
      <span className={styles.grow} />
      <span className={styles.statItem}>
        <ProviderMark model={session.model} />
        {session.model}
      </span>
      <span className={styles.statSep}>·</span>
      <span className={styles.statItem}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="4" width="18" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 20h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {agent.host}
      </span>
      <button className={styles.statRun} type="button" title="run" aria-label="run">
        <IconPlay size={12} />
      </button>
    </footer>
  );
}

/* a tiny markdown renderer — headings, lists, and inline code/mentions/highlights */
/* The artifacts the pane can host. Each carries its own renderer via `kind`. The
   diff comes straight from git (a complete unified diff, above); the plan and the
   design note are markdown, rendered by the same real markdown renderer. */
const PLAN_MD = `# streaming invoice totals

~ plan · 3/8 draws · $0.78 / $5.00

## scope

billing only — invoice totals, streaming, **no** running mutable. Do not touch
ledger settlement or auth.

## approach

- accumulate with \`totals.add(line.amountMicros)\`
- fold is pure: a repeat over unchanged lines is a cache hit
- keep it in \`src/billing\`

## acceptance

\`streamTotal([100, 250]) === 350\`; no auth or schema changes.

## sessions

- \`feat/streaming-invoice-totals\` — writing
- \`scout/invoice-schema\` — settled ✓
`;

const NOTE_MD = `# Why streaming totals

A running mutable (\`let total = 0\`) makes the fold **stateful**: you cannot
re-run it over a subset without resetting, and two readers racing the same
invoice can observe a torn value.

## The shape

> A \`StreamingTotal\` is an append-only accumulator. \`add\` is commutative;
> \`settle\` is idempotent.

So a repeated fold over unchanged lines is a pure cache hit — the property the
plan leans on.

## Caught in review

An off-scope edit reached into \`src/auth/session.ts\` to \`elevate\` a session
"to read all invoices". That is outside billing and was steered before the rest
of the work was written on top of it.
`;

const ARTIFACTS: readonly Artifact[] = [
  {
    id: 'pr-invoice',
    kind: 'diff',
    title: 'feat/streaming-invoice-totals',
    sub: 'PR · billing',
    mark: '~',
    diff: INVOICE_DIFF,
  },
  { id: 'plan-invoice', kind: 'plan', title: 'streaming invoice totals', sub: 'plan', mark: '~', md: PLAN_MD },
  { id: 'note-streaming', kind: 'doc', title: 'why streaming totals', sub: 'note', md: NOTE_MD },
];

/* A prism theme in the WIRE palette — colours are the design tokens themselves,
   so the code reads in the same operator surface as everything else. */
const CODE_THEME: PrismTheme = {
  plain: { color: 'var(--tx1)', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'cdata'], style: { color: 'var(--tx3)', fontStyle: 'italic' } },
    { types: ['keyword', 'boolean', 'tag', 'operator', 'selector', 'atrule'], style: { color: 'var(--blu2)' } },
    { types: ['string', 'char', 'attr-value', 'inserted', 'template-string'], style: { color: 'var(--grn2)' } },
    { types: ['number', 'symbol', 'unit'], style: { color: 'var(--amb2)' } },
    { types: ['function', 'method', 'function-variable'], style: { color: 'var(--blu2)' } },
    { types: ['class-name', 'maybe-class-name', 'builtin', 'constant'], style: { color: 'var(--amb2)' } },
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

/* ---- a real unified-diff parser: `git diff` text → files → hunks → rows ---- */
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
   (GitHub-style) that threads inline AND lands in the chat. */
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
  strong: ({ children }: { children?: React.ReactNode }) => <strong className={styles.mdStrong}>{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className={styles.mdEm}>{children}</em>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className={styles.mdQuote}>{children}</blockquote>,
  code: ({ children }: { children?: React.ReactNode }) => <code className={styles.mdCode}>{children}</code>,
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
      .map((r) => ({ top: r.top - b.top + body.scrollTop, left: r.left - b.left, width: r.width, height: r.height }));
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
              style={{ top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` }}
            />
          ))
        : null}
      {sel ? (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: selection resize handle */}
          <div
            className={`${styles.docHandle} ${styles.docHandleStart}`}
            style={{ top: `${sel.start.y}px`, left: `${sel.start.x}px`, height: `${sel.start.h}px` }}
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
          <div className={styles.docComposeQuote}>“{sel.quote.length > 90 ? `${sel.quote.slice(0, 90)}…` : sel.quote}”</div>
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
            <span className={styles.docComposeHint}>appears in the chat as you type · ⌘⏎ to comment</span>
            <span className={styles.grow} />
            <button type="button" className={styles.docComposeCancel} onClick={close}>
              cancel
            </button>
            <button type="submit" className={styles.docComposeSend} disabled={draft.trim().length === 0}>
              comment
            </button>
          </div>
        </form>
      ) : null}

      {comments.length > 0 ? (
        <div className={styles.artComments}>
          {comments.map((c) => (
            <div key={c.id} className={styles.artComment}>
              <span className={styles.artCommentQuote}>“{c.quote.length > 40 ? `${c.quote.slice(0, 40)}…` : c.quote}”</span>
              <span className={styles.artCommentText}>{c.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* a distinct icon per artifact kind — the switcher is icons only, so each kind
   must read at a glance: diff (a file with +/−), plan (a checklist), doc (text). */
function ArtifactKindIcon({ kind, size = 15 }: { kind: ArtifactKind; size?: number }) {
  if (kind === 'diff') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M6 3h8l4 4v14H6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 11v5M9.5 13.5h5M9.5 18h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'plan') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M3.5 6.5 5 8l2.6-2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3.5 16.5 5 18l2.6-2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11 7h9.5M11 17h9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 3h8l4 4v14H6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 12h6M9 15.5h6M9 19h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/* ARTIFACT PANE — the right split, an artifact HOST. The switcher lists the open
   artifacts by name; the active one renders through the renderer its kind selects
   (diff → real git diff, doc/plan → markdown). Comments anchor where they're made
   and echo to the chat. */
function ArtifactPane({
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
      {/* footer status — height-matched to the other bottom bars via --foot-h */}
      <div className={styles.artFoot}>
        {active.mark ? <span className={styles.mark}>{active.mark}</span> : null}
        <span className={styles.artFootStatus}>{active.kind === 'diff' ? 'proposed' : active.kind} · draft</span>
        <span className={styles.grow} />
        <span className={styles.artFootHint}>
          awaiting a human
          <IconCheck size={11} />
        </span>
      </div>
    </section>
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
          <RichText text={step.text ?? ''} />
        )}
      </span>
    </div>
  );
}

/* A TURN — the agent's whole tool-call history for one session turn, folded into
   a skewed accordion. Hover peeks; click opens a scrollable inner pane that is
   itself resizable (drag its bottom edge). This is what keeps the chat uncluttered:
   a hundred tool calls read as ONE row until you want them. */
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
        <button type="button" className={styles.turnStackBtn} onClick={() => setOpen(true)} aria-label="open turn history">
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
            <RichText text={turn.conclusion.text} />
            {turn.conclusion.reply ? (
              <div className={styles.threadReply}>
                <span className={`${styles.logWho} ${styles.human}`}>{turn.conclusion.reply.who}</span>
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
    <span className={`${styles.avatar} ${kind === 'human' ? styles.avatarHuman : styles.avatarAgent}`} aria-hidden>
      {(who ?? '').slice(0, 2)}
    </span>
  );
}

/* Every chat item is a two-column row: a gutter (avatar/dot) and an indented
   content column, so what belongs together lines up under one author. */
function ChatMessage({ msg }: { msg: ChatMsg }) {
  const mmExcerpt = (
    msg.text ??
    msg.turn?.conclusion?.text ??
    msg.turn?.summary ??
    (msg.image ? `[image] ${msg.image.alt}` : '')
  )
    .replace(/[`=*]/g, '')
    .trim();
  if (msg.kind === 'system') {
    return (
      <div className={styles.chatRow} data-kind="system" data-mm-id={msg.id} data-mm-kind="system" data-mm-who="system" data-mm-excerpt={mmExcerpt}>
        <Avatar kind="system" />
        <div className={styles.chatContent}>
          <span className={styles.chatSysText}>
            <span className={styles.chatTime}>{msg.time}</span> <RichText text={msg.text ?? ''} />
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.chatRow} data-kind={msg.kind} data-mm-id={msg.id} data-mm-kind={msg.kind} data-mm-who={msg.who ?? ''} data-mm-excerpt={mmExcerpt}>
      <Avatar who={msg.who} kind={msg.kind} />
      <div className={styles.chatContent}>
        <div className={styles.chatMeta}>
          <span className={`${styles.chatWho} ${msg.kind === 'human' ? styles.human : styles.agent}`}>{msg.who}</span>
          <span className={styles.chatTime}>{msg.time}</span>
        </div>
        {msg.turn ? <Turn turn={msg.turn} /> : null}
        {msg.text ? (
          <div className={styles.chatBody}>
            <RichText text={msg.text} />
          </div>
        ) : null}
        {msg.image ? (
          // biome-ignore lint/nursery/noImgElement: inline chat image (mock data URI)
          <img className={styles.chatImage} src={msg.image.src} alt={msg.image.alt} />
        ) : null}
        {msg.reply ? (
          <div className={styles.threadReply}>
            <span className={`${styles.logWho} ${styles.human}`}>{msg.reply.who}</span>
            <span className={styles.threadText}>{msg.reply.text}</span>
          </div>
        ) : null}
      </div>
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
function ChatMinimap({ scrollRef, revision }: { scrollRef: React.RefObject<HTMLDivElement | null>; revision: string }) {
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
            excerpt: (el.dataset.mmExcerpt || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
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
    <div className={styles.minimap} ref={railRef} onPointerDown={onPointerDown} onPointerLeave={() => setHover(null)}>
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
              toggleMark(t.id);
            }
          }}
        />
      ))}
      {view.scrollable ? <div className={styles.mmView} style={{ top: `${view.top}px`, height: `${view.height}px` }} aria-hidden /> : null}
      {hover ? (
        <div className={styles.mmPreview} style={{ top: `${Math.max(0, Math.min(hover.top, (railRef.current?.clientHeight ?? 0) - 96))}px` }}>
          <div className={styles.mmPreviewText}>{hover.excerpt.length > 120 ? `${hover.excerpt.slice(0, 120)}…` : hover.excerpt}</div>
          <div className={styles.mmPreviewMeta}>
            <span className={`${styles.face} ${hover.kind === 'human' ? styles.faceHuman : styles.faceAgent}`} aria-hidden>
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

/* CHAT — the room's conversation and the ONLY input. `@mention` an agent to
   delegate (incl. the gpt-live call agent); when the agent is paused mid-steer,
   the same input takes the redirect. */
function ChatBlock({
  selected,
  echoes,
  draftComment,
  steering,
  redirect,
  setRedirect,
  onSteerSend,
  onSay,
}: {
  selected: Selection;
  echoes: readonly string[];
  draftComment: CommentDraft | null;
  steering: boolean;
  redirect: string;
  setRedirect: (v: string) => void;
  onSteerSend: () => void;
  onSay: (text: string) => void;
}) {
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
  const convo = conversationFor(shownSel);
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
      <ChatMinimap scrollRef={logRef} revision={`${shownSel.kind}:${shownSel.id}|${echoes.length}|${draftComment ? draftComment.text.length : -1}|${fading ? 1 : 0}`} />
      <div className={styles.chatLog} ref={logRef}>
        <div className={`${styles.chatConvo} ${fading ? styles.chatConvoOut : ''}`}>
          {convo.map((msg) => (
            <ChatMessage key={msg.id} msg={msg} />
          ))}
        </div>
        {echoes.map((e, i) => (
          <ChatMessage
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only echo list
            key={`e${i}`}
            msg={{ id: `e${i}`, time: 'now', kind: 'human', who: 'you', text: e }}
          />
        ))}
        {/* the comment being composed in the artifact pane, portaled here live */}
        {draftComment ? <DraftComment draft={draftComment} /> : null}
        {/* multiplayer: someone else is typing, right above your input */}
        <TypingRow who="dane" />
        {/* the input is just the next line of the thread — your avatar + a cursor */}
        <Composer
          inputRef={inputRef}
          steering={steering}
          value={steering ? redirect : value}
          onChange={steering ? setRedirect : setValue}
          onSubmit={() => {
            if (steering) {
              if (redirect.trim().length > 0) onSteerSend();
            } else if (value.trim().length > 0) {
              onSay(value);
              setValue('');
            }
          }}
        />
      </div>
    </section>
  );
}

const SLASH_COMMANDS: readonly [string, string][] = [
  ['/goal', 'stage an objective for review'],
  ['/decision', 'stage a decision for review'],
  ['/question', 'stage an open question for review'],
  ['/commitment', 'stage your commitment for review'],
  ['/claim', 'stage your claim for review'],
];
const MENTION_TARGETS: readonly [string, string][] = [
  ['hexi', 'agent · billing-rewrite'],
  ['mira', 'agent · search-relevance'],
  ['vale', 'agent · infra-audit'],
  ['call', 'the live agent'],
];

/* COMPOSER — delta.dev-simple: the input is the last row of the thread. Your
   avatar, a field that blends in, a blinking cursor. No toolbar, no send button.
   Typing `@` or `/` still opens a popover ABOVE the field. Enter sends. */
function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  steering,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  steering: boolean;
}) {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  const slashMatch = /^\/(\S*)$/.exec(value);
  const mentionMatch = /(^|\s)@([\w-]*)$/.exec(value);
  const commands = SLASH_COMMANDS.filter(([c]) => c.slice(1).startsWith(slashMatch?.[1]?.toLowerCase() ?? ''));
  const mentions = MENTION_TARGETS.filter(([n]) => n.startsWith(mentionMatch?.[2]?.toLowerCase() ?? ''));
  const kind = !steering && slashMatch !== null && commands.length > 0 ? 'slash'
    : !steering && mentionMatch !== null && mentions.length > 0 ? 'mention'
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
    <div className={styles.chatRow} data-kind={steering ? 'steer' : 'human'}>
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
  const quote = draft.quote.length > 52 ? `${draft.quote.slice(0, 52)}…` : draft.quote;
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
            <span className={styles.draftText}>{draft.text}</span>
          ) : (
            <span className={styles.draftPlaceholder}>start typing your comment…</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* who else is typing — multiplayer presence, shown just above the composer */
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

/* TILE: the live-call transcript — tiles in when you click the call strip. You
   talk to the call's gpt-live agent from the chat below, by @mentioning. */

