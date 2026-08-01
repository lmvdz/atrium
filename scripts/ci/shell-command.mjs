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
  // Whether any part of the word was quoted or escaped. For most words this is
  // noise; for a here-document's *delimiter* it decides whether the body is data
  // or shell-expanded text — see `skipHeredocBodies` and the heredoc problem in
  // `singleCommandProblems`.
  let quoted = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      if (source[index + 1] === '\n') {
        index += 2; // Line continuation: the word carries on over the newline.
        continue;
      }
      quoted = true;
      value += source[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (character === "'") {
      quoted = true;
      const end = source.indexOf("'", index + 1);
      value += source.slice(index + 1, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (character === '"') {
      quoted = true;
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
  return [{ value, expandable, quoted }, index];
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
  const heredocs = [];
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
      const heredoc = {
        delimiter: word.value,
        strip: previous.op === '<<-',
        // An unquoted delimiter means the shell expands the body. This parser
        // skips bodies as data, so an unquoted one is text it is not reading.
        expands: !word.quoted,
      };
      pendingHeredocs.push(heredoc);
      heredocs.push(heredoc);
    }
  }
  return { tokens, heredocs };
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
  const { tokens, heredocs } = tokenize(String(script ?? ''));
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
  return { commands, functions, controls, keywords, heredocs };
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
  const { commands, functions, controls, keywords, heredocs } = parseScript(script);
  const problems = [];
  const unique = (values) => [...new Set(values)];

  // ── AN UNQUOTED HERE-DOCUMENT IS NOT DATA (#40 round 4) ──────────────────
  // Found by the blind review of this round's own fix, and it is a hole in this
  // parser's *stated model* rather than in a rule: `skipHeredocBodies` treats a
  // body as data, which is right — `cat <<'EOF'` followed by a line reading
  // `git fetch …` is a file being written. With the delimiter unquoted the
  // shell expands the body, so
  //
  //     cat > .env <<ENVIRONMENT
  //     LOG_LEVEL=info$(echo "NODE_OPTIONS=--require ./nobble.cjs" >> "$GITHUB_ENV")
  //     ENVIRONMENT
  //
  // runs a command this file never sees and poisons every later step in the
  // job — the sixteenth bypass smuggled through the one construct the parser
  // deliberately does not read. Verified clean against the engine before this.
  // One quote closes it, and the deploy job's `.env` heredoc already had it.
  for (const heredoc of heredocs ?? []) {
    if (heredoc.expands) {
      problems.push(
        `it opens a here-document on \`${heredoc.delimiter}\` with the delimiter unquoted, so the shell expands the body — and this parser reads here-document bodies as data, which means a \`$( … )\` in there is a command nothing in this policy can see. Quote the delimiter (\`<<'${heredoc.delimiter}'\`)`,
      );
    }
  }

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
  for (const command of commands) problems.push(...launcherProblems(command));
  return problems;
}

/**
 * Launchers a protected step may reach its command through, and the options of
 * theirs it may pass.
 *
 * ── WHY THIS IS AN ALLOWLIST (#40 round 4) ──────────────────────────────────
 * Round 3 refused two spellings by name — `xargs`, and a `-b`/`--background`
 * anywhere in a launcher's prefix — and said out loud that it was "a list of
 * spellings rather than a proof". The round-3 gauntlet spent one line proving
 * it: `setsid -f node scripts/ci/assert-page-serves.mjs`. `setsid` was in the
 * recognised-launcher table, so `unwrap()` saw straight through it; `-f` is
 * neither `-b` nor `--background`; and a file whose one line is `setsid -f sleep
 * 30`, run as `bash -e <file>` the way a runner runs a step, exits 0 in three
 * milliseconds. Policy-clean, CI-green, and the assertion's exit status never
 * observed by anything.
 *
 * That was the fifteenth spelling of "invoked is not runs" across #28 and #40,
 * and each of the previous fourteen was closed one at a time by adding it to a
 * list of refusals. A list of ways to evade is unbounded by construction: the
 * sixteenth exists before anybody writes it down. So the polarity is inverted
 * here. A protected step may reach its command through the launchers in this
 * table **and nothing else**, with the options in this table **and no others**.
 * `setsid`, `nohup`, `env`, `exec`, `xargs`, `flock`, `systemd-run`, `nice`,
 * `stdbuf`, `doas`, `builtin`, `ionice` and every launcher nobody has thought of
 * yet are all refused by the same clause, which is the point: the refusal does
 * not have to have heard of them.
 *
 * ── THE HARNESS, WHICH ROUND 4 GOT WRONG ───────────────────────────────────
 * Round 4 measured under `bash --noprofile --norc -eo pipefail -c '<line>'` and
 * called that "the shell a runner uses for a step with no `shell:` key". It is
 * not. A runner writes the step's script to a file and runs `bash -e <file>`;
 * `--noprofile --norc -eo pipefail` is what `shell: bash` asks for, which this
 * workflow never does. The numbers happened to survive the correction — except
 * for the one launcher whose whole entry is about them:
 *
 *     bash --noprofile --norc -eo pipefail -c 'setsid sleep 3'   exit 0,    3ms
 *     bash -e <file containing `setsid sleep 3`>                 exit 0, 3003ms
 *
 * Same machine, same minute, opposite answers. So requirement (b) below names
 * `bash -e <file>`, and every number here was re-taken under it:
 *
 *     setsid -f false                              exit 0,    3ms
 *     setsid sleep 3                               exit 0, 3003ms
 *     flock -n -E 0 <a held lock> false            exit 0,    3ms
 *     timeout 5 false                              exit 1,    4ms
 *     timeout 5 sleep 2                            exit 0, 2004ms
 *     timeout 0 false                              exit 1,    3ms
 *     command false                                exit 1,    1ms
 *     command sleep 2                              exit 0, 2003ms
 *     command -p false                             exit 1,    2ms
 *     nohup false                                  exit 1,    2ms
 *
 * Two of those are worth reading twice. **Bare `setsid` waited here and did not
 * wait under `-c`**, because it execs its argument when the caller is not
 * already a process group leader and forks when it is — so whether the step
 * waits depends on how the runner happened to start the shell, which is not a
 * property the workflow controls or can test. That is no longer an argument
 * from the manual; it is the two lines above. A launcher whose waiting is
 * conditional on its caller fails property 3 whichever way today's measurement
 * came out. And **`nohup` passes all three properties**: it is refused for not
 * being on the list, not for being unsafe. That is the allowlist working as
 * intended — absence is the default, and "nobody has needed it" is a sufficient
 * reason to leave a launcher out.
 *
 * ── WHAT AN ENTRY HAS TO PROVE ──────────────────────────────────────────────
 * Three properties, all three, for the launcher *and* for every option listed
 * beside it. They are the definition of "the step takes the command's exit
 * status", broken into the three ways a launcher can fail to give it:
 *
 *   1. **It execs the command.** The words after it are an argv it runs, not a
 *      string it interprets (`sh -c`) and not a name it looks up (`command -v`).
 *   2. **It runs it exactly once, unconditionally.** Not "once per input line,
 *      which may be zero" (`xargs -r`), not "unless a lock is held" (`flock -n
 *      -E 0`), not "as a transient unit and return" (`systemd-run` without
 *      `--wait`).
 *   3. **It waits for it and exits with its status.** Not "forks and returns"
 *      (`setsid -f`, `sudo -b`, `screen -dm`), and not "reports its own success
 *      at having started something".
 *
 * The evidence for each is written in `why` below and has two parts: the
 * sentence of the manual that states the property, and a measurement under the
 * shell GitHub Actions actually uses — a file containing `<the launcher> false`
 * run as `bash -e <file>` must exit non-zero, and one containing `<the
 * launcher> sleep 2` must take about two seconds. A launcher that passes the
 * first and not the second has property 3 exactly backwards, which is what
 * `setsid -f` does.
 *
 * The rule those two measurements encode, stated once so a future entry can be
 * argued about rather than guessed at: **no value of any listed option may
 * produce exit 0 without the command having run to completion.** It is a rule
 * about the *worst* case, not the usual one — which is why `timeout 0` is
 * admissible (a duration of 0 means no limit, and an expiry is 124, so neither
 * branch is a silent success) and `flock -n -E 0` is not (the lock-held branch
 * is exit 0 with the command never started).
 *
 * ── HOW A FUTURE LAUNCHER GETS ADDED ────────────────────────────────────────
 * Four things in one commit, or it does not go in:
 *
 *   a. an entry here whose `why` cites the manual sentence for each of the three
 *      properties, for the launcher and for each option added beside it;
 *   b. the two measurements above, quoted in `why` with the exit status and the
 *      elapsed time, taken under `bash -e <file>` — the shell the runner uses
 *      for a step with no `shell:` key, and not `bash … -c`, which gives a
 *      different answer for `setsid` and would have given a wrong one here;
 *   c. an ACCEPTED_FORMS fixture in `workflow-policy-selftest.mjs` — the real
 *      workflow rewritten to use it must come back *completely clean*, which is
 *      what proves the entry is reachable rather than decorative;
 *   d. a REJECTED fixture for the nearest option that breaks one of the three
 *      properties, so the entry's boundary is a test rather than a claim.
 *
 * An option is added the same way and separately: being on this table is not a
 * property of the binary, it is a property of the binary *with these flags*.
 * `timeout` waits; `timeout` is on the list. `sudo` waits; `sudo -b` is not on
 * the list, and it is refused for not being on it rather than for being `-b`.
 *
 * ── WHAT IT STILL DOES NOT PROVE ────────────────────────────────────────────
 * The same boundary `no-command-shadowing` states: this reads *words*, and a
 * shell function or a PATH entry can make `timeout` mean anything. Executable
 * provenance is governance-bound and is not claimed here. What changed is only
 * the polarity of the enumeration — an unknown spelling now fails closed.
 */
/**
 * An option that carries no value: `--flag`, never `--flag=anything`.
 *
 * ── THE SPELLING BOTH BLIND REVIEWS FOUND (#40 round 5, second pass) ────────
 * The first version of the manager table required `--filter` to be paired with
 * `--fail-if-no-match`, and checked the pairing against `optionName()`, which
 * strips an attached value so that `--user=root` and `--user root` are one
 * option. That is right for an option whose value is data and catastrophic for
 * one whose value is a *boolean*. Measured, under `bash -e <file>` at the
 * repository root:
 *
 *     pnpm --fail-if-no-match      --filter @atrium/nope exec node fail7.mjs   exit 1
 *     pnpm --fail-if-no-match=true --filter @atrium/nope exec node fail7.mjs   exit 1
 *     pnpm --fail-if-no-match=false --filter @atrium/nope exec node fail7.mjs  exit 0
 *     pnpm --no-fail-if-no-match   --filter @atrium/nope exec node fail7.mjs   exit 0
 *
 * `=false` restored the exact fail-open the pairing was written to close, and
 * the policy called it clean. Two independent cross-lineage reviews found it
 * within minutes of each other, which is what an allowlist checked by the wrong
 * comparison looks like.
 *
 * So the polarity goes one level further down: an option's *value* is part of
 * the entry, not incidental to it. `BARE` means the word must be exactly the
 * flag; `VALUE` means it may carry one, attached or separate, because the value
 * is a user, a group, a signal, a duration or a workspace selector rather than
 * a switch. `--no-fail-if-no-match` needs no clause of its own: it is a
 * different word, and a different word is not on the list.
 */
const BARE = { takesValue: false };
const VALUE = { takesValue: true };

export const PROTECTED_STEP_LAUNCHERS = {
  command: {
    options: { '-p': BARE },
    why: 'POSIX: `command` executes the utility "in the current shell environment" with the argv it is given, suppressing function lookup — one exec, one wait, and the status is the utility\'s. `-p` only changes which PATH is searched. Measured under `bash -e <file>`: `command false` exits 1 in 1ms, `command sleep 2` takes 2003ms, `command -p false` exits 1 in 2ms. `-v`/`-V` print a path instead of running anything and are refused by `unwrap` itself, one layer earlier.',
  },
  timeout: {
    options: {
      '-s': VALUE,
      '--signal': VALUE,
      '-k': VALUE,
      '--kill-after': VALUE,
      '--preserve-status': BARE,
      '--foreground': BARE,
      '-v': BARE,
      '--verbose': BARE,
    },
    why: 'coreutils: "Start COMMAND, and kill it if still running after DURATION"; the exit status is the command\'s, or 124 when the duration expired. Every listed option changes which signal is sent or when — none of them stops the wait, and 124 is non-zero, so a timed-out assertion fails the step rather than passing it. Measured under `bash -e <file>`: `timeout 5 false` exits 1 in 4ms, `timeout 5 sleep 2` takes 2004ms, and `timeout 0 false` exits 1 in 3ms — a duration of 0 is documented as no limit, so neither branch of the argument is a silent success.',
  },
  sudo: {
    options: {
      '-u': VALUE,
      '--user': VALUE,
      '-g': VALUE,
      '--group': VALUE,
      '-n': BARE,
      '--non-interactive': BARE,
      '-E': BARE,
      '--preserve-env': BARE,
      '-H': BARE,
      '--set-home': BARE,
    },
    why: 'sudo(8): "sudo will wait until the command has completed" and "exits with the exit status of the command". The listed options choose the target user, group and environment and change nothing about the wait. Not independently measured here: this sandbox has no sudo privileges, so `sudo -n true` exits 1 without running anything — which is fail-closed and therefore says nothing either way about propagation. The manual sentence is the evidence, and it is quoted rather than paraphrased for that reason. `-b`/`--background` is the documented exception — "the command is run in the background … sudo will exit immediately" — and it is refused for not being on this list, which is also why `-B`, `--bell`, or whatever the next release adds is refused without anybody editing anything.',
  },
};

/**
 * Package managers a protected step may run its command through, and the
 * options of theirs it may pass.
 *
 * ── THE DEFECT THIS TABLE WAS (#40 round 5) ─────────────────────────────────
 * Round 4 wrote the admission criteria above, applied them to
 * `PROTECTED_STEP_LAUNCHERS`, and left this table exactly as it had been: twelve
 * `pnpm` options and four other managers, none of them measured, none of them
 * with a fixture, and none of them argued for. A rule stated in one comment and
 * applied to one table is indistinguishable in a diff from a rule applied
 * everywhere, and the blind review of round 4 spent one line proving it. Half
 * this repo's gates are `pnpm --filter @atrium/db exec node …`, and, measured
 * here under pnpm 10.13.1:
 *
 *     pnpm --filter @atrium/web exec node fail7.mjs         exit 1,  249ms
 *     pnpm --filter @atrium/does-not-exist exec node fail7.mjs
 *                          "No projects matched the filters"  exit 0,  194ms
 *     pnpm -F nope exec node fail7.mjs                      exit 0,  205ms
 *     pnpm --filter=@atrium/nope exec node fail7.mjs        exit 0,  193ms
 *     pnpm -r --filter nope exec node fail7.mjs             exit 0,  199ms
 *     pnpm --if-present run nosuchscript-xyz                exit 0,  194ms
 *
 * A filter that matches nothing is exit 0 with the command never started —
 * which is the disqualifier property 2 exists for, the same one that keeps
 * `flock -n -E 0` and `xargs -r` off the launcher list. Nine steps of the real
 * `ci.yml` rewritten to name a workspace that does not exist came back
 * **clean** from `node scripts/ci/workflow-policy.mjs`, deploy job included,
 * because `DEPLOY_ENTRYPOINTS['ci-script'].match` tests `argv[0]` after
 * `unwrap()` has already discarded the filter.
 *
 * ── WHAT AN ENTRY HERE HAS TO PROVE ─────────────────────────────────────────
 * The same four things a launcher does, per manager *and per option*: the
 * manual sentence for each of the three properties, the two measurements with
 * exit status and elapsed time, an ACCEPTED_FORMS fixture in
 * `workflow-policy-selftest.mjs` where the real workflow uses it and comes back
 * completely clean, and a REJECTED fixture for the nearest option that breaks
 * one of the three. `why` below carries the first two; the self-test carries
 * the other two.
 *
 * ── WHAT CAME OFF, AND WHY ──────────────────────────────────────────────────
 * `--recursive`/`-r` run the command once per matched project, and "once per
 * match" includes zero — measured above. `--if-present` is exit 0 when the
 * script is absent, which is the same failure with the filter matching: `pnpm
 * --if-present run nosuchscript-xyz` exits 0 having run nothing, and no filter
 * flag fixes it because the *script* is what is missing. `--frozen-lockfile`,
 * `--workspace-root`/`-w`, `--silent`, `--reporter`, `--dir`/`-C` and the whole
 * of `npm`, `yarn`, `bun`, `npx` and `bunx` came off for the reason the
 * launcher table gives for `nohup`: nothing in this repository needs them, and
 * "nobody has needed it" is a sufficient reason to leave an entry out. An
 * unknown manager is refused by the same clause that refuses an unknown
 * launcher, without this file having heard of it.
 *
 * ── AND WHAT REPLACED THEM ──────────────────────────────────────────────────
 * `--filter`/`-F` stay, because the workflow genuinely needs them, and they are
 * admissible **only paired with pnpm's own `--fail-if-no-match`**, whose help
 * text is exactly the missing property: "If no projects are matched by the
 * command, exit with exit code 1 (fail)". That is `requires` below, and it is
 * checked over the option words `unwrap()` actually consumed, so
 * `--filter=@atrium/nope` and `-F nope` are the same claim as `--filter nope`.
 *
 * Stated rather than implied: what a package.json script *does* once pnpm has
 * waited for it is semantics, and semantics is out of scope for every rule in
 * this repository's policy engine (see the SCOPE block in ci.yml).
 *
 * Also stated, because it is a real deviation from property 3: `pnpm --filter X
 * exec node -e 'process.exit(3)'` exits **1**, not 3 —
 * `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` replaces the child's status with its
 * own. Non-zero is preserved, zero is preserved, and the *value* is not. Every
 * rule in this repository asks "did the step fail", never "with what number",
 * so the narrowing is admissible and it is written down here rather than
 * discovered by somebody relying on the number.
 */
export const PROTECTED_STEP_MANAGERS = {
  pnpm: {
    why: 'pnpm spawns the child, waits for it, and fails the step when it fails. Measured under `bash -e <file>` from the repository root: `pnpm exec node fail7.mjs` exits 7 in 237ms (the status is the child\'s, unfiltered), `pnpm --filter @atrium/web exec node fail7.mjs` exits 1 in 249ms, and `pnpm --fail-if-no-match --filter @atrium/web exec sleep 2` takes 2200ms — so it waits rather than detaching. `pnpm exec` is documented as "Execute a shell command in scope of a project", i.e. an argv it runs, not a string it interprets.',
    options: {
      '--filter': {
        takesValue: true,
        why: 'pnpm(1): "--filter <selector> … restricts the scope to package names matching the given pattern". It changes *which* project the command runs in and nothing about the wait. Measured under `bash -e <file>`: `pnpm --fail-if-no-match --filter @atrium/web exec node fail7.mjs` exits 1 in 229ms, `pnpm --fail-if-no-match --filter @atrium/web exec sleep 2` takes 2200ms. Alone it fails property 2 — `pnpm --filter @atrium/does-not-exist exec node fail7.mjs` prints "No projects matched the filters" and exits **0 in 194ms** with the command never started — so it is admissible only with `--fail-if-no-match`.',
        requires: ['--fail-if-no-match'],
      },
      '-F': {
        takesValue: true,
        why: 'the documented short spelling of `--filter`; same measurement, same failure without the pairing (`pnpm -F nope exec node fail7.mjs` exits 0 in 205ms, and `pnpm --filter=@atrium/nope exec node fail7.mjs` — the attached spelling `optionName()` normalises — exits 0 in 193ms).',
        requires: ['--fail-if-no-match'],
      },
      '--fail-if-no-match': {
        takesValue: false,
        why: 'pnpm(1), verbatim from `pnpm help exec`: "If no projects are matched by the command, exit with exit code 1 (fail)". It is the option that gives `--filter` property 2, and it cannot itself skip the command: measured, `pnpm --fail-if-no-match --filter nope exec node fail7.mjs` exits 1 in 198ms and `pnpm --fail-if-no-match --filter @atrium/web exec sleep 2` takes 2200ms. Admissible **bare only**: `--fail-if-no-match=false` exits 0 on a filter that matches nothing, which is the whole fail-open back again (measured, 406ms), so a value on this flag is not on the list.',
      },
    },
  },
};

/** `--user=root` and `--user root` name the same option. */
function optionName(word) {
  const equals = word.indexOf('=');
  return equals === -1 ? word : word.slice(0, equals);
}

/**
 * The launchers this command reaches its real command through, checked against
 * the two tables above.
 *
 * Reads `command.via`, which `unwrap()` fills in with the launcher name, its
 * kind, and the option words that were consumed on its behalf — so the check is
 * over what was actually stripped, not over a re-scan of the prefix. Round 3
 * re-scanned (`raw.slice(0, raw.length - argv.length)`) and therefore could not
 * tell whose option a word was.
 */
export function launcherProblems(command, kinds = ['launcher', 'manager']) {
  const problems = [];
  const allowed = Object.keys(PROTECTED_STEP_LAUNCHERS).map((name) => `\`${name}\``);
  const managers = Object.keys(PROTECTED_STEP_MANAGERS).map((name) => `\`${name}\``);
  for (const { name, kind, options, exec } of command.via ?? []) {
    if (!kinds.includes(kind)) continue;
    const table =
      kind === 'manager'
        ? PROTECTED_STEP_MANAGERS[name]?.options
        : PROTECTED_STEP_LAUNCHERS[name]?.options;
    if (table === undefined) {
      problems.push(
        `it reaches the command through \`${name}\`, which is not on the allowlist of launchers a protected step may use (${allowed.join(', ')}, and the package managers ${managers.join(', ')}). This is an allowlist rather than a list of refusals because fifteen ways of writing "invoked but not run" were enumerated one round at a time and the next one always existed: \`setsid -f node x\` exits 0 in two milliseconds and never observes x's status. To add \`${name}\`, prove the three properties in PROTECTED_STEP_LAUNCHERS — it execs the command, it runs it exactly once, and it waits for it and exits with its status — with the manual sentence and the two measurements each entry there carries`,
      );
      continue;
    }
    const words = options ?? [];
    // The *bare* flags, which is what a companion requirement may be satisfied
    // by. `--fail-if-no-match=false` is the option's name attached to the value
    // that turns it off, and counting it as the companion is how the pairing
    // rule was defeated in the hour after it was written.
    const flags = words.filter((word) => word.indexOf('=') === -1);
    for (const word of words) {
      const flag = optionName(word);
      const attached = word.indexOf('=') !== -1;
      if (!Object.hasOwn(table, flag)) {
        problems.push(
          `it passes \`${flag}\` to \`${name}\`, which is not one of the options a protected step may use it with (${Object.keys(
            table,
          )
            .map((word) => `\`${word}\``)
            .join(
              ', ',
            )}). Being on the launcher allowlist is a property of the binary *with these flags*: \`sudo\` waits for its command and exits with its status, and \`sudo -b\` returns immediately. An option is justified one at a time, with the manual sentence and the two measurements, or it is refused`,
        );
        continue;
      }
      // An option's *value* is part of the entry. A flag whose value is data —
      // a user, a signal, a duration, a workspace selector — may carry one; a
      // flag that is a switch may not, because the switch's other position is
      // the behaviour the entry was written to refuse. Measured: `pnpm
      // --fail-if-no-match=false --filter @atrium/nope exec node fail7.mjs`
      // exits 0 in 406ms, where the bare flag exits 1.
      if (attached && table[flag]?.takesValue !== true) {
        problems.push(
          `it passes \`${word}\` to \`${name}\`. \`${flag}\` is admissible only written bare: it is a switch, and an attached value can set it to the position this allowlist exists to refuse — \`pnpm --fail-if-no-match=false --filter @atrium/nope exec node x\` exits 0 in 406ms with the command never started, where the bare flag exits 1. An option's value is part of its entry, or the entry is a name the next spelling walks past`,
        );
        continue;
      }
      // An option can be admissible only *in company*. `pnpm --filter nope exec
      // node x` prints "No projects matched the filters" and exits 0 with the
      // command never started; `--fail-if-no-match` is pnpm's own name for the
      // missing property. Being on this table is a property of the binary with
      // these flags, and for these flags that includes the flags beside them.
      // ── THE SEPARATE SPELLING OF THE SAME VALUE (#40 round 5, third pass) ─
      // Refusing `--fail-if-no-match=false` left `--fail-if-no-match false`,
      // and pnpm honours both: measured, `pnpm --fail-if-no-match false
      // --filter @atrium/nope exec node fail7.mjs` exits **0** with the command
      // never started. It walks past the attached-value test because this
      // parser never consumed `false` as a value — `--fail-if-no-match` is not
      // in `PACKAGE_MANAGERS.pnpm.value`, so the unwrap stopped at the bare
      // word and read it as the command. Two tables describing one option's
      // arity, disagreeing, which is the defect this whole ticket is about.
      //
      // The word after a BARE option is therefore ambiguous by construction:
      // it is the manager's script (`pnpm build`) or the option's value, and
      // nothing here can tell. Ambiguous is refused. `pnpm --fail-if-no-match
      // --filter X exec node y` names its exec word and is unaffected, and so
      // is `pnpm --fail-if-no-match --filter X build`, whose last option
      // consumed its own value.
      const last = words.at(-1);
      if (
        word === last &&
        exec === false &&
        table[flag]?.takesValue !== true &&
        command.argv.length > 0
      ) {
        problems.push(
          `it passes \`${flag}\` to \`${name}\` as the last option before \`${command.argv[0]}\`, with no \`exec\`/\`run\`/\`dlx\` between them. \`${flag}\` takes no value, so \`${command.argv[0]}\` is either a script name or the value somebody meant to give it — and \`${name}\` may read it either way. Measured: \`pnpm --fail-if-no-match false --filter @atrium/nope exec node fail7.mjs\` exits 0 with the command never started, because pnpm took \`false\` as the flag's value while this parser took it as the command. Write the option last only when an exec word follows, or give the manager a script name with no bare option in front of it`,
        );
        continue;
      }
      const required = table[flag]?.requires ?? [];
      for (const companion of required) {
        if (flags.includes(companion)) continue;
        problems.push(
          `it passes \`${flag}\` to \`${name}\` without \`${companion}\`. \`${flag}\` may select zero targets, and \`${name}\` reports that as success with the command never started — measured, \`pnpm --filter @atrium/does-not-exist exec node fail7.mjs\` exits 0 in 194ms — which is the same fail-open as \`flock -n -E 0\` and \`xargs -r\`. \`${companion}\` is the option whose documented job is to turn that into a failure, so on a protected step the two are one entry`,
        );
      }
    }
  }
  return problems;
}

/**
 * Node flags a protected `node <script>` may carry.
 *
 * ── THE DENYLIST THIS REPLACES, AND WHY (#40 round 4) ───────────────────────
 * Round 3 listed the flags that make `node <script>` *not* run the script —
 * `--check`, `-c`, `--version`, `-e`, `-p` and the rest — after a blind review
 * found `node --check scripts/ci/assert-page-serves.mjs` clean: it parses the
 * file, prints nothing, exits 0, and is one unconditional command, so the shape
 * rule had nothing to say either.
 *
 * It was the same denylist mistake as the launcher table, one layer down, and it
 * had the same sequel. Measured against the round-3 engine, three more spellings
 * were clean:
 *
 *     node --test scripts/ci/assert-page-serves.mjs        # runs it as a test file
 *     node -r ./nobble.mjs scripts/ci/assert-page-serves.mjs
 *     node --experimental-loader ./x.mjs scripts/ci/assert-page-serves.mjs
 *
 * `--test` changes what the exit status means; `-r` and `--experimental-loader`
 * run somebody else's code first, in the same process, before a line of the
 * assertion — which can stub `process.exit`, `fetch`, or the reporter the
 * assertion writes its verdict through. None of them is on any denylist because
 * nobody had thought of them, and the next release of Node ships more.
 *
 * So the polarity is inverted here too. A `node` invocation of a protected
 * script may carry **only** the flags below, each of which changes diagnostics
 * and nothing else: no code is loaded, no module hook is installed, and the exit
 * status is still the script's. Everything else — every flag that exists and
 * every flag that does not yet — reads as *not an invocation of the script*,
 * which makes the step **missing**, which is the loud answer.
 *
 * Adding one takes the same evidence as a launcher: the manual sentence saying
 * it neither loads code nor changes the exit status, and a measurement that
 * `node <flag> -e 'process.exit(3)'` still exits 3.
 *
 * ── THE SEVENTEENTH BYPASS, MADE BY THIS TABLE ─────────────────────────────
 * The first version of this list was a flat set of flag names, and the blind
 * cross-lineage review of it found that three of the entries take a *value*.
 * The comment here claimed that spelling one with a space "fails closed". For
 * two of them it does — `node --max-old-space-size scripts/ci/assert-x.mjs`
 * exits 9 with `illegal value for flag`. For the third it fails wide open:
 *
 *     $ node /tmp/fail7.mjs                              FAILED   exit=7
 *     $ node --disable-warning /tmp/fail7.mjs                     exit=0
 *
 * Node takes the script path as the flag's value, is left with no entry point,
 * reads an empty stdin, and exits 0 — while this parser, which does not know
 * which flags consume an operand, still sees the script as the first operand
 * and reports the step present. `run: node --disable-warning
 * scripts/ci/assert-page-serves.mjs` was **policy-clean** and ran nothing.
 *
 * Introduced by the allowlist, in the same commit that argued allowlists are
 * safer, and found by pointing somebody else at it. So the entry is not the
 * flag — it is the flag *with its value attached*. A value-taking flag is
 * admissible only as `--flag=value`; written with a space it is refused, which
 * is the same rule the launcher table states as "being on this list is a
 * property of the binary with these flags".
 *
 * And the environment is the other half of this table: `NODE_OPTIONS` applies
 * these same flags to every `node` process without appearing in any argv, which
 * is the sixteenth bypass. It is refused by `INJECTING_VARIABLES` in
 * `workflow-policy.mjs`; an allowlist here with that variable unguarded would
 * have been decoration.
 */
export const NODE_FLAGS_ALLOWED = new Map([
  ['--enable-source-maps', { takesValue: false }],
  ['--no-warnings', { takesValue: false }],
  ['--trace-warnings', { takesValue: false }],
  ['--trace-uncaught', { takesValue: false }],
  ['--use-strict', { takesValue: false }],
  ['--disable-warning', { takesValue: true }],
  ['--max-old-space-size', { takesValue: true }],
  ['--stack-size', { takesValue: true }],
]);

/**
 * True when this argv is `node` running its script as a program.
 *
 * Non-`node` argvs are not this function's business and answer true; the
 * launcher allowlist is what governs those.
 */
export function runsItsScript(argv) {
  if (argv[0] !== 'node') return true;
  for (const word of argv.slice(1)) {
    if (!word.startsWith('-') || word === '-' || word === '--') return true; // the script
    const equals = word.indexOf('=');
    const flag = NODE_FLAGS_ALLOWED.get(equals === -1 ? word : word.slice(0, equals));
    if (flag === undefined) return false;
    // `--disable-warning <script>` makes node swallow the script as the flag's
    // value and exit 0 having run nothing. Only the `=` form is an entry here.
    if (flag.takesValue && equals === -1) return false;
  }
  // Only flags, no operand: `node --no-warnings` runs a REPL, not a script.
  return false;
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
 *
 * ── THIS TABLE IS RECOGNITION, NOT PERMISSION (#40 round 4) ─────────────────
 * `setsid` sat here for two rounds and that was correct: `setsid node x` really
 * does run x, and a policy that reads it as "the assertion is missing" is wrong
 * in the direction that gets rules deleted. What was wrong was that being here
 * was also, silently, permission — nothing else asked whether a launcher waits
 * for what it launched. Recognition and permission are two questions now:
 * everything here is *seen through*, and only `PROTECTED_STEP_LAUNCHERS` above
 * may appear on a step whose failure is the point.
 *
 * `flock` and `systemd-run` were added in round 4 by asking "what else execs an
 * argv on a GitHub runner", before anybody found them in a workflow. Both are
 * recognised, both are refused on a protected step, and each has a fixture:
 * `flock -n -E 0 <a held lock> false` was measured here at **exit 0 in 2ms**
 * with `false` never run, and `systemd-run --user node x` returns as soon as the
 * transient unit is queued (the manual's `--wait` exists precisely because the
 * default does not). They are here so that the *allowlist* is what refuses them,
 * rather than their absence from a table — an evasion that is merely
 * unrecognised is an evasion the engine reports as a missing step, and the
 * fixtures in the self-test prove these two trip the shape rule and nothing
 * else.
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
  // `flock [options] <file> command …` — the lock path is a positional. With
  // `-n` it gives up rather than waiting, and `-E <status>` chooses what "gave
  // up" exits with, so `flock -n -E 0 /tmp/lock node x` is a real invocation
  // that runs x zero times and exits 0.
  flock: { value: ['-E', '--conflict-exit-code', '-w', '--wait', '--timeout'], positional: 1 },
  // `systemd-run [options] command …` queues a transient unit and returns as
  // soon as it has been started, unless `--wait` is given.
  'systemd-run': {
    value: ['--unit', '-u', '--property', '-p', '--uid', '--gid', '--setenv', '-E', '--machine'],
  },
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
  // The prefix words that were stripped, in order, as
  // `{name, kind, options, assignments}`. A rule that means "run through the
  // workspace's package manager" asks about this rather than about `argv[0]`, so
  // `sudo pnpm build` is still a `pnpm build` — and `singleCommandProblems()`
  // asks it which launcher owned which option word, which is a question round
  // 3's "everything before the argv" prefix scan could not answer.
  const via = [];
  for (let guard = 0; guard < 8 && words.length > 0; guard += 1) {
    const head = words[0];
    const launcher = Object.hasOwn(LAUNCHERS, head) ? LAUNCHERS[head] : undefined;
    if (launcher !== undefined) {
      let index = 1;
      let rejected = false;
      const options = [];
      const assignments = [];
      while (index < words.length && isOption(words[index])) {
        // `command -v pnpm` looks up a path; it does not run pnpm.
        if ((launcher.reject ?? []).includes(words[index])) rejected = true;
        options.push(words[index]);
        if (launcher.value.includes(words[index])) index += 1;
        index += 1;
      }
      if (launcher.assignments === true) {
        while (index < words.length && ASSIGNMENT.test(words[index])) {
          assignments.push(words[index]);
          index += 1;
        }
      }
      for (let skipped = 0; skipped < (launcher.positional ?? 0); skipped += 1) {
        if (index < words.length) index += 1;
      }
      if (rejected || index >= words.length) return { argv: words, via };
      via.push({ name: head, kind: 'launcher', options, assignments });
      words = words.slice(index);
      continue;
    }
    const manager = Object.hasOwn(PACKAGE_MANAGERS, head) ? PACKAGE_MANAGERS[head] : undefined;
    if (manager !== undefined) {
      let index = 1;
      const options = [];
      while (index < words.length && isOption(words[index])) {
        options.push(words[index]);
        if (manager.value.includes(words[index])) index += 1;
        index += 1;
      }
      // Only options may sit between the manager and the command it runs. A
      // bare word here is not an option, so the unwrap stops and the manager
      // itself stays the command word — which is the whole defence against
      // `pnpm … echo exec node …`.
      if (index >= words.length) return { argv: words, via };
      const exec = EXEC_WORDS.has(words[index]);
      if (exec) index += 1;
      if (index >= words.length) return { argv: words, via };
      // `exec` is recorded because the two tables that describe an option's
      // arity are different tables: `PACKAGE_MANAGERS[x].value` decides what
      // this function consumes, and `PROTECTED_STEP_MANAGERS[x].options[y]`
      // decides what a protected step may pass. When they disagree, the word
      // after the option is read as the command — see `launcherProblems`.
      via.push({ name: head, kind: 'manager', options, assignments: [], exec });
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

/**
 * The package-manager half of `launcherProblems`, for every step rather than
 * only the protected ones.
 *
 * ── WHY IT IS SPLIT OUT (#40 round 5, from a blind review of the first fix) ─
 * `launcherProblems` is reached only through `singleCommandProblems`, which the
 * policy asks of protected steps and of the whole deploy job. So the rule "a
 * `--filter` that can match nothing is a command that can not run" was written
 * about the workflow and enforced on a subset of it: `pnpm --filter
 * @atrium/does-not-exist install --frozen-lockfile` on the install step was
 * policy-clean, exits 0, and installs nothing. That is this round's own
 * meta-defect — a rule applied at fewer sites than its own words cover —
 * committed in the commit that named it.
 *
 * The *launcher* half stays protected-only deliberately, and the difference is
 * a claim rather than an omission: refusing `xargs` or `setsid` on an ordinary
 * step would be a new prohibition with no defect behind it, while a package
 * manager that selects nothing is the same silent success wherever it appears.
 */
export function managerProblems(command) {
  return launcherProblems(command, ['manager']);
}
