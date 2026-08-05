'use client';

/* ---------------------------------------------------------------------------
 * THE OUTER HALF OF THE SAME BOUNDARY.
 *
 * `app/error.tsx` catches a throw inside the page. It cannot catch one in the
 * ROOT LAYOUT, because the layout is what renders the boundary — so without this
 * file a failure there still reaches Next's default "This page couldn't load"
 * with the whole document replaced.
 *
 * It renders its own `<html>`/`<body>` because at this level nothing else has.
 * ------------------------------------------------------------------------- */

export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#e6e2da', color: '#1b1c1e' }}>
        <div data-error-boundary="global" role="alert" style={{ padding: 24, maxWidth: 640 }}>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
              fontSize: 10,
              letterSpacing: '.14em',
              marginBottom: 10,
            }}
          >
            ATRIUM REFUSED TO RENDER
          </div>
          <pre
            style={{
              fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
              fontSize: 10.5,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message}
          </pre>
          <button onClick={reset} type="button">
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
