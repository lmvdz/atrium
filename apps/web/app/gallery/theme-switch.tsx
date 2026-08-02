'use client';

/* The gallery's theme control. Both themes are the SAME markup under one class
   on <html> — there is no per-frame theme override anywhere, because every
   token name exists in both blocks and nothing downstream branches on theme.
   Playwright drives this control to shoot both themes. */

import { useEffect, useState } from 'react';
import styles from './gallery.module.css';

const STORAGE_KEY = 'atrium-theme';

export function ThemeSwitch() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('atr-dark'));
  }, []);

  const apply = (next: boolean) => {
    setDark(next);
    document.documentElement.classList.toggle('atr-dark', next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
    } catch {
      // storage disabled — the class still applies for this session
    }
  };

  return (
    <div aria-label="Theme" className={styles.themeControls} role="toolbar">
      <button
        aria-pressed={!dark}
        className={`${styles.themeButton} atr-lbl`}
        data-testid="gallery-theme-light"
        onClick={() => apply(false)}
        type="button"
      >
        LIGHT
      </button>
      <button
        aria-pressed={dark}
        className={`${styles.themeButton} atr-lbl`}
        data-testid="gallery-theme-dark"
        onClick={() => apply(true)}
        type="button"
      >
        DARK
      </button>
    </div>
  );
}
