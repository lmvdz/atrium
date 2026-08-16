/* ---------------------------------------------------------------------------
 * THE COVENANT CLASSIFICATION THE CLIENT AFFORDANCES WIRE TO (#168 go-live B2).
 *
 * The married surface's live covenant doors (`apps/web/app/prototype/covenant.ts`
 * `makeCovenant`) route each RESERVED human-only act to its server command:
 *   certify a session landing / a claim → `correct` (the `certifies` class)
 *   fund a plan (set/raise its slice)   → `set_plan_rlimit` (the `authorizes-spend` class)
 *   steer / interrupt a session         → `signal_session` (the `open` class — participation)
 *
 * The covenant is held SERVER-SIDE: `applyCommand` (commands.ts ~:1767) refuses a
 * NON-HUMAN principal at BOTH the `certifies` and `authorizes-spend` doors BEFORE
 * any append — a machine may draft a `~`, never mint a `✓`, and never raise a
 * budget. `certificationClassOf` is the single place that list of classes lives;
 * this pins it, so a regression that reclassified the spend door as `open` (a
 * machine funding itself — campaign-stopping) or the certify door as participation
 * fails here. The reducer-fold half of the same rule (every non-human certify /
 * correction / retract refused) is exhaustively covered by
 * `packages/core/test/authority-matrix.test.ts`.
 * ------------------------------------------------------------------------- */

import { describe, expect, it } from 'vitest';
import {
  certificationClassOf,
  nonHumanCertificationRefusal,
  nonHumanSpendAuthorizationRefusal,
} from '../src/commands.js';

describe('the reserved human-only doors are classified so a non-human is refused', () => {
  it('the SPEND door (fund → set_plan_rlimit) is authorizes-spend, not open', () => {
    // If this were `open`, a machine could raise its own plan's ceiling — the one
    // classification #118 exists to make impossible by construction.
    expect(certificationClassOf('set_plan_rlimit')).toBe('authorizes-spend');
  });

  it('the CERTIFY door (certify / certifyClaim / retract → correct) is certifies', () => {
    // The `correct` verb carries the covenant certify (`amend {verification}`) and
    // the retract; classifying it `certifies` is what refuses a machine minting a `✓`.
    expect(certificationClassOf('correct')).toBe('certifies');
  });

  it('the STEER/INTERRUPT door (signal_session) is open — participation, any member', () => {
    // A steer is powerless over covenant and purse, so it is participation, not
    // certification; the WHO (owner-only interrupt) is checked in-command, not here.
    expect(certificationClassOf('signal_session')).toBe('open');
  });

  it('the refusal a machine is shown names the act, the kind, and the human route', () => {
    const certify = nonHumanCertificationRefusal('correct', 'agent');
    expect(certify).toContain('agent');
    expect(certify).toContain('may never certify');

    const spend = nonHumanSpendAuthorizationRefusal('set_plan_rlimit', 'agent');
    expect(spend).toContain('agent');
    expect(spend).toContain('human = init');
    expect(spend).toContain('fund the plan');
  });
});
