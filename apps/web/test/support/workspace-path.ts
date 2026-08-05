import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/** Resolve a checked-in file from the pnpm workspace, independent of test cwd. */
export function workspacePath(...parts: string[]): string {
  let directory = process.cwd();
  const root = parse(directory).root;
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    if (directory === root) throw new Error('pnpm workspace root not found');
    directory = dirname(directory);
  }
  return join(directory, ...parts);
}
