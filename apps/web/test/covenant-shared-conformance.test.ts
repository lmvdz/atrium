import { describe } from 'vitest';
import { CovenantDocReaderProd } from '@/lib/covenant-reader';
import { YjsCovenantDocReader } from '../../../packages/core/test/support/yjs-reader';
import {
  type HarnessReader,
  type HarnessSelection,
  runReaderConformance,
} from './support/conformance-harness';

/**
 * THE SHARED CONFORMANCE SUITE (#189 coverage close).
 *
 * The IDENTICAL contract (`runReaderConformance`) run against BOTH readers:
 *   - the REFERENCE DOUBLE (`YjsCovenantDocReader`, `@atrium/core`'s test adapter);
 *   - the PRODUCTION reader (`CovenantDocReaderProd`).
 *
 * Both must pass every advertised drift class, class B/C, flip-the-input, EXACT
 * content, strict snapshot, embed straddle, canonical+NFC child, provenance-not-
 * content — AND the three controls the production suite had omitted (off-boundary
 * SV redistribution, boundary-tombstone, unrelated-deletion). Because the assertions
 * are defined ONCE and parameterized, the two readers' coverage cannot diverge.
 */

describe('shared conformance — reference double', () => {
  runReaderConformance(
    'double',
    (doc, selection?: HarnessSelection): HarnessReader => new YjsCovenantDocReader(doc, selection),
  );
});

describe('shared conformance — production reader', () => {
  runReaderConformance(
    'production',
    (doc, selection?: HarnessSelection): HarnessReader => new CovenantDocReaderProd(doc, selection),
  );
});
