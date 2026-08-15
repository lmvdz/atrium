/* Shared types + small constants for the molding surface, extracted from the
   original one-file MoldingSurface so the per-pane files (NavTree, ChatBlock,
   ArtifactPane, …) can each own one concern without colliding on a monolith.

   NOTHING here binds real data — the data itself lives behind the typed seams in
   `seams.ts`. These are the shapes the seams and the panes agree on. */

import type { SessionDiff } from '@atrium/db';
import type { DiffLine } from './mock';

export type { DiffLine } from './mock';

/* A node in the tree. Selecting one molds the center to its associated block. */
export type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'plan'; id: string }
  | { kind: 'session'; id: string };

/* The right split pane HOSTS artifacts. An artifact's KIND selects its renderer
   (diff → a real git-diff viewer, doc/plan → markdown); switching artifacts is
   switching what's hosted, never picking a renderer type. */
export type ArtifactKind = 'diff' | 'doc' | 'plan';
export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string; // the artifact's own name (a branch, a doc, a plan)
  sub: string; // a short qualifier shown beside the title
  /**
   * Whether a human has CERTIFIED this artifact's reading. The `~`/`✓` glyph is
   * DERIVED from this through the shipped `<Glyph>` (never a literal glyph in
   * mock content — the covenant's glyph-source rule). `undefined`/false ⇒ `~`,
   * the machine's own draft; a doc note carries no epistemic mark at all.
   */
  certified?: boolean;
  /**
   * The SERVER-PRE-STRUCTURED diff (#145), when `kind === 'diff'` — the shape the
   * shipped `ReviewPane` `DiffView` renders. The client never parses a `git diff`
   * string; the producer already structured it. SEAM(#159): today a real-typed
   * fixture, tomorrow the session's settle-receipt diff.
   */
  sessionDiff?: SessionDiff;
  md?: string; // markdown source, when kind === 'doc' | 'plan'
}

/* A comment is ANCHORED — to a diff line (`path:newNo`) or to a prose quote —
   so it lives where it was made, not in an undifferentiated pile at the bottom. */
export interface Comment {
  id: number;
  artifactId: string;
  anchor: string;
  quote: string;
  text: string;
}
/* a comment being composed — portaled live into the chat as the user types. */
export interface CommentDraft {
  quote: string;
  text: string;
}

export type ChatKind = 'system' | 'agent' | 'human';
export type StepKind = 'thought' | 'search' | 'read' | 'edit' | 'command' | 'output' | 'message';

export interface TurnStep {
  kind: StepKind;
  text?: string;
  edit?: { file: string; lines: readonly DiffLine[] };
  command?: string;
}
export interface TurnData {
  summary: string;
  spend: string;
  steps: readonly TurnStep[];
  /** the turn's final message — ALWAYS shown, connected to the thread; the middle
      (steps) is what folds, not this. */
  conclusion?: { text: string; reply?: { who: string; text: string } };
}
export interface ChatMsg {
  id: string;
  time: string;
  kind: ChatKind;
  who?: string;
  text?: string;
  /**
   * A system line that reports a SETTLED reading a human has certified. The `✓`
   * is derived from this by the conversation model (`systemSettlementState`) and
   * rendered by the shipped `SystemRow` `<Glyph>` — the covenant's glyph-source
   * rule: certification is a STATE, never a literal glyph in the text.
   */
  certified?: boolean;
  /** an agent TURN — its whole tool-call history, folded into one accordion */
  turn?: TurnData;
  /** an inline image (screenshot, chart, paste) */
  image?: { src: string; alt: string };
  /** a threaded reply pinned under this message, on a specific span */
  reply?: { who: string; text: string };
}

/* who is on this thread — the human, the agents that have spoken, plus the live
   collaborator. */
export interface Participant {
  who: string;
  kind: ChatKind;
}

/* Keep password managers off the chat field. `data-1p-ignore` is 1Password's own
   opt-out, `data-lpignore` LastPass's; `autoComplete=off` + a non-credential name
   covers the rest. */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const;

export const PHASE_LABEL: Record<string, string> = {
  planning: 'reading',
  writing: 'writing',
  testing: 'running tests',
  proposed: 'proposed',
  steering: 'paused — you have the floor',
};

export const STEP_TAG: Record<StepKind, string> = {
  thought: 'think',
  search: 'grep',
  read: 'read',
  edit: 'edit',
  command: 'run',
  output: 'out',
  message: 'says',
};

export const SLASH_COMMANDS: readonly [string, string][] = [
  ['/goal', 'stage an objective for review'],
  ['/decision', 'stage a decision for review'],
  ['/question', 'stage an open question for review'],
  ['/commitment', 'stage your commitment for review'],
  ['/claim', 'stage your claim for review'],
];
export const MENTION_TARGETS: readonly [string, string][] = [
  ['hexi', 'agent · billing-rewrite'],
  ['mira', 'agent · search-relevance'],
  ['vale', 'agent · infra-audit'],
  ['call', 'the live agent'],
];
