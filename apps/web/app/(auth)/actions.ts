'use server';

import { clientIp, createThrottle, type Throttle } from '@atrium/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { authErrorCode } from '@/lib/auth-errors';
import { proxyStrategy } from '@/lib/env';
import { safeNextPath } from '@/lib/next-path';

/**
 * Signing up, in, and out.
 *
 * These are Server Actions driven by plain `<form>` elements, so the flows work
 * with no client JavaScript at all and there is no auth token anywhere near the
 * browser bundle. Failures come back as a `?error=` code that the page renders —
 * a redirect, not thrown state, so a refresh after a bad password is harmless.
 */

const Email = z.email().max(320);
/** Better Auth is configured with a 12-character floor; say so before it does. */
const Password = z.string().min(12, 'too-short').max(128);

const SignUpForm = z.object({
  displayName: z.string().trim().min(1).max(80),
  email: Email,
  password: Password,
});

const SignInForm = z.object({
  email: Email,
  password: z.string().min(1),
});

/** Only ever redirect inside this app: an open redirect is a phishing gift. */
const safeNext = (value: FormDataEntryValue | null) => safeNextPath(value);

/**
 * Rate limits, on two dimensions.
 *
 * Better Auth rate-limits its HTTP endpoints, but these actions call `auth.api.*`
 * directly and so never pass through that middleware. Without these, a form post
 * could brute-force a password or mail-bomb an address as fast as the network
 * allows. Kept on `globalThis` so the dev server's hot reload does not hand an
 * attacker a fresh empty counter on every file save.
 *
 * **Two dimensions, because one is not enough.** Round 1 keyed only on the email
 * address, which bounds "many guesses at one account" and does nothing at all
 * about "one guess at each of ten thousand accounts" — password spray, the
 * attack that actually works against a user base. Every attempt now counts
 * against the address *and* against the caller's IP, and the IP limit is the
 * looser of the two because a shared NAT is a real thing and a spraying script
 * is still hundreds of times over it.
 *
 * Where the IP comes from — and whether it can be trusted — is
 * `@atrium/auth`'s `clientIp`, which believes the forwarded headers only as far
 * as `ATRIUM_TRUSTED_PROXY_HOPS` says to. That variable is **required in
 * production** (`lib/env.ts`): leaving the limiter silently one-dimensional was
 * round 2's finding, and a value nobody set is not a safe default. `0` says
 * there is nothing in front of this process, which on the Server Action path
 * means no address is available at all — Next cannot hand one over — so the
 * per-address limiter carries the load until a proxy is put in front and `hops`
 * says so. Absent, never forged.
 *
 * Scope caveats (single process, reset on restart) are in
 * `packages/auth/src/throttle.ts` and hold here.
 */
const limiters = ((): {
  signIn: Throttle;
  signUp: Throttle;
  resend: Throttle;
} => {
  const key = Symbol.for('atrium.web.throttles');
  const holder = globalThis as unknown as { [key]?: ReturnType<typeof build> };
  function build() {
    return {
      // Ten wrong passwords in five minutes is a person; the eleventh is a script.
      signIn: createThrottle({ limit: 10, windowMs: 5 * 60_000 }),
      signUp: createThrottle({ limit: 5, windowMs: 60 * 60_000 }),
      // Verification mail is the loudest thing we can aim at a stranger's inbox.
      resend: createThrottle({ limit: 3, windowMs: 15 * 60_000 }),
    };
  }
  holder[key] ??= build();
  return holder[key];
})();

/**
 * The IP limit is deliberately looser than the per-address one: an office, a
 * university or a mobile carrier is one address to us and hundreds of people to
 * itself. It is still tight enough that spraying one guess at each of a thousand
 * accounts trips on the twentieth.
 */
const ipLimiters = ((): { signIn: Throttle; signUp: Throttle; resend: Throttle } => {
  const key = Symbol.for('atrium.web.throttles.ip');
  const holder = globalThis as unknown as { [key]?: ReturnType<typeof build> };
  function build() {
    return {
      signIn: createThrottle({ limit: 60, windowMs: 5 * 60_000 }),
      signUp: createThrottle({ limit: 20, windowMs: 60 * 60_000 }),
      resend: createThrottle({ limit: 20, windowMs: 15 * 60_000 }),
    };
  }
  holder[key] ??= build();
  return holder[key];
})();

/** Rate-limit keys are case-insensitive; `Ada@` and `ada@` are one address. */
const limitKey = (email: string) => email.trim().toLowerCase();

/** The caller's address, or null when nothing in front of us can be believed. */
async function callerIp(): Promise<string | null> {
  return clientIp(await headers(), { strategy: proxyStrategy() });
}

/**
 * Record one attempt against both dimensions. False means refused.
 *
 * Both counters are always recorded, even when the first already refuses:
 * otherwise tripping the cheap one would shield the expensive one.
 */
function allow(kind: 'signIn' | 'signUp' | 'resend', email: string, ip: string | null): boolean {
  const byEmail = limiters[kind].attempt(limitKey(email));
  const byIp = ip === null ? true : ipLimiters[kind].attempt(ip);
  return byEmail && byIp;
}

export async function signUpAction(formData: FormData): Promise<never> {
  const next = safeNext(formData.get('next'));
  const parsed = SignUpForm.safeParse({
    displayName: formData.get('displayName'),
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    const tooShort = parsed.error.issues.some((issue) => issue.message === 'too-short');
    redirect(`/sign-up?error=${tooShort ? 'password_too_short' : 'invalid'}`);
  }

  if (!allow('signUp', parsed.data.email, await callerIp())) {
    redirect('/sign-up?error=rate_limited');
  }

  let failure: string | null = null;
  try {
    await auth().api.signUpEmail({
      body: {
        name: parsed.data.displayName,
        email: parsed.data.email,
        password: parsed.data.password,
      },
      headers: await headers(),
    });
  } catch (error) {
    failure = authErrorCode(error);
  }

  // `redirect` throws to unwind, so it must never sit inside the try above.
  if (failure) redirect(`/sign-up?error=${failure}`);
  redirect(
    `/check-email?email=${encodeURIComponent(parsed.data.email)}&next=${encodeURIComponent(next)}`,
  );
}

export async function signInAction(formData: FormData): Promise<never> {
  const next = safeNext(formData.get('next'));
  const parsed = SignInForm.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) redirect(`/sign-in?error=invalid&next=${encodeURIComponent(next)}`);

  const key = limitKey(parsed.data.email);
  const ip = await callerIp();
  if (!allow('signIn', parsed.data.email, ip)) {
    redirect(`/sign-in?error=rate_limited&next=${encodeURIComponent(next)}`);
  }

  let failure: string | null = null;
  try {
    await auth().api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
      headers: await headers(),
    });
    // A correct password clears the address counter, so a run of typos costs
    // nothing once you get it right. The IP counter is deliberately *not*
    // cleared: one successful sign-in must not reset the budget a spray is
    // burning through from the same address.
    limiters.signIn.reset(key);
  } catch (error) {
    failure = authErrorCode(error);
  }

  if (failure === 'email_not_verified') {
    redirect(`/check-email?email=${encodeURIComponent(parsed.data.email)}&resent=1`);
  }
  if (failure) redirect(`/sign-in?error=${failure}&next=${encodeURIComponent(next)}`);
  redirect(next);
}

/**
 * The one OAuth provider. Better Auth returns the provider's authorize URL
 * rather than redirecting itself, so the action hands it to Next — which keeps
 * the client secret and the PKCE state on the server where they belong.
 */
export async function signInWithGitHubAction(formData: FormData): Promise<never> {
  const next = safeNext(formData.get('next'));

  let target: string | null = null;
  try {
    const result = await auth().api.signInSocial({
      body: { provider: 'github', callbackURL: next, errorCallbackURL: '/sign-in?error=unknown' },
      headers: await headers(),
    });
    target = typeof result?.url === 'string' ? result.url : null;
  } catch {
    target = null;
  }

  redirect(target ?? '/sign-in?error=unknown');
}

export async function signOutAction(): Promise<never> {
  try {
    await auth().api.signOut({ headers: await headers() });
  } catch {
    // Already signed out is the outcome we wanted anyway.
  }
  redirect('/sign-in');
}

/** Re-sends the verification email for someone stuck on the check-email page. */
export async function resendVerificationAction(formData: FormData): Promise<never> {
  const email = Email.safeParse(formData.get('email'));
  if (!email.success) redirect('/sign-in');

  // Over the limit still lands on the same page saying the same thing. Telling
  // the caller "you have been throttled" would confirm the address is worth
  // throttling, and the person who genuinely clicked twice does not care.
  if (!allow('resend', email.data, await callerIp())) {
    redirect(`/check-email?email=${encodeURIComponent(email.data)}&resent=1`);
  }

  try {
    await auth().api.sendVerificationEmail({
      body: { email: email.data, callbackURL: '/app' },
      headers: await headers(),
    });
  } catch {
    // Never confirm or deny whether an address is registered.
  }
  redirect(`/check-email?email=${encodeURIComponent(email.data)}&resent=1`);
}
