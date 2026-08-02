/**
 * The client's runtime configuration, read per request.
 *
 * `force-dynamic` is the entire point of this file. Next inlines
 * `NEXT_PUBLIC_*` into the bundle and prerenders static routes at build time —
 * either of which freezes the WebSocket URL into the image, which is the defect
 * #19's gauntlet routed to #22. A dynamic route handler reads `process.env`
 * when the request arrives, so one image runs in dev, staging and production,
 * and a self-hoster changes a domain by restarting a container.
 *
 * `ATRIUM_WS_URL` (not `NEXT_PUBLIC_WS_URL`) on purpose: the old name meant
 * "inline me", and leaving it in place would keep the trap armed for whoever
 * copies the compose file next.
 *
 * Both values may be absent, and absent is the good case: the client then
 * derives a same-origin `/ws`, which is right for any deployment behind the
 * reverse proxy init.md describes.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET(): Response {
  return Response.json(
    {
      wsUrl: process.env.ATRIUM_WS_URL ?? null,
      wsPath: process.env.ATRIUM_WS_PATH ?? '/ws',
    },
    {
      headers: {
        // Belt and braces with `force-dynamic`: a CDN that cached this would
        // serve one deployment's socket URL to another's browser.
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    },
  );
}
