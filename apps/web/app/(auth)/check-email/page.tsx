import type { Metadata } from 'next';
import Link from 'next/link';
import { resendVerificationAction } from '../actions';
import styles from '../auth.module.css';

export const metadata: Metadata = { title: 'Confirm your email · Atrium' };
export const dynamic = 'force-dynamic';

/**
 * The pause between signing up and being signed in.
 *
 * In development there is no SMTP server, so the link is printed to the server
 * console by the dev mailer. Saying that here — rather than leaving someone
 * staring at an empty inbox — is the difference between a five-second detour and
 * a support question.
 */
export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; resent?: string }>;
}) {
  const { email, resent } = await searchParams;

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Confirm your email</h1>

        {resent ? (
          <p className={styles.notice} role="status">
            Sent again. It can take a moment to arrive.
          </p>
        ) : null}

        <p className={styles.lede} data-testid="check-email-lede">
          We sent a confirmation link to{' '}
          <strong className={styles.mono}>{email ?? 'your email address'}</strong>. Open it to
          finish setting up your account.
        </p>

        <p className={styles.hint}>
          Running Atrium locally? There is no mail server in development — the link is printed in
          the terminal running <code>pnpm dev</code>, under “atrium dev mailer”.
        </p>

        {email ? (
          <form action={resendVerificationAction} className={styles.form}>
            <input type="hidden" name="email" value={email} />
            <button className={styles.secondaryButton} type="submit">
              Send it again
            </button>
          </form>
        ) : null}

        <p className={styles.footer}>
          <Link className={styles.link} href="/sign-in">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
