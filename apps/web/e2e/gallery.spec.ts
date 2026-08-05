import { existsSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';
import type { AuditResult } from './audit';
import { AUDIT } from './audit';

/**
 * Playwright downloads its browsers into a cache outside the repo. In sandboxes
 * where that download is blocked, skip with a reason instead of failing the
 * suite — a red gallery test would say "the design system is broken" when the
 * truth is "no browser is installed".
 */
function browserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const FRAMES = [
  'fresh-room',
  'since-you-left',
  'filtered',
  'receipt-open',
  'cross-room-jump',
  'zero-owed',
  'rail-open',
] as const;

/**
 * The two design targets plus the two edges of the supported range.
 *
 * WHAT MOVED AND WHAT IT COSTS. This list read `[1124, 1280, 1340, 1440]` while
 * the shell's floor was 1024. The v8 batch raised the floor to 1340 without
 * touching this list, so the 1124 and 1280 cases began reporting real overflow
 * — every offender's right edge landing at exactly 1340, because they inherited
 * `.app`'s own `min-width`. The floor is now measured at 1280 and this list
 * starts there.
 *
 * The old 1124 case asserted that nothing clips, nothing sits below 10px and
 * every pair passes AA *at 1124*. That claim is gone: 1124 is below the floor
 * and the shell now refuses it in words rather than laying out for it. What
 * replaces it is the below-floor case in `smoke.spec.ts`, which drives 1124 in
 * a real engine and pins that the notice appears — a different claim about the
 * same width, and the honest one now that the range has moved.
 */
const WIDTHS = [1280, 1340, 1440] as const;

const THEMES = ['light', 'dark'] as const;

/**
 * The one thing the ring sweep is allowed to skip, named once.
 *
 * It is a constant so the assertion below can be written against the RESIDUE
 * rather than against a literal spelling of the set's only member — round 6
 * found both branches of `toEqual(skipped.size === 0 ? [] : [<that literal>])`
 * were tautologies.
 */
const DEV_OVERLAY = 'nextjs-portal (next dev overlay)';

test.describe('gallery', () => {
  test.skip(
    !browserAvailable(),
    'Playwright browsers are not installed — run `pnpm exec playwright install chromium`',
  );

  for (const theme of THEMES) {
    test(`every frame renders in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/gallery?theme=${theme}`);

      await expect(page.locator('[data-gallery-frame]')).toHaveCount(FRAMES.length);
      for (const frame of FRAMES) {
        const box = page.locator(`[data-gallery-frame="${frame}"]`);
        await expect(box).toBeVisible();
        // a full frame, not a crop of one: all four regions present inside it
        await expect(box.locator('nav[aria-label="Rooms and people"]')).toHaveCount(1);
        await expect(box.locator('[data-region="needs-you"]')).toHaveCount(1);
        await expect(box.locator('[data-region="conversation"]')).toHaveCount(1);
        await expect(box.locator('[data-region="current-state"]')).toHaveCount(1);
      }

      // the theme is one class on <html> and nothing else
      expect(await page.locator('html').evaluate((el) => el.classList.contains('atr-dark'))).toBe(
        theme === 'dark',
      );
    });
  }

  test('the frames render the states they claim to', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');

    const sinceYouLeft = page.locator('[data-gallery-frame="since-you-left"]');
    // counts by attention class, and the divider is not yet muted
    await expect(sinceYouLeft.locator('[data-row="since-you-left"]')).toHaveAttribute(
      'data-seen',
      'false',
    );
    /* ROUND 10, D3: the chip's number is COUNTED from the rows it sits with —
       `4 NEED YOU` was hand-written in the fixture beside a feed holding two.
       A chip that promises four and a filter that lifts three is the gap this
       closes; `the chip lifts what it counts` below is the other half. */
    await expect(sinceYouLeft.locator('[data-count-class="need"]')).toHaveText('2 NEED YOU');
    // hardest first: the ■ destructive decision is the open card
    await expect(
      sinceYouLeft.locator('[data-region="needs-you"] article [data-glyph]').first(),
    ).toHaveAttribute('data-glyph', '■');
    // the routine group says what it hid, not just how much
    await expect(sinceYouLeft.locator('[data-row="routine"]')).toContainText('8 routine');
    await expect(sinceYouLeft.locator('[data-row="routine"]')).toContainText('11:50 – 11:57');
    await expect(sinceYouLeft.locator('[data-row="routine"]')).toContainText('click to peek');

    const filtered = page.locator('[data-gallery-frame="filtered"]');
    // marked seen MUTES the divider; the counts and window survive
    await expect(filtered.locator('[data-row="since-you-left"]')).toHaveAttribute(
      'data-seen',
      'true',
    );
    await expect(filtered.locator('[data-row="since-you-left"]')).toContainText('marked seen');
    await expect(filtered.locator('[data-count-class="need"]')).toHaveText('2 NEED YOU');
    /* A filter LIFTS what matches; it never removes anything and it never
       fades anything. Round 1: `opacity: .3` put the row's text at 1.48–1.71:1,
       so the frame's own caption ("a row you cannot see is a row you cannot
       check") was false. Measured against these tokens there is no fade that is
       both visible and legible — the weakest thing a row can carry, an amber
       needs-you tag, is already at the shell's 4.53:1 floor at full opacity —
       so EVERY row keeps 100% of its contrast and the matching ones are lifted
       onto a different surface instead. */
    const unfilteredCount = await page
      .locator(
        '[data-gallery-frame="since-you-left"] [data-region="conversation"] [data-row="message"]',
      )
      .count();
    const filteredRows = filtered.locator('[data-region="conversation"] [data-row="message"]');
    expect(await filteredRows.count()).toBe(unfilteredCount);
    const unmatched = filtered.locator('[data-row="message"][data-dimmed="true"]');
    expect(await unmatched.count()).toBeGreaterThan(0);
    await expect(unmatched.first()).toBeVisible();
    const opacities = await filteredRows.evaluateAll((els) =>
      els.map((el) => Number.parseFloat(getComputedStyle(el).opacity)),
    );
    expect(
      opacities.every((o) => o === 1),
      'a filtered row is faded below full contrast',
    ).toBe(true);
    /* and the filter is still visible: matched rows sit on a different surface */
    const matched = filtered.locator('[data-row="message"]:not([data-dimmed])');
    const [matchedBg, unmatchedBg] = await Promise.all([
      matched.first().evaluate((el) => getComputedStyle(el).backgroundColor),
      unmatched.first().evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    expect(matchedBg, 'the filter does nothing visible').not.toBe(unmatchedBg);

    /* An irreversible item holds even when it is compressed: friction belongs
       to the action, not to how much room the card was given. */
    await expect(
      filtered.locator('[data-attention-id="X1"] button[data-hold="2000"]'),
    ).toBeVisible();

    const receipt = page.locator('[data-gallery-frame="receipt-open"]');
    await expect(receipt.locator('[data-receipt-id="P1"]')).toBeVisible();
    // every excerpt in the receipt carries its provenance
    const quoted = receipt.locator('[data-quoted]');
    expect(await quoted.count()).toBeGreaterThan(0);
    for (const ref of await quoted.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-quoted')),
    )) {
      expect(ref).toMatch(/^msg:/);
    }

    const jump = page.locator('[data-gallery-frame="cross-room-jump"]');
    await expect(jump.locator('[data-row="cross-room-jump"]')).toBeVisible();
    await expect(jump.locator('[data-row="cross-room-jump"]')).toHaveAttribute(
      'data-voice',
      'system',
    );

    const zero = page.locator('[data-gallery-frame="zero-owed"]');
    await expect(zero.locator('[data-region="needs-you"]')).toContainText(
      'THAT IS A RESULT, NOT AN ABSENCE',
    );
    // and the trailer only says "verified" because it derived it
    /* ROUND 10, D4: every lead names the set it counts. "everything else is
       verified" counted the objects OUTSIDE the pin and said "else", in a
       sentence whose other clause counts the pin's own objectives. */
    await expect(zero.locator('[data-row="trailer"]')).toContainText(
      'everything outside your list is verified',
    );

    // the room that owes nothing may not say everything is green
    await expect(
      page.locator('[data-gallery-frame="fresh-room"] [data-row="trailer"]'),
    ).not.toContainText('everything outside your list is verified');

    /* Mutation: restore the detailed outside/yours count reconciliation after
       its actionable lead. Those numbers duplicate Current state and make the
       trailer a run-on audit of itself; the trailer now keeps only the derived
       lead and the time at which it was checked. */
    const trailer = page.locator('[data-gallery-frame="fresh-room"] [data-row="trailer"]');
    await expect(trailer.locator('[data-trailer-lead="true"]')).toHaveCount(1);
    await expect(trailer.locator('[data-trailer-scope="check"]')).toContainText('last check');
    await expect(trailer).not.toContainText('commitment');
    await expect(trailer).not.toContainText('objectives clear');
  });

  /* ---------------------------------------------------------------------------
   * ROUND 10, D2 — A FRAME IS A ROOM.
   *
   * Frame 05's head, lens, composer and rail all said `#identity-service` while
   * its FEED rendered eight `room: 'users-migration'` records as this room's
   * conversation: a reader came away believing priya said "Staging backfill ran
   * clean — 4.2M rows in 38 minutes" in #identity-service. The rail also showed
   * `#users-migration ◆4` and `#identity-service ◆4` for the same four items.
   *
   * CATCHES: any frame reassembled with `room` overridden independently of
   * `entries`. The row-level refusal in `TimelineRow` makes that state throw
   * rather than render, so this asserts the frame that used to be wrong.
   * ------------------------------------------------------------------------- */
  test('the cross-room frame is one room, feed included', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const jump = page.locator('[data-gallery-frame="cross-room-jump"]');

    // the head, the rail's current chip and the composer agree on the room
    await expect(jump.locator('[data-region="current-state"]')).toContainText('#identity-service');
    await expect(
      jump.locator('nav[aria-label="Rooms and people"] [aria-current="true"]'),
    ).toHaveAttribute('aria-label', /^#identity-service/);
    await expect(jump.locator('textarea')).toHaveAttribute(
      'aria-label',
      'Message #identity-service',
    );

    /* AND SO DOES EVERY ROW IN THE FEED. The register knows which room each
       record lives in; these are the ids #identity-service actually holds. */
    const ids = await jump
      .locator('[data-region="conversation"] [data-row="message"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-message-id')));
    expect(ids.length, 'the cross-room frame renders no feed rows').toBeGreaterThan(1);
    expect(
      ids.filter((id) => id !== null && ['m2', 'm5', 'm7', 'm10', 'm17', 'm21'].includes(id)),
      'a #users-migration record is rendered as #identity-service’s conversation',
    ).toEqual([]);

    /* THE SAME FOUR ITEMS ARE NOT COUNTED TWICE. r9's rail read
       `#users-migration ◆4` beside `#identity-service ◆4`, which reads as eight. */
    const chips = await jump
      .locator('nav[aria-label="Rooms and people"] [data-owed-chip]')
      .evaluateAll((els) =>
        els.map((el) => `${el.getAttribute('data-owed-chip')}:${(el.textContent ?? '').trim()}`),
      );
    /* …and each chip's glyph is the hardest of THAT room's items (D1):
       users-migration's four are headed by an irreversible drop, identity's one
       is an open question. r9 printed a literal ◆ on both. */
    expect(chips).toContain('users-migration:■4');
    expect(chips).toContain('identity-service:?1');
  });

  /* ---------------------------------------------------------------------------
   * ROUND 10, D3 — THE CHIP LIFTS WHAT IT COUNTS.
   *
   * Every chip lifted the same three rows: `matchesFilter` was
   * `entry.tag !== null && entry.tag.tone === 'needs'` whatever the filter said,
   * so someone asking what was ROUTINE while they were away was shown a
   * destructive table drop as the answer. And the answer was carried by a
   * background colour and an inset stripe — outside `textContent`, `aria-label`
   * and `title`, and therefore outside every instrument in this repo.
   * ------------------------------------------------------------------------- */
  test('the class filter lifts the class it names, and says so in words', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?theme=light');
    await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
    /* VISIBLE IS NOT INTERACTIVE. `[data-region="needs-you"]` is in the
       server-rendered HTML, so it is visible before React has attached a single
       handler — and the first click then lands on a button that does nothing.
       This failed for exactly that reason and passed the moment a diagnostic
       added two round-trips ahead of the click, which is the signature of a
       race rather than a defect. The per-route sweep in this same file already
       waits for this; so does every check below that drives a control. */
    await page.waitForLoadState('networkidle');

    const seen: Record<string, string[]> = {};
    for (const attentionClass of ['need', 'change', 'discussion', 'routine']) {
      const chip = page.locator(`[data-count-class="${attentionClass}"]`);
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      /* WHAT THE FILTER DID, IN WORDS. r9 said it only in a background colour. */
      const note = page.locator('[data-filter-note]');
      await expect(note).toHaveAttribute('data-filter-note', attentionClass);
      await expect(note).toContainText(`filtered to ${attentionClass}`);

      seen[attentionClass] = await page
        .locator('[data-region="conversation"] [data-row]:not([data-dimmed])')
        .evaluateAll((els) =>
          els.map(
            (el) =>
              `${el.getAttribute('data-row')}:${el.getAttribute('data-message-id') ?? el.getAttribute('data-open') ?? ''}`,
          ),
        );
      await chip.click();
    }

    /* NO TWO CHIPS LIFT THE SAME SET. On r9 all four lifted the identical three
       rows; this is that measurement, inverted. */
    const signatures = Object.values(seen).map((rows) => rows.sort().join('|'));
    expect(new Set(signatures).size, 'two class chips lift the same rows').toBe(signatures.length);
    /* …and ROUTINE lifts the routine strip, which is where the routine rows are. */
    expect(seen.routine?.some((row) => row.startsWith('routine:'))).toBe(true);
    /* …and NEED lifts only rows that are owed, never the routine strip. */
    expect(seen.need?.some((row) => row.startsWith('routine:'))).toBe(false);
  });

  /* ---------------------------------------------------------------------
   * THE AUDIT RUNS EVERYWHERE THE APP RENDERS, NOT ONLY ON /gallery.
   *
   * Round 4's gauntlet: `AUDIT` ran on one route. `/` drives the same frame
   * through a live consumer (different binding, a real draft, rows the session
   * appended) and `/gallery/pin/[n]` renders it under load — and neither had
   * ever been swept. "The gallery covers it" is a claim about six stills, not
   * about the app.
   * ------------------------------------------------------------------- */
  /* Every frame on the page, not the first — `/gallery` stacks six of them and
     a sweep that opened one fold would report the other five as folded. Clicks
     are sequential because each one re-lays out the grid it sits in. */
  async function openFolds(page: import('@playwright/test').Page): Promise<void> {
    const folds = page.getByRole('button', { name: 'Show rooms and people' });
    for (let i = 0; i < (await folds.count()); i += 1) {
      await folds.nth(i).click();
    }
  }

  const ROUTES = [
    { path: '/gallery', ready: '[data-gallery-frame]' },
    { path: '/', ready: '[data-region="needs-you"]' },
    { path: '/gallery/pin/34', ready: '[data-region="needs-you"]' },
    { path: '/gallery/pin/60', ready: '[data-region="needs-you"]' },
  ] as const;

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      for (const route of ROUTES) {
        test(`no horizontal overflow, no type below 10px, AA contrast — ${route.path} · ${theme} @ ${width}`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${route.path}?theme=${theme}`);
          // Audit the page, not a dev server still compiling it.
          await expect(page.locator(route.ready).first()).toBeVisible();
          await page.waitForLoadState('networkidle');

          /* THE FOLD IS OPENED BEFORE THE SWEEP, on every frame that has one.
             v8 folds the room rail by default, and the rail is where three of
             the six registered non-text graphics live — the `here` presence
             fill, the idle/away presence ring, and the disabled count chip's
             dashed border. With it folded, the pin routes rendered ONE
             registered kind and the coverage guard failed at every width in
             both themes; worse, three registry entries were being measured
             nowhere at all while the run still reported a contrast pass.
             A state a person can reach in one click is a state this sweep has
             to reach too. `openFolds` is a no-op on routes with no fold. */
          await openFolds(page);

          const audit = (await page.evaluate(AUDIT)) as AuditResult;
          expect(audit.elementsChecked, 'the audit found almost nothing to check').toBeGreaterThan(
            /* /gallery stacks six frames; a single frame carries roughly a
               sixth of that, and the floor has to be per-route or it is a floor
               only one route can clear. */
            route.path === '/gallery' ? 500 : 120,
          );

          /* THE COVERAGE GUARD COUNTS REGISTRY ENTRIES, NOT INSTANCES.
             Round 4's read `graphicsChecked > 10`, which the claim underline's
             own fifty instances satisfied on their own — so a registry of ONE
             passed a check named for the breadth of the sweep. Distinct kinds
             is the number that cannot be met by one registered graphic. */
          expect(
            audit.graphicKinds.length,
            `the non-text-graphic sweep found ${audit.graphicKinds.length} of ${audit.registrySize} registered kinds: ${audit.graphicKinds.join(', ')}`,
          ).toBeGreaterThanOrEqual(3);
          expect(audit.graphicsChecked).toBeGreaterThan(10);

          /* THE PSEUDO SWEEP HAS A DENOMINATOR NOW.

             Round 6: `pseudoChecked` had no floor and had never measured
             anything — 1 on three of four routes (the composer placeholder), 0
             on the fourth, and breaking the placeholder lookup left the whole
             harness green. A count nothing is asserted against is a count that
             cannot fail. What the sweep OWES is every placeholder the DOM
             holds; that is the number, and it is checked against the DOM
             rather than against a constant somebody guessed. */
          expect(
            audit.placeholdersFound,
            `the ::placeholder sweep reached ${audit.placeholdersFound} of the ${audit.placeholdersInDom} visible placeholders on this page`,
          ).toBe(audit.placeholdersInDom);
          expect(audit.pseudo.placeholder, 'a placeholder was found but not measured').toBe(
            audit.placeholdersFound,
          );
          expect(audit.placeholdersInDom, 'this route renders no composer at all').toBeGreaterThan(
            0,
          );

          /* THE OVERFLOW SWEEP HAS ONE TOO. `clipped()` exempted any element
             with a non-visible-overflow ancestor, and `.app` is `overflow:
             hidden` — so the audit inspected 33 of 2542 elements on /gallery
             and 12 of 476 on /, and a 3000px-wide element in a 1124px viewport
             passed all four overflow assertions. The sweep reports what it
             looked at; the floor is proportional to what the contrast sweep
             found, because both walk `body *`. */
          /* AGAINST THE DOM, NOT AGAINST THE OTHER SWEEP. The first version of
             this compared `overflowChecked` with `elementsChecked`, and the
             overflow loop's filter is strictly weaker than the text loop's — so
             the inequality held for every possible page. What the sweep owes is
             every RENDERED element, counted independently. */
          expect(
            audit.overflow.overflowChecked,
            `the overflow sweep evaluated ${audit.overflow.overflowChecked} of the ${audit.overflow.renderedElements} rendered elements on this page`,
          ).toBe(audit.overflow.renderedElements);
          expect(
            audit.overflow.renderedElements,
            'this route rendered almost nothing',
          ).toBeGreaterThan(100);
          expect(
            audit.overflow.clippersChecked,
            'no box with a non-visible overflow was inspected for hidden horizontal scroll',
          ).toBeGreaterThan(0);

          // Reported so the numbers land in the run log, not just the assertions.
          console.info(
            `${route.path} ${theme} @ ${width}: ${audit.elementsChecked} text elements · pseudo before ${audit.pseudo.before} after ${audit.pseudo.after} placeholder ${audit.pseudo.placeholder}/${audit.placeholdersInDom} · smallest font ${audit.smallestFont}px · lowest contrast ${audit.lowestContrast}:1 · graphics [${audit.graphicKinds.join(', ')}] lowest ${audit.lowestGraphic}:1 · geometry ${audit.overflow.overflowChecked} evaluated, ${audit.overflow.overflowContained} contained, ${audit.overflow.clippersChecked} clippers · scrollWidth ${audit.overflow.documentScrollWidth} / clientWidth ${audit.overflow.documentClientWidth}`,
          );

          expect(audit.overflow.widest, 'unclipped elements past the right edge').toEqual([]);
          expect(audit.overflow.scrollingFrames, 'a box hides horizontal overflow').toEqual([]);
          expect(audit.overflow.documentScrollWidth).toBeLessThanOrEqual(
            audit.overflow.documentClientWidth,
          );
          expect(audit.fontFailures, 'text below the 10px floor').toEqual([]);
          expect(audit.contrastFailures, 'text below AA').toEqual([]);
          expect(
            audit.graphicFailures,
            'a meaningful non-text graphic below WCAG 1.4.11’s 3:1',
          ).toEqual([]);
        });
      }
    }
  }

  /* Every registry entry has to be findable SOMEWHERE, or the registry is a list
     of selectors nobody has checked still match. The per-route assertion above
     asks for four, because no single route renders all six; this one asks for
     all six across the routes together. */
  test('every registered non-text graphic is on screen somewhere and measured', async ({
    page,
  }) => {
    const seen = new Set<string>();
    let registrySize = 0;
    for (const route of ROUTES) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${route.path}?theme=light`);
      await expect(page.locator(route.ready).first()).toBeVisible();
      /* Same reason as the per-route sweep: the presence fill, the presence ring
         and the disabled count chip's dashed border all live in the folded rail,
         and this is the check whose whole job is to prove no registry entry is
         being measured nowhere. */
      await openFolds(page);
      const audit = (await page.evaluate(AUDIT)) as AuditResult;
      registrySize = audit.registrySize;
      for (const kind of audit.graphicKinds) seen.add(kind.replace(/ ×\d+$/, ''));
    }
    console.info(`non-text graphics: ${seen.size}/${registrySize} registered kinds rendered`);
    expect(
      seen.size,
      `registered graphics never found on any route: the registry has ${registrySize} entries and ${seen.size} of them rendered (${[...seen].join(', ')})`,
    ).toBe(registrySize);
  });

  test('reduced motion is honoured globally, not per component', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');

    /* ROUND 4's GAUNTLET: THE SECOND CLAUSE SUBSUMED THE FIRST.
       The filter read `.filter(a !== 'none' || t !== 'all').filter(a !== 'none')`
       — and the second predicate is strictly narrower than the first, so the
       transition half of the first was dead code and TRANSITIONS WERE NEVER
       CHECKED. The kill switch in globals.css names both; this was measuring
       one. Two lists now, reported separately, because a transition surviving
       the switch and an animation surviving it are different defects and one
       filter that silently drops one of them is how the blind spot was born. */
    const motion = await page.evaluate(() => {
      const animations: string[] = [];
      const transitions: string[] = [];
      for (const el of document.querySelectorAll('body *')) {
        const style = getComputedStyle(el);
        const where = `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`;
        if (style.animationName !== 'none') {
          animations.push(`${where} animation-name ${style.animationName}`);
        }
        /* A duration, not a property name: `transition-property: all` with a 0s
           duration is not a transition, and a property list with a real duration
           is one whatever it names. */
        const longest = style.transitionDuration
          .split(',')
          .map((d) => Number.parseFloat(d) * (d.includes('ms') ? 0.001 : 1))
          .reduce((a, b) => Math.max(a, b), 0);
        if (longest > 0) {
          transitions.push(
            `${where} transition ${style.transitionProperty} ${style.transitionDuration}`,
          );
        }
      }
      return { animations, transitions, elements: document.querySelectorAll('body *').length };
    });
    console.info(
      `reduced motion: ${motion.elements} elements · ${motion.animations.length} animating · ${motion.transitions.length} transitioning`,
    );
    expect(motion.animations.slice(0, 5), 'an animation survived prefers-reduced-motion').toEqual(
      [],
    );
    expect(motion.transitions.slice(0, 5), 'a transition survived prefers-reduced-motion').toEqual(
      [],
    );

    // and the elements that WOULD animate are still there, still visible
    await expect(page.locator('.atr-rise-s').first()).toBeVisible();
    await context.close();
  });

  /* The other half of the same statement, and the reason the check above cannot
     pass vacuously: without the preference there ARE transitions to suppress. */
  test('transitions exist when they are not suppressed', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const transitioning = await page.evaluate(
      () =>
        [...document.querySelectorAll('body *')].filter((el) =>
          getComputedStyle(el)
            .transitionDuration.split(',')
            .some((d) => Number.parseFloat(d) > 0),
        ).length,
    );
    console.info(`without the preference: ${transitioning} elements carry a live transition`);
    expect(
      transitioning,
      'nothing transitions at all, so the reduced-motion check has no subject',
    ).toBeGreaterThan(0);
    await context.close();
  });

  test('motion is present when it is not suppressed', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const name = await page
      .locator('.atr-rise-s')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe('gl-rise');
    await context.close();
  });

  /* ---------------------------------------------------------------------
   * The four round-1 findings whose evidence only exists in a real browser.
   * ------------------------------------------------------------------- */

  for (const theme of THEMES) {
    test(`the focus ring clears 3:1 on every control it lands on — ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/gallery?theme=${theme}`);
      await expect(page.locator('[data-gallery-frame]').first()).toBeVisible();

      /* Round 1: --line3 measured 1.68–2.23:1 against every surface it landed
         on, on 70 focusable controls per frame, in both themes — and since
         nothing else in this shell reacts to focus, the ring is the only
         keyboard wayfinding there is. The audit above never checked it because
         it only checks TEXT.

         This TABS, rather than reading `outlineColor` off unfocused elements.
         An unfocused control's outline-color is `currentColor`, so measuring it
         at rest measures the text colour and calls it a ring — which is a check
         that would pass on a ring that never appears. `:focus-visible` only
         matches for keyboard focus, so the keyboard is what has to do it.

         A CONTROL WITH NO RING IS THE FAILURE, NOT A CONTROL OUTSIDE THE CHECK.
         This used to read `if (outlineStyle === 'none') return null`, which
         dropped ring-less controls out of `measured` instead of putting them in
         `failures` — so a rule named "the focus ring clears 3:1 on every control
         it lands on" could only ever be tripped by controls that already had a
         ring. It was the THIRD instance in this codebase of an audit written to
         skip the case its rule covers (after audit.ts's opacity guard and
         CONVENTIONS' inactive-control paragraph), and the one control in the app
         that tripped it was the composer — the primary input. CONVENTIONS now
         forbids this explicitly: an audit may not exempt the case its rule
         covers. `ratio: null` means "no ring at all", and the assertion below
         treats it as worse than a bad ring rather than as no data. */
      const MEASURE = `(() => {
        const el = document.activeElement;
        /* Nothing is focused. Absence, not exemption — the same distinction
           audit.ts draws between opacity 0 and a fade. */
        if (el === null || el === document.body) return null;
        /* Identity, not label. Two frames hold two identical "Send" buttons, so
           a label-keyed visit set would call the second one a repeat and stop
           measuring it — the sweep would report a smaller universe than the page
           has and look thorough doing it. A mark on the element is exact. */
        const already = el.hasAttribute('data-ring-swept');
        el.setAttribute('data-ring-swept', '1');
        /* NOT AN EXEMPTION — NOT THIS APP'S CONTROL. <nextjs-portal> is the dev
           server's own error/devtools overlay, injected by next dev and absent
           from the production build. It is named by tag rather than by "skip
           things with no ring", and it is REPORTED rather than dropped, so the
           carve-out cannot quietly widen: the assertion below fails if anything
           other than this one element ends up in the skipped list. */
        if (el.tagName === 'NEXTJS-PORTAL') return { devOverlay: true, already };
        const style = getComputedStyle(el);
        const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 28);
        const where = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '');
        const none = { ratio: null, colour: style.outlineColor, surface: 'n/a', label, where, already };
        if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0) return none;
        const parse = (value) => {
          const m = value.match(/rgba?\\(([^)]+)\\)/);
          if (!m) return null;
          const p = m[1].split(',').map((x) => parseFloat(x.trim()));
          return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        };
        const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
        const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
        /* The ring's adjacent colour. Positive offset puts it outside the border
           box, so what it sits on is the PARENT's surface; a negative offset
           (the composer, which fills its own box) puts it over the control's own
           background, so that is what it has to clear. */
        const inset = parseFloat(style.outlineOffset) < 0;
        let node = inset ? el : el.parentElement;
        let behind = { r: 255, g: 255, b: 255, a: 1 };
        while (node) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0) { behind = bg; break; }
          node = node.parentElement;
        }
        const ring = parse(style.outlineColor);
        /* An outline whose colour cannot be read is a ring that cannot be
           checked, which is not the same as a ring that passed. */
        if (!ring) return { ...none, surface: 'unparseable' };
        return {
          ratio: Math.round(ratio(ring, behind) * 100) / 100,
          colour: style.outlineColor,
          surface: 'rgb(' + Math.round(behind.r) + ', ' + Math.round(behind.g) + ', ' + Math.round(behind.b) + ')',
          label,
          where,
          already,
        };
      })()`;

      type Ring = {
        ratio: number | null;
        colour: string;
        surface: string;
        label: string;
        where: string;
        already: boolean;
        devOverlay?: true;
      };

      /* ROUND 4's GAUNTLET: THE RULE SAID "EVERY" AND THE LOOP SAID 90.
         The page has 335 focusable controls and the sweep pressed Tab ninety
         times — a cap chosen when the page was smaller, never revisited, and
         invisible because 90 measurements look like a thorough sweep. The three
         frames past the cap were simply never keyboard-focused by anything.

         It now runs to EXHAUSTION: tab until the focused element repeats, which
         is what "went all the way round the cycle" means, and then assert the
         set that was measured covers every control the DOM says is focusable.
         The cap that remains is a runaway guard an order of magnitude past the
         real count, and tripping it FAILS rather than quietly truncating. */
      const FOCUSABLE =
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const focusable = await page.evaluate(
        (selector) => document.querySelectorAll(selector).length,
        FOCUSABLE,
      );

      const measured: Ring[] = [];
      const skipped = new Set<string>();
      let repeats = 0;
      const CEILING = focusable * 3 + 60;
      for (let i = 0; i < CEILING; i += 1) {
        await page.keyboard.press('Tab');
        const one = (await page.evaluate(MEASURE)) as Ring | null;
        if (one === null) continue;
        if (one.devOverlay === true) {
          skipped.add(DEV_OVERLAY);
          continue;
        }
        if (one.already) {
          /* The cycle has closed. Keep going for one more lap's worth of
             repeats before stopping, so a control that only appears later in the
             order is not missed by stopping at the first wrap. */
          repeats += 1;
          if (repeats > focusable) break;
          continue;
        }
        measured.push(one);
      }

      console.info(
        `focus ring ${theme}: ${focusable} focusable controls in the DOM · ${measured.length} reached by Tab, to exhaustion · skipped [${[...skipped].join(', ')}]`,
      );
      /* ROUND 6: BOTH BRANCHES OF THIS WERE TAUTOLOGIES.
         It read `toEqual(skipped.size === 0 ? [] : ['nextjs-portal …'])`, and
         that string is the only value ever added to the set — so the empty case
         compared `[]` with `[]` and the non-empty case compared the set with a
         literal spelling of its only possible member. Nothing about the
         assertion could fail, which is the same shape as a coverage guard one
         registered graphic can satisfy: the carve-out cannot widen because the
         check cannot see it widen. What is asserted is the RESIDUE — anything
         skipped that is not the dev overlay — so a second carve-out fails here
         whatever it is called. */
      expect(
        [...skipped].filter((what) => what !== DEV_OVERLAY),
        'the ring sweep skipped something other than the dev server overlay',
      ).toEqual([]);
      expect(measured.length, 'tabbing focused nothing').toBeGreaterThan(40);
      /* THE ASSERTION THE OLD CAP MADE UNFALSIFIABLE. The rule is named "every
         control it lands on" and the loop stopped at a constant 90 while the
         page held 335 — so three of the six frames were never keyboard-focused
         by anything. The sweep runs until the tab order repeats, and what is
         asserted is not a COUNT but the NAMES of the controls the sweep never
         reached: a count can be satisfied by reaching different ones, and a
         count is what let the old cap look thorough. */
      const missed = await page.evaluate((selector) => {
        const out = { rendered: [] as string[], notRendered: 0 };
        for (const el of document.querySelectorAll(selector)) {
          if (el.hasAttribute('data-ring-swept')) continue;
          /* A control with no layout box cannot receive focus, so it is outside
             the UNIVERSE of this rule rather than exempt from it — the filtered
             feed's row-action strips are `display: none` on unmatched rows. The
             two are counted separately and the count is printed, so "outside the
             universe" cannot quietly grow into "skipped". */
          const style = getComputedStyle(el);
          if (
            el.getClientRects().length === 0 ||
            style.visibility === 'hidden' ||
            el.tagName === 'NEXTJS-PORTAL'
          ) {
            out.notRendered += 1;
            continue;
          }
          out.rendered.push(
            `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32)}"`,
          );
        }
        return out;
      }, FOCUSABLE);
      console.info(
        `focus ring ${theme}: ${missed.notRendered} focusable elements have no layout box (display:none) and cannot be focused`,
      );
      expect(
        missed.rendered,
        `rendered controls the keyboard never reached — ${measured.length} of ${focusable} matched elements were swept`,
      ).toEqual([]);
      const ringless = measured.filter((m) => m.ratio === null);
      const rings = measured.filter((m): m is Ring & { ratio: number } => m.ratio !== null);
      const worst = rings.reduce((a, b) => (a.ratio < b.ratio ? a : b));
      console.info(
        `focus ring ${theme}: ${measured.length} controls tabbed · ${ringless.length} with no ring at all · worst ${worst.ratio}:1 (${worst.colour} on ${worst.surface}) at "${worst.label}"`,
      );
      /* Reported first and separately, because "no indicator" and "a weak
         indicator" are different defects and collapsing them into one number is
         how the weaker one hides. */
      expect(
        ringless.map((m) => `${m.where} "${m.label}"`),
        'focused controls that paint no focus indicator at all — WCAG 2.4.7',
      ).toEqual([]);
      const failures = rings.filter((m) => m.ratio + 0.005 < 3);
      expect(failures.slice(0, 5), 'focus ring below WCAG 1.4.11').toEqual([]);
    });
  }

  test('the live indicator actually animates', async ({ browser }) => {
    /* Round 1: `.live` said `animation: gl-pulse 1.6s infinite` inside a CSS
       Module, and CSS Modules rewrite animation-NAMES even when the keyframes
       are global — so the computed name was `lens_gl-pulse__hash`, no such
       keyframe existed, and `getAnimations()` returned []. The dot had been
       static since it was written, and nothing noticed because a static dot
       looks exactly like a dot. */
    const context = await browser.newContext({ reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const live = page.locator('[data-live="true"]').first();
    await expect(live).toBeVisible();
    const report = await live.evaluate((el) => ({
      name: getComputedStyle(el).animationName,
      running: el.getAnimations().length,
    }));
    console.info(
      `live indicator: animation-name ${report.name} · getAnimations() ${report.running}`,
    );
    expect(report.name).toBe('gl-pulse');
    expect(report.running, 'the live indicator declares an animation that does not exist').toBe(1);
    await context.close();
  });

  test('the invisible hover strip does not steal clicks', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    /* Round 1: `.acts` is absolutely positioned at `opacity: 0` with pointer
       events live, covering the right half of every row — `elementFromPoint` at
       the centre of the always-visible tag button returned the reply button.
       An invisible affordance was eating clicks meant for a visible one. */
    const report = await page.evaluate(() => {
      const tags = [...document.querySelectorAll('[data-row-tag]')];
      const stolen: string[] = [];
      let probed = 0;
      for (const tag of tags) {
        /* Scroll each one into view first. `elementFromPoint` takes VIEWPORT
           coordinates, so a tag below the fold would otherwise be probed at
           whatever happens to sit at those coordinates in a different frame. */
        tag.scrollIntoView({ block: 'center' });
        const box = tag.getBoundingClientRect();
        if (box.width === 0 || box.top < 0 || box.bottom > window.innerHeight) continue;
        probed += 1;
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (hit !== tag && !tag.contains(hit)) {
          const el = hit as HTMLElement | null;
          stolen.push(
            `${(tag.textContent ?? '').slice(0, 24)} → ${el?.tagName ?? 'nothing'}.${el?.className ?? ''}`,
          );
        }
      }
      return { tags: probed, stolen };
    });
    console.info(`row tags checked: ${report.tags} · clicks stolen: ${report.stolen.length}`);
    expect(report.tags).toBeGreaterThan(0);
    expect(report.stolen, 'an invisible strip is eating clicks on a visible button').toEqual([]);
  });

  test('the hold is a real two seconds, and releasing early cancels', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const hold = page
      .locator('[data-gallery-frame="since-you-left"] button[data-hold="2000"]')
      .first();
    await expect(hold).toBeVisible();
    await hold.scrollIntoViewIfNeeded();

    /* release before the hold completes: nothing is armed, progress resets */
    const box = await hold.boundingBox();
    if (box === null) throw new Error('the hold control has no box');
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.waitForTimeout(900);
    const midway = Number(await hold.getAttribute('data-hold-progress'));
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterRelease = Number(await hold.getAttribute('data-hold-progress'));
    expect(midway).toBeGreaterThan(0.3);
    expect(midway).toBeLessThan(0.7);
    expect(afterRelease).toBe(0);
    expect(await hold.getAttribute('data-armed')).toBeNull();

    /* hold it through: it arms, and it took at least the declared two seconds */
    const started = Date.now();
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.waitForFunction(
      () => document.querySelector('button[data-armed="true"]') !== null,
      undefined,
      { timeout: 5000 },
    );
    const elapsed = Date.now() - started;
    await page.mouse.up();
    console.info(
      `hold: ${midway.toFixed(2)} at 900ms, reset to ${afterRelease} on early release, armed after ${elapsed}ms`,
    );
    expect(
      elapsed,
      'the hold armed in less than the two seconds it promises',
    ).toBeGreaterThanOrEqual(1950);
    expect(elapsed).toBeLessThan(3500);
  });

  /* -------------------------------------------------------------------------
   * THE DISABLED STATE, MEASURED — the case the harness used to skip.
   * ---------------------------------------------------------------------- */
  for (const theme of THEMES) {
    test(`a disabled control is legible and still reads as inactive — ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/gallery?theme=${theme}`);
      await expect(page.locator('[data-gallery-frame]').first()).toBeVisible();

      /* Round 2: `.surf[disabled] { opacity: .55 }` measured 2.49:1 light and
         2.98:1 dark at 10px — below AA, below the 3:1 large-text floor, and
         below --tx4, which globals.css bans from carrying text outright. The
         audit never saw it because it skipped anything under `opacity 0.999`
         and named "a disabled chip" as the reason. */
      const report = await page.evaluate(() => {
        const parse = (value: string) => {
          const m = value.match(/rgba?\(([^)]+)\)/);
          if (m === null) return null;
          const p = (m[1] as string).split(',').map((x) => Number.parseFloat(x.trim()));
          return { r: p[0] as number, g: p[1] as number, b: p[2] as number, a: p[3] ?? 1 };
        };
        const channel = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const lum = (c: { r: number; g: number; b: number }) =>
          0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
        const ratio = (a: { r: number; g: number; b: number }, b: typeof a) => {
          const la = lum(a);
          const lb = lum(b);
          return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };
        const fade = (el: Element) => {
          let node: Element | null = el;
          let opacity = 1;
          while (node !== null && node !== document.documentElement) {
            opacity *= Number.parseFloat(getComputedStyle(node).opacity || '1');
            node = node.parentElement;
          }
          return opacity;
        };
        const behind = (el: Element) => {
          let node: Element | null = el.parentElement;
          while (node !== null) {
            const bg = parse(getComputedStyle(node).backgroundColor);
            if (bg !== null && bg.a > 0) return bg;
            node = node.parentElement;
          }
          return { r: 255, g: 255, b: 255, a: 1 };
        };
        const out: {
          label: string;
          ratio: number;
          fontSize: number;
          opacity: number;
          colour: string;
          enabledColour: string;
        }[] = [];
        /* ROUND 4's GAUNTLET, TWO EXCLUSIONS IN FOUR LINES.

           `.disabled === true` is a property only form controls have, so every
           `aria-disabled` control — the way a non-button is made inactive — was
           invisible to a check named "a disabled control is legible". And
           `querySelector('span')` read THE FIRST span: the surface chip has two,
           a label and a count chip, and the count chip is the one an earlier
           round had shipped at 2.43:1 with nobody measuring it. Reading the
           first of two is the same defect as capping the tab sweep at 90 —
           a subset that looks like the set.

           Both gone: any control that is disabled by EITHER mechanism, and every
           text-bearing span inside it, one row per span. */
        const inactive = (el: Element) =>
          (el as HTMLButtonElement).disabled === true ||
          el.getAttribute('aria-disabled') === 'true';
        for (const button of document.querySelectorAll(
          'button, [disabled], [aria-disabled="true"]',
        )) {
          if (!inactive(button)) continue;
          const spans = [...button.querySelectorAll('span')].filter(
            (el) => (el.textContent ?? '').trim().length > 0,
          );
          const labels: Element[] = spans.length > 0 ? spans : [button];
          const sibling = [...(button.parentElement?.children ?? [])].find(
            (el) => el !== button && !inactive(el),
          );
          for (const label of labels) {
            const style = getComputedStyle(label);
            const fg = parse(style.color);
            if (fg === null) continue;
            const bg = behind(label);
            const alpha = fade(label);
            const ink = {
              r: fg.r * alpha + bg.r * (1 - alpha),
              g: fg.g * alpha + bg.g * (1 - alpha),
              b: fg.b * alpha + bg.b * (1 - alpha),
            };
            /* The enabled counterpart is matched by POSITION inside its own
               control, so a two-span chip compares its label with a label and
               its count with a count rather than both with the label. */
            const index = labels.indexOf(label);
            const enabledSpans = [...(sibling?.querySelectorAll('span') ?? [])].filter(
              (el) => (el.textContent ?? '').trim().length > 0,
            );
            /* "Reads as inactive" is a claim about the CONTROL, so only its
               leading label is compared with the enabled control's. Every span
               is still measured for legibility — which is the half the old
               `querySelector('span')` was skipping. */
            const enabled = index === 0 ? enabledSpans[0] : undefined;
            out.push({
              label: (label.textContent ?? '').trim().slice(0, 24),
              ratio: Math.round(ratio(ink, bg) * 100) / 100,
              fontSize: Number.parseFloat(style.fontSize),
              opacity: Math.round(alpha * 1000) / 1000,
              colour: style.color,
              enabledColour: enabled === undefined ? '' : getComputedStyle(enabled).color,
            });
          }
        }
        return out;
      });

      expect(report.length, 'no disabled control was on screen to measure').toBeGreaterThan(0);
      for (const one of report) {
        console.info(
          `disabled ${theme}: "${one.label}" ${one.ratio}:1 at ${one.fontSize}px · opacity ${one.opacity} · ${one.colour}`,
        );
      }
      // legible: AA at the size it is actually rendered
      expect(
        report.filter((r) => r.ratio + 0.005 < 4.5),
        'a disabled control is below AA',
      ).toEqual([]);
      // and no fade: CONVENTIONS' measurement is that none of them clear AA
      expect(
        report.filter((r) => r.opacity < 0.999),
        'a disabled control is de-emphasised with alpha',
      ).toEqual([]);
      // still reads as inactive: a different ink from the enabled one beside it
      const compared = report.filter((r) => r.enabledColour !== '');
      expect(compared.length).toBeGreaterThan(0);
      expect(
        compared.filter((r) => r.colour === r.enabledColour),
        'a disabled control looks identical to an enabled one',
      ).toEqual([]);
    });
  }

  /* -------------------------------------------------------------------------
   * THE BINDING CUE UNDER FOCUS.
   *
   * `.cbox:focus-within` out-ranked `.cboxBound`, so focusing the composer
   * replaced the amber ANSWERING border with grey — the cue that says "your
   * next message resolves this item" destroyed by focusing the field you are
   * meant to answer in. The token-contrast test asserts the specificity; this
   * asserts what the browser actually paints, because specificity arithmetic
   * done by hand is how the defect got in.
   * ---------------------------------------------------------------------- */
  for (const theme of THEMES) {
    test(`the answer-binding border survives focus — ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/gallery?theme=${theme}`);
      const bar = page.locator('[data-binding="bound"]').first();
      await expect(bar).toBeVisible();

      const read = () =>
        page.evaluate(() => {
          const bound = document.querySelector('[data-binding="bound"]');
          const box = bound?.parentElement?.querySelector('textarea')?.parentElement;
          if (box === null || box === undefined) return null;
          return {
            border: getComputedStyle(box).borderTopColor,
            within: box.matches(':focus-within'),
          };
        });

      const resting = await read();
      expect(resting, 'no bound composer on the page').not.toBeNull();

      await page.evaluate(() => {
        const bound = document.querySelector('[data-binding="bound"]');
        bound?.parentElement?.querySelector('textarea')?.focus();
      });
      /* `border-color` carries a 120ms transition, and getComputedStyle DURING a
         transition returns the interpolated value — reading it synchronously
         after focus reports the RESTING colour and passes on a border that is
         about to change. The first version of this measurement did exactly
         that and reported the r3 stylesheet as fixed. */
      await expect.poll(async () => (await read())?.within, { timeout: 2000 }).toBe(true);
      await page.waitForTimeout(400);
      const focused = await read();

      console.info(
        `bound composer ${theme}: resting ${resting?.border} · focused ${focused?.border}`,
      );
      expect(
        focused?.border,
        'focusing the composer replaced the answer-binding border with the generic focus grey',
      ).toBe(resting?.border);
    });
  }

  /* -------------------------------------------------------------------------
   * THE NAME A SCREEN READER HEARS IS A RENDERED STRING TOO.
   *
   * Round 3's gauntlet found two: the hold control announced as "0 Authorise the
   * drop — hold" (a `role="progressbar"` descendant contributes its value to its
   * ancestor's name) and the disabled chip as "NEEDS YOU0" (a label and a count
   * with no text node between them). Sweeping every button's COMPUTED name found
   * three more of the second kind — two rail room chips and the routine strip,
   * where the only whitespace was inside an `aria-hidden` separator.
   *
   * COMPUTED, not `textContent`. `textContent` never inserts a space between
   * adjacent elements and the accname algorithm does for block-level ones, so a
   * textContent sweep reports a dozen welds a screen reader never hears — and
   * would send the next person to redesign the lens rows, which are fine. This
   * reads Playwright's aria snapshot, which is the browser's own computation.
   * ---------------------------------------------------------------------- */
  test('no control announces a value welded to its label', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    await expect(page.locator('[data-gallery-frame]').first()).toBeVisible();

    const snapshot = await page.locator('body').ariaSnapshot();
    const names = [...snapshot.matchAll(/- (?:button|link) "([^"]*)"/g)].map((m) =>
      (m[1] ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(names.length, 'the aria snapshot found no named controls').toBeGreaterThan(40);

    /* A digit stuck to a letter with no separator, in either direction. Real
       words that contain digits are exempt by SHAPE, not by name: a unit
       ("16h", "90-day"), a time ("11:50"), an issue number ("#418"), an ordinal.
       An exemption that named a component would be the defect this round exists
       to stop. */
    const welded = names.filter((name) => {
      const stripped = name
        .replace(/#\d+/g, '') //   issue numbers
        .replace(/\b\d+:\d+\b/g, '') // times
        .replace(/\b\d+(h|m|s|px|d)\b/gi, '') // durations and units
        .replace(/\b\d+-\w+/g, '') //   "90-day"
        .replace(/\b\d+(st|nd|rd|th)\b/gi, ''); // ordinals
      return /[A-Za-z]\d|\d[A-Za-z]/.test(stripped);
    });
    console.info(`accessible names: ${names.length} controls · ${welded.length} welded`);
    expect(welded, 'a control announces a number welded to its label').toEqual([]);

    /* And the hold control specifically, which is the one the gauntlet named:
       its name is the label, and the progress it exposes is a description. */
    const hold = names.filter((n) => n.includes('— hold'));
    expect(hold.length, 'no hold control on the page').toBeGreaterThan(0);
    for (const name of hold) expect(name).toMatch(/^[A-Z]/);
  });

  test('the theme switch is the only theme mechanism', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');
    const html = page.locator('html');
    expect(await html.evaluate((el) => el.classList.contains('atr-dark'))).toBe(false);

    await page.getByTestId('gallery-theme-dark').click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('atr-dark'))).toBe(true);

    // no frame carries a theme override of its own
    const overrides = await page.evaluate(
      () => document.querySelectorAll('[data-theme], [class*="theme-"]').length,
    );
    expect(overrides).toBe(0);
  });
});
