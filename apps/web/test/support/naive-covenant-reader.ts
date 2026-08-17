import type * as Y from 'yjs';
import type { Mark } from '@atrium/core';
import {
  type BodyPath,
  CovenantDocReaderProd,
  type DocSource,
  type ReaderOptions,
} from '@/lib/covenant-reader';

/**
 * THE NAIVE READER — the not-theater FOIL for #189's three routed hardenings.
 *
 * It drives the IDENTICAL resolution path as {@link CovenantDocReaderProd} (so the
 * comparison is fair — it passes every NON-hardening conformance class exactly as
 * production does) but reintroduces, one seam each, the three pre-hardening holes
 * #180's gauntlet routed to SL-2:
 *
 *   (a) `canonicalizeLeaf` → `String(v)`. A nested-object embed / mark field
 *       collapses to `"[object Object]"`, so two DISTINCT such embeds collide to
 *       one digest — a false `✓`. Production canonicalizes structurally.
 *   (b) `marksForEmbed` → `[]`. An embed's own inline marks never reach the digest,
 *       so a `format()` on a certified embed (link on an image, highlight on a
 *       mention) does not move it — a false `✓`. Production emits the embed's marks.
 *   (c) `deadlineEnabled` → `false`. A never-ready source is polled FOREVER; the
 *       reader hangs instead of failing closed. Production bounds it by a deadline.
 *
 * Each hardening test asserts the naive reader exhibits the hole and the production
 * reader closes it, so the tests are load-bearing — they FAIL if the production
 * hardening is removed, and could never pass merely by construction.
 */
export class NaiveCovenantDocReader extends CovenantDocReaderProd {
  constructor(
    input: Y.Doc | null | DocSource,
    selection?: { path: BodyPath; start: number; end: number },
    options?: ReaderOptions,
  ) {
    super(input, selection, options);
  }

  /** (a) the collapse: every field via `String(v)` — nested objects become "[object Object]". */
  protected override canonicalizeLeaf(value: unknown): string {
    return String(value);
  }

  /** (b) embed inline marks are dropped — they never reach the digest. */
  protected override marksForEmbed(): Mark[] {
    return [];
  }

  /** (c) no deadline — a stalled source loops forever (the hang the hardening prevents). */
  protected override get deadlineEnabled(): boolean {
    return false;
  }
}
