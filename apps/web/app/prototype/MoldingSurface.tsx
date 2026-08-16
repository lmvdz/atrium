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
 *
 * ── phase-5 decomposition (#161) ──
 * This file WAS the entire ~2400-line surface. It is now the top-level composer
 * that wires the per-pane component files, so the four wiring lanes can each bind
 * their own seam on their own file without colliding on a monolith:
 *   NavTree.tsx (#154) · ChatBlock.tsx + ChatChrome.tsx + MessageText.tsx (#155)
 *   · ChatChrome.tsx + SharePopover.tsx (#156) · ArtifactPane.tsx (#155/#156/#157)
 *   · UserBar.tsx (#158) · ProviderMark.tsx · icons.tsx. All mock data lives
 *   behind the typed seams in seams.ts; the covenant invariants are unchanged.
 * ------------------------------------------------------------------------- */

import { useEffect, useMemo, useState } from 'react';
import type { ControlPlaneData } from '@/lib/control-plane-data';
import { ArtifactPane } from './ArtifactPane';
import { ChatBlock } from './ChatBlock';
import { ThreadStatus } from './ChatChrome';
import type { Echo } from './conversation-model';
import { covenant } from './covenant';
import { IconPanel } from './icons';
import { NavTree } from './NavTree';
import styles from './prototype.module.css';
import { sessionArtifacts, sessionFor, treeData, usePRStream } from './seams';
import type { Comment, CommentDraft, Selection } from './types';
import { UserBar } from './UserBar';

/* ── #157 round 3: steer/interrupt is a STRUCTURED control, NOT chat prose ──────
   Rounds 1–2 detected steer/interrupt by matching a finite regex over free chat
   text in the composer. That mechanism was wrong in BOTH directions and cannot be
   made right: it let covenant cues BYPASS ("@hexi cancel", "@hexi cease work", a
   zero-width "@hexi st​op" all missed the regex and posted as a normal, delivered-
   looking message with no notice — a fake-success hole), and it OVER-TRIGGERED
   ("hexi should not stop", "mira: ask whether hexi can stop" were swallowed from
   chat and replaced with an interrupt notice — message loss). Keyword inference
   over prose cannot separate a covenant act from a sentence that merely mentions
   one. So the inference is GONE: a chat message is always just a chat message. The
   steer/interrupt covenant act is a discrete, structured control on the running
   session (ThreadStatus's steer/interrupt buttons), an honest inert seam here
   naming `signal_session{steer|interrupt}` for go-live (#168) — never guessed. */

/* The node the surface opens on. When a LIVE control plane is mounted (the real
   room route, #168 go-live A), the tree carries real ids that the mock `s-live`
   is not among, so opening on it would leave nothing selected — open on the
   plane's first session (then plan, then agent) instead. On the `/prototype`
   fixture route no live plane is passed, and the surface opens on the mock live
   session exactly as before. */
function firstSelection(plane: ControlPlaneData | undefined): Selection {
  if (plane === undefined) return { kind: 'session', id: 's-live' };
  for (const agent of plane.agents) {
    for (const plan of agent.plans) {
      const session = plan.sessions[0];
      if (session !== undefined) return { kind: 'session', id: session.id };
    }
  }
  const firstPlan = plane.agents.flatMap((agent) => agent.plans)[0];
  if (firstPlan !== undefined) return { kind: 'plan', id: firstPlan.id };
  const firstAgent = plane.agents[0];
  if (firstAgent !== undefined) return { kind: 'agent', id: firstAgent.userId };
  return { kind: 'session', id: 's-live' };
}

/**
 * The married surface.
 *
 * `tree` is the LIVE control-plane projection (`ControlPlaneData`) when the
 * surface is mounted on a real room route (#168 go-live A): the server component
 * loads it through `loadControlPlane` (server-only) and hands it down here, so the
 * process tree renders REAL agents/plans/sessions and a live column change moves
 * the rendered cell. When omitted (the `/prototype` fixture route) the tree falls
 * back to the seeded `treeData()` fixture. The type is imported `import type`, so
 * this client component never pulls the server-only module into the browser bundle.
 *
 * ONLY the READ-ONLY process tree is live in this lane. The conversation feed,
 * the thread roster and the covenant ACTION doors are unchanged: the doors stay
 * honestly inert (`{reached:false}`, wired under go-live B's security gauntlet),
 * and the per-session conversation/roster remain the design shell until their
 * live source lands (#159 / Phase 6 — there is no per-session-thread live read
 * model on this tree to bind them to yet).
 */
export function MoldingSurface({ tree: liveTree }: { tree?: ControlPlaneData } = {}) {
  const [echoes, setEchoes] = useState<readonly Echo[]>([]);
  /* WHERE YOU ARE in the tree — which thread the main view shows. */
  const [selected, setSelected] = useState<Selection>(() => firstSelection(liveTree));
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
    const move = (ev: PointerEvent) =>
      setSideW(Math.min(620, Math.max(200, start + ev.clientX - sx)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /* SEAM(#154) — BOUND, and LIVE on a real room (#168 go-live A). The process
     tree reads the real control-plane shape (`ControlPlaneData`), derived through
     the shipped `control/state.ts` selectors. When the surface is mounted on a
     real room route the projection is the LIVE `loadControlPlane` read, handed in
     as `liveTree`; on the `/prototype` route it falls back to the seeded
     `treeData()`. Either way the seam is resolved at the composition root and
     handed down, so a mutated column moves the rendered cell (nav-tree.test.tsx
     and molding-mount.test.tsx). */
  const tree = useMemo(() => liveTree ?? treeData(), [liveTree]);
  /* the right split — an artifact host (diff / plan / doc) you comment on. */
  // SEAM(#155): bind to the session's real artifacts.
  const artifacts = useMemo(() => sessionArtifacts(), []);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<string>(artifacts[0]!.id);
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

  /* SEAM(#159): bind to the live diff / turn stream. The stream is NOT frozen by
     any local flag — a real pause of the agent is the SERVER's, minted only when
     `signal_session{interrupt}` is accepted. The prototype's old "@hexi stop"
     froze this mock stream and cleared the drift concern with nothing reaching
     any server: a faked stop for an agent that would keep spending. That theater
     is gone (#157); the drift stays until a real, gated act clears it. */
  const stream = usePRStream(false);
  const concern = stream.concern !== null;

  /* The chat is the ONLY text input, and it is ONLY chat. A message that
     @-addresses an agent is a delegation (rendered `→ …` so the room can see who
     it is aimed at); anything else is just said in the room. Nothing typed here
     is ever intercepted as a covenant act: "@hexi stop", "@hexi cancel", a
     zero-width "@hexi st​op" all post as ordinary authored messages, exactly like
     any other line — no keyword inference, no swallowing, no "not delivered"
     notice for a match, no fake stop. The steer/interrupt covenant act is a
     STRUCTURED control (ThreadStatus), never guessed from these words (#157 r3). */
  const say = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) return;
    const low = text.toLowerCase();
    const isDelegation =
      text.startsWith('@') || /^(hexi|mira|vale|dane|iris|omar|noor)\b/.test(low);
    setEchoes((e) => [...e, { delivery: 'said', text: isDelegation ? `→ ${text}` : text }]);
  };

  /* commenting on an artifact anchors the note there AND appends it to the thread
     in real time — the anchor (a diff line or a quote) travels with it.
     SEAM(#156): write the comment to the ledger, anchored (`path:line` or quote). */
  const addComment = (artifactId: string, anchor: string, quote: string, text: string) => {
    setComments((c) => [...c, { id: c.length + 1, artifactId, anchor, quote, text }]);
    const q = quote.length > 46 ? `${quote.slice(0, 46)}…` : quote;
    // The viewer's own note, honestly authored on the room's register (a `said`
    // echo) — a comment is the operator speaking, not a covenant act.
    setEchoes((e) => [...e, { delivery: 'said', text: `💬 ${anchor} · “${q}” — ${text}` }]);
    setDraftComment(null); // the live draft becomes a permanent line

    /* COMMENT-TO-STEER (#158/#152). An anchored comment is, in the client shape,
       a real room message carrying a quotation anchor; when it TARGETS A RUNNING
       SESSION's goal it additionally classifies into `signal_session{steer}` via
       that message's durable id (`causeMessageId` / the "mediatedFromMessageId"
       edge) — `covenant.mediateSteer` names both gated calls. On int/phase5 there
       is no live room/session, so the mediation is honestly INERT: it returns
       `reached:false` and NO `session_signaled{steer}` leaves the client. The
       operator is told — verbatim — that nothing was delivered, never a faked
       steer. Flip the input (select a settled session) and the steer
       classification does not fire at all — only a running target steers. */
    const target = sessionFor(selected).session;
    if (target.status === 'running') {
      const outcome = covenant.mediateSteer(target.id, { anchor, quote, body: text });
      setEchoes((e) => [
        ...e,
        {
          delivery: 'refused',
          text: `steer not delivered — ${outcome.inert} · door: ${outcome.door}`,
        },
      ]);
    }
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
          <rect
            x="3"
            y="4"
            width="18"
            height="16"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.8"
          />
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
              <NavTree data={tree} selected={selected} onSelect={setSelected} concern={concern} />
            </div>
            <UserBar />
          </aside>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pane width resizer */}
          <div
            className={styles.sideResizer}
            onPointerDown={startSideResize}
            role="separator"
            aria-orientation="vertical"
          />
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
              onSay={say}
            />
            {/* the status strip is the CHAT's footer — contained to this column,
                it stops at the split rather than running under the artifact. */}
            <ThreadStatus selected={selected} stream={stream} />
          </div>
          {artifactOpen ? (
            <>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: split resizer */}
              <div
                className={styles.colResizer}
                onPointerDown={startColResize}
                role="separator"
                aria-orientation="vertical"
              />
              <div className={styles.artifactCol} style={{ flexGrow: 1 - chatFrac }}>
                <ArtifactPane
                  artifacts={artifacts}
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
