import { spawn } from 'node:child_process';
import type { GitHubClient } from './github-thread.js';

/**
 * A `GitHubClient` backed by the `gh` CLI.
 *
 * `gh` is the transport rather than raw `fetch` because it already holds the
 * user's credentials — no token plumbing, and an authenticated 5000/hour rate
 * limit instead of 60. The interface is narrow on purpose: swapping in a
 * `fetch` client (or a recorded fixture, as the tests do) touches nothing else.
 */

export interface GhOptions {
  /** Path to the CLI. */
  bin?: string;
  /** Attempts per request, including the first. */
  attempts?: number;
  /** Base delay for the linear backoff between attempts, in ms. */
  retryDelayMs?: number;
  /** Hard timeout per request, in ms. */
  timeoutMs?: number;
}

const DEFAULTS = { bin: 'gh', attempts: 3, retryDelayMs: 2000, timeoutMs: 60_000 } as const;

class GhError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

function run(
  bin: string,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new GhError(`${bin} ${args[0] ?? ''} timed out after ${timeoutMs}ms`, null, stderr));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GhError(`failed to run ${bin}: ${error.message}`, null, stderr));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new GhError(`${bin} exited with code ${code}: ${stderr.trim()}`, code, stderr));
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A GraphQL 200 can still carry errors. Surfacing them as failures keeps a
 * partial page from being silently serialised into a corpus.
 */
function assertNoGraphqlErrors(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return;
  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub GraphQL returned errors: ${JSON.stringify(errors)}`);
  }
}

export function ghClient(options: GhOptions = {}): GitHubClient {
  const bin = options.bin ?? DEFAULTS.bin;
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const retryDelayMs = options.retryDelayMs ?? DEFAULTS.retryDelayMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

  const call = async (args: string[], input?: string): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const stdout = await run(bin, args, input, timeoutMs);
        const payload: unknown = JSON.parse(stdout);
        assertNoGraphqlErrors(payload);
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
      }
    }
    throw lastError;
  };

  return {
    rest: (path) =>
      call(['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', path]),
    graphql: (query, variables) =>
      call(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })),
  };
}
