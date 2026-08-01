/**
 * Semantic policy for this repo's GitHub Actions workflows.
 *
 * Round 1 of this ticket enforced the same intent with `grep`. A grep over a
 * workflow is not a policy engine: it cannot see that a construct sits on a job
 * rather than a step, it reads a quoted key as different from a bare one, it is
 * blind to YAML aliases, and — the failure that actually mattered — it never
 * runs at all when the job carrying it is skipped by an `if:` the attacker
 * controls. So the rules below run over the *parsed document*, and the `gate`
 * job (rule gate-covers-all-jobs) makes skipping any of them red rather than
 * green.
 *
 * Every rule is a hard failure. There are no warnings: a warning is a fail-open
 * construct wearing a different hat.
 *
 * SCOPE. This engine — and the CI it guards — defends against **accident and
 * drift**: a step deleted in a hurry, a floor quietly lowered, an action tag
 * that moved under us, a job that stopped running and nobody noticed. It does
 * *not* defend against a malicious author with write access, because it cannot:
 * the policy, its self-test, the reporters and the floors all execute from the
 * revision under test, so an author who can edit this file can edit what it
 * checks. The rules below make that expensive and loud, not impossible.
 * Adversarial closure is the governance trigger in the README — required-check
 * rulesets, pull requests, and code-owner review — not anything in this file.
 *
 * Usage:
 *   node scripts/ci/workflow-policy.mjs .github/workflows/*.yml
 *   import { checkWorkflow } from './workflow-policy.mjs'
 */

import { readFileSync } from 'node:fs';
import { isAlias, isCollection, parseDocument, visit } from 'yaml';

/** A pinned action reference: `owner/repo@<40 hex>`, optionally `owner/repo/path@sha`. */
const PINNED_USES = /^[^@\s]+@([0-9a-f]{40})$/;
/** Local (`./.github/actions/x`) and docker refs are pinned by other means. */
const LOCAL_USES = /^\.\//;
const DOCKER_USES = /^docker:\/\//;
/** `uses:` lines must carry a `# vN.N.N` comment recording the intended major. */
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*))?\s*$/;
const VERSION_COMMENT = /v\d+(\.\d+)*/;

/** Shell fragments that turn a failing command into a passing step. */
const FAIL_OPEN_SHELL = [
  { pattern: /\|\|\s*true\b/, label: '`|| true`' },
  { pattern: /\|\|\s*:\s*(?:$|\n|;)/, label: '`|| :`' },
  { pattern: /\|\|\s*exit\s+0\b/, label: '`|| exit 0`' },
  { pattern: /set\s+\+e\b/, label: '`set +e`' },
  { pattern: /set\s+\+o\s+pipefail\b/, label: '`set +o pipefail`' },
  { pattern: /continue-on-error/, label: '`continue-on-error`' },
];

/** Untrusted context that must never be interpolated into a shell script. */
const INJECTABLE_CONTEXT =
  /\$\{\{\s*github\.(event\b|head_ref\b|event_name\s*==\s*)|github\.event\.(pull_request|issue|comment|head_commit)/;

const REQUIRED_TRIGGERS = ['pull_request', 'merge_group'];
const GATE_JOB = 'gate';

/**
 * Every rule this engine can emit, declared rather than counted by hand.
 *
 * Round 2 of this ticket claimed "15 rules" in a receipt while the engine
 * carried 18, and four of them had never been mutated by the self-test. Both
 * mistakes were possible because the rule set lived only in the call sites. It
 * lives here now: `add()` refuses an undeclared rule id, and the self-test
 * asserts every entry below has at least one mutation proving it fires. The
 * count in any receipt is `RULES.length`, not a number someone remembered.
 */
export const RULES = [
  'yaml-parse',
  'no-yaml-alias',
  'no-yaml-anchor',
  'no-continue-on-error',
  'no-shell-override',
  'no-step-timeout',
  'no-fail-open-shell',
  'no-untrusted-interpolation',
  'required-triggers',
  'least-privilege',
  'pin-actions-to-sha',
  'job-timeout-required',
  'gate-covers-all-jobs',
  'gate-runs-always',
  'gate-inspects-needs',
  'no-job-condition',
  'no-step-condition',
  'no-stray-condition',
  'policy-steps-present',
  'required-job-steps',
  'no-remote-reusable-workflow',
];

/**
 * Steps that must exist, by job.
 *
 * A job can satisfy every rule above and still prove nothing, by simply not
 * running the checks any more — delete the policy step and the policy stops
 * objecting to its own absence. That is circular, and knowingly so: it cannot
 * stop an author who means it (see SCOPE at the top of this file). What it does
 * stop is the accident — a step dropped during a rebase, a script renamed
 * without its call site, a job hollowed out to "make CI fast" — which is the
 * threat model this repo actually has today.
 *
 * `policy-steps-present` covers the meta-guards: the things that check the
 * workflow itself. `required-job-steps` covers the verification work.
 */
const REQUIRED_STEPS = {
  verify: [
    // Matches actionlint being *run*, not merely downloaded — the install step
    // names it too, and a job that fetches a linter it never invokes is exactly
    // the shape this rule is looking for.
    { rule: 'policy-steps-present', what: 'actionlint', test: /actionlint"?\s+-{1,2}color\b/ },
    {
      rule: 'policy-steps-present',
      what: 'the workflow policy engine',
      test: /scripts\/ci\/workflow-policy\.mjs\b/,
    },
    {
      rule: 'policy-steps-present',
      what: "the policy engine's own self-test",
      test: /scripts\/ci\/workflow-policy-selftest\.mjs\b/,
    },
    {
      rule: 'policy-steps-present',
      what: "the test gates' self-test",
      test: /scripts\/ci\/gate-selftest\.mjs\b/,
    },
    { rule: 'required-job-steps', what: 'the linter', test: /\bpnpm (?:run )?lint\b/ },
    { rule: 'required-job-steps', what: 'the typechecker', test: /\bpnpm (?:run )?typecheck\b/ },
    { rule: 'required-job-steps', what: 'the unit/integration suite', test: /\bpnpm vitest run\b/ },
    { rule: 'required-job-steps', what: 'the build', test: /\bpnpm (?:run )?build\b/ },
    {
      rule: 'required-job-steps',
      what: 'the workspace-enrollment assertion',
      test: /scripts\/ci\/assert-workspace-enrollment\.mjs\b/,
    },
    {
      rule: 'required-job-steps',
      what: 'the floor-ratchet assertion',
      test: /scripts\/ci\/assert-floor-ratchet\.mjs\b/,
    },
    {
      rule: 'required-job-steps',
      what: 'the schema set-equality assertion',
      test: /scripts\/ci\/assert-tables\.mjs\b/,
    },
    {
      rule: 'required-job-steps',
      what: 'the vitest report gate',
      test: /scripts\/ci\/assert-vitest-report\.mjs\b/,
    },
  ],
  e2e: [
    {
      rule: 'required-job-steps',
      what: 'the browser-presence assertion',
      test: /scripts\/ci\/assert-chromium\.mjs\b/,
    },
    { rule: 'required-job-steps', what: 'the Playwright suite', test: /\bplaywright test\b/ },
    {
      rule: 'required-job-steps',
      what: 'the e2e report gate',
      test: /scripts\/ci\/assert-playwright-report\.mjs\b/,
    },
  ],
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collects violations, refusing any rule id not declared in RULES. A rule the
 * self-test has never heard of is a rule nobody has proved fires.
 */
function makeAdd(violations, path) {
  return (rule, message) => {
    if (!RULES.includes(rule)) {
      throw new Error(
        `workflow-policy: undeclared rule id "${rule}". Add it to RULES and give it a mutation in workflow-policy-selftest.mjs.`,
      );
    }
    violations.push({ rule, message, path });
  };
}

/** Depth-first walk yielding [pathSegments, key, value] for every mapping key. */
function* walkKeys(node, path = []) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* walkKeys(item, [...path, index]);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    yield [path, key, value];
    yield* walkKeys(value, [...path, key]);
  }
}

function pathString(path, key) {
  return [...path, key].join('.');
}

/** `always()`, `${{ always() }}`, `${{always()}}` all mean the same thing. */
function normalizeCondition(value) {
  return String(value)
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
}

/**
 * @param {string} source raw workflow YAML
 * @param {string} path file path, for messages
 * @returns {{rule: string, message: string}[]} every violation found
 */
export function checkWorkflow(source, path = '<workflow>') {
  const violations = [];
  const add = makeAdd(violations, path);

  const doc = parseDocument(source, { merge: false, strict: true });
  for (const error of doc.errors) {
    add('yaml-parse', `${path} is not valid YAML: ${error.message}`);
  }
  if (doc.errors.length > 0) return violations;

  // Anchors and aliases: GitHub does not support them, and a policy that reads
  // the expanded tree while a human reads the anchor is a policy nobody can
  // audit. Ban both outright.
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      add('no-yaml-alias', `${path}: YAML alias *${node.source} — aliases are not allowed.`);
    } else if (isCollection(node) && node.anchor) {
      add('no-yaml-anchor', `${path}: YAML anchor &${node.anchor} — anchors are not allowed.`);
    }
  });

  const workflow = doc.toJS({ maxAliasCount: -1 }) ?? {};
  // YAML 1.1 readers fold a bare `on` into boolean true. We parse as 1.2 (where
  // it stays a string), but accept both so the rule can never be dodged by a
  // schema quirk.
  const triggers = workflow.on ?? workflow.true ?? workflow[true];
  const jobs = isPlainObject(workflow.jobs) ? workflow.jobs : {};

  // ---- rules that apply to any key, at any depth -------------------------
  for (const [keyPath, key, value] of walkKeys(workflow)) {
    const where = pathString(keyPath, key);

    if (key === 'continue-on-error') {
      add(
        'no-continue-on-error',
        `${path}: \`continue-on-error\` at ${where}. A step allowed to fail is a gate that does not gate.`,
      );
    }

    if (key === 'shell') {
      add(
        'no-shell-override',
        `${path}: \`shell: ${value}\` at ${where}. The default \`bash -e -o pipefail\` is the only shell allowed; an override can drop the flags that make a failing command fail the step.`,
      );
    }

    if (key === 'if') {
      classifyCondition(keyPath, value, where, add, path);
    }

    if (key === 'timeout-minutes' && keyPath.at(-2) === 'steps') {
      add(
        'no-step-timeout',
        `${path}: step-level \`timeout-minutes\` at ${where}. A per-step timeout turns a hung test suite into a red step that a later edit can mask; the job-level timeout already fails the whole job closed.`,
      );
    }

    if (key === 'run' && typeof value === 'string') {
      for (const { pattern, label } of FAIL_OPEN_SHELL) {
        if (pattern.test(value)) {
          add('no-fail-open-shell', `${path}: ${label} in the script at ${where}.`);
        }
      }
      if (INJECTABLE_CONTEXT.test(value)) {
        add(
          'no-untrusted-interpolation',
          `${path}: attacker-controllable \`github.event\` context interpolated into the script at ${where}. Pass it through \`env:\` instead.`,
        );
      }
    }
  }

  // ---- triggers ----------------------------------------------------------
  const triggerNames = isPlainObject(triggers)
    ? Object.keys(triggers)
    : Array.isArray(triggers)
      ? triggers.map(String)
      : triggers
        ? [String(triggers)]
        : [];
  for (const required of REQUIRED_TRIGGERS) {
    if (!triggerNames.includes(required)) {
      add(
        'required-triggers',
        `${path}: missing the \`${required}\` trigger. A merge queue that never gets a run treats the absence of a verdict as consent.`,
      );
    }
  }

  // ---- permissions -------------------------------------------------------
  if (!isPlainObject(workflow.permissions) || workflow.permissions.contents !== 'read') {
    add(
      'least-privilege',
      `${path}: workflow-level \`permissions:\` must declare \`contents: read\` so a job inherits nothing it did not ask for.`,
    );
  }

  // ---- actions are pinned to commit SHAs ---------------------------------
  for (const [index, line] of source.split('\n').entries()) {
    const match = USES_LINE.exec(line);
    if (!match) continue;
    const [, ref, comment] = match;
    const at = `${path}:${index + 1}`;
    if (LOCAL_USES.test(ref) || DOCKER_USES.test(ref)) continue;
    if (!PINNED_USES.test(ref)) {
      add(
        'pin-actions-to-sha',
        `${at}: \`uses: ${ref}\` is not pinned to a 40-character commit SHA. A tag is mutable; whoever can move it can run code here.`,
      );
      continue;
    }
    if (!comment || !VERSION_COMMENT.test(comment)) {
      add(
        'pin-actions-to-sha',
        `${at}: \`uses: ${ref}\` needs a trailing \`# vN.N.N\` comment recording which release the SHA is, so the pin stays auditable.`,
      );
    }
  }

  // ---- every job is bounded, and defined here -----------------------------
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job)) continue;
    if (typeof job['timeout-minutes'] !== 'number') {
      add(
        'job-timeout-required',
        `${path}: job \`${jobId}\` has no \`timeout-minutes\`. A job that can hang forever is a check that never reports.`,
      );
    }
    // A reusable workflow moves the job body somewhere this engine cannot read
    // it. For a remote one that body is a different repository's file, on a ref
    // whose contents can change without a commit here — the policy would be
    // enforcing rules over a stub while the real steps ran elsewhere. Refused
    // outright, local ones included, so that adopting one is a deliberate edit
    // to this rule rather than a quiet hole. (Round-2 receipt: none are used
    // today; this converts the gap into a loud choice.)
    if (job.uses !== undefined) {
      add(
        'no-remote-reusable-workflow',
        `${path}: job \`${jobId}\` delegates to the reusable workflow \`${job.uses}\`. Reusable workflows are refused: their steps are not in this file, so nothing here can check them, and a remote one can change without a commit to this repository. Inline the job.`,
      );
    }
    if (job.secrets !== undefined) {
      add(
        'no-remote-reusable-workflow',
        `${path}: job \`${jobId}\` passes \`secrets:\` to a called workflow. Only reusable-workflow calls take that key, and those are refused.`,
      );
    }
  }

  // ---- the checks themselves must still be wired up -----------------------
  for (const [jobId, required] of Object.entries(REQUIRED_STEPS)) {
    const job = jobs[jobId];
    if (!isPlainObject(job)) {
      add(
        'required-job-steps',
        `${path}: no \`${jobId}\` job. The gates this repo relies on are declared per job in scripts/ci/workflow-policy.mjs; a workflow without \`${jobId}\` is missing ${required.length} of them.`,
      );
      continue;
    }
    const script = jobScriptText(job);
    for (const { rule, what, test } of required) {
      if (!test.test(script)) {
        add(
          rule,
          `${path}: job \`${jobId}\` never runs ${what} (nothing in its steps matches ${test}). A job can satisfy every other rule here and still prove nothing by quietly dropping the step that does the proving.`,
        );
      }
    }
  }

  // ---- the gate ----------------------------------------------------------
  const gate = jobs[GATE_JOB];
  if (!isPlainObject(gate)) {
    add(
      'gate-covers-all-jobs',
      `${path}: no \`${GATE_JOB}\` job. Every workflow needs exactly one job that fails unless all the others succeeded — it is the only check that may be marked required.`,
    );
  } else {
    const needs = Array.isArray(gate.needs) ? gate.needs : gate.needs ? [String(gate.needs)] : [];
    const others = Object.keys(jobs).filter((id) => id !== GATE_JOB);
    const uncovered = others.filter((id) => !needs.includes(id));
    if (uncovered.length > 0) {
      add(
        'gate-covers-all-jobs',
        `${path}: job(s) ${uncovered.map((id) => `\`${id}\``).join(', ')} are not in \`${GATE_JOB}.needs\`. A job the gate does not need is a job whose failure nothing reports.`,
      );
    }
    for (const need of needs) {
      if (!Object.hasOwn(jobs, need)) {
        add(
          'gate-covers-all-jobs',
          `${path}: \`${GATE_JOB}.needs\` names \`${need}\`, which is not a job in this file.`,
        );
      }
    }
    if (normalizeCondition(gate.if ?? '') !== 'always()') {
      add(
        'gate-runs-always',
        `${path}: \`${GATE_JOB}\` must declare \`if: always()\`. Without it the gate is skipped whenever a needed job is skipped or fails, and GitHub reports a skipped required check as success.`,
      );
    }
    checkGateInspectsNeeds(gate, path, add);
  }

  return violations;
}

/** Flattens every `run:` and `uses:` in a job into one string, for presence checks. */
function jobScriptText(job) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return steps
    .map((step) => (isPlainObject(step) ? `${step.run ?? ''}\n${step.uses ?? ''}` : ''))
    .join('\n');
}

/**
 * The gate must actually read the results it needs — parsed, not grepped.
 *
 * Round 2 checked this with `JSON.stringify(gate).includes('toJSON(needs)')`,
 * which a comment containing that string satisfies just as well as a working
 * gate. So: find the step that binds `${{ toJSON(needs) }}` into an environment
 * variable, then read the script that step runs and require it to read that
 * variable, iterate it, look at each job's `result`, compare against the
 * literal `success`, exit non-zero when one is not, and refuse an empty `needs`
 * rather than passing by vacuous truth. gate-selftest.mjs then extracts that
 * same script and *runs* it against synthetic `needs` payloads, which is the
 * only check that can tell working code from convincing code.
 */
function checkGateInspectsNeeds(gate, path, add) {
  const steps = Array.isArray(gate.steps) ? gate.steps : [];
  let bound;
  for (const step of steps) {
    if (!isPlainObject(step) || typeof step.run !== 'string') continue;
    const env = isPlainObject(step.env) ? step.env : {};
    const entry = Object.entries(env).find(([, value]) =>
      /toJSON\s*\(\s*needs\s*\)/.test(String(value)),
    );
    if (entry) {
      bound = { name: entry[0], run: step.run };
      break;
    }
  }

  if (bound === undefined) {
    add(
      'gate-inspects-needs',
      `${path}: no step in \`${GATE_JOB}\` binds \`\${{ toJSON(needs) }}\` into an \`env:\` variable and then reads it. The gate must inspect every needed job's \`result\` and fail unless each one is literally \`success\`.`,
    );
    return;
  }

  const { name, run } = bound;
  const readsVariable = new RegExp(
    `process\\.env\\.${name}\\b|process\\.env\\[\\s*["']${name}["']\\s*\\]|\\$\\{?${name}\\b`,
  );
  const checks = [
    { ok: readsVariable.test(run), why: `never reads the \`${name}\` variable it binds` },
    {
      ok: /Object\.(entries|values|keys)\s*\(|\bfor\s*\(|\.map\s*\(|\.filter\s*\(/.test(run),
      why: 'never iterates the needed jobs, so it can only be looking at one of them (or none)',
    },
    { ok: /\bresult\b/.test(run), why: "never looks at any job's `result`" },
    {
      ok: /["']success["']/.test(run),
      why: 'never compares a result against the literal `success`, so `skipped` and `cancelled` would read as fine',
    },
    {
      ok: /process\.exit\s*\(\s*[1-9]|\bexit\s+[1-9]/.test(run),
      why: 'never exits non-zero, so whatever it finds it reports green',
    },
    {
      ok: /length\s*(?:===?|<)\s*[01]\b/.test(run),
      why: 'does not fail on an empty `needs`, so a gate quietly emptied of its dependencies would pass by vacuous truth',
    },
  ];
  for (const { ok, why } of checks) {
    if (!ok) {
      add(
        'gate-inspects-needs',
        `${path}: the \`${GATE_JOB}\` step that binds \`toJSON(needs)\` ${why}.`,
      );
    }
  }
}

/** `if:` is allowed in exactly two places; everything else is a verdict in disguise. */
function classifyCondition(keyPath, value, where, add, path) {
  const condition = normalizeCondition(value);
  const [root, jobId, maybeSteps] = keyPath;

  const isJobLevel = root === 'jobs' && keyPath.length === 2;
  const isStepLevel = root === 'jobs' && maybeSteps === 'steps' && keyPath.length === 4;

  if (isJobLevel) {
    if (jobId === GATE_JOB) return; // checked separately: must be always()
    add(
      'no-job-condition',
      `${path}: \`if: ${value}\` on job \`${jobId}\`. GitHub reports a skipped required check as *success*, so a condition on a gating job is a bypass — this is the exact hole \`if: \${{ false }}\` opens.`,
    );
    return;
  }

  if (isStepLevel) {
    // `failure()` is provisionally allowed here; checkConditionalStepsAreUploads
    // then proves the step it sits on is an artifact upload and nothing else.
    if (condition === 'failure()') return;
    add(
      'no-step-condition',
      `${path}: \`if: ${value}\` at ${where}. The only step condition allowed is \`if: failure()\` on an artifact upload — a condition on anything else lets a gate decline to run and still report green.`,
    );
    return;
  }

  add(
    'no-stray-condition',
    `${path}: \`if: ${value}\` at ${where}, which is not a place a condition belongs.`,
  );
}

/** Steps carrying `if: failure()` must be artifact uploads and nothing else. */
export function checkConditionalStepsAreUploads(workflow, path, add) {
  const jobs = isPlainObject(workflow.jobs) ? workflow.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job) || !Array.isArray(job.steps)) continue;
    for (const [index, step] of job.steps.entries()) {
      if (!isPlainObject(step) || step.if === undefined) continue;
      const uses = String(step.uses ?? '');
      if (!uses.startsWith('actions/upload-artifact@')) {
        add(
          'no-step-condition',
          `${path}: jobs.${jobId}.steps.${index} carries \`if:\` but is not an \`actions/upload-artifact\` step. Conditions may gate artifacts, never verdicts.`,
        );
      }
    }
  }
}

/** Runs both passes over one file. */
export function checkWorkflowFile(source, path) {
  const violations = checkWorkflow(source, path);
  const doc = parseDocument(source, { merge: false, strict: true });
  if (doc.errors.length === 0) {
    checkConditionalStepsAreUploads(
      doc.toJS({ maxAliasCount: -1 }) ?? {},
      path,
      makeAdd(violations, path),
    );
  }
  return violations;
}

function main(argv) {
  const files = argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/ci/workflow-policy.mjs <workflow.yml> [...]');
    return 2;
  }
  let failed = 0;
  for (const file of files) {
    const violations = checkWorkflowFile(readFileSync(file, 'utf8'), file);
    for (const violation of violations) {
      console.error(`::error file=${file}::[${violation.rule}] ${violation.message}`);
    }
    failed += violations.length;
    if (violations.length === 0) console.info(`Workflow policy: ${file} clean.`);
  }
  if (failed > 0) console.error(`Workflow policy: ${failed} violation(s).`);
  return failed > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
