import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { oauthEnabled } from '@/lib/auth';
import { authErrorMessage } from '@/lib/auth-errors';
import { safeNextPath } from '@/lib/next-path';
import { currentSession } from '@/lib/session';
import { systemText } from '@/src/components/model/quotation';
import { signInAction, signInWithGitHubAction } from '../actions';
import styles from '../auth.module.css';

export const metadata: Metadata = { title: 'Sign in · Atrium' };
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const target = safeNextPath(next);

  if (await currentSession()) redirect(target);
  const message = authErrorMessage(error);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Sign in</h1>

        {message ? (
          <p className={styles.error} role="alert" data-testid="form-error">
            {/* THE PAGE'S OWN COPY, THROUGH THE PAGE'S OWN DOOR. `message` is
                one of the seven literals in `lib/auth-errors.ts`, which is
                page-authored text in the system's voice — exactly what
                `systemText` is for. It is not a formality: the check is what
                stops the eighth entry being written with quotation marks or a
                "we could not…" first person, which is how a refusal starts
                reading as somebody speaking. */}
            {systemText(message, 'sign-in form error')}
          </p>
        ) : null}

        <form action={signInAction} className={styles.form}>
          <input type="hidden" name="next" value={target} />

          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">
              Email
            </label>
            <input
              autoComplete="email"
              className={styles.input}
              id="email"
              name="email"
              required
              type="email"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">
              Password
            </label>
            <input
              autoComplete="current-password"
              className={styles.input}
              id="password"
              name="password"
              required
              type="password"
            />
          </div>

          <button className={styles.button} type="submit">
            Sign in
          </button>
        </form>

        {oauthEnabled() ? (
          <>
            <div className={styles.divider}>or</div>
            <form action={signInWithGitHubAction}>
              <input type="hidden" name="next" value={target} />
              <button className={styles.secondaryButton} type="submit">
                Continue with GitHub
              </button>
            </form>
          </>
        ) : null}

        <p className={styles.footer}>
          No account yet?{' '}
          <Link className={styles.link} href="/sign-up">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
