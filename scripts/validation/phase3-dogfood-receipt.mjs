import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const QUESTION_IDS = ['current-decisions', 'open-questions', 'who-owes-what', 'current-objective'];
const EVIDENCE_KEYS = [
  'projectChanged',
  'repeatedQuestions',
  'forgottenCommitments',
  'missedDecisions',
  'interpretations',
  'attentionItems',
  'manualOrganization',
];

const fail = (message) => {
  throw new Error(message);
};
const object = (value, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  return value;
};
const string = (value, path) => {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
};
const integer = (value, path) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${path} must be a non-negative integer`);
  return value;
};
const instant = (value, path) => {
  string(value, path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${path} must be an ISO timestamp`);
  return parsed;
};
const strings = (value, path) => {
  if (!Array.isArray(value) || value.length === 0) fail(`${path} must be a non-empty array`);
  value.forEach((item, index) => {
    string(item, `${path}[${index}]`);
  });
  return value;
};

const evidenceStrings = (value, path, template) => {
  strings(value, path);
  if (!template && value.some((item) => item.trim().toLowerCase().startsWith('replace')))
    fail(`${path} contains a template placeholder`);
  return value;
};

export function validateReceipt(input, source = '<memory>') {
  const receipt = object(input, source);
  if (receipt.protocolVersion !== 1) fail(`${source}.protocolVersion must equal 1`);
  if (typeof receipt.template !== 'boolean') fail(`${source}.template must be boolean`);
  for (const key of ['runId', 'openingId', 'project', 'stratum', 'observer'])
    string(receipt[key], `${source}.${key}`);
  if (
    !receipt.template &&
    ['runId', 'openingId', 'stratum', 'observer'].some((key) =>
      receipt[key].trim().toLowerCase().startsWith('replace'),
    )
  )
    fail(`${source} contains a template placeholder in an identity field`);
  if (receipt.project !== 'atrium-campaign') fail(`${source}.project must equal atrium-campaign`);

  const startedAt = instant(receipt.startedAt, `${source}.startedAt`);
  const endedAt = instant(receipt.endedAt, `${source}.endedAt`);
  if (endedAt < startedAt) fail(`${source}.endedAt must not precede startedAt`);
  strings(receipt.capabilities, `${source}.capabilities`);

  const absence = object(receipt.absence, `${source}.absence`);
  const absenceStart = instant(absence.startedAt, `${source}.absence.startedAt`);
  const absenceEnd = instant(absence.endedAt, `${source}.absence.endedAt`);
  if (absenceEnd - absenceStart < 4 * 60 * 60 * 1000)
    fail(`${source}.absence must be at least four hours`);
  if (absenceEnd !== startedAt) fail(`${source}.absence.endedAt must equal startedAt`);
  if (absence.projectChanged !== true) fail(`${source}.absence.projectChanged must equal true`);

  const reorientation = object(receipt.reorientation, `${source}.reorientation`);
  const durationMs = integer(reorientation.durationMs, `${source}.reorientation.durationMs`);
  if (durationMs > endedAt - startedAt)
    fail(`${source}.reorientation.durationMs exceeds the receipt interval`);
  if (
    !Array.isArray(reorientation.questions) ||
    reorientation.questions.length !== QUESTION_IDS.length
  ) {
    fail(`${source}.reorientation.questions must contain the four fixed questions`);
  }
  reorientation.questions.forEach((question, index) => {
    object(question, `${source}.reorientation.questions[${index}]`);
    if (question.id !== QUESTION_IDS[index])
      fail(`${source}.reorientation.questions[${index}].id must equal ${QUESTION_IDS[index]}`);
    if (typeof question.answered !== 'boolean')
      fail(`${source}.reorientation.questions[${index}].answered must be boolean`);
    evidenceStrings(
      question.evidenceRefs,
      `${source}.reorientation.questions[${index}].evidenceRefs`,
      receipt.template,
    );
  });

  const outcomes = object(receipt.outcomes, `${source}.outcomes`);
  for (const key of [
    'questionsReviewed',
    'repeatedQuestions',
    'dueCommitmentsReviewed',
    'forgottenCommitments',
    'relevantDecisionsReviewed',
    'missedDecisions',
    'workSessionMs',
    'manualOrganizationMs',
  ]) {
    integer(outcomes[key], `${source}.outcomes.${key}`);
  }
  if (outcomes.repeatedQuestions > outcomes.questionsReviewed)
    fail(`${source}.outcomes.repeatedQuestions exceeds questionsReviewed`);
  if (outcomes.forgottenCommitments > outcomes.dueCommitmentsReviewed)
    fail(`${source}.outcomes.forgottenCommitments exceeds dueCommitmentsReviewed`);
  if (outcomes.missedDecisions > outcomes.relevantDecisionsReviewed)
    fail(`${source}.outcomes.missedDecisions exceeds relevantDecisionsReviewed`);
  if (outcomes.manualOrganizationMs > outcomes.workSessionMs)
    fail(`${source}.outcomes.manualOrganizationMs exceeds workSessionMs`);
  const interpretations = object(outcomes.interpretations, `${source}.outcomes.interpretations`);
  for (const key of ['reviewed', 'incorrect', 'unreviewed'])
    integer(interpretations[key], `${source}.outcomes.interpretations.${key}`);
  if (interpretations.incorrect > interpretations.reviewed)
    fail(`${source}.outcomes.interpretations.incorrect exceeds reviewed`);
  const attention = object(outcomes.attentionItems, `${source}.outcomes.attentionItems`);
  for (const key of ['reviewed', 'useful', 'unreviewed'])
    integer(attention[key], `${source}.outcomes.attentionItems.${key}`);
  if (attention.useful > attention.reviewed)
    fail(`${source}.outcomes.attentionItems.useful exceeds reviewed`);

  const evidence = object(receipt.evidence, `${source}.evidence`);
  for (const key of EVIDENCE_KEYS)
    evidenceStrings(evidence[key], `${source}.evidence.${key}`, receipt.template);
  if (!Array.isArray(receipt.interventions)) fail(`${source}.interventions must be an array`);
  receipt.interventions.forEach((item, index) => {
    object(item, `${source}.interventions[${index}]`);
    if (!['measurement-integrity', 'data-loss', 'security', 'continuation'].includes(item.kind))
      fail(`${source}.interventions[${index}].kind is not recognized`);
    string(item.description, `${source}.interventions[${index}].description`);
    if (typeof item.resolved !== 'boolean')
      fail(`${source}.interventions[${index}].resolved must be boolean`);
    evidenceStrings(
      item.evidenceRefs,
      `${source}.interventions[${index}].evidenceRefs`,
      receipt.template,
    );
  });

  return receipt;
}

const median = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

function summarizeStratum(observations, stopReached) {
  const unansweredQuestions = observations.reduce(
    (sum, receipt) =>
      sum + receipt.reorientation.questions.filter((question) => !question.answered).length,
    0,
  );
  const unresolvedIntegrityInterventions = observations.reduce(
    (sum, receipt) =>
      sum +
      receipt.interventions.filter(
        (item) => !item.resolved && ['measurement-integrity', 'data-loss'].includes(item.kind),
      ).length,
    0,
  );
  const unreviewed = observations.reduce(
    (sum, receipt) =>
      sum +
      receipt.outcomes.interpretations.unreviewed +
      receipt.outcomes.attentionItems.unreviewed,
    0,
  );
  let status = 'incomplete';
  if (observations.length >= 5 && stopReached) status = 'ready-for-review';
  else if (observations.length >= 5) status = 'minimum-met-window-open';
  if (
    status === 'ready-for-review' &&
    (unansweredQuestions > 0 || unreviewed > 0 || unresolvedIntegrityInterventions > 0)
  )
    status = 'inconclusive';

  return {
    status,
    qualifyingSessions: observations.length,
    unansweredQuestions,
    unresolvedIntegrityInterventions,
    reorientationMs:
      observations.length === 0
        ? { values: [], median: null }
        : {
            values: observations.map((receipt) => receipt.reorientation.durationMs),
            median: median(observations.map((receipt) => receipt.reorientation.durationMs)),
          },
    repeatedQuestions: observations.reduce(
      (sum, receipt) => ({
        reviewed: sum.reviewed + receipt.outcomes.questionsReviewed,
        repeated: sum.repeated + receipt.outcomes.repeatedQuestions,
      }),
      { reviewed: 0, repeated: 0 },
    ),
    forgottenCommitments: observations.reduce(
      (sum, receipt) => ({
        reviewed: sum.reviewed + receipt.outcomes.dueCommitmentsReviewed,
        forgotten: sum.forgotten + receipt.outcomes.forgottenCommitments,
      }),
      { reviewed: 0, forgotten: 0 },
    ),
    missedDecisions: observations.reduce(
      (sum, receipt) => ({
        reviewed: sum.reviewed + receipt.outcomes.relevantDecisionsReviewed,
        missed: sum.missed + receipt.outcomes.missedDecisions,
      }),
      { reviewed: 0, missed: 0 },
    ),
    interpretations: observations.reduce(
      (sum, receipt) => ({
        reviewed: sum.reviewed + receipt.outcomes.interpretations.reviewed,
        incorrect: sum.incorrect + receipt.outcomes.interpretations.incorrect,
        unreviewed: sum.unreviewed + receipt.outcomes.interpretations.unreviewed,
      }),
      { reviewed: 0, incorrect: 0, unreviewed: 0 },
    ),
    attentionItems: observations.reduce(
      (sum, receipt) => ({
        reviewed: sum.reviewed + receipt.outcomes.attentionItems.reviewed,
        useful: sum.useful + receipt.outcomes.attentionItems.useful,
        unreviewed: sum.unreviewed + receipt.outcomes.attentionItems.unreviewed,
      }),
      { reviewed: 0, useful: 0, unreviewed: 0 },
    ),
    manualOrganizationMs: observations.reduce(
      (sum, receipt) => sum + receipt.outcomes.manualOrganizationMs,
      0,
    ),
    workSessionMs: observations.reduce((sum, receipt) => sum + receipt.outcomes.workSessionMs, 0),
    interventions: observations.reduce((sum, receipt) => sum + receipt.interventions.length, 0),
  };
}

export function summarize(receipts, asOf = Date.now()) {
  const observations = receipts.filter((receipt) => !receipt.template);
  const runIds = new Set();
  const openingIds = new Set();
  const capabilitiesByStratum = new Map();
  const priorByObserver = new Map();
  for (const receipt of [...observations].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  )) {
    if (runIds.has(receipt.runId)) fail(`duplicate runId: ${receipt.runId}`);
    runIds.add(receipt.runId);
    if (openingIds.has(receipt.openingId)) fail(`duplicate openingId: ${receipt.openingId}`);
    openingIds.add(receipt.openingId);
    const capabilities = [...receipt.capabilities].sort().join('\n');
    const priorCapabilities = capabilitiesByStratum.get(receipt.stratum);
    if (priorCapabilities !== undefined && priorCapabilities !== capabilities)
      fail(`stratum ${receipt.stratum} contains different capability sets`);
    capabilitiesByStratum.set(receipt.stratum, capabilities);
    const prior = priorByObserver.get(receipt.observer);
    if (prior && Date.parse(receipt.startedAt) < Date.parse(prior.endedAt))
      fail(`observer ${receipt.observer} has overlapping receipt intervals`);
    if (prior && Date.parse(receipt.absence.startedAt) < Date.parse(prior.endedAt))
      fail(`observer ${receipt.observer} has an absence overlapping a prior receipt`);
    priorByObserver.set(receipt.observer, receipt);
  }
  if (observations.length > 10) fail('the protocol exceeds ten qualifying sessions');
  const orderedObservations = [...observations].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  const calendarStopAt =
    orderedObservations.length === 0
      ? null
      : Date.parse(orderedObservations[0].startedAt) + 14 * 24 * 60 * 60 * 1000;
  if (
    orderedObservations.length > 1 &&
    Date.parse(orderedObservations.at(-1).startedAt) > calendarStopAt
  )
    fail('an observation falls after the fourteen-day stop boundary');
  const stopReached =
    observations.length === 10 || (calendarStopAt !== null && asOf >= calendarStopAt);

  const grouped = new Map();
  for (const receipt of observations) {
    const group = grouped.get(receipt.stratum) ?? [];
    group.push(receipt);
    grouped.set(receipt.stratum, group);
  }
  return {
    templatesExcluded: receipts.length - observations.length,
    qualifyingSessions: observations.length,
    stopReached,
    calendarStopAt: calendarStopAt === null ? null : new Date(calendarStopAt).toISOString(),
    strata: Object.fromEntries(
      [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([stratum, group]) => [stratum, summarizeStratum(group, stopReached)]),
    ),
  };
}

function selfTest() {
  const base = JSON.parse(
    readFileSync(resolve('plans/phase3-dogfood/receipt.example.json'), 'utf8'),
  );
  validateReceipt(base, 'example');
  const mutations = [
    [
      'catches a shortened absence being counted as a qualifying return',
      (value) => {
        value.absence.startedAt = '2026-08-03T13:00:00.000Z';
      },
    ],
    [
      'catches a changed fixed question set making runs incomparable',
      (value) => {
        value.reorientation.questions[0].id = 'anything';
      },
    ],
    [
      'catches an impossible incorrect-over-reviewed interpretation denominator',
      (value) => {
        value.outcomes.interpretations.incorrect = 2;
      },
    ],
    [
      'catches a repeated-question count larger than its reviewed population',
      (value) => {
        value.outcomes.repeatedQuestions = 2;
      },
    ],
    [
      'catches an example template being silently counted as an observation',
      (value) => {
        value.template = 'false';
      },
    ],
    [
      'catches a zero-count metric with no inspected evidence surface',
      (value) => {
        value.evidence.repeatedQuestions = [];
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(base);
    mutate(candidate);
    try {
      validateReceipt(candidate, name);
      fail(`self-test failed: ${name}`);
    } catch (error) {
      if (String(error.message).startsWith('self-test failed:')) throw error;
    }
  }
  if (Object.keys(summarize([base]).strata).length !== 0)
    fail('self-test failed: template entered the denominator');
  const observation = structuredClone(base);
  observation.template = false;
  observation.runId = 'real-run';
  observation.openingId = 'real-opening';
  const replaceEvidence = (references) =>
    references.map((reference) => reference.replace('replace:', 'urn:'));
  observation.reorientation.questions.forEach((question) => {
    question.evidenceRefs = replaceEvidence(question.evidenceRefs);
  });
  for (const key of EVIDENCE_KEYS)
    observation.evidence[key] = replaceEvidence(observation.evidence[key]);
  try {
    summarize([observation, structuredClone(observation)]);
    fail('self-test failed: duplicate run ids entered the denominator');
  } catch (error) {
    if (String(error.message).startsWith('self-test failed:')) throw error;
  }
  const duplicateOpening = structuredClone(observation);
  duplicateOpening.runId = 'different-run-same-opening';
  duplicateOpening.startedAt = new Date(Date.parse(observation.endedAt) + 60 * 1000).toISOString();
  duplicateOpening.endedAt = new Date(
    Date.parse(duplicateOpening.startedAt) + 3 * 60 * 1000,
  ).toISOString();
  duplicateOpening.absence.endedAt = duplicateOpening.startedAt;
  duplicateOpening.absence.startedAt = new Date(
    Date.parse(duplicateOpening.startedAt) - 6 * 60 * 60 * 1000,
  ).toISOString();
  try {
    summarize([observation, duplicateOpening]);
    fail('self-test failed: one opening produced two qualifying receipts');
  } catch (error) {
    if (String(error.message).startsWith('self-test failed:')) throw error;
  }
  const overlappingAbsence = structuredClone(observation);
  overlappingAbsence.runId = 'overlapping-absence-run';
  overlappingAbsence.openingId = 'overlapping-absence-opening';
  overlappingAbsence.startedAt = new Date(
    Date.parse(observation.startedAt) + 4 * 60 * 60 * 1000,
  ).toISOString();
  overlappingAbsence.endedAt = new Date(
    Date.parse(overlappingAbsence.startedAt) + 3 * 60 * 1000,
  ).toISOString();
  overlappingAbsence.absence.startedAt = observation.startedAt;
  overlappingAbsence.absence.endedAt = overlappingAbsence.startedAt;
  try {
    summarize([observation, overlappingAbsence]);
    fail('self-test failed: overlapping claimed absences manufactured a return');
  } catch (error) {
    if (String(error.message).startsWith('self-test failed:')) throw error;
  }
  const nonAnswering = Array.from({ length: 10 }, (_, index) => {
    const receipt = structuredClone(observation);
    receipt.runId = `non-answer-${index}`;
    receipt.openingId = `non-answer-opening-${index}`;
    receipt.startedAt = new Date(
      Date.parse(observation.startedAt) + index * 5 * 60 * 60 * 1000,
    ).toISOString();
    receipt.endedAt = new Date(Date.parse(receipt.startedAt) + 3 * 60 * 1000).toISOString();
    receipt.absence.startedAt = new Date(
      Date.parse(receipt.startedAt) - 4 * 60 * 60 * 1000,
    ).toISOString();
    receipt.absence.endedAt = receipt.startedAt;
    receipt.reorientation.questions[0].answered = false;
    return receipt;
  });
  if (summarize(nonAnswering).strata[observation.stratum].status !== 'inconclusive')
    fail('self-test failed: fast non-answers produced a reviewable result');
  const unreviewed = structuredClone(nonAnswering);
  unreviewed.forEach((receipt) => {
    receipt.reorientation.questions.forEach((question) => {
      question.answered = true;
    });
  });
  unreviewed[0].outcomes.interpretations.unreviewed = 1;
  if (summarize(unreviewed).strata[observation.stratum].status !== 'inconclusive')
    fail('self-test failed: unreviewed interpretations produced a reviewable result');
  const otherStratum = structuredClone(observation);
  otherStratum.runId = 'other-stratum-run';
  otherStratum.openingId = 'other-stratum-opening';
  otherStratum.observer = 'other-observer';
  otherStratum.stratum = 'other-stratum';
  const stratified = summarize([observation, otherStratum]);
  if (
    Object.keys(stratified.strata).length !== 2 ||
    stratified.strata[observation.stratum].qualifyingSessions !== 1 ||
    stratified.strata[otherStratum.stratum].qualifyingSessions !== 1
  )
    fail('self-test failed: different strata were numerically combined');
  const placeholder = structuredClone(observation);
  placeholder.evidence.projectChanged = [' replace:not-real'];
  try {
    validateReceipt(placeholder, 'real-placeholder');
    fail('self-test failed: a template placeholder entered a real receipt');
  } catch (error) {
    if (String(error.message).startsWith('self-test failed:')) throw error;
  }
  const tooManyStrata = Array.from({ length: 11 }, (_, index) => {
    const receipt = structuredClone(observation);
    receipt.runId = `global-stop-run-${index}`;
    receipt.openingId = `global-stop-opening-${index}`;
    receipt.observer = `global-stop-observer-${index}`;
    receipt.stratum = `global-stop-stratum-${index}`;
    return receipt;
  });
  try {
    summarize(tooManyStrata);
    fail('self-test failed: changing strata extended the global ten-session stop');
  } catch (error) {
    if (String(error.message).startsWith('self-test failed:')) throw error;
  }
  console.info(`self-test: ${mutations.length + 9}/${mutations.length + 9} mutations caught`);
}

function load(path) {
  const resolved = resolve(path);
  if (!statSync(resolved).isFile()) fail(`${path} must be a JSON file`);
  return validateReceipt(JSON.parse(readFileSync(resolved, 'utf8')), path);
}

const args = process.argv.slice(2).filter((argument) => argument !== '--');
if (args.includes('--self-test')) {
  selfTest();
} else if (args.length === 0) {
  console.error('usage: pnpm dogfood:validate -- --self-test | <receipt.json>...');
  process.exitCode = 2;
} else {
  console.info(JSON.stringify(summarize(args.map(load)), null, 2));
}
