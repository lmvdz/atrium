/* ---------------------------------------------------------------------------
 * The pin under load — one full frame per owed-item count.
 *
 * Round 1 measured the unbounded pin at 1440×900: 13 owed items left the feed
 * 183px tall, 17 left 55px, and at 19 the composer's bottom edge sat at 909 in
 * a 900px viewport with `scrollHeight` stuck at 900 — unreachable by any means.
 * These routes exist so that number is MEASURED on every run rather than
 * asserted once: `pin-bound.spec.ts` drives all four counts across all four
 * widths in both themes and checks the composer is still in frame.
 *
 * They are static: `generateStaticParams` names the four counts, so nothing
 * here needs a runtime.
 * ------------------------------------------------------------------------- */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import * as f from '../../fixtures';
import { RoomFrame } from '../../RoomFrame';

/**
 * 4 fits; 13 and 19 are the round-1 failure points; 34 is well past them; 60 is
 * where round 2's gauntlet found the expanded pin stranding 50 owed items
 * behind an affordance that could not reveal them.
 */
export const PIN_LOADS = [4, 13, 19, 34, 60] as const;

/** The largest load this route will build. Past it the fixture is the joke. */
const MAX_LOAD = 200;

export function generateStaticParams() {
  return PIN_LOADS.map((n) => ({ n: String(n) }));
}

export const metadata: Metadata = {
  title: 'Atrium · the pin under load',
};

export default async function PinLoadPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  /* `Number.parseInt` is happy to return NaN, and NaN walked all the way to the
     screen as "NaN owed to you" — /gallery/pin/abc rendered a frame stating a
     quantity that does not exist. A route parameter is untrusted input like any
     other; this is model/quotation.ts's parse-or-throw boundary, one layer
     out. */
  const count = /^\d+$/.test(n) ? Number.parseInt(n, 10) : Number.NaN;
  if (!Number.isInteger(count) || count < 0 || count > MAX_LOAD) notFound();
  const attention = f.manyOwed(count);

  return (
    <div data-pin-load={String(count)}>
      <RoomFrame
        attention={attention}
        binding={f.FREE}
        boxed={false}
        composerNote={`${count} owed · the pin folds rather than pushing this off the screen`}
        entries={f.timeline({ seen: false, filter: null, routineOpen: false })}
        filtered={false}
        focused="needs-you"
        humans={f.HUMANS}
        label={`pin-load-${count}`}
        lastCheck="12:29"
        objectives={f.OBJECTIVES}
        objects={f.OBJECTS}
        room={f.ROOM}
        rooms={f.ROOMS}
        trailer={f.TRAILER}
        updatedAt="13:41"
        viewer={f.VIEWER}
        viewerNote={`here · ${count} owed to you`}
      />
    </div>
  );
}
