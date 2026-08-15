'use client';

/* ---------------------------------------------------------------------------
 * Mock substrate for the observability command-center prototype.
 *
 * This stands in for what the ledger will stream for real: agents, their plans
 * and sessions, and — the centerpiece — a DIFF THAT DEVELOPS OVER TIME rather
 * than one that arrives finished on a settle event. The scripted PR below
 * deliberately goes sideways partway through (it starts touching an auth file it
 * was never scoped to) so the "catch the wrong 70% early" intervention has a
 * real thing to catch. Nothing here is a claim about live data; it is a shape.
 * ------------------------------------------------------------------------- */

import { useEffect, useRef, useState } from 'react';

export type SessionPhase =
  | 'planning' // reading, no code yet
  | 'writing' // producing the diff
  | 'testing' // running the suite
  | 'proposed' // done — a `~` draft awaiting a human `✓`
  | 'steering'; // a human has stepped in; the agent is paused

/* A session's lifecycle, matching the control plane's vocabulary. */
export type SessionStatus = 'running' | 'settled' | 'open' | 'failed';

export interface MockSession {
  readonly id: string;
  readonly model: string;
  readonly branch: string;
  readonly harness: string;
  readonly status: SessionStatus;
  readonly ctxPct: number | null; // context window used, 0..1
  readonly spendMicros: number;
  readonly ageMin: number;
  readonly certified: boolean; // a human put ✓ on it
}

export interface MockPlan {
  readonly id: string;
  readonly title: string;
  readonly status: 'open' | 'settled';
  readonly drawsUsed: number;
  readonly drawsCeiling: number | null; // null = unfunded
  readonly budgetMicros: number | null; // the ~ dollar intent
  readonly spentMicros: number;
  readonly sessions: readonly MockSession[];
}

export interface MockAgent {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly host: string;
  readonly room: string;
  readonly plans: readonly MockPlan[];
}

/* The tree. One agent is ours and mid-build (session s-live, the one whose diff
   streams); the rest are the ambient "other people's agents" the command center
   exists to make visible. */
export const AGENTS: readonly MockAgent[] = [
  {
    id: 'a-hexi',
    name: 'hexi',
    model: 'opus-5',
    host: 'mac-studio-01',
    room: 'billing-rewrite',
    plans: [
      {
        id: 'p-invoices',
        title: 'streaming invoice totals',
        status: 'open',
        drawsUsed: 3,
        drawsCeiling: 8,
        budgetMicros: 5_000_000,
        spentMicros: 780_000,
        sessions: [
          {
            id: 's-live',
            model: 'opus-5',
            branch: 'feat/streaming-invoice-totals',
            harness: 'claude-code',
            status: 'running',
            ctxPct: 0.42,
            spendMicros: 660_000,
            ageMin: 9,
            certified: false,
          },
          {
            id: 's-scout',
            model: 'sonnet-5',
            branch: 'scout/invoice-schema',
            harness: 'claude-code',
            status: 'settled',
            ctxPct: 0.18,
            spendMicros: 120_000,
            ageMin: 41,
            certified: true,
          },
        ],
      },
    ],
  },
  {
    id: 'a-mira',
    name: 'mira',
    model: 'gpt-5.6-sol',
    host: 'linux-ci-07',
    room: 'search-relevance',
    plans: [
      {
        id: 'p-rank',
        title: 're-rank on embeddings',
        status: 'open',
        drawsUsed: 6,
        drawsCeiling: 6,
        budgetMicros: 3_000_000,
        spentMicros: 2_910_000,
        sessions: [
          {
            id: 's-rank',
            model: 'gpt-5.6-sol',
            branch: 'feat/embedding-rerank',
            harness: 'codex',
            status: 'running',
            ctxPct: 0.71,
            spendMicros: 2_910_000,
            ageMin: 26,
            certified: false,
          },
        ],
      },
    ],
  },
  {
    id: 'a-vale',
    name: 'vale',
    model: 'grok-4.6',
    host: 'linux-ci-03',
    room: 'infra-audit',
    plans: [
      {
        id: 'p-audit',
        title: 'sweep env reads',
        status: 'open',
        drawsUsed: 1,
        drawsCeiling: null,
        budgetMicros: null,
        spentMicros: 40_000,
        sessions: [
          {
            id: 's-audit',
            model: 'grok-4.6',
            branch: 'audit/env-reads',
            harness: 'grok',
            status: 'running',
            ctxPct: 0.09,
            spendMicros: 40_000,
            ageMin: 4,
            certified: false,
          },
        ],
      },
    ],
  },
];

/** micro-dollars → $x.xx */
export function fmtMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/* NOTE: the org/team roll-up mock (`TEAMS`/`Team`/`TeamMember`) was removed
   during the phase-5 decomposition — the HANDOFF flagged it "may already be
   dead — verify before porting", and a tree-wide grep confirmed it had no
   readers. The higher-altitude org roll-up, when it exists, binds to a real
   source and does not need this literal to scaffold it. */

/* A REAL unified diff — the exact text `git diff` emits for this branch, complete
   (not streamed into being). The right pane parses and renders this the way any
   diff viewer would: two line-number gutters, per-file counts, syntax highlight.
   The last file is the off-scope drift into auth the covenant surface must catch. */
export const INVOICE_DIFF = `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
index 3a1f2b1..9c4e7a2 100644
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -1,6 +1,7 @@
 import type { Invoice } from './types'
+import { StreamingTotal } from './streaming-total'

 /** Sum an invoice's line items, in micros. */
 export function invoiceTotal(invoice: Invoice): number {
   const lines = invoice.lines
@@ -9,8 +10,8 @@ export function invoiceTotal(invoice: Invoice): number {
   if (lines.length === 0) return 0

-  let total = 0
-  for (const line of lines) {
-    total += line.amountMicros
-  }
-  return total
+  const totals = new StreamingTotal()
+  for (const line of lines) {
+    totals.add(line.amountMicros)
+  }
+  return totals.settle()
 }
diff --git a/src/billing/invoice.test.ts b/src/billing/invoice.test.ts
index 1122aa0..77abf30 100644
--- a/src/billing/invoice.test.ts
+++ b/src/billing/invoice.test.ts
@@ -4,3 +4,8 @@ describe('invoiceTotal', () => {
   it('sums a single line', () => {
     expect(invoiceTotal(one)).toBe(100)
   })
+
+  it('accumulates without a running mutable', () => {
+    expect(streamTotal([100, 250])).toBe(350)
+  })
 })
diff --git a/src/auth/session.ts b/src/auth/session.ts
index 55dd001..66ee112 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -20,6 +20,10 @@ export interface Session {
   role: Role
 }

+export function elevate(session: Session) {
+  session.role = 'admin' // to read all invoices
+  return session
+}
`;

export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** files that were not in the plan's scope read as a concern */
  readonly offScope?: boolean;
}

interface StreamStep {
  readonly atMs: number;
  readonly phase?: SessionPhase;
  readonly line?: DiffLine;
  /** a surfaced concern the human is meant to catch */
  readonly concern?: string;
}

/* The scripted develop-over-time PR. Phases advance, hunks land, and at ~7s the
   agent drifts off-scope into an auth file — the moment the whole surface exists
   to make catchable BEFORE the remaining work is written on a bad foundation. */
const SCRIPT: readonly StreamStep[] = [
  { atMs: 0, phase: 'planning' },
  { atMs: 900, line: { kind: 'file', text: 'src/billing/invoice.ts' } },
  { atMs: 1200, phase: 'writing' },
  { atMs: 1500, line: { kind: 'hunk', text: '@@ totals accumulation @@' } },
  { atMs: 1800, line: { kind: 'del', text: 'let total = 0' } },
  { atMs: 2100, line: { kind: 'add', text: 'const totals = new StreamingTotal()' } },
  {
    atMs: 2600,
    line: { kind: 'add', text: 'for (const line of invoice.lines) totals.add(line.amountMicros)' },
  },
  { atMs: 3200, line: { kind: 'ctx', text: 'return totals.settle()' } },
  { atMs: 3800, line: { kind: 'file', text: 'src/billing/invoice.test.ts' } },
  { atMs: 4100, line: { kind: 'hunk', text: '@@ streaming totals @@' } },
  {
    atMs: 4400,
    line: { kind: 'add', text: "it('accumulates without a running mutable', () => {" },
  },
  { atMs: 4900, line: { kind: 'add', text: '  expect(streamTotal([100, 250])).toBe(350)' } },
  { atMs: 5300, line: { kind: 'add', text: '})' } },
  { atMs: 6000, phase: 'testing' },
  { atMs: 6600, line: { kind: 'file', text: 'src/billing/invoice.ts' } },
  { atMs: 6900, phase: 'writing' },
  {
    atMs: 7200,
    line: { kind: 'file', text: 'src/auth/session.ts', offScope: true },
    concern: 'touching src/auth/session.ts — outside this plan’s scope (billing)',
  },
  {
    atMs: 7600,
    line: { kind: 'add', text: 'export function elevate(session: Session) {', offScope: true },
  },
  {
    atMs: 8000,
    line: { kind: 'add', text: '  session.role = "admin" // to read all invoices', offScope: true },
  },
];

export interface StreamState {
  readonly phase: SessionPhase;
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  readonly files: number;
  readonly elapsedMs: number;
  readonly spendMicros: number;
  readonly concern: string | null;
}

const EMPTY: StreamState = {
  phase: 'planning',
  lines: [],
  added: 0,
  removed: 0,
  files: 0,
  elapsedMs: 0,
  spendMicros: 0,
  concern: null,
};

/* Replays the script against a wall clock, appending as time passes. `steering`
   freezes the stream where it is — the point of the intervention is that the
   remaining (bad) work never gets written. */
export function useMockPRStream(steering: boolean): StreamState {
  const [state, setState] = useState<StreamState>(EMPTY);
  const startRef = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (steering) return; // hold the stream where it stands
    startRef.current ??= performance.now();
    const tick = () => {
      const start = startRef.current ?? performance.now();
      const elapsed = performance.now() - start;
      const due = SCRIPT.filter((s) => s.atMs <= elapsed);
      const lines: DiffLine[] = [];
      let phase: SessionPhase = 'planning';
      let concern: string | null = null;
      let files = 0;
      for (const step of due) {
        if (step.phase) phase = step.phase;
        if (step.concern) concern = step.concern;
        if (step.line) {
          lines.push(step.line);
          if (step.line.kind === 'file') files += 1;
        }
      }
      const last = SCRIPT[SCRIPT.length - 1]?.atMs ?? 0;
      if (elapsed >= last + 1200 && phase === 'writing') phase = 'proposed';
      const added = lines.filter((l) => l.kind === 'add').length;
      const removed = lines.filter((l) => l.kind === 'del').length;
      setState({
        phase,
        lines,
        added,
        removed,
        files,
        elapsedMs: Math.min(elapsed, last + 1200),
        spendMicros: Math.round(Math.min(elapsed, last + 1200) * 340), // ~$0.34/s, illustrative
        concern,
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [steering]);

  return state;
}
