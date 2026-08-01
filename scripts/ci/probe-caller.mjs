/**
 * One caller, hammering the sign-in form, reporting what the limiter did.
 *
 * Runs **inside** the compose network, in a throwaway container with a fixed
 * address, because that is the only way to be a distinct caller. Reaching the
 * stack from the host through a published port makes every request look like the
 * docker bridge, so a per-address limiter would be indistinguishable from a
 * global one — which is precisely the confusion #26 round 4 could not resolve
 * and #40 was asked to settle.
 *
 * Each attempt uses a **fresh email address**, so the per-address (per-account)
 * limiter never fires and the only dimension being exercised is the caller's IP.
 * Nothing here signs anybody in: the accounts do not exist, so every attempt is
 * a failed sign-in, and a failed sign-in is exactly what a spray looks like.
 *
 * Output is one JSON object on stdout, read by `assert-rate-limit.mjs`.
 */

import { follow, formFields, stackTarget, submit, uniqueEmail } from './stack-client.mjs';

const target = stackTarget();
const attempts = Number(process.env.ATRIUM_PROBE_ATTEMPTS ?? 5);
const label = process.env.ATRIUM_PROBE_LABEL ?? 'caller';

const page = await follow(target, '/sign-in');
if (page.status !== 200) {
  process.stdout.write(JSON.stringify({ label, error: `GET /sign-in → ${page.status}` }));
  process.exit(0);
}
const fields = formFields(page.body, '$ACTION_ID_');

const outcomes = [];
for (let index = 0; index < attempts; index += 1) {
  const response = await submit(target, '/sign-in', {
    ...fields,
    email: uniqueEmail(`${label}-probe`),
    password: 'not-the-right-password',
  });
  const limited = response.path.includes('error=rate_limited');
  outcomes.push({ index, status: response.status, path: response.path, limited });
  // Stop at the first refusal: the number matters, and continuing past it only
  // burns time and makes the log longer.
  if (limited) break;
}

const firstLimited = outcomes.findIndex((outcome) => outcome.limited);
process.stdout.write(
  JSON.stringify({
    label,
    attempts: outcomes.length,
    limitedAt: firstLimited === -1 ? null : firstLimited + 1,
    limited: firstLimited !== -1,
    lastPath: outcomes.at(-1)?.path ?? null,
  }),
);
