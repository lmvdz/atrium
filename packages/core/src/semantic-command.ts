import type {
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
} from './objects.js';

export type SemanticCommand =
  | { readonly command: 'goal'; readonly type: 'objective'; readonly payload: ObjectivePayload }
  | { readonly command: 'decision'; readonly type: 'decision'; readonly payload: DecisionPayload }
  | {
      readonly command: 'question';
      readonly type: 'open_question';
      readonly payload: OpenQuestionPayload;
    }
  | {
      readonly command: 'commitment';
      readonly type: 'commitment';
      readonly payload: CommitmentPayload;
    }
  | { readonly command: 'claim'; readonly type: 'claim'; readonly payload: ClaimPayload };

/**
 * Parse the deliberately small authored-command grammar.
 *
 * The full message remains canonical speech. This function only derives the
 * proposed semantic payload from the text after the command token. Unknown
 * commands and commands without content are ordinary messages.
 */
export function parseSemanticCommand(body: string, actorId: string): SemanticCommand | null {
  const match = /^\/(goal|decision|question|commitment|claim)[ \t]+([\s\S]*\S)[ \t]*$/.exec(body);
  if (!match) return null;
  const command = match[1] as SemanticCommand['command'];
  const content = match[2]?.trim();
  if (!content) return null;

  switch (command) {
    case 'goal':
      return { command, type: 'objective', payload: { title: content, status: 'open' } };
    case 'decision':
      return {
        command,
        type: 'decision',
        payload: { statement: content, decidedBy: null, status: 'active' },
      };
    case 'question':
      return { command, type: 'open_question', payload: { question: content, status: 'open' } };
    case 'commitment':
      return {
        command,
        type: 'commitment',
        payload: { statement: content, owner: actorId, due: null, status: 'open' },
      };
    case 'claim':
      return {
        command,
        type: 'claim',
        payload: { statement: content, claimant: actorId, verification: 'unverified' },
      };
  }
}
