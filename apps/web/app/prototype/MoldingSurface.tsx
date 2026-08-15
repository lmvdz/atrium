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
import { ArtifactPane } from './ArtifactPane';
import { ChatBlock } from './ChatBlock';
import { ThreadStatus } from './ChatChrome';
import type { Echo } from './conversation-model';
import { covenant } from './covenant';
import { IconPanel } from './icons';
import { NavTree } from './NavTree';
import styles from './prototype.module.css';
import { sessionArtifacts, treeData, usePRStream } from './seams';
import type { Comment, CommentDraft, Selection } from './types';
import { UserBar } from './UserBar';

/* The two covenant verbs the composer routes to, kept DISTINCT (#157 round-1
   residual 3). An "@hexi stop/halt/pause" is an INTERRUPT — a request to stop,
   gated by the server to the agent principal or its owner (`signal_session
   {interrupt}`). An "@hexi steer/redirect/focus" is a STEER — public, receipted
   guidance any room member may append (`signal_session{steer}`), powerless over
   covenant and purse. Routing a steer cue through interrupt (or the reverse)
   names the wrong gated door; the two are matched separately below, interrupt
   winning when a message carries both (a hard stop dominates a redirect). */
const INTERRUPT_CUE = /\b(stop|halt|drop|pause|kill|abort|interrupt|freeze)\b/;
const STEER_CUE = /\b(steer|redirect|reroute|refocus|focus|guide)\b/;

export function MoldingSurface() {
  /* `steering` means the operator is COMPOSING a steer/interrupt draft — it opens
     the redirect composer. It is NOT a claim that the agent stopped: drafting is
     not a covenant act, only the SEND is, and the send routes through the gated
     door (`covenant.steer` / `covenant.interrupt`), inert here. */
  const [steering, setSteering] = useState(false);
  /* WHICH covenant verb the drafted send will route to — set from the cue that
     opened the composer, so a "steer" reaches steer and a "stop" reaches interrupt. */
  const [steerIntent, setSteerIntent] = useState<'steer' | 'interrupt'>('interrupt');
  const [redirect, setRedirect] = useState('');
  const [echoes, setEchoes] = useState<readonly Echo[]>([]);
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
    const move = (ev: PointerEvent) =>
      setSideW(Math.min(620, Math.max(200, start + ev.clientX - sx)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /* SEAM(#154) — BOUND. The process tree reads the real control-plane shape
     (`ControlPlaneData`), derived through the shipped `control/state.ts`
     selectors. The seam is called at the composition root and handed down, so a
     test can render `NavTree` against a seeded plane and assert a mutated cost
     moves the rendered cell. */
  const tree = useMemo(() => treeData(), []);
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

  /* The session the steer targets — the selected one, or the live thread. */
  const steerTargetId = selected.kind === 'session' ? selected.id : 's-live';

  /* The chat is the only input. A message that @-addresses an agent is a
     delegation; anything else is just said in the room. "@hexi stop" opens a
     steer DRAFT — the operator composes guidance/a reason; sending it is the
     covenant act, gated below (`sendSteer`). */
  const say = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) return;
    const low = text.toLowerCase();
    const interruptCue = /hexi/.test(low) && INTERRUPT_CUE.test(low);
    const steerCue = /hexi/.test(low) && STEER_CUE.test(low);
    if (interruptCue || steerCue) {
      // A covenant cue. Do NOT append it as an authored "@hexi stop" line: that
      // reads as a sent stop with nothing behind it (#157 round-1 D1). Instead
      // open the draft composer AND, in the SAME action, append a NOT-delivered
      // notice — so the very first thing the operator sees is that nothing was
      // sent, not a message that looks delivered. Interrupt wins a message that
      // carries both cues (a hard stop dominates a redirect).
      const intent = interruptCue ? 'interrupt' : 'steer';
      setSteerIntent(intent);
      setSteering(true);
      // The notice is a SYSTEM statement — it reports the state, it does not
      // quote the operator (no quotation marks, no first person, no speech verbs;
      // see the quotation invariant). So it describes what happened without
      // echoing the typed words back as a quote.
      setEchoes((e) => [
        ...e,
        {
          delivery: 'pending',
          text: `${intent} not delivered — the ${intent} composer is open, but this surface has no live session, so nothing reached any server (#157)`,
        },
      ]);
      return;
    }
    const isDelegation =
      text.startsWith('@') || /^(hexi|mira|vale|dane|iris|omar|noor)\b/.test(low);
    setEchoes((e) => [...e, { delivery: 'said', text: isDelegation ? `→ ${text}` : text }]);
  };

  /* SEND the drafted steer/interrupt. The gated door is `signal_session{steer}`
     or `signal_session{interrupt}` (`commands.ts`; the server gates interrupt to
     the agent principal or its owner, and receipts a steer from any member) —
     routed by the cue that opened the composer, so the drafted send reaches the
     door it was named for. On int/phase5 the route holds no live session, so the
     covenant seam is honestly INERT: it performs NO durable mutation and returns
     `reached:false`, and the operator is told — verbatim — that NOTHING was
     delivered. This is the flip-the-input case the ticket demands: send it, and
     no durable command and no fake success leaves the client. */
  const sendSteer = () => {
    const body = redirect.trim();
    const outcome =
      steerIntent === 'interrupt'
        ? covenant.interrupt(steerTargetId, body)
        : covenant.steer(steerTargetId, body);
    setSteering(false);
    setRedirect('');
    setEchoes((e) => [
      ...e,
      {
        delivery: 'refused',
        text: `${steerIntent} not delivered — ${outcome.inert} · door: ${outcome.door}`,
      },
    ]);
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
              steering={steering}
              redirect={redirect}
              setRedirect={setRedirect}
              onSteerSend={sendSteer}
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
