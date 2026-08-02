import Link from 'next/link';
import { currentSession } from '@/lib/session';
import { signOutAction } from './(auth)/actions';
import styles from './shell.module.css';

/**
 * Who you are, in the top bar. Rendered on the server, so the page never flashes
 * "signed out" while some client hook works out that you are not.
 */
export async function AccountBar() {
  const session = await currentSession();

  if (!session) {
    return (
      <span className={styles.account}>
        <Link className={styles.accountLink} data-testid="sign-in-link" href="/sign-in">
          sign in
        </Link>
      </span>
    );
  }

  return (
    <span className={styles.account}>
      <Link className={styles.accountLink} data-testid="account-name" href="/app">
        {session.displayName}
      </Link>
      <form action={signOutAction}>
        <button className={styles.accountButton} data-testid="sign-out" type="submit">
          sign out
        </button>
      </form>
    </span>
  );
}
