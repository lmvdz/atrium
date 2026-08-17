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
      /**
       * Where the browser reads a room's document (#201) — a PATH on this
       * origin, and only ever a path.
       *
       * `ELECTRIC_URL` is emphatically NOT published here. That variable names
       * the sync service on the private network, and Electric authenticates
       * nobody: handing a browser its address would be handing every browser
       * every room's document. What is published is the route in this app that
       * checks the session, checks the membership, and pins the shape's `where`
       * clause server-side. The value is configurable only so a deployment that
       * mounts the proxy elsewhere can say so — it is not a way to point the
       * browser at Electric directly, and `resolveElectricShapeUrl` refuses an
       * absolute value for exactly that reason.
       *
       * Reported as `null` when this deployment has no Electric, so the client
       * can render a room without a live document rather than retrying a route
       * that will 503 forever.
       */
      electricShapePath: process.env.ELECTRIC_URL?.trim()
        ? (process.env.ATRIUM_ELECTRIC_SHAPE_PATH ?? '/electric/v1/shape')
        : null,
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
