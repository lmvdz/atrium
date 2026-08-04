import { expect, test } from '@playwright/test';
import { requireBrowser } from './support/flows';

test.describe('shell', () => {
  requireBrowser();

  test('renders the three surfaces of the real frame', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // Conversation on the left, what needs YOU pinned above it, what the group
    // now understands in the lens — init.md §3, on screen at the same time.
    await expect(page.locator('[data-region]')).toHaveCount(3);
    await expect(page.locator('[data-region="conversation"]')).toBeVisible();
    await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
    await expect(page.locator('[data-region="current-state"]')).toBeVisible();

    // every owed item states why it needs this person
    await expect(page.locator('[data-region="needs-you"]')).toContainText('WHY YOU');
    await expect(page.locator('[data-region="needs-you"] article')).toContainText(
      'no automated path may drop a table',
    );

    // the rail is navigation; the roster is not
    await expect(page.getByRole('navigation', { name: 'Rooms and people' })).toBeVisible();
  });

  /* -------------------------------------------------------------------------
   * `/` IS OPERABLE.
   *
   * Round 2's gauntlet: this page forwarded no handlers at all, so the demo
   * meant to prove the component library worked was a screen of controls that
   * did nothing when clicked. Nothing was forced to fork — the props existed —
   * but "the props exist" is not the claim the page makes by rendering them.
   * ---------------------------------------------------------------------- */
  test('the controls on / actually do something', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    /* Every handler writes what it did into the composer's note, so a control
       that fires nothing is a note that does not change. */
    const note = page.locator('[data-composer-note]');

    /* THE COMPOSER'S OWN CONTRACT. The footer says "↵ send"; type and press
       Enter, and a real row appears — built through `messageEntry` from a real
       record, so it is quotable, attributed, and its body reads as its
       record. */
    const rowsBefore = await page.locator('[data-row="message"]').count();
    const composer = page.getByRole('combobox');
    await composer.click();
    await composer.type('the composer seam is real');
    await composer.press('Enter');
    await expect(page.locator('[data-row="message"]')).toHaveCount(rowsBefore + 1);
    const sent = page.locator('[data-row="message"]').last();
    await expect(sent.locator('[data-attribution]')).toHaveText('lars');
    await expect(sent.locator('[data-row-body]')).toHaveText('the composer seam is real');
    await expect(composer).toHaveValue('');

    /* SHIFT+ENTER IS A NEWLINE, which is the other half of the same sentence. */
    await composer.type('two');
    await composer.press('Shift+Enter');
    await expect(page.locator('[data-row="message"]')).toHaveCount(rowsBefore + 1);
    await expect(composer).toHaveValue(/two/);

    await expect(note).toContainText('typed, quotable, attributed to lars');

    // the surface indicators focus rather than navigate — and they respond
    const surface = page.locator('[data-surface="current-state"]');
    await expect(surface).toHaveAttribute('aria-pressed', 'false');
    await surface.click();
    await expect(surface).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toContainText('focused current-state');

    // the filter chips filter
    await page.locator('[data-count-class="need"]').first().click();
    await expect(note).toContainText('filtered to need');
    await expect(page.locator('[data-row="message"][data-dimmed="true"]').first()).toBeVisible();

    // acting on an owed item takes it out of the pin
    const owedBefore = await page.locator('[data-region="needs-you"] [data-attention-id]').count();
    await page
      .locator('[data-region="needs-you"] button')
      .filter({ hasText: 'Keep it behind our retention window' })
      .first()
      .click();
    await expect(note).toContainText('it leaves the pin because it no longer needs you');
    await expect(page.locator('[data-region="needs-you"] [data-attention-id]')).not.toHaveCount(
      owedBefore,
    );

    /* Nothing on this page renders an absent value as a word. The RENDERED text,
       not `page.content()` — the dev server's own inline bundles contain the
       literal "undefined" and a check that reads them is a check that can only
       fail. */
    const rendered = await page.evaluate(() => document.body.innerText);
    expect(rendered).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/);
  });

  /* -------------------------------------------------------------------------
   * EVERY VISIBLE CONTROL ON `/` DOES SOMETHING, OR IS NAMED INERT WITH A
   * REASON.
   *
   * Round 6's blind critic clicked all 53 visible controls on `/` with
   * before/after diffs on `documentElement.className`, `body.innerHTML.length`
   * and `innerText`, and found 17 dead: all four rail room chips, both objective
   * disclosure triangles in Current state (the collapsed one could never be
   * opened, hiding four objects, two of which need you), all ten state-object
   * rows, and the trailer's failure count.
   *
   * The test above exists for exactly this — it was written after round 2's "a
   * screen of controls that did nothing" — and it clicked FOUR controls. Four
   * passing controls out of fifty-three is not evidence about the page; it is
   * evidence about four controls. A check named "the controls on / actually do
   * something" has to know how many controls there are.
   *
   * So this one asserts the DENOMINATOR. It enumerates every visible control,
   * clicks each, and requires an observable change — or membership in `INERT`,
   * which is a list of names with reasons, checked to be exhaustive in both
   * directions: an entry that no longer matches anything fails too, because a
   * stale exemption is how a carve-out outlives the thing it was written for.
   * ---------------------------------------------------------------------- */
  /* -------------------------------------------------------------------------
   * TWO STATES, AND THE BINDING THEME.
   *
   * ROUND 7. The sweep below ran on `/` IN ITS INITIAL STATE, where
   * `receiptId === null` — so the receipt's six controls were never in the
   * denominator it reports. That is exactly where D3's dead `onJump` lived:
   * deleting it killed five visible controls and this test still said "71
   * visible · 0 dead", because the receipt was not on the page.
   *
   * And the run was in the WRONG THEME. The theme toggle is control #1, clicking
   * it counts as "changed", and the remaining 70 controls were then measured in
   * DARK — while CONVENTIONS' binding measurement is LIGHT. The theme is restored
   * after every control that moves it, so the sweep covers the binding theme and
   * the toggle stays in the denominator.
   * ---------------------------------------------------------------------- */
  for (const state of ['initial', 'receipt-open'] as const) {
    test(`every visible control on / changes something, or is listed inert — ${state}`, async ({
      page,
    }) => {
      await runControlSweep(page, state);
    });
  }

  async function runControlSweep(
    page: import('@playwright/test').Page,
    state: 'initial' | 'receipt-open',
  ) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?theme=light');
    await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
    /* MARK THE DOM ONLY AFTER REACT OWNS IT. Writing an attribute into
       server-rendered markup before hydration makes React report a mismatch,
       and this project's standing claim is zero console warnings — a harness
       that dirties the console it is meant to be watching is measuring itself. */
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-hydrated', 'true');
    /* THE BINDING THEME IS LIGHT (CONVENTIONS). `?theme=` pins it before first
       paint; asserted rather than assumed, because a sweep that silently ran in
       the other theme is what round 6 shipped. */
    expect(await page.evaluate(() => document.documentElement.classList.contains('atr-dark'))).toBe(
      false,
    );

    if (state === 'receipt-open') {
      /* THE RECEIPT IS ON THE PAGE FOR THIS RUN. P1 specifically: it is the one
         object with a hand-written receipt carrying real provenance rows and a
         real correction chain, and those are the controls the initial-state
         sweep has never once looked at. Opening whichever row happens to be
         first would open a DERIVED receipt with no excerpts, which is a
         denominator that quietly excludes the thing being measured. */
      await page.locator('[data-object-id="P1"]').click();
      await expect(page.locator('[data-receipt-id="P1"]')).toBeVisible();
    }

    /**
     * Controls that legitimately change nothing, each with the reason.
     *
     * Written as accessible-name predicates rather than selectors so the reason
     * is checkable against what a person actually sees. Keep this SHORT: an
     * inert control is a design decision, and a growing list is the page going
     * back to being a demo of markup.
     */
    const INERT: readonly { readonly name: RegExp; readonly why: string }[] = [
      {
        name: /^atrium$/,
        /* Mutation: change this narrowly anchored home-route exemption to a
           broad link exemption; a genuinely dead navigation control then
           disappears from the denominator. */
        why: 'the persistent wordmark links to the current home route while this sweep is already on it',
      },
      {
        name: /^sign in$/,
        /* Mutation: broaden this to all links. A dead in-product navigation
           then escapes the sweep; this one route-changing link is driven by
           the dedicated signed-out-entry test below. */
        why: 'sign in unmounts this sweep’s denominator and is driven by "offers a way in to someone who is not signed in"',
      },
      {
        name: /^Answer .* in your own words$|^Message #/,
        why: 'the composer textarea — focusing a field is not an act, and what it does when it has a draft is asserted in "the controls on / actually do something"',
      },
      {
        name: /^Send$/,
        why: 'Send with an empty draft correctly does nothing; sending a real draft is asserted in "the controls on / actually do something"',
      },
    ];

    const SELECTOR =
      'button:not([disabled]), a[href], [role="button"]:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])';

    const visible = await page.evaluate((selector) => {
      const out: { index: number; name: string }[] = [];
      let index = 0;
      for (const el of document.querySelectorAll(selector)) {
        index += 1;
        el.setAttribute('data-control-index', String(index));
        if (el.tagName === 'NEXTJS-PORTAL') continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (el.getClientRects().length === 0) continue;
        /* THE WHOLE NAME, NOT A DISPLAY STRING — round 10. It was truncated to
           60 characters HERE, and `INERT` matches against it: the composer
           textarea's exemption is `/^Answer .* in your own words$/`, and the
           moment the bound item's label got long enough the anchor fell off the
           end of the string and the field was reported dead. A pattern matched
           against an abbreviation is a pattern that stops meaning what it says,
           and the alternative — loosening it to `/^Answer /` — would have
           exempted the "Answer it" BUTTON, which is a live control. Matched in
           full; abbreviated only where it is printed. */
        const name = (
          el.getAttribute('aria-label') ||
          el.textContent ||
          el.getAttribute('placeholder') ||
          el.tagName
        )
          .trim()
          .replace(/\s+/g, ' ');
        out.push({ index, name });
      }
      return out;
    }, SELECTOR);

    /* The count is reported, not asserted against a constant: a constant here is
       the "ninety Tab presses" cap one file over. What is asserted is that every
       one of them was reached. */
    expect(visible.length, 'the page renders almost no controls').toBeGreaterThan(40);

    const snapshot = () =>
      page.evaluate(() => ({
        className: document.documentElement.className,
        length: document.body.innerHTML.length,
        text: document.body.innerText,
      }));

    /* THE CONTROLS THAT REPLACE THE PAGE GO LAST.
       Round 7 made the rail's chips switch the ROOM rather than the header, so
       clicking one unmounts every row, card and object the sweep had marked —
       and a control the page removed is skipped, which would quietly drop most
       of the denominator this test exists to assert. Ordering them last measures
       every other control in one room and still leaves the chips in the count;
       the room switch itself is asserted in "the rail, the objectives and the
       object rows are wired". */
    const REPLACES_THE_PAGE = /^#/;
    /* Mutation: drive a state-changing control before the inert composer.
       React replaces the composer node and its temporary enumeration marker,
       so the sweep skips it and then reports both exemptions as stale. Exercise
       inert controls first while the denominator's exact nodes still exist. */
    const isInert = (control: { readonly name: string }) =>
      INERT.some((entry) => entry.name.test(control.name));
    const exitsRoute = (control: { readonly name: string }) => /^sign in$/.test(control.name);
    const ordered = [
      ...visible.filter((control) => isInert(control) && !exitsRoute(control)),
      ...visible.filter(
        (control) =>
          !isInert(control) && !REPLACES_THE_PAGE.test(control.name) && !exitsRoute(control),
      ),
      ...visible.filter((control) => REPLACES_THE_PAGE.test(control.name)),
      ...visible.filter((control) => exitsRoute(control)),
    ];
    expect(
      ordered.filter((control) => REPLACES_THE_PAGE.test(control.name)).length,
      'the rail renders no room chips, so the ordering above is measuring nothing',
    ).toBeGreaterThan(3);

    const dead: string[] = [];
    const inertHit = new Set<string>();
    for (const control of ordered) {
      const target = page.locator(`[data-control-index="${control.index}"]`);
      /* A control the page removed while we were clicking other controls is not
         a dead control — acting on an owed item takes its card out of the pin.
         It is reported separately so "gone" cannot quietly become "passed". */
      if ((await target.count()) === 0 || !(await target.isVisible())) continue;
      const exemption = INERT.find((entry) => entry.name.test(control.name));
      const before = await snapshot();
      await target.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      /* Give React a paint. The alternative — waiting for a specific selector —
         would be a per-control expectation, which is the thing this test refuses
         to be: it asks one question of all of them. */
      await page.waitForTimeout(60);
      const after = await snapshot();
      const changed =
        before.className !== after.className ||
        before.length !== after.length ||
        before.text !== after.text;
      /* PUT THE BINDING THEME BACK. The toggle is a control like any other and it
         belongs in the denominator; what must not happen is that flipping it once
         measures every control after it in the theme CONVENTIONS does not bind. */
      if (before.className !== after.className) {
        await page.evaluate(() => document.documentElement.classList.remove('atr-dark'));
      }
      if (exemption !== undefined) {
        inertHit.add(exemption.why);
        continue;
      }
      if (!changed) dead.push(`${control.name.slice(0, 60)} (control #${control.index})`);
    }

    console.info(
      `/ controls (${state}, light): ${visible.length} visible · ${INERT.length} listed inert · ${dead.length} dead`,
    );
    /* THE RECEIPT'S OWN CONTROLS ARE IN THIS RUN, by name rather than by count —
       a count is satisfied by reaching different ones (CONVENTIONS). */
    if (state === 'receipt-open') {
      expect(
        visible.map((control) => control.name),
        'the receipt-open sweep did not see the receipt',
      ).toContain('← BACK TO CURRENT STATE');
      expect(
        visible.filter((control) => /jump to source|in #/.test(control.name)).length,
        'the receipt-open sweep saw no provenance rows',
      ).toBeGreaterThan(2);
    }
    expect(dead, 'visible controls on / that change nothing when clicked').toEqual([]);
    /* AND THE EXEMPTION LIST IS EXHAUSTIVE IN BOTH DIRECTIONS. An entry nothing
       matches is a carve-out that outlived its subject, and it reports exactly
       like one that is doing its job. */
    expect(
      INERT.filter((entry) => !inertHit.has(entry.why)).map((entry) => String(entry.name)),
      'an inert-control exemption matched nothing on the page',
    ).toEqual([]);
  }

  /* THE THREE HANDLERS THE FRAME FORGOT, NAMED. The sweep above proves the
     denominator; these prove the specific defect is closed, so a regression
     reads as itself rather than as "some control went dead". */
  test('the rail, the objectives and the object rows are wired', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const note = page.locator('[data-composer-note]');

    /* THE COLLAPSED OBJECTIVE CAN BE OPENED. It held four objects, two of which
       need this person, behind a triangle with no handler.

       BEFORE the room switch, deliberately. Round 7 made the chip switch the
       ROOM rather than the header, so `o2` is an objective in #users-migration
       and does not exist in #identity-service — a test that switched first and
       then looked for it would be asserting against the wrong room, which is
       the defect it is checking for, committed by the check. */
    const collapsed = page.locator('[data-objective-id="o2"]');
    await expect(collapsed.locator('button[aria-expanded]').first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const before = await page.locator('[data-object-id]').count();
    await collapsed.locator('button[aria-expanded]').first().click();
    await expect(collapsed.locator('button[aria-expanded]').first()).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await page.locator('[data-object-id]').count()).toBeGreaterThan(before);

    /* AND AN OBJECT ROW OPENS ITS RECEIPT — the affordance `ObjectRow` has
       advertised since round 1, with nothing behind it on this page. */
    await page.locator('[data-object-id]').first().click();
    await expect(page.locator('[data-receipt-id]')).toBeVisible();
    await expect(note).toContainText('opened the receipt');
    await page.getByRole('button', { name: /BACK TO CURRENT STATE/ }).click();
    await expect(page.locator('[data-receipt-id]')).toHaveCount(0);

    /* AND THE RAIL CHIP SWITCHES THE ROOM. Round 6 wired it to the header and
       nothing else; round 7 requires the feed, the pin and the lens to follow,
       and the rail to stop marking the room you left. */
    const feedBefore = await page.locator('[data-row="message"]').count();
    await page.locator('nav[aria-label="Rooms and people"] button').nth(1).click();
    await expect(note).toContainText('switched to #identity-service');
    await expect(page.locator('header h2')).toContainText('identity-service');
    expect(await page.locator('[data-row="message"]').count()).not.toBe(feedBefore);
    await expect(
      page.locator('nav[aria-label="Rooms and people"] [aria-current="true"]'),
    ).toHaveAttribute('aria-label', /#identity-service/);
    await expect(page.locator('[data-objective-id="o2"]')).toHaveCount(0);
  });

  /* -------------------------------------------------------------------------
   * TRUNCATION OWES THE READER A ROUTE.
   *
   * Round 6 measured all three compressed owed rows clipping their WHY YOU line
   * — 321 of 777px, 199 of 801px, 379 of 680px — with the full text on `title=`
   * only, which is the affordance `AttentionCompact`'s own header records as the
   * round-1 defect it was written to fix. A person's name in the rail and a
   * QUOTATION in the reply line were clipped too, and nothing in CONVENTIONS
   * governed truncating quoted words.
   *
   * The rule now: anything that actually clips names its way to the full text on
   * the DOM, in `data-truncates`. This is the denominator — every clipped
   * element, not the ones somebody remembered.
   * ---------------------------------------------------------------------- */
  for (const width of [1124, 1440] as const) {
    for (const state of ['initial', 'receipt-open'] as const) {
      test(`every clipped string on / names a route that is TRUE — @ ${width} ${state}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/?theme=light');
        await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
        if (state === 'receipt-open') {
          /* THE RECEIPT WAS NEVER IN THIS SWEEP EITHER. Round 7 measured all
             three of its `provExcerpt` elements at `scrollHeight 31 /
             clientHeight 15` — clipped quotations, in the one artifact whose job
             is being the trustworthy record — and this test had never looked at
             them, because it ran with `receiptId === null`. */
          await page.locator('[data-object-id="P1"]').click();
          await expect(page.locator('[data-receipt-id="P1"]')).toBeVisible();
        }

        /* ---------------------------------------------------------------------
         * THE ROUTE IS CHECKED, NOT COUNTED.
         *
         * Round 6 asserted the PRESENCE of `data-truncates` and never its truth,
         * so the receipt's clipped quotation carried "focusing this row expands
         * it; the cited record is on this page" — a `:focus-visible` clamp
         * expansion, which is none of the three routes CONVENTIONS permits,
         * followed by a claim that is false for `msg:m-legal@identity-service`.
         * The attribute is a grammar now and each kind is verified against the
         * page that is actually rendered.
         * ------------------------------------------------------------------ */
        const broken = await page.evaluate(() => {
          const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
          /* TEXT NODES JOINED BY A SPACE, not `textContent`. Adjacent inline
             elements concatenate with nothing between them — the m17 row reads
             `12:31✗justinParity check 418…` as one string — so a word-level
             comparison against `textContent` reports "justin" and "parity"
             missing from a row that plainly states both. The same defect
             `RoutineCollapse`'s header records for the accessible-name
             computation, in an instrument instead of in a component. */
          const spaced = (el: Element): string => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const parts: string[] = [];
            let node = walker.nextNode();
            while (node !== null) {
              parts.push(node.nodeValue ?? '');
              node = walker.nextNode();
            }
            return norm(parts.join(' '));
          };
          /* WORD CONTAINMENT, NOT SUBSTRING. A route may legitimately restate
             the content in another order or with other separators — the routine
             strip's accessible name says "8 routine rows between 11:50 and
             11:57" where the strip says "8 routine · 11:50 – 11:57", and the
             feed row a reply cites carries the actor, the time and the words in
             a different layout. What must be true is that nothing the reader was
             shown a fragment of is MISSING from the route, which is what caught
             "the item's card in Needs you" (it does not state the objective at
             all). Short tokens are dropped because punctuation and articles say
             nothing about whether the content is there. */
          const missing = (full: string, route: string): string[] => {
            const inRoute = new Set(
              norm(route.toLowerCase())
                .split(/[^\p{L}\p{N}]+/u)
                .filter(Boolean),
            );
            return norm(full.toLowerCase())
              .split(/[^\p{L}\p{N}]+/u)
              .filter((word) => word.length > 2 && !inRoute.has(word));
          };
          const out: { selector: string; route: string; why: string }[] = [];
          let checked = 0;
          for (const el of document.querySelectorAll('[data-truncates]')) {
            /* A check may skip what is NOT RENDERED and may not skip what is
               (CONVENTIONS). Below 1280 the compressed row's facts are
               `display: none`, so there is no clipped string there to owe
               anybody a route. The count of what WAS checked is returned, so a
               sweep that skipped everything cannot report like a clean one. */
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (el.getClientRects().length === 0) continue;
            checked += 1;
            const route = el.getAttribute('data-truncates') ?? '';
            const full = spaced(el);
            const describe =
              el.tagName.toLowerCase() +
              (typeof el.className === 'string' && el.className
                ? `.${el.className.trim().split(/\s+/)[0]}`
                : '');
            const fail = (why: string) => out.push({ selector: describe, route, why });
            const [kind, ...rest] = route.split(':');
            const detail = rest.join(':');
            if (kind === 'none') {
              /* `none` claims this element cannot lose letters. If it is actually
                 clipping, the claim is false. */
              if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
                fail('declares it cannot truncate, and it is truncating');
              }
              continue;
            }
            if (kind === 'name') {
              const named = el.closest('[aria-label]');
              if (named === null) fail('no ancestor carries an accessible name');
              else {
                const gone = missing(full, named.getAttribute('aria-label') ?? '');
                if (gone.length > 0) {
                  fail(`the accessible name is missing ${JSON.stringify(gone)}`);
                }
              }
              continue;
            }
            if (kind === 'control') {
              const control = el.closest(
                'button:not([disabled]), a[href], [role="button"]:not([aria-disabled="true"])',
              );
              if (control === null) fail('nothing here is a control a reader can press');
              else if (control.getClientRects().length === 0) fail('the control is not on screen');
              continue;
            }
            if (kind === 'element') {
              let other: Element | null = null;
              try {
                other = document.querySelector(detail);
              } catch {
                fail(`the route is not a selector: ${detail}`);
                continue;
              }
              if (other === null) fail(`the route names ${detail}, which is not on this page`);
              else if (other.getClientRects().length === 0) {
                fail(`the route names ${detail}, which is not visible`);
              } else {
                const gone = missing(full, spaced(other));
                if (gone.length > 0) fail(`${detail} is missing ${JSON.stringify(gone)}`);
              }
              continue;
            }
            fail('not one of the kinds CONVENTIONS permits');
          }
          return { broken: out, checked };
        });

        console.info(
          `/ @ ${width} ${state}: ${broken.checked} rendered routes checked · ${broken.broken.length} untrue`,
        );
        expect(broken.checked, 'no rendered element declares a truncation route').toBeGreaterThan(
          3,
        );
        expect(
          broken.broken,
          'an element names a route to the rest of its text that the rendered page does not have',
        ).toEqual([]);
      });
    }

    test(`every clipped string on / names its route to the full text — @ ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?theme=light');
      await expect(page.locator('[data-region="needs-you"]')).toBeVisible();

      const clipped = await page.evaluate(() => {
        const out: { selector: string; text: string; routed: string | null }[] = [];
        const describe = (el: Element) =>
          el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/)[0]}`
            : '');
        for (const el of document.querySelectorAll('body *')) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (el.getClientRects().length === 0) continue;
          /* A VISUALLY-HIDDEN STRING IS NOT A TRUNCATED ONE. The `srOnly` boxes
             that carry the hold contract to a screen reader are 1px clipped
             squares by construction: their whole text reaches the assistive
             tree, and none of it is on screen to be cut off. Excluded by
             GEOMETRY rather than by class name, so a new visually-hidden helper
             is covered without being added to a list. */
          const box = el.getBoundingClientRect();
          if (box.width <= 1 || box.height <= 1) continue;
          /* Both shapes of truncation: a single-line ellipsis (scrollWidth wider
             than the box) and a line clamp (scrollHeight taller than it). */
          const truncated =
            el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          if (!truncated) continue;
          /* A scroll CONTAINER is not truncating: it is offering the rest. */
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') continue;
          /* THE RULE IS ABOUT A STRING, NOT ABOUT A BOX. An element whose text
             is entirely in child elements is a container, and a container that
             clips its children is a FOLD — the pin's belt is exactly that, and
             it is governed by "the pin pages; it never scrolls" with its own
             assertions at five viewport heights. What this sweep owns is the
             case where the letters themselves are cut: an element with its own
             text nodes. */
          let own = '';
          for (const child of el.childNodes) {
            if (child.nodeType === 3) own += child.nodeValue ?? '';
          }
          if (own.trim().length === 0) continue;
          out.push({
            selector: describe(el),
            text: (el.textContent ?? '').trim().slice(0, 40),
            routed: el.getAttribute('data-truncates'),
          });
        }
        return out;
      });

      console.info(
        `/ @ ${width}: ${clipped.length} clipped strings — ${clipped
          .map((c) => `${c.selector}:${c.routed ?? 'UNROUTED'}`)
          .join(', ')}`,
      );
      expect(
        clipped.filter((c) => c.routed === null),
        'a string is truncated on screen with no stated route to the rest of it',
      ).toEqual([]);
    });
  }

  /* ---------------------------------------------------------------------------
   * BELOW THE FLOOR — r8 D10, in a real engine at a real width.
   *
   * Every width this suite has ever measured is 1124 or above, which is above
   * the shell's declared `min-width: 1024px`. The r8 blind review went below it
   * and found 664px of horizontal overflow at 360 and 304px at 720, with nothing
   * on screen stating or refusing a minimum — correct behaviour over an input
   * range nobody had stated, which is this round's shape everywhere else.
   *
   * `test/viewport.test.tsx` proves the rule exists and states the right number.
   * JSDOM does not evaluate media queries, so THIS is where a browser proves the
   * notice actually appears below the floor and actually does not above it.
   * ------------------------------------------------------------------------- */
  for (const width of [360, 720, 1023] as const) {
    test(`the shell states its minimum width @ ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const notice = page.locator('[data-below-minimum-width]');
      await expect(notice).toBeVisible();
      const floor = await notice.getAttribute('data-below-minimum-width');
      expect(Number(floor), 'the notice states no floor').toBeGreaterThan(320);
      await expect(notice).toContainText(String(floor));
      /* AND THE PAGE STILL WORKS. Stating a bound is not the same as refusing to
         run, and a notice over a dead page would be the compliant-but-unusable
         failure with a sentence on it. */
      await expect(page.locator('[data-region="needs-you"]')).toBeAttached();
    });
  }

  test('the minimum-width notice is absent above the floor', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('[data-region="needs-you"]')).toBeVisible();
    /* BOTH DIRECTIONS: a notice that is always on is a notice nobody reads, and
       it would be indistinguishable from one that works. */
    await expect(page.locator('[data-below-minimum-width]')).toBeHidden();
    /* …and above the floor the page does not scroll sideways at all. */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the page overflows horizontally at a width it claims to support').toBe(0);
  });

  test('offers a way in to someone who is not signed in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('sign-in-link')).toBeVisible();
    await page.getByTestId('sign-in-link').click();
    await page.waitForURL(/\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('toggles dark mode via the atr-dark class', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    const toggle = page.getByTestId('theme-toggle');

    // The button is server-rendered; wait for React to attach the handler.
    await expect(toggle).toHaveAttribute('data-hydrated', 'true');
    const before = await html.evaluate((el) => el.classList.contains('atr-dark'));

    await toggle.click();
    await expect.poll(() => html.evaluate((el) => el.classList.contains('atr-dark'))).toBe(!before);
  });
});
