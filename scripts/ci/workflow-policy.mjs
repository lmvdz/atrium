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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const add = (rule, message) => violations.push({ rule, message, path });

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

  // ---- every job is bounded ----------------------------------------------
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job)) continue;
    if (typeof job['timeout-minutes'] !== 'number') {
      add(
        'job-timeout-required',
        `${path}: job \`${jobId}\` has no \`timeout-minutes\`. A job that can hang forever is a check that never reports.`,
      );
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
    if (!JSON.stringify(gate).includes('toJSON(needs)')) {
      add(
        'gate-inspects-needs',
        `${path}: \`${GATE_JOB}\` never reads \`toJSON(needs)\`. It must inspect every needed job's \`result\` and fail unless each one is literally \`success\`.`,
      );
    }
  }

  return violations;
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
    checkConditionalStepsAreUploads(doc.toJS({ maxAliasCount: -1 }) ?? {}, path, (rule, message) =>
      violations.push({ rule, message, path }),
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
