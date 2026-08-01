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
] as const;

/** The two design targets plus the two edges of the supported range. */
const WIDTHS = [1124, 1280, 1340, 1440] as const;

const THEMES = ['light', 'dark'] as const;

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
    await expect(sinceYouLeft.locator('[data-count-class="need"]')).toHaveText('4 NEED YOU');
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
    await expect(filtered.locator('[data-count-class="need"]')).toHaveText('4 NEED YOU');
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
    await expect(zero.locator('[data-row="trailer"]')).toContainText('everything else is verified');

    // the room that owes nothing may not say everything is green
    await expect(
      page.locator('[data-gallery-frame="fresh-room"] [data-row="trailer"]'),
    ).not.toContainText('everything else is verified');
  });

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`no horizontal overflow, no type below 10px, AA contrast — ${theme} @ ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/gallery?theme=${theme}`);
        // Audit the gallery, not a dev server still compiling it.
        await expect(page.locator('[data-gallery-frame]')).toHaveCount(FRAMES.length);
        await expect(page.locator('[data-row="trailer"]').first()).toBeVisible();
        await page.waitForLoadState('networkidle');

        const audit = (await page.evaluate(AUDIT)) as AuditResult;
        expect(audit.elementsChecked, 'the audit found almost nothing to check').toBeGreaterThan(
          500,
        );

        // Reported so the numbers land in the run log, not just the assertions.
        console.info(
          `${theme} @ ${width}: ${audit.elementsChecked} text elements · smallest font ${audit.smallestFont}px · lowest contrast ${audit.lowestContrast}:1 · scrollWidth ${audit.overflow.documentScrollWidth} / clientWidth ${audit.overflow.documentClientWidth}`,
        );

        expect(audit.overflow.widest, 'unclipped elements past the right edge').toEqual([]);
        expect(audit.overflow.scrollingFrames, 'a frame scrolls sideways').toEqual([]);
        expect(audit.overflow.documentScrollWidth).toBeLessThanOrEqual(
          audit.overflow.documentClientWidth,
        );
        expect(audit.fontFailures, 'text below the 10px floor').toEqual([]);
        expect(audit.contrastFailures, 'text below AA').toEqual([]);
      });
    }
  }

  test('reduced motion is honoured globally, not per component', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/gallery?theme=light');

    const animated = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .map((el) => {
          const style = getComputedStyle(el);
          return {
            animation: style.animationName,
            transition: style.transitionProperty,
            className: typeof el.className === 'string' ? el.className : '',
          };
        })
        .filter((s) => s.animation !== 'none' || s.transition !== 'all')
        .filter((s) => s.animation !== 'none')
        .slice(0, 5),
    );
    expect(animated, 'an animation survived prefers-reduced-motion').toEqual([]);

    // and the elements that WOULD animate are still there, still visible
    await expect(page.locator('.atr-rise-s').first()).toBeVisible();
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
         matches for keyboard focus, so the keyboard is what has to do it. */
      const MEASURE = `(() => {
        const el = document.activeElement;
        if (el === null || el === document.body) return null;
        const style = getComputedStyle(el);
        if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0) return null;
        const parse = (value) => {
          const m = value.match(/rgba?\\(([^)]+)\\)/);
          if (!m) return null;
          const p = m[1].split(',').map((x) => parseFloat(x.trim()));
          return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        };
        const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
        const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
        /* The ring sits outside the border box with a 1px offset, so the colour
           adjacent to it is the PARENT's surface, not the control's own fill. */
        let node = el.parentElement;
        let behind = { r: 255, g: 255, b: 255, a: 1 };
        while (node) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0) { behind = bg; break; }
          node = node.parentElement;
        }
        const ring = parse(style.outlineColor);
        if (!ring) return null;
        return {
          ratio: Math.round(ratio(ring, behind) * 100) / 100,
          colour: style.outlineColor,
          surface: 'rgb(' + Math.round(behind.r) + ', ' + Math.round(behind.g) + ', ' + Math.round(behind.b) + ')',
          label: (el.textContent || el.tagName).trim().slice(0, 28),
        };
      })()`;

      const measured: { ratio: number; colour: string; surface: string; label: string }[] = [];
      for (let i = 0; i < 90; i += 1) {
        await page.keyboard.press('Tab');
        const one = (await page.evaluate(MEASURE)) as (typeof measured)[number] | null;
        if (one !== null) measured.push(one);
      }

      expect(measured.length, 'no focused control painted a ring').toBeGreaterThan(40);
      const worst = measured.reduce((a, b) => (a.ratio < b.ratio ? a : b));
      console.info(
        `focus ring ${theme}: ${measured.length} controls tabbed · worst ${worst.ratio}:1 (${worst.colour} on ${worst.surface}) at "${worst.label}"`,
      );
      const failures = measured.filter((m) => m.ratio + 0.005 < 3);
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
        for (const button of document.querySelectorAll('.surf, [disabled]')) {
          if (!(button as HTMLButtonElement).disabled) continue;
          const label = button.querySelector('span') ?? button;
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
          const sibling = [...(button.parentElement?.children ?? [])].find(
            (el) => el !== button && !(el as HTMLButtonElement).disabled,
          );
          const enabled = sibling?.querySelector('span');
          out.push({
            label: (label.textContent ?? '').trim().slice(0, 24),
            ratio: Math.round(ratio(ink, bg) * 100) / 100,
            fontSize: Number.parseFloat(style.fontSize),
            opacity: Math.round(alpha * 1000) / 1000,
            colour: style.color,
            enabledColour:
              enabled === undefined || enabled === null ? '' : getComputedStyle(enabled).color,
          });
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
