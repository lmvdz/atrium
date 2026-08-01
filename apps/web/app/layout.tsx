import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// The single source of colour, type and motion. globals.css imports
// design/tokens.css; nothing else in the app names a colour.
import './globals.css';

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
 * `?theme=` pins a theme for screenshots and e2e without touching storage.
 */
const themeBootstrap = `(function(){try{var q=new URLSearchParams(location.search).get('theme');var s=q||localStorage.getItem('atrium-theme');var dark=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('atr-dark',dark);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The theme class must be set before first paint; a component effect
            runs too late and a dark-mode user gets a flash of warm paper. The
            script is a constant defined above — no interpolation reaches it. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
