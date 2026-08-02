import { generateObject, NoObjectGeneratedError } from 'ai';
import { ExtractionOutput, ExtractionWireSchema } from './extraction.js';

/**
 * The seam between the interpretation worker and a model.
 *
 * One method, and it is deliberately the *whole* call: the worker decides which
 * tier to use before it gets here (`escalation.ts`, deterministic, pre-call),
 * assembles the prompt before it gets here (`prompt.ts`), and judges the output
 * after it gets here (`packages/core`). What is left is "send these words to
 * this model id and give me back a parsed object or an error" — which is
 * exactly what a test needs to be able to replace.
 *
 * The AI SDK implementation below is one line of real logic and a lot of error
 * classification, and that ratio is the point: everything with a decision in it
 * lives somewhere a unit test can reach without a network.
 */

export interface InterpretationRequest {
  /** The model id, from env. Never a literal in this repository. */
  model: string;
  system: string;
  prompt: string;
  /** Aborts a call that has stopped being worth waiting for. */
  signal?: AbortSignal;
}

export interface InterpretationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** USD, when the gateway reports it. `null` is "not reported", never 0. */
  costUsd: number | null;
}

export interface InterpretationResult {
  output: ExtractionOutput;
  /** The model's object exactly as it arrived, for `interpretations.raw`. */
  raw: unknown;
  usage: InterpretationUsage;
  /** What actually answered, which may not be what was asked for. */
  model: string;
}

export interface InterpretationProvider {
  generate(request: InterpretationRequest): Promise<InterpretationResult>;
}

/**
 * Output the schema refuses.
 *
 * Named so the job can tell "the model said something malformed" — which is
 * retryable and, on exhaustion, a dead-letter — apart from "the database is
 * down", which is also retryable but means something else entirely. Carries the
 * raw text when the SDK could recover it, because a DLQ entry that does not say
 * what the model actually returned is an alert nobody can act on.
 */
export class MalformedModelOutputError extends Error {
  readonly rawText: string | null;

  constructor(message: string, rawText: string | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MalformedModelOutputError';
    this.rawText = rawText;
  }
}

/** Model ids and tier routing. Every value arrives from the environment. */
export interface ModelRouting {
  /** The default pass — every window that fires no escalation trigger. */
  default: string;
  /** The escalation tier — a window a pre-call text trigger fired on. */
  escalation: string;
}

/**
 * The AI SDK provider, through the Vercel AI Gateway (#7).
 *
 * A bare model-id string is the gateway's own routing form in AI SDK v5+, so
 * `INTERPRET_MODEL_DEFAULT=openai/gpt-5.6-luna` reaches the gateway with no
 * provider package imported here and no vendor named in this file. That is the
 * property #7 bought the gateway for: swapping a provider is a config change,
 * and this module cannot tell which one answered.
 */
export function createGatewayProvider(): InterpretationProvider {
  return {
    async generate(request: InterpretationRequest): Promise<InterpretationResult> {
      let result: Awaited<ReturnType<typeof generateObject<typeof ExtractionWireSchema>>>;
      try {
        result = await generateObject({
          model: request.model,
          schema: ExtractionWireSchema,
          system: request.system,
          prompt: request.prompt,
          abortSignal: request.signal,
        });
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          throw new MalformedModelOutputError(
            `the model returned no object matching the extraction schema (finishReason=${error.finishReason ?? 'unknown'})`,
            error.text ?? null,
            { cause: error },
          );
        }
        throw error;
      }

      const parsed = ExtractionOutput.safeParse(result.object);
      if (!parsed.success) {
        // The SDK validated against the wire schema; this is the second parse,
        // against the schema the worker actually believes. They can differ — the
        // wire schema exists to be describable to a model, not to be the truth.
        throw new MalformedModelOutputError(
          `the model's object cleared the wire schema and failed the extraction schema: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
          JSON.stringify(result.object),
        );
      }

      return {
        output: parsed.data,
        raw: result.object,
        usage: readUsage(result),
        model: result.response?.modelId ?? request.model,
      };
    },
  };
}

/**
 * Tokens and, when the gateway reports it, dollars.
 *
 * `costUsd` is `null` rather than `0` when nothing reported it. A cost line
 * that reads `$0.00` because the field was missing is a fabricated receipt, and
 * the smoke run this worker has to produce is a cost claim somebody will act
 * on.
 */
function readUsage(result: {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  providerMetadata?: Record<string, Record<string, unknown>> | undefined;
}): InterpretationUsage {
  const gateway = result.providerMetadata?.gateway;
  const reported = gateway?.cost ?? gateway?.totalCost;
  const costUsd =
    typeof reported === 'number'
      ? reported
      : typeof reported === 'string' && reported.trim() !== '' && Number.isFinite(Number(reported))
        ? Number(reported)
        : null;
  return {
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    totalTokens: result.usage?.totalTokens ?? null,
    costUsd,
  };
}
