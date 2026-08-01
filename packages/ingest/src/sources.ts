import type { ThreadRef } from './github-thread.js';

/**
 * The registered corpora (issue #2's resolution, as amended after #20 round 1).
 *
 * All three are public, real, decision-dense conversations, so nothing here
 * needs privacy handling. The registry is data, not code paths: adding a thread
 * is one entry, and `pnpm ingest <id>` picks it up.
 */

export type SourceKind = 'github-issue' | 'github-discussion';

/**
 * What a corpus is *for*. Round 1 had a single `evalOnly` boolean, which could
 * not express "committed, exercised, but not the thing we demo with".
 */
export type SourceRole =
  /** The threaded conversation the replay UI is built and shown against. */
  | 'demo'
  /** Committed and tested, but not the showcase. */
  | 'sample'
  /** Reserved for the interpretation-quality golden set. Never demoed, never tuned on. */
  | 'eval-holdout';

export interface SourceDefinition extends ThreadRef {
  id: string;
  kind: SourceKind;
  role: SourceRole;
  /** Output path, relative to the repository root. */
  out: string;
  title: string;
  /** Why this thread, in one line. */
  note: string;
}

export const SOURCES: Record<string, SourceDefinition> = {
  'nextjs-isr': {
    id: 'nextjs-isr',
    kind: 'github-discussion',
    role: 'demo',
    owner: 'vercel',
    repo: 'next.js',
    number: 11552,
    out: 'corpora/nextjs-isr.jsonl',
    title: 'Next.js discussion #11552 — RFC: Incremental Static Regeneration',
    note: 'A two-year RFC-to-shipped-feature argument, deeply threaded: pointed critique, revised proposals, resolutions.',
  },
  ts9998: {
    id: 'ts9998',
    kind: 'github-issue',
    role: 'sample',
    owner: 'microsoft',
    repo: 'TypeScript',
    number: 9998,
    out: 'corpora/ts9998.jsonl',
    title: 'TypeScript #9998 — Trade-offs in Control Flow Analysis',
    note: 'A decade-long multi-party design argument. Flat, because GitHub issues carry no threading — the REST path’s sample.',
  },
  'holdout-nextjs-rfc': {
    id: 'holdout-nextjs-rfc',
    kind: 'github-discussion',
    role: 'eval-holdout',
    owner: 'vercel',
    repo: 'next.js',
    number: 37136,
    out: 'corpora/holdout-nextjs-rfc.jsonl',
    title: 'Next.js discussion #37136 — RFC: Layouts',
    note: 'Threaded RFC feedback. Held out of demo use for interpretation eval.',
  },
};

export function sourceIds(): string[] {
  return Object.keys(SOURCES).sort();
}

export function sourcesWithRole(role: SourceRole): SourceDefinition[] {
  return Object.values(SOURCES).filter((source) => source.role === role);
}

/** The one corpus the replay UI demos against. */
export function demoSource(): SourceDefinition {
  const demo = sourcesWithRole('demo');
  const only = demo[0];
  if (demo.length !== 1 || !only) {
    throw new Error(`expected exactly one demo source, found ${demo.length}`);
  }
  return only;
}

export function getSource(id: string): SourceDefinition {
  const source = SOURCES[id];
  if (!source) {
    throw new Error(`unknown source ${JSON.stringify(id)} — known: ${sourceIds().join(', ')}`);
  }
  return source;
}
