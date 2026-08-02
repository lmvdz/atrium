import { expect } from 'vitest';

/**
 * Assert that a statement was refused by a *named* database constraint.
 *
 * The name matters. Drizzle wraps a driver error in a `Failed query: ...`
 * message and hangs the real one off `cause`, so a plain `rejects.toThrow(/…/)`
 * matches the wrapper and passes for the wrong reason — or, worse, passes
 * because some unrelated statement in the setup failed. Walking the cause chain
 * and reading postgres-js's `constraint_name` is the difference between "this
 * threw" and "Postgres refused it, by this rule".
 */
export async function violatesConstraint(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(describeError(error), `expected constraint "${name}"`).toContain(name);
    return;
  }
  throw new Error(`expected constraint "${name}" to be violated, but the statement succeeded`);
}

/** Every message, constraint name and detail down the cause chain. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const pg = current as Error & {
      constraint_name?: string;
      constraint?: string;
      detail?: string;
      code?: string;
    };
    parts.push(current.message);
    for (const field of [pg.constraint_name, pg.constraint, pg.detail, pg.code]) {
      if (field) parts.push(field);
    }
    current = current.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join(' | ');
}
