/**
 * @atrium/core — the Semantic Core.
 *
 * Pure TypeScript, zero I/O. This package must never import `node:*`, a
 * database driver, a network client, or anything that reads a clock. That
 * purity is load-bearing: it is what makes interpretation replayable and
 * testable in isolation (issue #11).
 */
export * from './acceptance.js';
export * from './attention.js';
export * from './authority.js';
export * from './common.js';
export * from './corrections.js';
export * from './epistemic.js';
export * from './escalation.js';
export * from './events.js';
export * from './matching.js';
export * from './objects.js';
export * from './policy.js';
export * from './ports.js';
export * from './proposal.js';
export * from './reduce.js';
export * from './relations.js';
export * from './state.js';
