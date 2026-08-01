/* ---------------------------------------------------------------------------
 * Browser-side audits, injected by the Playwright specs.
 *
 * These run inside the page because they need computed styles: what colour a
 * token actually resolved to on this surface in this theme, what the layout
 * engine did with a track, whether a keyframe was suppressed. None of it can be
 * checked from the source, which is exactly why it is here and not in Vitest.
 * ------------------------------------------------------------------------- */

export interface ContrastFailure {
  readonly ratio: number;
  readonly color: string;
  readonly background: string;
  readonly fontSize: number;
  readonly text: string;
  readonly selector: string;
}

export interface FontFailure {
  readonly fontSize: number;
  readonly text: string;
  readonly selector: string;
}

export interface OverflowReport {
  readonly documentScrollWidth: number;
  readonly documentClientWidth: number;
  readonly widest: readonly { readonly selector: string; readonly right: number }[];
  readonly scrollingFrames: readonly {
    readonly selector: string;
    readonly scrollWidth: number;
    readonly clientWidth: number;
  }[];
}

/**
 * A meaningful non-text graphic measured against what it sits on. WCAG 1.4.11
 * puts the floor at 3:1 — the same floor as the focus ring, and for the same
 * reason: information carried by a shape rather than by letters still has to be
 * perceivable.
 */
export interface GraphicFailure {
  readonly ratio: number;
  readonly what: string;
  readonly color: string;
  readonly background: string;
  readonly text: string;
  readonly selector: string;
}

export interface AuditResult {
  readonly contrastFailures: readonly ContrastFailure[];
  readonly fontFailures: readonly FontFailure[];
  readonly graphicFailures: readonly GraphicFailure[];
  readonly overflow: OverflowReport;
  readonly elementsChecked: number;
  readonly smallestFont: number | null;
  readonly lowestContrast: number | null;
  readonly graphicsChecked: number;
  readonly lowestGraphic: number | null;
}

/**
 * The audit, as a string that is evaluated in the page. It is one blob rather
 * than an import because Playwright's `evaluate` serialises the function and
 * cannot carry module scope with it.
 */
export const AUDIT = `(() => {
  const describe = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i += 1) {
      const cls = typeof node.className === 'string' && node.className
        ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      parts.unshift(node.tagName.toLowerCase() + cls);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const parseColor = (value) => {
    const m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const backdrop = (el) => {
    let node = el;
    let colour = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    while (node) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) stack.push(bg);
      node = node.parentElement;
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) colour = over(stack[i], colour);
    return colour;
  };

  /* PARTIAL OPACITY IS MEASURED, NOT EXCUSED.

     This used to read \`if (effectiveOpacity(el) < 0.999) continue;\`, justified
     by naming "a disabled chip" as unreadable by design. That is the rule the
     audit exists to enforce — CONVENTIONS' "de-emphasis must stay readable" has
     no exemption — and the round-2 gauntlet found exactly what the exemption was
     hiding: \`.surf[disabled] { opacity: .55 }\` at 2.49:1 light / 2.98:1 dark,
     shipped, invisible to a harness written to skip it. It is the same species
     as the prototype's sticky-footer whitelist: an invariant narrowed until it
     could not see its own counterexample.

     A fade is now FOLDED INTO THE MEASUREMENT: the element's effective opacity
     multiplies the text colour's alpha, so a 55% grey is measured as the grey
     the eye actually gets. The only thing still skipped is opacity 0, which is
     not de-emphasis — it is absence, in the same category as \`display: none\`
     (the hover strips that live at 0 until hover, and cannot be read at all).

     Scope, stated rather than implied: the composite is exact for a faded
     element that has no background of its own, because then the colour behind
     the ink is the unfaded parent surface. An element that fades its own fill
     AND its own text would need its fill composited separately; nothing in this
     app does that, and if something starts to, this comment is the place the
     next person finds out the model got narrower than the code. */
  const effectiveOpacity = (el) => {
    let node = el;
    let opacity = 1;
    while (node && node !== document.documentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity || '1');
      node = node.parentElement;
    }
    return opacity;
  };

  const ownText = (el) => {
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
    }
    return out.trim();
  };

  const contrastFailures = [];
  const fontFailures = [];
  let lowestContrast = Infinity;
  let smallestFont = Infinity;
  let checked = 0;

  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = ownText(el);
    if (!text) continue;
    const alpha = effectiveOpacity(el);
    if (alpha === 0) continue;

    const fontSize = parseFloat(style.fontSize);
    smallestFont = Math.min(smallestFont, fontSize);
    if (fontSize < 10) {
      fontFailures.push({ fontSize, text: text.slice(0, 60), selector: describe(el) });
    }

    const parsed = parseColor(style.color);
    if (!parsed) continue;
    /* The fade the element is wearing, applied to the ink. This is the whole
       point: a token that clears AA at full strength does not clear it at 55%,
       and the harness has to say so rather than look away. */
    const fg = { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a * alpha };
    const bg = backdrop(el);
    const ratio = contrast(over(fg, bg), bg);
    lowestContrast = Math.min(lowestContrast, ratio);
    checked += 1;
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    if (ratio + 0.005 < required) {
      contrastFailures.push({
        ratio: Math.round(ratio * 100) / 100,
        color: style.color,
        background: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
        fontSize,
        text: text.slice(0, 60),
        selector: describe(el),
      });
    }
  }

  /* NON-TEXT GRAPHICS — WCAG 1.4.11, the same 3:1 floor as the focus ring.

     The audit above measures TEXT and the ring audit in gallery.spec.ts measures
     the ring; between them they had never measured a graphic that carries
     meaning without being either. The claim underline is exactly that: this
     codebase's own words are "the dotted underline is the visual difference
     between 'someone said it' and 'the system checked it'", which is a
     definition of a meaningful non-text graphic. It shipped as --line3 at
     1.32–2.23:1 for three rounds because nothing in the harness had a category
     for it.

     Redundancy is NOT an exemption here, and this is the trap worth naming: on
     many rows the ~ glyph says the same thing, so the underline looks decorative
     — but <ClaimText> renders it without a ~ for gate-proposals, and round 3
     counted 9 elements beside ◆ and 6 beside ■ where the stroke was the only
     carrier. "Usually redundant" is what an exemption sounds like from the
     inside; the check measures every instance.

     The registry is explicit rather than a walk over every border in the app: a
     hairline divider is genuinely decorative and flagging it would train the
     check to be ignored. Anything ADDED to it has to be a graphic that carries
     information, and anything that carries information has to be in it. */
  const GRAPHICS = [
    { what: 'claim underline', selector: '[data-claim="true"]', side: 'borderBottomColor' },
  ];

  const graphicFailures = [];
  let graphicsChecked = 0;
  let lowestGraphic = Infinity;
  for (const graphic of GRAPHICS) {
    for (const el of document.querySelectorAll(graphic.selector)) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const alpha = effectiveOpacity(el);
      if (alpha === 0) continue;
      const parsed = parseColor(style[graphic.side]);
      if (!parsed) continue;
      const ink = { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a * alpha };
      const bg = backdrop(el);
      const ratio = contrast(over(ink, bg), bg);
      graphicsChecked += 1;
      lowestGraphic = Math.min(lowestGraphic, ratio);
      if (ratio + 0.005 < 3) {
        graphicFailures.push({
          ratio: Math.round(ratio * 100) / 100,
          what: graphic.what,
          color: style[graphic.side],
          background: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
          text: ownText(el).slice(0, 60),
          selector: describe(el),
        });
      }
    }
  }

  /* An element whose layout box runs past the viewport is only overflow if
     nothing between it and the root clips it. A room name that ellipsises
     inside a fixed track still has a wide layout box — the track is doing its
     job, and flagging it would train the check to be ignored. */
  const clipped = (el) => {
    let node = el.parentElement;
    while (node) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX !== 'visible') return true;
      node = node.parentElement;
    }
    return false;
  };

  const widest = [];
  const limit = document.documentElement.clientWidth;
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    if (rect.right > limit + 0.5 && !clipped(el)) {
      widest.push({ selector: describe(el), right: Math.round(rect.right) });
    }
  }

  /* And the frames themselves must not scroll sideways internally: a broken
     track set shows up here even when the page as a whole looks fine. */
  const scrollingFrames = [];
  for (const el of document.querySelectorAll('[data-gallery-frame], [data-frame]')) {
    if (el.scrollWidth > el.clientWidth + 1) {
      scrollingFrames.push({
        selector: describe(el),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      });
    }
  }

  return {
    contrastFailures,
    fontFailures,
    graphicFailures,
    graphicsChecked,
    lowestGraphic: lowestGraphic === Infinity ? null : Math.round(lowestGraphic * 100) / 100,
    overflow: {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      widest: widest.slice(0, 8),
      scrollingFrames,
    },
    elementsChecked: checked,
    smallestFont: smallestFont === Infinity ? null : Math.round(smallestFont * 100) / 100,
    lowestContrast: lowestContrast === Infinity ? null : Math.round(lowestContrast * 100) / 100,
  };
})()`;
