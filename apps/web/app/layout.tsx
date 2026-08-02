import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
// The single source of colour, type and motion. globals.css imports
// design/tokens.css; nothing else in the app names a colour. This replaces the
// scaffold's direct `import '../../../design/tokens.css'` — the tokens are
// still loaded, one level down, which is exactly what that import's own comment
// said would happen when the design branch landed.
import './globals.css';
import { AccountBar } from './account-bar';
import styles from './shell.module.css';

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
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: `themeBootstrap`
            is a module-level string literal with no interpolation and no data
            from a request, a prop or storage flowing into it. There is no
            supported way to emit a pre-paint inline script in the App Router
            without this prop, and the alternative — setting the class from an
            effect — is the flash-of-wrong-theme this exists to prevent. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        {/* WHO YOU ARE IS GLOBAL CHROME; THE ROOM IS NOT.
            The auth lane put a wordmark, a room name, the account cluster and a
            theme toggle in this bar. Two of those four now have an owner one
            level down, and keeping a second copy here would be worse than
            keeping none:

            - the ROOM NAME was the literal `#scaffold`, printed on every route
              including routes that are not a room. `RoomHead` prints the room's
              actual name from its record, and this codebase's standing rule is
              that the page does not invent the strings it prints.
            - the THEME TOGGLE lives in the frame's 52px workspace strip, which
              is where design/CONVENTIONS.md puts it ("workspace tile, spacer,
              theme control, you") and where `RoomFrame` renders it. It is the
              same `<ThemeToggle />` component the auth lane shipped, with the
              same `data-testid`, the same storage key and the same pre-paint
              contract — moved, not dropped. A second one here would put two
              elements behind `getByTestId('theme-toggle')` and break the
              single-toggle assertion BOTH lanes' e2e depends on.

            The account cluster has no owner further down — the frame's strip
            carries a viewer's initials, not a session — so it stays here, on
            every route, which is what `/app` and `/app/<ws>/<room>` assert. */}
        <div className={styles.app}>
          <header className={styles.topbar}>
            <Link className={styles.wordmark} href="/">
              atrium
            </Link>
            <span className={styles.spacer} />
            <AccountBar />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
