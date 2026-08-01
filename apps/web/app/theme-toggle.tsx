'use client';

import { useEffect, useState } from 'react';
import styles from './shell.module.css';

const STORAGE_KEY = 'atrium-theme';

/**
 * Dark/light is one class on <html>. No theme provider, no context — the
 * token file does all the work.
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
      type="button"
      className={styles.themeToggle}
      onClick={toggle}
      aria-pressed={dark}
      data-testid="theme-toggle"
      // The button renders server-side but only works once hydrated; the e2e
      // test waits on this rather than racing React.
      data-hydrated={hydrated}
    >
      {dark ? 'dark' : 'light'}
    </button>
  );
}
