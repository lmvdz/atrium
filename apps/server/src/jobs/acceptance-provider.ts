import type { ExtractedReading } from './extraction.js';
import type {
  InterpretationProvider,
  InterpretationRequest,
  InterpretationResult,
} from './provider.js';

export const ACCEPTANCE_MODEL = 'acceptance/deterministic-v1';

/**
 * No-network model-call substitute for the scripted Phase 2 acceptance run.
 *
 * This is deliberately not a keyword classifier. It understands five exact,
 * one-line fixtures whose prefix says what the scenario is asserting. All
 * other conversation is returned as no readings. The production worker still
 * owns every consequential step after this seam.
 */
export function createAcceptanceProvider(): InterpretationProvider {
  return {
    async generate(request: InterpretationRequest): Promise<InterpretationResult> {
      if (request.model !== ACCEPTANCE_MODEL) {
        throw new Error(
          `deterministic acceptance provider refuses model ${JSON.stringify(request.model)}; expected ${ACCEPTANCE_MODEL}`,
        );
      }
      if (!request.sourceMessages) {
        throw new Error(
          'deterministic acceptance provider requires database-derived sourceMessages',
        );
      }
      const readings = request.sourceMessages.flatMap(readingFor);
      return {
        output: { readings },
        raw: { source: ACCEPTANCE_MODEL, readings },
        usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0 },
        model: ACCEPTANCE_MODEL,
      };
    },
  };
}

type SourceMessage = NonNullable<InterpretationRequest['sourceMessages']>[number];

function readingFor(message: SourceMessage): ExtractedReading[] {
  const mention =
    /^Mention for [0-9a-f-]{36}: ((?:Decision|Objective|Open question|Claim): \S[^\r\n]*)$/.exec(
      message.body,
    );
  const semanticText = mention?.[1] ?? message.body;
  const own = /^(Decision|Objective|Open question|Claim): (\S[^\r\n]*)$/.exec(semanticText);
  if (own) {
    const type = {
      Decision: 'decision',
      Objective: 'objective',
      'Open question': 'open_question',
      Claim: 'claim',
    }[own[1] as string] as ExtractedReading['type'];
    return [reading(message, type, message.body, type === 'claim' ? message.authorId : null)];
  }

  const commitment = /^Commitment for ([0-9a-f-]{36}): (\S[^\r\n]*)$/.exec(message.body);
  if (commitment) {
    return [reading(message, 'commitment', message.body, commitment[1] as string)];
  }
  return [];
}

function reading(
  message: SourceMessage,
  type: ExtractedReading['type'],
  text: string,
  subject: string | null,
): ExtractedReading {
  return {
    type,
    text,
    subject,
    confidence: 0.95,
    quote: message.body,
    messageIds: [message.id],
  };
}
