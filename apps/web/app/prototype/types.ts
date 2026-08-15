/* Shared types + small constants for the molding surface, extracted from the
   original one-file MoldingSurface so the per-pane files (NavTree, ChatBlock,
   ArtifactPane, …) can each own one concern without colliding on a monolith.

   NOTHING here binds real data — the data itself lives behind the typed seams in
   `seams.ts`. These are the shapes the seams and the panes agree on. */

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
  mark?: '~' | '✓';
  diff?: string; // a unified git diff, when kind === 'diff'
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
