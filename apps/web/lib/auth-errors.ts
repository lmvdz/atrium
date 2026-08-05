/**
 * Turning a Better Auth failure into something a page can say out loud.
 *
 * Two rules shape this list. Sign-in never distinguishes "no such account" from
 * "wrong password", because doing so hands an attacker a way to enumerate who
 * has an account here. And anything unrecognised becomes `unknown` rather than
 * leaking a library message into the UI.
 */

export type AuthErrorCode =
  | 'invalid'
  | 'invalid_credentials'
  | 'email_taken'
  | 'email_not_verified'
  | 'password_too_short'
  | 'rate_limited'
  | 'unknown';

const byLibraryCode: Record<string, AuthErrorCode> = {
  USER_ALREADY_EXISTS: 'email_taken',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'email_taken',
  INVALID_EMAIL_OR_PASSWORD: 'invalid_credentials',
  INVALID_EMAIL: 'invalid',
  INVALID_PASSWORD: 'invalid_credentials',
  USER_NOT_FOUND: 'invalid_credentials',
  EMAIL_NOT_VERIFIED: 'email_not_verified',
  PASSWORD_TOO_SHORT: 'password_too_short',
  PASSWORD_TOO_LONG: 'invalid',
};

interface ApiErrorish {
  status?: unknown;
  statusCode?: unknown;
  body?: { code?: unknown; message?: unknown };
  message?: unknown;
}

export function authErrorCode(error: unknown): AuthErrorCode {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const api = error as ApiErrorish;

  const code = api.body?.code;
  if (typeof code === 'string' && byLibraryCode[code]) return byLibraryCode[code];

  if (api.status === 'TOO_MANY_REQUESTS' || api.statusCode === 429) return 'rate_limited';

  // Older/edge paths only carry prose. Match on the one phrase that matters,
  // because "check your email" and "wrong password" are different screens.
  const message = [api.body?.message, api.message].find((m) => typeof m === 'string');
  if (typeof message === 'string' && /verif/i.test(message)) return 'email_not_verified';

  return 'unknown';
}

/** What the person actually reads. */
export const authErrorMessages: Record<AuthErrorCode, string> = {
  invalid: 'Check the details above and try again.',
  invalid_credentials: 'That email and password do not match an account.',
  email_taken: 'There is already an account with that email. Try signing in.',
  email_not_verified: 'Confirm your email address first — check your inbox.',
  password_too_short: 'Passwords need at least 12 characters.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  unknown: 'Something went wrong. Try again.',
};

export function authErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return authErrorMessages[code as AuthErrorCode] ?? authErrorMessages.unknown;
}
