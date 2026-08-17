import type {
  CovenantReadResult,
  CovenantReadStatus,
  ObjectGlyphResolver,
} from '../../lib/covenant-read';

/**
 * A test double for the covenant read authority the migrated display readers
 * (#181 / SL-6) source `✓` through. `read()`/`peek()` are collapsed to a single
 * status decision per object, so a test can pin the authority's verdict and assert
 * the glyph that follows — `ok` ⇒ `✓`, `drift`/`unresolved` ⇒ `~` — without a live
 * Yjs doc or a ledger.
 *
 * Pass a constant status, or a function of `objectId` (e.g. "resolve `ok` iff this
 * fixture row carries a human certification"). The returned object structurally
 * satisfies {@link ObjectGlyphResolver} (its `peek`), so it drops straight into
 * `replayView` / `locallyAcceptedState` / `retypeAsClaim`.
 */
export function glyphResolver(
  status: CovenantReadStatus | ((objectId: string) => CovenantReadStatus),
): ObjectGlyphResolver {
  const decide = typeof status === 'function' ? status : () => status;
  return {
    peek(objectId: string): CovenantReadResult {
      return {
        objectId,
        revision: null,
        renderedFragment: null,
        covenantStatus: decide(objectId),
      };
    },
  };
}
