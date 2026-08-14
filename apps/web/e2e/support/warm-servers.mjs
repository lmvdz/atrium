import { baseURL, serverPort } from './config.mjs';

/**
 * Compile every route ONCE, SERIALLY, before any worker starts.
 *
 * ## The defect this closes (#131)
 *
 * `playwright.config.ts` starts `next dev` and considers it up as soon as `/`
 * answers. That is one route. Next's dev server compiles the *rest* on first
 * request, and `tsx src/index.ts` warms its own module graph the same way — so
 * at the instant the gate declares the servers ready, four browser workers are
 * released against a process that still has to build almost everything they ask
 * for. Four workers requesting four different uncompiled routes do not share
 * that work: they queue behind a compiler on a box whose run queue is already
 * 8–16 deep on 4 CPUs, and every one of them is holding a test clock open while
 * they wait.
 *
 * The symptom was one test failing per full run, a DIFFERENT one each run, every
 * one of them passing in isolation — measured across four runs and two operators.
 * The victim moves because the loser is whichever test happens to be holding the
 * longest clock when the contention lands, not because of anything that test
 * does. It spanned unrelated families: `multiplayer.spec.ts` (five contexts, 200
 * messages, real reconnects) and `gallery.spec.ts`'s focus-ring sweep, which
 * opens no socket, touches no database and reconnects nothing — it tabs a static
 * page ~670 times through CDP. A test with no realtime surface at all was the
 * worst hit (5.7s solo → over its 60s budget at 4 workers), which is what rules
 * out every reconnect-shaped explanation.
 *
 * ## Why this is the fix and not a mask
 *
 * It does not buy any test more time — no timeout in this suite moves. The
 * compilation cost is not avoided either; it is *paid once, serially, here*,
 * where nothing is being timed, instead of four ways at once inside four test
 * clocks. Flip the input and the machinery is visible: with the servers warm the
 * full suite at 4 workers is green and takes 4.0 minutes; cold at the same 4
 * workers on the same tree it took 7.7 and lost three tests to bare
 * wall-clock timeouts with no assertion failure among them.
 *
 * ## What this does NOT claim
 *
 * The box is still saturated during the run (run queue 8–16 on 4 CPUs, 0–2%
 * idle). This removes the one starvation source that is an artifact of *how the
 * gate starts*; it does not make 4 workers roomy on a 4-core machine. The worker
 * count is the map's call, and the honest margin is thin.
 *
 * Warm-up failures are logged and never thrown: a suite that goes red because a
 * preparatory fetch hiccuped would be reporting the harness as the product.
 */

/**
 * Every route the suite reaches, plus the realtime server's health endpoint.
 *
 * The authenticated routes answer 307 to an unauthenticated warm-up, and that is
 * enough: Next compiles a route's module graph to *run* it, and the redirect is
 * a decision the compiled code makes. A 307 here means the bundle got built,
 * which is the cost being moved.
 */
const ROUTES = [
  '/',
  '/sign-in',
  '/sign-up',
  '/check-email',
  '/app',
  '/gallery',
  '/gallery?theme=dark',
  '/gallery?theme=light',
  '/gallery/pin/1',
  '/invite/00000000-0000-0000-0000-000000000000',
  '/app/warm/general',
  '/app/warm/general/control',
  '/replay/warm/general',
];

export default async function warmServers() {
  const started = Date.now();
  let warmed = 0;

  try {
    await fetch(`http://127.0.0.1:${serverPort}/health`);
  } catch (error) {
    console.warn(`[e2e] realtime health check did not answer during warm-up: ${describe(error)}`);
  }

  for (const route of ROUTES) {
    try {
      const response = await fetch(new URL(route, baseURL), { redirect: 'manual' });
      // Drain it. An undrained body leaves the connection open and the render
      // half-done, which is not the warm state this is trying to reach.
      await response.text().catch(() => {});
      warmed += 1;
    } catch (error) {
      console.warn(`[e2e] could not warm ${route}: ${describe(error)}`);
    }
  }

  console.info(
    `[e2e] warmed ${warmed}/${ROUTES.length} routes in ${Date.now() - started}ms ` +
      `— compilation paid before the workers start, not inside their clocks (#131)`,
  );
}

/** `(error as Error).message` throws on a rejection carrying a hostile getter. */
function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
