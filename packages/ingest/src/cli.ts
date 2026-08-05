#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ghClient } from './gh.js';
import { serializeCorpus } from './jsonl.js';
import { markdownToMessages } from './markdown.js';
import { buildCorpus } from './pipeline.js';
import { getSource, SOURCES, sourceIds } from './sources.js';
import { corpusStats, formatStats } from './stats.js';
import { validateCorpusText } from './validate.js';

/**
 * `atrium-ingest` — conversations in, canonical JSONL out.
 *
 * Files in, files out: no database, no interpretation, no UI. Rerunning a
 * fetch overwrites the corpus with byte-identical content, which is what makes
 * the corpora safe to commit and diff.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/ingest/{src,dist}` → repository root. */
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const USAGE = `atrium-ingest — conversations in, canonical JSONL out

Usage
  pnpm ingest <source>                fetch a registered thread and write its corpus
  pnpm ingest all                     fetch every registered thread
  pnpm ingest list                    list registered sources
  pnpm ingest markdown <file>         convert a pasted markdown transcript
  pnpm ingest validate <file...>      validate committed JSONL corpora

Options
  --out <path>        write somewhere other than the registered path
  --stdout            write JSONL to stdout instead of a file
  --check             do not write; fail if the file would change (idempotence gate)
  --source-id <id>    id namespace for a markdown transcript (default: file basename)
  --default-ts <ts>   timestamp for a first markdown message that has none
  --default-offset <o>  offset for markdown timestamps written without one (default: Z)
  -h, --help          this text

Sources
${Object.values(SOURCES)
  .map((source) => `  ${source.id.padEnd(20)} [${source.role}] ${source.title}`)
  .join('\n')}
`;

type WriteOutcome = 'created' | 'unchanged' | 'rewritten';

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeCorpus(path: string, jsonl: string): Promise<WriteOutcome> {
  const existing = await readIfPresent(path);
  if (existing === jsonl) return 'unchanged';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonl, 'utf8');
  return existing === undefined ? 'created' : 'rewritten';
}

function resolveOut(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function display(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith('..') ? path : rel;
}

interface Options {
  out?: string | undefined;
  stdout: boolean;
  check: boolean;
  sourceId?: string | undefined;
  defaultTs?: string | undefined;
  defaultOffset?: string | undefined;
}

/** Human-facing output goes to stderr whenever stdout is carrying data. */
function reporter(options: Options): (line: string) => void {
  return options.stdout ? (line) => console.error(line) : (line) => console.info(line);
}

async function emit(
  jsonl: string,
  outPath: string,
  options: Options,
  say: (line: string) => void,
): Promise<number> {
  if (options.stdout) {
    process.stdout.write(jsonl);
    return 0;
  }
  if (options.check) {
    const existing = await readIfPresent(outPath);
    if (existing === undefined) {
      say(`✗ ${display(outPath)} does not exist`);
      return 1;
    }
    if (existing !== jsonl) {
      say(`✗ ${display(outPath)} would change`);
      return 1;
    }
    say(`✓ ${display(outPath)} is byte-identical`);
    return 0;
  }
  const outcome = await writeCorpus(outPath, jsonl);
  say(`${outcome === 'unchanged' ? '✓' : '→'} ${display(outPath)} (${outcome})`);
  return 0;
}

async function runSource(id: string, options: Options): Promise<number> {
  const source = getSource(id);
  const say = reporter(options);
  say(`${source.id}: ${source.title}`);
  const client = ghClient();
  const { messages, jsonl } = await buildCorpus(client, source);
  const outPath = resolveOut(options.out ?? source.out);
  const code = await emit(jsonl, outPath, options, say);
  say(formatStats(corpusStats(messages)));
  return code;
}

async function runAll(options: Options): Promise<number> {
  if (options.out !== undefined) throw new Error('--out cannot be combined with `all`');
  let worst = 0;
  for (const id of sourceIds()) {
    worst = Math.max(worst, await runSource(id, options));
  }
  return worst;
}

async function runMarkdown(file: string | undefined, options: Options): Promise<number> {
  if (!file) throw new Error('usage: pnpm ingest markdown <file>');
  const say = reporter(options);
  const inputPath = resolve(process.cwd(), file);
  const source = await readFile(inputPath, 'utf8');
  const sourceId =
    options.sourceId ?? (inputPath.split('/').pop() ?? 'transcript').replace(/\.[^.]+$/, '');
  const messages = markdownToMessages(source, {
    sourceId,
    ...(options.defaultTs !== undefined ? { defaultTs: options.defaultTs } : {}),
    ...(options.defaultOffset !== undefined ? { defaultOffset: options.defaultOffset } : {}),
  });
  const jsonl = serializeCorpus(messages, sourceId);

  if (options.out === undefined && !options.stdout) {
    process.stdout.write(jsonl);
    console.error(formatStats(corpusStats(messages)));
    return 0;
  }
  const outPath = resolveOut(options.out ?? join('corpora', `${sourceId}.jsonl`));
  const code = await emit(jsonl, outPath, options, say);
  say(formatStats(corpusStats(messages)));
  return code;
}

async function runValidate(files: string[]): Promise<number> {
  const targets = files.length > 0 ? files : Object.values(SOURCES).map((source) => source.out);
  let failures = 0;
  for (const file of targets) {
    const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
    const text = await readFile(path, 'utf8');
    const { messages, issues } = validateCorpusText(text);
    if (issues.length === 0) {
      console.info(`✓ ${display(path)} — ${messages.length} messages`);
      console.info(formatStats(corpusStats(messages)));
    } else {
      failures++;
      console.error(`✗ ${display(path)} — ${issues.length} issue(s)`);
      for (const issue of issues.slice(0, 50)) {
        console.error(`    line ${issue.line}: [${issue.code}] ${issue.message}`);
      }
    }
  }
  return failures === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      stdout: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'source-id': { type: 'string' },
      'default-ts': { type: 'string' },
      'default-offset': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const options: Options = {
    out: values.out,
    stdout: values.stdout === true,
    check: values.check === true,
    sourceId: values['source-id'],
    defaultTs: values['default-ts'],
    defaultOffset: values['default-offset'],
  };

  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    console.info(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }

  switch (command) {
    case 'list':
      for (const source of Object.values(SOURCES)) {
        console.info(
          `${source.id}  [${source.role}]\n  ${source.title}\n  ${source.note}\n  → ${source.out}`,
        );
      }
      return 0;
    case 'all':
      return runAll(options);
    case 'markdown':
      return runMarkdown(rest[0], options);
    case 'validate':
      return runValidate(rest);
    default:
      return runSource(command, options);
  }
}

/** Run only when this file is the process entry point, never when imported. */
const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Exit code before description. `instanceof` runs a Proxy's
      // `getPrototypeOf` trap and `String()` runs `Symbol.toPrimitive`, so a
      // rejection travelling up from `gh` or from the filesystem could throw on
      // the line above the assignment and leave a failed run reporting success
      // — the fail-open shape round 9 swept for. Ordering rather than a shared
      // helper here: `@atrium/ingest` must not take a dependency on
      // `@atrium/auth`, and ordering is what secures the exit code.
      process.exitCode = 1;
      console.error(error instanceof Error ? error.message : String(error));
    });
}
