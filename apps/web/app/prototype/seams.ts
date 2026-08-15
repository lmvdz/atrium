'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DATA SEAM — one module, every mock source, each marked with the pane-lane
 * ticket that replaces it with a real source.
 *
 * The phase-5 SCAFFOLD (#161) splits the monolith into per-pane component files
 * and leaves the *data* exactly here, behind typed accessors, so the four pane
 * lanes can each bind their own seam on their own file without colliding:
 *
 *   #154 — the process tree            → `treeData()`  (BOUND — real shape)
 *   #155 — the conversation feed + diff → `conversationFor()`, artifacts, stream
 *   #156 — chat head / participants     → `threadHeadFor()`, `participantsFor()`
 *   #157 — covenant affordances         → wired to gated doors (not here)
 *   #159 — the live develop-over-time   → `usePRStream()`
 *
 * Every export below is a SINGLE typed seam. A pane lane replaces the *body*
 * with its real source; the component that consumes it never changes shape.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { ControlPlaneData } from '@/lib/control-plane-data';
import { controlPlaneFixture } from './control-fixture';
import type {
  MemberChip,
  ParticipantSummary,
  Presence,
  RoomHeadRecord,
} from '@/src/components/model/records';
import {
  type DiffLine,
  INVOICE_DIFF,
  AGENTS as MOCK_AGENTS,
  type StreamState,
  useMockPRStream,
} from './mock';
import type { Artifact, ChatMsg, Selection } from './types';

export type { StreamState } from './mock';

/* SEAM(#154) — BOUND. The process tree now reads the REAL control-plane shape:
   `ControlPlaneData` (`lib/control-plane-data.ts`: `ControlAgentRow` /
   `ControlPlanRow` / `ControlSessionRow`), rendered through the shipped
   `control/state.ts` selectors (`planCost`, `formatMicros`, `sessionCertified`),
   exactly as `ProcessTree.tsx` does. The value is a SEEDED fixture standing in
   for `loadControlPlane` (server-only; its live channel is #159, out of scope) —
   every field is a real column, nothing invented. Swap this body for the load
   when #159 lands; `NavTree` never changes shape. */
export function treeData(): ControlPlaneData {
  return controlPlaneFixture();
}

/* SEAM(#159): bind to the real diff / turn stream (settle events + live).
   Real source: the live-progress channel (#152/#159). Today it replays a
   scripted wall-clock PR against a mock; `steering` freezes it. */
export function usePRStream(steering: boolean): StreamState {
  return useMockPRStream(steering);
}

/* ── the conversation seam (#155) ─────────────────────────────────────────
   Real source: the thread's real messages, rendered through the shipped
   `Timeline`/`TimelineRow` (+ `MessageBody`) once messages arrive as ledger
   `MessageRecord`s. Today they are literals. Each `ChatMsg` is the shape the
   feed consumes; the shipped swap replaces the literals, not the feed shell. */

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
  {
    id: 'c1',
    time: '14:01',
    kind: 'system',
    text: 'plan opened · streaming invoice totals · 3/8 draws',
  },
  {
    id: 'c2',
    time: '14:03',
    kind: 'human',
    who: 'you',
    text: 'can we do streaming totals without a running mutable? keep it in `billing`',
  },
  {
    id: 'c3',
    time: '14:05',
    kind: 'agent',
    who: 'hexi',
    turn: {
      summary: 'streaming invoice totals · edited 1 file',
      spend: '$0.34',
      steps: [
        {
          kind: 'thought',
          text: 'the running `let total` mutates across the loop, so the fold is not pure',
        },
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
      conclusion: {
        text: 'schema mapped — a `SummaryCache` keyed by a generation counter would fit. handing to the build session.',
      },
    },
  },
  { id: 'sc3', time: '13:41', kind: 'system', text: '✓ settled · certified by you' },
];
const CONVO_RANK: readonly ChatMsg[] = [
  {
    id: 'r1',
    time: '11:02',
    kind: 'system',
    text: 'plan opened · re-rank on embeddings · 6/6 draws',
  },
  {
    id: 'r2',
    time: '11:05',
    kind: 'human',
    who: 'you',
    text: 'rerank the top-50 by cosine, keep p95 under 40ms',
  },
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
        {
          kind: 'edit',
          edit: {
            file: 'src/search/rerank.ts',
            lines: [{ kind: 'add', text: 'const scored = embed(batch).map(cosine)' }],
          },
        },
        { kind: 'command', command: '$ pnpm bench rerank' },
        { kind: 'output', text: 'p95 38ms · +6% ndcg' },
      ],
      conclusion: {
        text: 'reranker in place — ==p95 38ms, ndcg +6%==. context is at 71%, may compact soon.',
      },
    },
  },
  {
    id: 'r4',
    time: '11:15',
    kind: 'human',
    who: 'you',
    text: 'do we have a benchmark proving this?',
  },
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
      conclusion: {
        text: '60 env reads enumerated; ==3 are unguarded==. want a ticket per unguarded read?',
      },
    },
  },
];
const CONVERSATIONS: Record<string, readonly ChatMsg[]> = {
  's-live': CONVO_LIVE,
  's-scout': CONVO_SCOUT,
  's-rank': CONVO_RANK,
  's-audit': CONVO_AUDIT,
};

/* SEAM(#155): bind to the real thread messages for the selected node.
   the chat follows the tree: a session shows its own thread; a plan or agent
   shows their primary session's thread. */
export function conversationFor(sel: Selection): readonly ChatMsg[] {
  if (sel.kind === 'session') return CONVERSATIONS[sel.id] ?? CONVO_LIVE;
  const plan =
    sel.kind === 'plan'
      ? MOCK_AGENTS.flatMap((a) => a.plans).find((p) => p.id === sel.id)
      : MOCK_AGENTS.find((a) => a.id === sel.id)?.plans[0];
  const sid = plan?.sessions[0]?.id;
  return (sid ? CONVERSATIONS[sid] : undefined) ?? CONVO_LIVE;
}

/* the session (and its agent) the thread is currently on — a plan/agent resolves
   to its primary session. Reads only from the tree seam. */
export function sessionFor(sel: Selection) {
  for (const agent of MOCK_AGENTS) {
    for (const plan of agent.plans) {
      for (const session of plan.sessions) {
        if (sel.kind === 'session' && session.id === sel.id) return { agent, session };
      }
    }
  }
  const plan =
    sel.kind === 'plan'
      ? MOCK_AGENTS.find((a) => a.plans.some((p) => p.id === sel.id))?.plans.find(
          (p) => p.id === sel.id,
        )
      : MOCK_AGENTS.find((a) => a.id === sel.id)?.plans[0];
  const agent = MOCK_AGENTS.find((a) => a.plans.includes(plan as (typeof a.plans)[number]));
  const session = plan?.sessions[0];
  return agent && session
    ? { agent, session }
    : { agent: MOCK_AGENTS[0]!, session: MOCK_AGENTS[0]!.plans[0]!.sessions[0]! };
}

/* #156: BIND THE THREAD HEAD TO `RoomHeadRecord` (the shipped `frame/RoomHead`
   shape), not an ad-hoc `{title, sub}`. The room is the record's `name`, the
   plan is its `topic`, and the faces are `MemberChip`s carrying each member's
   KIND — so the head can tell a person from an agent the way `RoomHead` does,
   instead of stamping every face the same. */
export function threadHeadFor(sel: Selection): RoomHeadRecord {
  const { agent, session } = sessionFor(sel);
  const plan =
    agent.plans.find((p) => p.sessions.some((s) => s.id === session.id)) ?? agent.plans[0];
  const members: readonly MemberChip[] = participantsFor(sel).map((participant) => ({
    name: participant.name,
    kind: participant.kind,
  }));
  return { name: agent.room, topic: plan?.title ?? session.branch, members };
}

/* The presence a session's lifecycle status implies for the agent holding it.
   An agent running a session is HERE the same way a person is; a settled/open
   one is idle; a failed one has stepped away. This is the seam where real
   presence over `src/lib/realtime.ts` lands — until then it is derived from the
   control-plane status the tree already carries, and it MOVES when that status
   does (flip-the-input: change a session's status, the face's presence moves). */
function agentPresence(agent: MockAgent): Presence {
  const statuses = agent.plans.flatMap((plan) => plan.sessions.map((session) => session.status));
  if (statuses.includes('running')) return 'here';
  if (statuses.includes('open') || statuses.includes('settled')) return 'idle';
  return 'away';
}

/** The live collaborator's presence — the one field a realtime channel drives.
    A module constant standing in for that channel; flipping it moves the face. */
export const COLLABORATOR_PRESENCE: Presence = 'here';

/* #156: PROJECT REAL `ParticipantSummary` ROWS — the shipped roster/RoomHead
   shape (`{id, kind, name, presence, note, isViewer}`), kind-aware and
   presence-carrying — rather than the old `{who, kind}` string derivation.

   Pure and injectable so the projection can be flipped in a test: hand it a
   tree whose session status differs and the agent's presence moves with it. */
export function projectParticipants(input: {
  readonly agents: readonly MockAgent[];
  /** who has spoken on this thread, in order — from the conversation seam */
  readonly spokenNames: readonly string[];
  readonly collaborator: { readonly name: string; readonly presence: Presence };
}): readonly ParticipantSummary[] {
  const out: ParticipantSummary[] = [
    { id: 'you', kind: 'human', name: 'you', presence: 'here', note: null, isViewer: true },
  ];
  const seen = new Set<string>(['you']);
  for (const name of input.spokenNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const agent = input.agents.find((candidate) => candidate.name === name);
    /* A speaker we can resolve to an agent IS an agent, with the presence its
       sessions imply. One we cannot is `unknown` — the fail-closed kind, never
       softened to a person — and presence `away`, since nothing here says it is
       present. Both mirror `model/kind.ts`'s allowlist. */
    out.push(
      agent === undefined
        ? { id: name, kind: 'unknown', name, presence: 'away', note: null, isViewer: false }
        : {
            id: agent.id,
            kind: 'agent',
            name: agent.name,
            presence: agentPresence(agent),
            note: null,
            isViewer: false,
          },
    );
  }
  if (!seen.has(input.collaborator.name)) {
    out.push({
      id: input.collaborator.name,
      kind: 'human',
      name: input.collaborator.name,
      presence: input.collaborator.presence,
      note: null,
      isViewer: false,
    });
  }
  return out;
}

/* SEAM(#156): who is on this thread, as real `ParticipantSummary` rows — the
   viewer, the agents that have spoken (with live presence), and the live
   collaborator. Derived from the conversation, so the roster matches the room. */
export function participantsFor(sel: Selection): readonly ParticipantSummary[] {
  const spokenNames = conversationFor(sel)
    .filter((message) => message.kind !== 'system' && message.who !== undefined)
    .map((message) => message.who as string);
  return projectParticipants({
    agents: MOCK_AGENTS,
    spokenNames,
    collaborator: { name: 'dane', presence: COLLABORATOR_PRESENCE },
  });
}

/* #156: THE BRANCH/MODEL STATUS STRIP has no single shipped source, so it is a
   small CLIENT PROJECTION over the tree + live-stream facts — branch and base,
   the diff counts, the model and the host — assembled here rather than computed
   inline in the footer. No server change: every field is already on the rows. */
export interface StatusStrip {
  readonly branch: string;
  readonly base: string;
  readonly model: string;
  readonly host: string;
  readonly added: number;
  readonly removed: number;
  readonly running: boolean;
}

export function statusStripFor(sel: Selection, stream: StreamState): StatusStrip {
  const { agent, session } = sessionFor(sel);
  const live = session.id === 's-live';
  return {
    branch: session.branch.split('/').pop() ?? session.branch,
    base: 'main',
    model: session.model,
    host: agent.host,
    added: live ? stream.added : Math.round(session.spendMicros / 90_000) + 3,
    removed: live ? stream.removed : (session.ageMin % 4) + 1,
    running: session.status === 'running',
  };
}

/* ── the artifact seam (#155) ─────────────────────────────────────────────
   Real source: the session's real artifacts — the diff from the session branch
   (rendered by the shipped `ReviewPane` `DiffView`, server pre-structured), the
   plan, and the design note. Today they are literals. */
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

/* SEAM(#155): bind to the session's real artifacts. */
export function sessionArtifacts(): readonly Artifact[] {
  return [
    {
      id: 'pr-invoice',
      kind: 'diff',
      title: 'feat/streaming-invoice-totals',
      sub: 'PR · billing',
      mark: '~',
      diff: INVOICE_DIFF,
    },
    {
      id: 'plan-invoice',
      kind: 'plan',
      title: 'streaming invoice totals',
      sub: 'plan',
      mark: '~',
      md: PLAN_MD,
    },
    { id: 'note-streaming', kind: 'doc', title: 'why streaming totals', sub: 'note', md: NOTE_MD },
  ];
}
