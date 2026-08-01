import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

/**
 * Better Auth's own endpoints: sign-in, sign-out, email verification, OAuth
 * callbacks. Everything under `/api/auth/*` is the library's, not ours — the
 * verification link in the dev mailer points here.
 *
 * The handler is resolved per request rather than at module scope so that
 * `next build`, which imports this file, never needs a database or a secret.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(auth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(auth()).POST(request);
}
