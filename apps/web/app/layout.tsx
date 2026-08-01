import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// The single source of colour, type and spacing. Replace this file wholesale
// when the `design/tokens` branch lands — nothing here needs to change.
import '../../../design/tokens.css';
import styles from './shell.module.css';
import { ThemeToggle } from './theme-toggle';

export const metadata: Metadata = {
  title: 'Atrium',
  description: 'Understanding-first multiplayer conversation.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#e6e2da' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0b0c' },
  ],
};

/**
 * Applied before first paint so a dark-mode user never sees a flash of warm
 * paper. Light is the default; `html.atr-dark` is the only dark switch.
 */
const themeBootstrap = `(function(){try{var s=localStorage.getItem('atrium-theme');var dark=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('atr-dark',dark);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the theme class must be set before first paint */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <div className={styles.app}>
          <header className={styles.topbar}>
            <span className={styles.wordmark}>atrium</span>
            <span className={styles.roomName}>#scaffold</span>
            <ThemeToggle />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
