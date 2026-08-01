/**
 * A restricted parser for the `run:` scripts the workflow policy protects.
 *
 * ── WHY THIS EXISTS (round 6) ───────────────────────────────────────────────
 * Round 5 replaced substring tests with a regular expression that recognised a
 * command "at the start of a line, optionally behind a package-manager `exec`":
 *
 *     (?:^|\n)[^\S\n]*(?:(?:pnpm|npm|npx|yarn|bunx?)[^\n]*?\bexec\s+)?
 *
 * The `[^\n]*?` between the package manager and `exec` is arbitrary text, so
 *
 *     pnpm --version && echo exec node scripts/ci/assert-floor-ratchet.mjs
 *
 * satisfies it: the regex consumes through `echo exec ` and matches the tail.
 * Every protected step and every prerequisite was defeatable by that one-line
 * rewrite — the ratchet, the baseline fetch, the migrations, all of them. The
 * fix is not a better regex. A regex cannot tell command position from text that
 * happens to sit at the start of a line, because command position is a fact
 * about a *parse*.
 *
 * The same round's line-start rule was wrong in the other direction too, and a
 * guard that is wrong in both directions is worse than the one it replaced: it
 * rejected `(git fetch …)`, `true && git fetch …`, `VAR=x git fetch …`,
 * `sudo …`, `timeout 30 …`, `command git …`, `xargs … git …` and any command
 * spread over a backslash continuation — all of them genuine invocations — while
 * accepting `git fetch … &`, which does not establish that the fetch finished
 * before the step that depends on it. So this parser answers both questions from
 * one model: which words are in command position, and does the command complete.
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────
 * A tokenizer for the subset of POSIX shell these scripts use — quoting,
 * escapes, comments, expansions, redirections, here-documents, operators and
 * subshells — followed by a splitter that yields *simple commands*. It is not a
 * shell: it does not expand anything, evaluate anything, or know what a variable
 * holds. It answers exactly one question per command — "which word is in command
 * position, and what are its arguments" — and answers it structurally.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * Four boundaries, stated rather than discovered later:
 *
 *   1. Reachability is not execution. `false && git fetch …` parses as a genuine
 *      invocation of `git` in command position, and this parser accepts it. So
 *      does `if [ -n "$SKIP" ]; then git fetch …; fi`. Whether a command runs on
 *      a given path is semantics; the policy rules are about invocation *shape*.
 *      That is a deliberate widening — round 5 rejected every conditional form,
 *      including the honest ones — and the cost is stated in ci.yml's scope
 *      block rather than papered over.
 *
 *      ── ROUND 3 OF #40: THE COST CAME DUE ───────────────────────────────────
 *      `false && node scripts/ci/assert-page-serves.mjs; true` satisfies every
 *      recognition rule, skips the assertion, and exits the step green. The
 *      widening above is still right about *recognition* — `sudo git fetch …`
 *      and `git -c x=y fetch …` are honest invocations and must be seen — and it
 *      was wrong to leave reachability entirely unasked. So this file now also
 *      reports the script's *shape*: `scriptShape()` below says which control
 *      operators and reserved words a script uses, and `singleCommandProblems()`
 *      turns that into the question "is this one command that always runs".
 *      Recognition and reachability are two questions; the policy asks the
 *      second one only of the steps whose failure is the point (see
 *      `protected-steps-run-one-command` in workflow-policy.mjs).
 *   2. Command substitution is opaque. `$(node scripts/ci/assert-tables.mjs)`
 *      genuinely runs the script, and this parser keeps the substitution as text
 *      inside the word that contains it rather than recursing into it. That
 *      fails *closed*: a gate invoked that way reads as missing and the policy
 *      goes red at the edit. Nothing in this repo invokes a gate for its stdout.
 *   3. A word that expands is opaque for the same reason. `$CMD fetch` has no
 *      recognisable command word; it matches nothing and fails closed.
 *   4. Identity is not provenance. `git` here means "the word `git` in command
 *      position", not "the git binary". A shell function or a PATH entry can
 *      make that word mean anything at all — see `no-command-shadowing` in
 *      workflow-policy.mjs, which bans the obvious spellings and says plainly
 *      that proving executable identity is governance-bound, not solved here.
 */

/** Operators, longest first so `<<<` is never read as `<<` then `<`. */
const OPERATORS = [
  '<<<',
  '<<-',
  '&&',
  '||',
  ';;',
  '|&',
  '>>',
  '>&',
  '&>',
  '>|',
  '<<',
  ';',
  '|',
  '&',
  '(',
  ')',
  '<',
  '>',
  '\n',
];

const REDIRECTS = new Set(['<<<', '<<-', '<<', '>>', '>&', '&>', '>|', '<', '>']);
const HEREDOCS = new Set(['<<', '<<-']);

/**
 * Reserved words that occupy command position without being a command.
 *
 * `if git fetch …; then` runs `git fetch`, and a parser that reads `if` as the
 * command word would miss it. These are skipped so the word after them is read
 * where it actually sits.
 */
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'esac',
  '!',
  '{',
  '}',
  'time',
  'coproc',
]);

/** `for x in …` / `case x in` — the words up to the next separator are not commands. */
const CLAUSE_KEYWORDS = new Set(['for', 'case', 'select']);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

function isBlank(character) {
  return character === ' ' || character === '\t' || character === '\r';
}

function operatorAt(source, index) {
  for (const operator of OPERATORS) {
    if (source.startsWith(operator, index)) return operator;
  }
  return undefined;
}

/**
 * Reads one `$…` or backtick expansion as raw text.
 *
 * The text is kept verbatim inside the word it belongs to — `$(date +%s%3N)`
 * stays `$(date +%s%3N)` — which is what makes `echo "X=$(date …)" >> …` a
 * single argument rather than a nested parse. See boundary 2 above.
 */
function readExpansion(source, start) {
  const character = source[start];
  if (character === '`') {
    let index = start + 1;
    while (index < source.length && source[index] !== '`') {
      index += source[index] === '\\' ? 2 : 1;
    }
    return [
      source.slice(start, Math.min(index + 1, source.length)),
      Math.min(index + 1, source.length),
    ];
  }
  const next = source[start + 1];
  if (next === '(') {
    // `$(( … ))` and `$( … )`, with nesting and quoting inside both.
    let index = start + 2;
    let depth = 1;
    while (index < source.length && depth > 0) {
      const here = source[index];
      if (here === '\\') {
        index += 2;
        continue;
      }
      if (here === "'" || here === '"') {
        const end = source.indexOf(here, index + 1);
        index = end === -1 ? source.length : end + 1;
        continue;
      }
      if (here === '(') depth += 1;
      if (here === ')') depth -= 1;
      index += 1;
    }
    return [source.slice(start, index), index];
  }
  if (next === '{') {
    let index = start + 2;
    let depth = 1;
    while (index < source.length && depth > 0) {
      const here = source[index];
      if (here === '\\') {
        index += 2;
        continue;
      }
      if (here === '{') depth += 1;
      if (here === '}') depth -= 1;
      index += 1;
    }
    return [source.slice(start, index), index];
  }
  // `$NAME`, `$1`, `$$`, or a bare `$`.
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9@*#?$!-]/.exec(source.slice(start));
  if (match) return [match[0], start + match[0].length];
  return ['$', start + 1];
}

/**
 * One word, with the quoting resolved but nothing expanded.
 *
 * `expandable` records whether any `$` or backtick in the word was outside
 * single quotes and unescaped — the difference between `>> "$GITHUB_ENV"`, which
 * appends to the job's environment file, and `>> '$GITHUB_ENV'`, which creates a
 * file called `$GITHUB_ENV` in the working directory and exports nothing.
 */
function readWord(source, start) {
  let index = start;
  let value = '';
  let expandable = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      if (source[index + 1] === '\n') {
        index += 2; // Line continuation: the word carries on over the newline.
        continue;
      }
      value += source[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (character === "'") {
      const end = source.indexOf("'", index + 1);
      value += source.slice(index + 1, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          if (source[index + 1] === '\n') {
            index += 2;
            continue;
          }
          value += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (source[index] === '$' || source[index] === '`') {
          expandable = true;
          const [text, next] = readExpansion(source, index);
          value += text;
          index = next;
          continue;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === '$' || character === '`') {
      expandable = true;
      const [text, next] = readExpansion(source, index);
      value += text;
      index = next;
      continue;
    }
    if (isBlank(character) || operatorAt(source, index) !== undefined) break;
    value += character;
    index += 1;
  }
  return [{ value, expandable }, index];
}

/** Everything up to and including the newline, for a `#` comment. */
function skipComment(source, index) {
  const end = source.indexOf('\n', index);
  return end === -1 ? source.length : end;
}

/**
 * Consumes the bodies of any here-documents opened on the line just ended.
 *
 * A here-doc body is data, not script. `cat <<'EOF'` followed by a line reading
 * `git fetch … refs/heads/main` is a file being written, and a policy that reads
 * it as a fetch is the round-4 `echo` decoy wearing a different hat.
 */
function skipHeredocBodies(source, index, pending) {
  let cursor = index;
  for (const { delimiter, strip } of pending) {
    for (;;) {
      if (cursor >= source.length) return cursor;
      const end = source.indexOf('\n', cursor);
      const line = source.slice(cursor, end === -1 ? source.length : end);
      cursor = end === -1 ? source.length : end + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break;
    }
  }
  pending.length = 0;
  return cursor;
}

/** `{type:'word'|'op'}` tokens for one script. */
function tokenize(source) {
  const tokens = [];
  const pendingHeredocs = [];
  let index = 0;
  let atTokenStart = true;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\' && source[index + 1] === '\n') {
      index += 2;
      continue;
    }
    if (isBlank(character)) {
      index += 1;
      atTokenStart = true;
      continue;
    }
    if (character === '#' && atTokenStart) {
      index = skipComment(source, index);
      continue;
    }
    // `2>`, `1>>`: a leading file descriptor belongs to the redirection.
    const fd = /^\d+(?=[<>])/.exec(source.slice(index));
    if (fd && atTokenStart) {
      index += fd[0].length;
      continue;
    }
    const operator = operatorAt(source, index);
    if (operator !== undefined) {
      tokens.push({ type: 'op', op: operator });
      index += operator.length;
      atTokenStart = true;
      if (operator === '\n' && pendingHeredocs.length > 0) {
        index = skipHeredocBodies(source, index, pendingHeredocs);
      }
      continue;
    }
    const [word, next] = readWord(source, index);
    index = next;
    atTokenStart = false;
    tokens.push({ type: 'word', ...word });
    const previous = tokens.at(-2);
    if (previous?.type === 'op' && HEREDOCS.has(previous.op)) {
      pendingHeredocs.push({ delimiter: word.value, strip: previous.op === '<<-' });
    }
  }
  return tokens;
}

function newCommand() {
  return { raw: [], words: [], assignments: [], redirections: [], background: false };
}

/**
 * Control operators, in the spelling a human would recognise them by.
 *
 * `\n` is deliberately absent: a `run: |` block always ends with one, and a
 * newline between two commands is already visible as `commands.length > 1`.
 * Reporting it as a control operator would make every block scalar look
 * conditional.
 */
const CONTROL_OPERATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')']);

function isSubstantial(command) {
  return (
    command.raw.length > 0 || command.assignments.length > 0 || command.redirections.length > 0
  );
}

/**
 * Every simple command in a script, in order, with the command word first.
 *
 * @param {string} script the text of one `run:` block
 * @returns {{commands: object[], functions: string[], controls: string[], keywords: string[]}}
 */
export function parseScript(script) {
  const tokens = tokenize(String(script ?? ''));
  const commands = [];
  const functions = [];
  const controls = [];
  const keywords = [];
  const listStarts = [];
  let listStart = 0;
  let current = newCommand();
  let pendingRedirect;
  let discarding = false;

  const flush = () => {
    if (isSubstantial(current)) commands.push(current);
    current = newCommand();
    pendingRedirect = undefined;
  };
  const background = () => {
    for (let index = listStart; index < commands.length; index += 1) {
      commands[index].background = true;
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.type === 'op') {
      if (REDIRECTS.has(token.op)) {
        pendingRedirect = token.op;
        continue;
      }
      if (CONTROL_OPERATORS.has(token.op)) controls.push(token.op);
      if (token.op === '(') {
        flush();
        listStarts.push(listStart);
        listStart = commands.length;
        discarding = false;
        continue;
      }
      if (token.op === ')') {
        flush();
        listStart = listStarts.pop() ?? 0;
        discarding = false;
        continue;
      }
      if (token.op === '&') {
        flush();
        background();
        listStart = commands.length;
        discarding = false;
        continue;
      }
      flush();
      if (token.op === ';' || token.op === ';;' || token.op === '\n') {
        listStart = commands.length;
      }
      discarding = false;
      continue;
    }

    if (pendingRedirect !== undefined) {
      current.redirections.push({ op: pendingRedirect, target: token });
      pendingRedirect = undefined;
      continue;
    }

    if (discarding) continue;

    if (current.raw.length === 0) {
      // `name() { … }` and `function name { … }`: a definition, not a call.
      const after = tokens[index + 1];
      const afterThat = tokens[index + 2];
      if (
        after?.type === 'op' &&
        after.op === '(' &&
        afterThat?.type === 'op' &&
        afterThat.op === ')'
      ) {
        functions.push(token.value);
        index += 2;
        continue;
      }
      if (token.value === 'function' && tokens[index + 1]?.type === 'word') {
        functions.push(tokens[index + 1].value);
        index += 1;
        if (tokens[index + 1]?.op === '(' && tokens[index + 2]?.op === ')') index += 2;
        continue;
      }
      if (KEYWORDS.has(token.value)) {
        keywords.push(token.value);
        continue;
      }
      if (CLAUSE_KEYWORDS.has(token.value)) {
        keywords.push(token.value);
        discarding = true;
        continue;
      }
      const assignment = ASSIGNMENT.exec(token.value);
      if (assignment && !token.expandable) {
        current.assignments.push({
          name: assignment[1],
          value: token.value.slice(assignment[0].length),
        });
        continue;
      }
    }

    current.raw.push(token.value);
    current.words.push(token);
  }
  flush();

  for (const command of commands) Object.assign(command, unwrap(command.raw));
  return { commands, functions, controls, keywords };
}

/**
 * Is this script exactly one command that always runs?
 *
 * ── WHY THIS EXISTS (#40 round 3) ───────────────────────────────────────────
 * The round-2 gauntlet: "the workflow and the ledger disagree about what ran,
 * and both report success". `false && node scripts/ci/assert-page-serves.mjs;
 * true` is a genuine invocation in command position — every recognition rule in
 * `workflow-policy.mjs` is satisfied — and the assertion never runs, and the
 * step exits 0. The mutation ledger then recovered the script's *name* from that
 * text and ran it directly, so it certified that the assertion caught its
 * mutation while CI had skipped it. Two halves of one verification stack
 * agreeing on something false.
 *
 * Recognition cannot answer this: `false && x` and `true && x` parse identically
 * and a policy engine does not evaluate shell. The answer is to refuse the
 * *shape* for the steps whose failure is the whole point — a protected step is
 * one command, unconditional, not backgrounded, not in a subshell, with nothing
 * after it to swallow its status. Everything a legitimate invocation needs is
 * still allowed: launchers (`sudo`, `timeout`, `command`, `xargs` as the command
 * word), one-shot assignments, redirections, backslash continuations, and any
 * number of arguments.
 *
 * @param {string} script the text of one `run:` block
 * @returns {string[]} human-readable problems; empty means it is canonical
 */
export function singleCommandProblems(script) {
  const { commands, functions, controls, keywords } = parseScript(script);
  const problems = [];
  const unique = (values) => [...new Set(values)];

  if (commands.length === 0) {
    problems.push('it runs no command at all');
  } else if (commands.length > 1) {
    problems.push(
      `it runs ${commands.length} commands (${commands.map((command) => command.argv[0] ?? '?').join(', ')}); only the first one's failure is guaranteed to fail the step, and only if nothing after it succeeds`,
    );
  }
  if (controls.length > 0) {
    problems.push(
      `it uses the shell control operator(s) ${unique(controls)
        .map((op) => `\`${op}\``)
        .join(', ')}, which decide whether the command runs and whether its exit status survives`,
    );
  }
  if (keywords.length > 0) {
    problems.push(
      `it uses the shell reserved word(s) ${unique(keywords)
        .map((word) => `\`${word}\``)
        .join(', ')}, so the command is inside a construct that can skip it`,
    );
  }
  if (functions.length > 0) {
    problems.push(
      `it defines the shell function(s) ${unique(functions)
        .map((name) => `\`${name}()\``)
        .join(', ')}; a definition is not a call, and a call is a second command`,
    );
  }
  if (commands.some((command) => command.background)) {
    problems.push('it backgrounds the command, so the step reports before it has finished');
  }
  return problems;
}

/**
 * Launchers that run the command in their arguments, and the options of theirs
 * that take a separate value.
 *
 * Round 5 rejected every one of these, which made `sudo git fetch …` and
 * `timeout 30 git fetch …` read as "the fetch is missing". They are unwrapped so
 * the command they launch is seen where it actually is. Each one genuinely
 * *execs* its argument — that is the entry criterion, and it is why `echo` will
 * never appear in this table.
 */
const LAUNCHERS = {
  sudo: { value: ['-u', '-g', '-p', '-U', '-C', '-h', '--user', '--group', '--prompt'] },
  doas: { value: ['-u', '-C'] },
  env: { value: ['-u', '--unset', '--chdir', '-C'], assignments: true },
  command: { value: [], reject: ['-v', '-V', '--version'] },
  builtin: { value: [] },
  exec: { value: ['-a'] },
  nohup: { value: [] },
  setsid: { value: [] },
  stdbuf: { value: ['-i', '-o', '-e'] },
  nice: { value: ['-n'] },
  ionice: { value: ['-c', '-n', '-p'] },
  timeout: { value: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  xargs: {
    value: [
      '-n',
      '-P',
      '-I',
      '-i',
      '-d',
      '-E',
      '-L',
      '-s',
      '-a',
      '--max-args',
      '--max-procs',
      '--replace',
      '--delimiter',
      '--arg-file',
      '--max-lines',
      '--max-chars',
    ],
  },
};

/**
 * Package managers, and the options of theirs that take a separate value.
 *
 * `pnpm --filter @atrium/db exec node …` is how half of this repo's gates are
 * invoked, so the sequence has to be recognised — but only as a real sequence.
 * Between the manager and `exec` this accepts *options only*: an option word, or
 * one of the value-taking options above plus its value. A bare word there ends
 * the unwrap, which is what kills
 *
 *     pnpm --version && echo exec node scripts/ci/assert-floor-ratchet.mjs
 *
 * twice over: the `&&` ends the `pnpm` command before `exec` is ever reached,
 * and even written as one command, `echo` is not an option.
 */
const PACKAGE_MANAGERS = {
  pnpm: {
    value: ['--filter', '-F', '--dir', '-C', '--config', '--reporter', '--use-node-version'],
  },
  npm: { value: ['--prefix', '-w', '--workspace', '--package'] },
  yarn: { value: ['--cwd'] },
  bun: { value: ['--cwd'] },
  npx: { value: ['--package', '-p'], implicitExec: true },
  bunx: { value: ['--package', '-p'], implicitExec: true },
};

/** `exec`, `dlx` and `run` all mean "and now run this". */
const EXEC_WORDS = new Set(['exec', 'dlx', 'run']);

export const LAUNCHER_NAMES = Object.keys(LAUNCHERS);
export const PACKAGE_MANAGER_NAMES = Object.keys(PACKAGE_MANAGERS);

function isOption(word) {
  return word.startsWith('-') && word !== '-' && word !== '--';
}

/**
 * Strips launcher and package-manager prefixes until the real command word is
 * first. Returns the argv unchanged when nothing recognisable wraps it.
 */
function unwrap(argv) {
  let words = argv;
  // The prefix words that were stripped, in order. A rule that means "run
  // through the workspace's package manager" asks about this rather than about
  // `argv[0]`, so `sudo pnpm build` is still a `pnpm build`.
  const via = [];
  for (let guard = 0; guard < 8 && words.length > 0; guard += 1) {
    const head = words[0];
    const launcher = Object.hasOwn(LAUNCHERS, head) ? LAUNCHERS[head] : undefined;
    if (launcher !== undefined) {
      let index = 1;
      let rejected = false;
      while (index < words.length && isOption(words[index])) {
        // `command -v pnpm` looks up a path; it does not run pnpm.
        if ((launcher.reject ?? []).includes(words[index])) rejected = true;
        if (launcher.value.includes(words[index])) index += 1;
        index += 1;
      }
      if (launcher.assignments === true) {
        while (index < words.length && ASSIGNMENT.test(words[index])) index += 1;
      }
      for (let skipped = 0; skipped < (launcher.positional ?? 0); skipped += 1) {
        if (index < words.length) index += 1;
      }
      if (rejected || index >= words.length) return { argv: words, via };
      via.push(head);
      words = words.slice(index);
      continue;
    }
    const manager = Object.hasOwn(PACKAGE_MANAGERS, head) ? PACKAGE_MANAGERS[head] : undefined;
    if (manager !== undefined) {
      let index = 1;
      while (index < words.length && isOption(words[index])) {
        if (manager.value.includes(words[index])) index += 1;
        index += 1;
      }
      // Only options may sit between the manager and the command it runs. A
      // bare word here is not an option, so the unwrap stops and the manager
      // itself stays the command word — which is the whole defence against
      // `pnpm … echo exec node …`.
      if (index >= words.length) return { argv: words, via };
      if (EXEC_WORDS.has(words[index])) index += 1;
      if (index >= words.length) return { argv: words, via };
      via.push(head);
      words = words.slice(index);
      continue;
    }
    return { argv: words, via };
  }
  return { argv: words, via };
}

/** The first argument that is not an option — `node -e X` → `X`. */
export function firstOperand(argv, from = 1) {
  for (let index = from; index < argv.length; index += 1) {
    if (!isOption(argv[index])) return argv[index];
  }
  return undefined;
}

/** The last path segment, so `"$RUNNER_TEMP/actionlint"` is `actionlint`. */
export function basename(word) {
  return String(word ?? '')
    .split('/')
    .pop();
}

/**
 * Every simple command in a script that actually completes before the next step.
 *
 * Backgrounded commands are excluded rather than reported: a prerequisite is a
 * claim that something *finished*, and `git fetch … &` hands the next step a
 * shallow clone with a race in it. Round 5's line-start matcher accepted it.
 */
export function completedCommands(script) {
  return parseScript(script).commands.filter((command) => !command.background);
}
