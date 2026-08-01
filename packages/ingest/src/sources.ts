import type { ThreadRef } from './github-thread.js';

/**
 * The registered corpora (issue #2's resolution).
 *
 * Both are public, real, decision-dense conversations, so nothing here needs
 * privacy handling. The registry is data, not code paths: adding a thread is
 * one entry, and `pnpm ingest <id>` picks it up.
 */

export type SourceKind = 'github-issue' | 'github-discussion';

export interface SourceDefinition extends ThreadRef {
  id: string;
  kind: SourceKind;
  /** Output path, relative to the repository root. */
  out: string;
  title: string;
  /** Why this thread, in one line. */
  note: string;
  /**
   * Eval holdout: reserved for the interpretation-quality golden set, so
   * prompts are never tuned on the corpus they are scored against.
   */
  evalOnly: boolean;
}

export const SOURCES: Record<string, SourceDefinition> = {
  ts9998: {
    id: 'ts9998',
    kind: 'github-issue',
    owner: 'microsoft',
    repo: 'TypeScript',
    number: 9998,
    out: 'corpora/ts9998.jsonl',
    title: 'TypeScript #9998 — Trade-offs in Control Flow Analysis',
    note: 'A decade-long multi-party design argument: decisions, supersessions, open questions, commitments.',
    evalOnly: false,
  },
  'holdout-nextjs-rfc': {
    id: 'holdout-nextjs-rfc',
    kind: 'github-discussion',
    owner: 'vercel',
    repo: 'next.js',
    number: 37136,
    out: 'corpora/holdout-nextjs-rfc.jsonl',
    title: 'Next.js discussion #37136 — RFC: Layouts',
    note: 'Threaded RFC feedback with real reply structure. Held out of demo use for interpretation eval.',
    evalOnly: true,
  },
};

export function sourceIds(): string[] {
  return Object.keys(SOURCES).sort();
}

export function getSource(id: string): SourceDefinition {
  const source = SOURCES[id];
  if (!source) {
    throw new Error(`unknown source ${JSON.stringify(id)} — known: ${sourceIds().join(', ')}`);
  }
  return source;
}
