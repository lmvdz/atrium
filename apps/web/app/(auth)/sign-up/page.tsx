import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { oauthEnabled } from '@/lib/auth';
import { authErrorMessage } from '@/lib/auth-errors';
import { currentSession } from '@/lib/session';
import { systemText } from '@/src/components/model/quotation';
import { signInWithGitHubAction, signUpAction } from '../actions';
import styles from '../auth.module.css';

export const metadata: Metadata = { title: 'Create an account · Atrium' };
export const dynamic = 'force-dynamic';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await currentSession()) redirect('/app');
  const { error, next } = await searchParams;
  const message = authErrorMessage(error);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Create an account</h1>
        <p className={styles.lede}>
          Atrium keeps track of what a conversation actually settled. Start by telling us who you
          are.
        </p>

        {message ? (
          <p className={styles.error} role="alert" data-testid="form-error">
            {/* THE PAGE'S OWN COPY, THROUGH THE PAGE'S OWN DOOR. `message` is
                one of the seven literals in `lib/auth-errors.ts`, which is
                page-authored text in the system's voice — exactly what
                `systemText` is for. It is not a formality: the check is what
                stops the eighth entry being written with quotation marks or a
                "we could not…" first person, which is how a refusal starts
                reading as somebody speaking. */}
            {systemText(message, 'sign-up form error')}
          </p>
        ) : null}

        <form action={signUpAction} className={styles.form}>
          <input type="hidden" name="next" value={next ?? '/app'} />

          <div className={styles.field}>
            <label className={styles.label} htmlFor="displayName">
              Name
            </label>
            <input
              autoComplete="name"
              className={styles.input}
              id="displayName"
              maxLength={80}
              name="displayName"
              required
              type="text"
            />
          </div>

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
              autoComplete="new-password"
              className={styles.input}
              id="password"
              minLength={12}
              name="password"
              required
              type="password"
            />
            <span className={styles.hint}>At least 12 characters.</span>
          </div>

          <button className={styles.button} type="submit">
            Create account
          </button>
        </form>

        {oauthEnabled() ? (
          <>
            <div className={styles.divider}>or</div>
            <form action={signInWithGitHubAction}>
              <input type="hidden" name="next" value={next ?? '/app'} />
              <button className={styles.secondaryButton} type="submit">
                Continue with GitHub
              </button>
            </form>
          </>
        ) : null}

        <p className={styles.footer}>
          Already have an account?{' '}
          <Link className={styles.link} href="/sign-in">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
