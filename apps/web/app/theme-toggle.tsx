'use client';

import { useEffect, useState } from 'react';
import styles from '../src/components/frame/frame.module.css';

const STORAGE_KEY = 'atrium-theme';

/**
 * Dark/light is one class on <html>. No theme provider, no context — both
 * themes define the same 51 token names, so nothing downstream branches on
 * theme; it reads `var(--tx1)` and gets the right answer.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('atr-dark'));
    setHydrated(true);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('atr-dark', next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
    } catch {
      // Private mode / storage disabled — the class still applies for this session.
    }
  };

  return (
    <button
      aria-label={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      aria-pressed={dark}
      className={styles.iconbtn}
      // The button renders server-side but only works once hydrated; the e2e
      // test waits on this rather than racing React.
      data-hydrated={hydrated}
      data-testid="theme-toggle"
      onClick={toggle}
      title={dark ? 'dark theme' : 'light theme'}
      type="button"
    >
      {dark ? (
        <svg fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
          <title>moon</title>
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
        </svg>
      ) : (
        <svg fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
          <title>sun</title>
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
        </svg>
      )}
    </button>
  );
}
