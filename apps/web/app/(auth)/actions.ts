'use server';

import { createThrottle, type Throttle } from '@atrium/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { authErrorCode } from '@/lib/auth-errors';
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
 * Rate limits, per address.
 *
 * Better Auth rate-limits its HTTP endpoints, but these actions call `auth.api.*`
 * directly and so never pass through that middleware. Without these, a form post
 * could brute-force a password or mail-bomb an address as fast as the network
 * allows. Kept on `globalThis` so the dev server's hot reload does not hand an
 * attacker a fresh empty counter on every file save.
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

/** Rate-limit keys are case-insensitive; `Ada@` and `ada@` are one address. */
const limitKey = (email: string) => email.trim().toLowerCase();

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

  if (!limiters.signUp.attempt(limitKey(parsed.data.email))) {
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
  if (!limiters.signIn.attempt(key)) {
    redirect(`/sign-in?error=rate_limited&next=${encodeURIComponent(next)}`);
  }

  let failure: string | null = null;
  try {
    await auth().api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
      headers: await headers(),
    });
    // A correct password clears the counter, so a run of typos costs nothing
    // once you get it right.
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
  if (!limiters.resend.attempt(limitKey(email.data))) {
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
