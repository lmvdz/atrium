/**
 * Apply the persisted theme before React hydrates. Keeping this in Next's
 * client instrumentation entry avoids placing a `<script>` inside the React
 * tree: client-side refreshes otherwise warn that the script cannot execute
 * and open the development error overlay over the product.
 *
 * Both token blocks currently resolve to WIRE. The class remains for persisted
 * preferences and for the explicitly addressable light/dark verification
 * routes.
 */
try {
  const query = new URLSearchParams(location.search).get('theme');
  const stored = query || localStorage.getItem('atrium-theme');
  const dark = stored
    ? stored === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('atr-dark', dark);
} catch {
  // Storage and media-query access can be unavailable; the base theme remains usable.
}
