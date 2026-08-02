/* ---------------------------------------------------------------------------
 * NO TWO ELEMENTS SIMULTANEOUSLY ON SCREEN MAY STATE DIFFERENT ANSWERS TO THE
 * SAME QUESTION.
 *
 * WHY THIS AND NOT ANOTHER COUNT CHECK. Round 8 shipped a five-surface
 * contradiction — pin, tab, rail footer, rail chip, lens head, feed tag and
 * trailer, disagreeing about one number on one screen — under 830 unit tests and
 * 82 e2e runs, all green. The r8 reviewer named why, and it is the finding
 * behind the findings:
 *
 *   the counting tests do exactly what they claim, and NONE OF THEM COMPARES
 *   TWO NUMBERS THAT ARE SIMULTANEOUSLY ON THE PAGE.
 *
 * Every other instrument in this repo checks a surface against the record. This
 * one checks a surface against its NEIGHBOUR, which is a different question and
 * the one nothing was asking. A page can be wrong about the record in one place
 * and right in six; it cannot disagree with itself anywhere without a reader
 * seeing it.
 *
 * WHAT IT ENUMERATES FROM — the denominator, stated (and asserted in the spec):
 *
 *   Every element in the rendered subtree, `root.querySelectorAll('*')` plus the
 *   root. For each, the three strings a reader can actually get out of it: its
 *   OWN text (direct child text nodes only, so a claim belongs to the element
 *   that states it rather than to every ancestor of it), its `aria-label`, and
 *   its `title`. Nothing is selected by class, by component, or by a remembered
 *   list of the surfaces that happen to carry a count today.
 *
 * WHAT IT CANNOT SEE, stated because a check that does not say this is a check
 * whose gaps get discovered by a critic instead:
 *
 *   - text that is not in the DOM: CSS `content:`, an image, a canvas.
 *   - a count carried only by colour, shape, or the LENGTH of a list.
 *   - anything not rendered in the state being driven: a folded pin's other
 *     pages, a collapsed objective's rows, the three rooms not on screen. The
 *     spec drives states rather than assuming one.
 *   - agreement with the RECORD. Six surfaces agreeing on a wrong number is
 *     silence here, by design — that is what every other instrument in this repo
 *     is for, and conflating the two is how both get weaker.
 *   - a question nobody has written a form for. Which is why `unparsed` below is
 *     an ALLOWLIST FAILURE and not a skip: a string that mentions the owed
 *     vocabulary beside a number and matches no form is REPORTED, so a new
 *     phrasing has to be classified rather than silently escaping the
 *     comparison. Round 8's own lesson: never denylist the violations.
 *
 * THE SENTENCE WITH NO FIELD WORD IN IT. The prototype lane's equivalent check
 * was defeated by a badge whose entire text was "3" — every pattern it matched
 * needed a noun beside the number. So the sweep enumerates WORDLESS COUNTS
 * separately (an element whose own text carries a digit and no letter at all),
 * resolves each to the nearest labelling string, and asserts that the set it
 * cannot resolve IS EMPTY. The rail's owed badge — literal text `◆4` — reaches
 * the comparison through that path.
 *
 * ROUND 10 — THE ANSWER WITH NO WORD AND NO DIGIT IN IT.
 *
 * r9's own verdict on this file was right and incomplete: "the check does what it
 * says — it is the enumeration of questions that is short, not the mechanism". It
 * ran verbatim over five states with 0 contradictions while four rendered
 * falsehoods were on screen. Three of its named blind spots are closed here:
 *
 *   1. A GLYPH. It is a character with no letter and no digit, so it was neither
 *      a form match nor a wordless count and never entered the comparison. r9's
 *      `/` had a rail chip reading `◆` forty pixels from a pin head reading `■`
 *      about the same four items. Bare glyphs are now enumerated, resolved to a
 *      question by `questionsNear`, and compared as `glyph:<question>` — and the
 *      "owed:here is owed:#<the room on screen>" unification covers the glyph
 *      pair as well as the count pair, which is what makes those two land on one
 *      question.
 *   2. `failures` / `overdue` / `commitments` HAD NO FORM, so "0 failures" beside
 *      "15 failures" was silence. Both are forms now, and they are DIFFERENT
 *      questions because the two sentences count different sets — which is only
 *      legible because r10's trailer names its scopes (D4).
 *   3. A FILTER MATCH WAS BACKGROUND COLOUR AND AN INSET STRIPE. The feed states
 *      what it lifted, in words, at the top of the region (D3), so what a filter
 *      did is now inside `textContent` rather than only in a computed style.
 *
 * WHAT IS STILL OUTSIDE IT, measured rather than asserted: `unresolvedGlyphs`
 * reports every bare glyph that resolved to no question — the composer's
 * ANSWERING banner is the standing member, because its glyph sits beside an item
 * LABEL and no count, and no form matches near it. The `not-room:` rule still
 * only fires when a room ON SCREEN is also named elsewhere. And this check still
 * says nothing about agreement with the RECORD, by design.
 * ------------------------------------------------------------------------- */

/** One thing an element says, parsed into the question it answers. */
export interface AgreementClaim {
  /** canonical question: `owed:here`, `owed:#users-migration`, `room`, … */
  readonly question: string;
  readonly answer: string;
  /** the string it was read from */
  readonly text: string;
  readonly selector: string;
  /** own-text | aria-label | title | wordless-count */
  readonly via: string;
}

export interface AgreementContradiction {
  /** which independent screen on the page — a gallery has six */
  readonly screen: number;
  readonly question: string;
  readonly answers: readonly string[];
  readonly claims: readonly {
    readonly answer: string;
    readonly text: string;
    readonly selector: string;
  }[];
}

export interface AgreementReport {
  /** how many independent screens were analysed (a gallery page has six) */
  readonly roots: number;
  /** the denominator: elements examined */
  readonly elements: number;
  /** reader-visible strings read off them */
  readonly strings: number;
  readonly claims: readonly AgreementClaim[];
  readonly contradictions: readonly AgreementContradiction[];
  /** elements whose whole text is a number and that no nearby string names */
  readonly unlabelledCounts: readonly { readonly text: string; readonly selector: string }[];
  /** strings that talk about owed attention beside a number and match no form */
  readonly unparsed: readonly { readonly text: string; readonly selector: string }[];
  /** wordless counts found, and how many of them produced a claim */
  readonly wordlessCounts: number;
  readonly wordlessClaims: number;
  /**
   * GLYPH MARKS FOUND, AND HOW MANY REACHED THE COMPARISON — round 10.
   *
   * The r9 check's own blind spot, in its own words: "a glyph is a character with
   * no letter and no digit, so it is neither a form match nor a wordless count
   * and never enters the comparison". `glyphMarks` is every bare glyph on screen;
   * `glyphClaims` is how many of them resolved to a question something else also
   * answers. The DIFFERENCE is the part of the vocabulary this check still cannot
   * compare, reported as a number rather than described in a comment — so the
   * next round is told the size of the gap instead of discovering it.
   */
  readonly glyphMarks: number;
  readonly glyphClaims: number;
  /** the bare glyphs that resolved to no question at all, for that difference */
  readonly unresolvedGlyphs: readonly { readonly text: string; readonly selector: string }[];
}

/**
 * The analysis, as a string evaluated in the page — the same shape as `AUDIT`
 * in audit.ts, and for the same reason: Playwright serialises the function and
 * cannot carry module scope with it. Vitest evaluates the identical source
 * against jsdom, so the browser and the unit suite run ONE analyser rather than
 * two that can drift.
 *
 * Takes `{ roots }` — a selector for the independent screens on the page.
 */
export const AGREEMENT = String.raw`((options) => {
  const rootSelector = (options && options.roots) || null;
  const roots = rootSelector === null
    ? [document.body]
    : (() => {
        const found = Array.from(document.querySelectorAll(rootSelector));
        return found.length === 0 ? [document.body] : found;
      })();

  const describe = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i += 1) {
      const cls = typeof node.className === 'string' && node.className
        ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      parts.unshift(node.tagName.toLowerCase() + cls);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  /* The element's OWN words: direct text children only. An ancestor does not
     get to claim what its descendants said, or every claim on the page would be
     attributed to <body> and every comparison would be trivially satisfied. */
  const ownText = (el) => {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  const allText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const hasLetter = (s) => /\p{L}/u.test(s);
  const hasDigit = (s) => /\d/.test(s);

  /* ---------------------------------------------------------------------
   * THE FORMS. Every one of them is a way this product states an answer to a
   * question some OTHER element also answers. A form maps a matched string to
   * (question, answer); "scoped" forms take the room out of the string.
   *
   * "question" is canonical, not literal: "1 item awaiting you" in the lens and
   * "here · 1 owed to you" in the rail footer are the same question in two
   * vocabularies, which is exactly why a reader reads them as a contradiction
   * and why grouping by wording would not.
   * ------------------------------------------------------------------- */
  const FORMS = [
    /* how many things in the room ON SCREEN need this person */
    { re: /here · (\d+) owed to you/, q: () => 'owed:here', a: (m) => m[1] },
    { re: /here · nothing owed/, q: () => 'owed:here', a: () => '0' },
    { re: /(\d+) owed to you here/, q: () => 'owed:here', a: (m) => m[1] },
    { re: /NEEDS YOU — (\d+)/, q: () => 'owed:here', a: (m) => m[1] },
    { re: /(\d+) items? · hardest first/, q: () => 'owed:here', a: (m) => m[1] },
    /* Anchored. Unanchored it matched the routine strip's "…no claim, nothing
       owed to anyone", which is a sentence about routine rows and not a count
       of what needs you — a form that matches prose is a form that invents
       contradictions. */
    { re: /^nothing owed$/, q: () => 'owed:here', a: () => '0' },
    { re: /NOTHING NEEDS YOU IN THIS ROOM/i, q: () => 'owed:here', a: () => '0' },
    { re: /(\d+) items? awaiting you/, q: () => 'owed:here', a: (m) => m[1] },
    { re: /(\d+) owed · /, q: () => 'owed:here', a: (m) => m[1] },
    /* …and in a NAMED room, which is the same question with a different scope */
    { re: /#([\w-]+) — (\d+) owed to you/, q: (m) => 'owed:#' + m[1], a: (m) => m[2] },
    { re: /(\d+) items? in #([\w-]+) needs? you/, q: (m) => 'owed:#' + m[2], a: (m) => m[1] },
    /* which room is on screen */
    { re: /[Mm]essage #([\w-]+)/, q: () => 'room', a: (m) => m[1] },
    { re: /the source of this item is a message in #([\w-]+) — this room/,
      q: () => 'room', a: (m) => m[1] },
    /* …and which room is NOT. Round 8's D3 is a contradiction of exactly this
       shape: one element saying "in #identity-service, not here" beside a head,
       a lens and a feed all saying you are in #identity-service. */
    { re: /the source of this item is in #([\w-]+), not here/, q: (m) => 'not-room:' + m[1], a: () => 'elsewhere' },
    { re: /source in #([\w-]+) →/, q: (m) => 'not-room:' + m[1], a: () => 'elsewhere' },
    { re: /jump to source in #([\w-]+) →/, q: (m) => 'not-room:' + m[1], a: () => 'elsewhere' },
    { re: /\(in #([\w-]+)\)/, q: (m) => 'not-room:' + m[1], a: () => 'elsewhere' },

    /* ---------------------------------------------------------------------
     * THE COUNTS THAT ARE NOT ABOUT OWED ATTENTION — round 10, D4.
     *
     * The r9 check had no form for 'failures', 'overdue' or 'commitments', so
     * "0 failures" in the trailer beside "15 failures" in the lens head was
     * SILENCE. They are two different questions — the trailer counts the objects
     * outside your list, the lens counts the room — and until r10 neither
     * sentence said which, so a reader had no way to tell a scope from a
     * contradiction. Each clause names its scope now and each scope is its own
     * question here, which is what makes the two numbers comparable to their own
     * kind and not to each other.
     * ------------------------------------------------------------------- */
    { re: /outside your list, of (\d+) objects?:/, q: () => 'objects:outside', a: (m) => m[1] },
    { re: /outside your list, of \d+ objects?:.*?(\d+) commitments?/, q: () => 'commitments:outside', a: (m) => m[1] },
    { re: /outside your list, of \d+ objects?:.*?(\d+) late/, q: () => 'late:outside', a: (m) => m[1] },
    { re: /outside your list, of \d+ objects?:.*?(\d+) failures?/, q: () => 'failures:outside', a: (m) => m[1] },
    /* the same three, said by the trailer's LEAD instead of by its clause — the
       clause drops whichever one the lead is already about (round 7) */
    { re: /(\d+) failures? outside your list/, q: () => 'failures:outside', a: (m) => m[1] },
    { re: /(\d+) things? (?:is|are) late outside your list/, q: () => 'late:outside', a: (m) => m[1] },
    { re: /(\d+) of the (\d+) outside your list still unverified/, q: () => 'objects:outside', a: (m) => m[2] },
    { re: /your list: (\d+) of (\d+) objectives clear/, q: () => 'objectives:clear', a: (m) => m[1] + '/' + m[2] },
    /* …and the lens head, which counts the ROOM. Anchored on the shape of the
       whole line rather than on the word 'failure' alone: a bare '(\d+) failures'
       matches the trailer too, and reading the two as one question is exactly the
       false contradiction that would make this check noise. */
    { re: /(\d+) objects? · \d+ settled/, q: () => 'objects:room', a: (m) => m[1] },
    { re: /(\d+) objects? · \d+ settled.*?· (\d+) failures?/, q: () => 'failures:room', a: (m) => m[2] },
  ];

  /* ---------------------------------------------------------------------
   * THE VOCABULARY, AS CHARACTERS — round 10, D1.
   *
   * The seven glyphs. A glyph is the one thing on this page that answers a
   * question with no letter and no digit in it, which is precisely why the r9
   * check could not see one: it was neither a form match nor a wordless count.
   * Two glyphs about one set that disagree is the contradiction this check
   * exists to find, and on r9's route / the rail chip said '◆' over the four items
   * the pin head said '■' about.
   * ------------------------------------------------------------------- */
  const GLYPHS = ['✓', '~', '?', '·', '◆', '■', '✗'];
  const isGlyphMark = (s) => s.length === 1 && GLYPHS.indexOf(s) !== -1;

  /* ---------------------------------------------------------------------
   * FORMS THAT LOOK LIKE THE OWED QUESTION AND ARE NOT. Enumerated rather than
   * ignored: each is a DIFFERENT question, and saying which one is what stops
   * the sweep from either reporting them forever or quietly dropping the ones
   * that matter. They are matched only to clear the "unparsed" allowlist.
   * ------------------------------------------------------------------- */
  const OTHER_QUESTIONS = [
    /* per-objective, and objects sit under more than one objective, so these
       overlap each other AND the pin — the lens says so in its own tooltip */
    /(\d+) need you/,
    /(\d+) of which need you/,
    /Nothing here is waiting on you/,
    /(\d+) objects? sit under this objective/,
    /* how many owed items are OFF THIS PAGE of the fold, not how many exist */
    /(\d+) more owed/,
    /(\d+) owed items not on this page/,
    /* how many stopped needing you — the complement, counted deliberately */
    /(\d+) items? here no longer needs? you/,
    /* the trailer counts objectives and commitments, not owed items */
    /(\d+)\/(\d+) objectives/,
    /* the empty-surface tooltip: a state, with no count in it */
    /nothing on the needs you surface/,
    /* the load route says what it is carrying, in its own words */
    /Carry (\d+) owed items/,
    /* the since-you-left divider counts ROWS, and says so in its own tooltip:
       "chips count rows, NEEDS YOU counts the items behind them". Two counts of
       two different things that happen to be near each other is not a
       contradiction, and calling it one would make this check noise. */
    /^\d+ NEED YOU$/,
    /messages in this group are linked to something that needs you/,
    /chips count rows/,
  ];

  /* A NUMBER STANDING NEXT TO THE OWED VOCABULARY IS AN ANSWER TO THE OWED
     QUESTION. If no form parses it, the sweep does not know what it says — and
     an unclassified claim is exactly the badge that defeated the prototype
     lane's check, so it FAILS rather than passing.
     ADJACENCY, not co-occurrence: "it failed and the explanation is owed to you
     · item 3 of 60" is a rationale about ONE item that happens to contain both,
     and a rule that flagged it would report sixty findings per screen until
     somebody turned the rule off. "#3" is excluded because a "#" before a
     number makes it an identifier, not a count. */
  const OWED_NOUN = '(owed|awaiting you|needs? you)';
  const NUMBER_THEN_NOUN = new RegExp('(?<!#)\\b\\d+\\b[^.;]{0,8}?' + OWED_NOUN, 'i');
  const NOUN_THEN_NUMBER = new RegExp(OWED_NOUN + '[^.;]{0,12}?(?<!#)\\b\\d+\\b', 'i');

  /* Emptied per screen — see the loop below. */
  const claims = [];
  const allClaims = [];
  const contradictions = [];
  const unparsed = [];
  const unlabelled = [];
  const unresolvedGlyphs = [];
  let elements = 0;
  let strings = 0;
  let wordlessCounts = 0;
  let wordlessClaims = 0;
  let glyphMarks = 0;
  let glyphClaims = 0;

  const readString = (text, el, via) => {
    if (text === null || text === undefined) return 0;
    const value = String(text).replace(/\s+/g, ' ').trim();
    if (value.length === 0) return 0;
    let matched = false;
    for (const form of FORMS) {
      const m = value.match(form.re);
      if (m === null) continue;
      matched = true;
      claims.push({
        question: form.q(m),
        answer: String(form.a(m)),
        text: value.slice(0, 160),
        selector: describe(el),
        via: via,
      });
    }
    if (!matched && (NUMBER_THEN_NOUN.test(value) || NOUN_THEN_NUMBER.test(value))) {
      if (!OTHER_QUESTIONS.some((re) => re.test(value))) {
        unparsed.push({ text: value.slice(0, 160), selector: describe(el) });
      }
    }
    return 1;
  };

  /* The label a wordless count sits under: its own or an ancestor's aria-label
     or title, else the nearest ancestor within three levels whose words — its
     own or a SIBLING's — have letters in them. The sibling half matters: the
     lens's "DECISIONS 3" is a label span beside a count span inside a container
     whose own text is empty, which is exactly the shape of the badge that
     defeated the prototype lane's check.
     Bounded on purpose — <body> has letters, so an unbounded walk resolves
     everything and the check measures nothing. */
  const labelFor = (el) => {
    let node = el;
    for (let i = 0; node && i < 4; i += 1) {
      const aria = node.getAttribute('aria-label');
      if (aria && hasLetter(aria)) return aria;
      const title = node.getAttribute('title');
      if (title && hasLetter(title)) return title;
      node = node.parentElement;
    }
    const mine = allText(el);
    node = el.parentElement;
    for (let i = 0; node && i < 3; i += 1) {
      const around = allText(node).replace(mine, ' ');
      if (hasLetter(around)) return allText(node);
      node = node.parentElement;
    }
    return null;
  };

  /* ---------------------------------------------------------------------
   * WHICH QUESTION A BARE GLYPH IS ABOUT.
   *
   * A glyph carries no words, so unlike every other claim on the page it cannot
   * say what it is about — the surrounding element has to. This walks the glyph's
   * own element and up to three ancestors, running the SAME FORMS over each
   * one's text and announced attributes, and stops at the first level that
   * yields any question. Bounded, and it stops at the first hit, because <body>
   * matches everything and an unbounded walk would attach every glyph on the
   * page to every question on it.
   *
   * Measured against the two surfaces r9 disagreed on:
   *   the rail chip   '<span aria-hidden>◆</span>' inside a pill whose 'title' is
   *                   "4 items in #users-migration need you" → owed:#users-migration
   *   the pin head    '<span data-pin-glyph>■</span>' inside '.pinHead', whose
   *                   text contains "4 items · hardest first"  → owed:here
   * and 'owed:here == owed:#<room on screen>' is already unified below, so the
   * two glyphs land on one question and r9's screen reports a contradiction.
   *
   * WHAT IT STILL CANNOT REACH, measured rather than guessed: see
   * 'unresolvedGlyphs' in the report. The composer's ANSWERING banner is the
   * known one — its glyph sits beside an item LABEL and no count, so no form
   * matches near it, and nothing else on screen states that item's glyph in a
   * form this check can parse. That glyph is held by the source sweep
   * ('test/glyph-source.test.ts') and by the render mutation
   * ('test/glyph-render.test.tsx') instead.
   * ------------------------------------------------------------------- */
  const questionsNear = (el) => {
    let node = el;
    /* THREE LEVELS, AND THE BOUND IS THE MEASUREMENT, NOT A ROUND NUMBER. A glyph
       mark is adjacent to what it labels: the rail chip's glyph is one level
       inside the pill that carries the count; the pin head's is two inside the
       head line that does. At FOUR the walk reaches 'main', whose text holds the
       pin AND the feed AND the composer — measured, that attached every feed
       row's per-row glyph to the room's owed count and reported four
       contradictions on a page that had none. A per-row glyph is about one row
       and belongs in 'unresolvedGlyphs', which is where it lands now. */
    for (let i = 0; node && i < 3; i += 1) {
      const before = claims.length;
      const strings = [allText(node), node.getAttribute('aria-label'), node.getAttribute('title')];
      for (const value of strings) {
        if (value === null || value === undefined) continue;
        const text = String(value).replace(/\s+/g, ' ').trim();
        if (text.length === 0) continue;
        for (const form of FORMS) {
          const m = text.match(form.re);
          if (m !== null) claims.push({ question: form.q(m), answer: String(form.a(m)), text: text.slice(0, 160), selector: describe(node), via: 'glyph-scope' });
        }
      }
      if (claims.length > before) {
        const found = claims.splice(before, claims.length - before);
        return found.map((c) => c.question);
      }
      node = node.parentElement;
    }
    return [];
  };

  /* CLAIMS THAT NEED THE ELEMENT AND NOT ONLY THE STRING.
     "#design" is the same string whether it is the head (you are in #design) or
     a rail chip (you can go to #design), and reading it as the first everywhere
     would invent a contradiction on every screen. A control that names a room is
     a way to reach it; the one marked "aria-current" is the rail saying which
     room you are in, which is precisely the surface round 6 caught disagreeing
     with the head. */
  const roomFromElement = (el) => {
    const tag = el.tagName.toLowerCase();
    const isControl = tag === 'button' || tag === 'a';
    if (el.getAttribute('aria-current') === 'true') {
      const aria = el.getAttribute('aria-label') || allText(el);
      const m = aria.match(/^#\s?([a-z][\w-]*)/);
      return m === null ? null : m[1];
    }
    if (isControl || el.closest('button, a') !== null) return null;
    const m = allText(el).match(/^#\s?([a-z][\w-]*)$/);
    return m === null ? null : m[1];
  };

  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    /* PER SCREEN. "/gallery" puts six frames side by side and they are six
       SCREENS: two of them showing different rooms with different owed counts is
       the gallery doing its job, and pooling their claims would report that as a
       contradiction. The invariant is about elements SIMULTANEOUSLY ON ONE
       SCREEN, so the comparison is scoped to one. */
    claims.length = 0;
    const all = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const el of all) {
      elements += 1;
      const own = ownText(el);
      strings += readString(own, el, 'own-text');
      strings += readString(el.getAttribute('aria-label'), el, 'aria-label');
      strings += readString(el.getAttribute('title'), el, 'title');

      const room = roomFromElement(el);
      if (room !== null) {
        claims.push({
          question: 'room',
          answer: room,
          text: (el.getAttribute('aria-label') || allText(el)).slice(0, 160),
          selector: describe(el),
          via: 'element',
        });
      }

      /* THE COUNT WITH NO WORD BESIDE IT. */
      if (own.length > 0 && hasDigit(own) && !hasLetter(own)) {
        wordlessCounts += 1;
        const label = labelFor(el);
        if (label === null) {
          unlabelled.push({ text: own, selector: describe(el) });
          continue;
        }
        const before = claims.length;
        readString(label, el, 'wordless-count');
        if (claims.length > before) wordlessClaims += 1;
      }

      /* THE ANSWER WITH NO WORD AND NO DIGIT IN IT — the glyph. */
      if (isGlyphMark(own)) {
        glyphMarks += 1;
        const questions = questionsNear(el);
        if (questions.length === 0) {
          unresolvedGlyphs.push({ text: own, selector: describe(el) });
        } else {
          glyphClaims += 1;
          for (const question of questions) {
            claims.push({
              question: 'glyph:' + question,
              answer: own,
              text: own,
              selector: describe(el),
              via: 'glyph',
            });
          }
        }
      }
    }

    /* ---------------------------------------------------------------------
     * THE COMPARISON. Group by question; a question with two answers is two
     * elements on one screen contradicting each other.
     * ------------------------------------------------------------------- */
    const byQuestion = new Map();
    for (const claim of claims) {
      const list = byQuestion.get(claim.question) || [];
      list.push(claim);
      byQuestion.set(claim.question, list);
    }

    for (const [question, list] of byQuestion) {
      const answers = Array.from(new Set(list.map((c) => c.answer)));
      if (answers.length > 1) {
        contradictions.push({
          screen: rootIndex,
          question: question,
          answers: answers,
          claims: list.map((c) => ({ answer: c.answer, text: c.text, selector: c.selector })),
        });
      }
    }

    /* The room on screen is one room, and the named-room owed count for THAT room
       is the same question as "owed:here" in a different vocabulary. Both of these
       compare a surface against its neighbour; neither reads the record. */
    const roomAnswers = Array.from(
      new Set((byQuestion.get('room') || []).map((c) => c.answer)),
    );
    if (roomAnswers.length === 1) {
      const here = roomAnswers[0];
      /* THE GLYPH HALF OF THE SAME UNIFICATION — round 10, D1. "how many things
         here need you" and "how many things in #<the room on screen> need you"
         are one question, and so are the two GLYPHS that stand for those two
         sets. r9's rail chip answered '◆' and its pin head answered '■' about
         the same four items, forty pixels apart. */
      for (const prefix of ['', 'glyph:']) {
        const scoped = byQuestion.get(prefix + 'owed:#' + here) || [];
        const local = byQuestion.get(prefix + 'owed:here') || [];
        const answers = Array.from(new Set(scoped.concat(local).map((c) => c.answer)));
        if (answers.length > 1) {
          contradictions.push({
            screen: rootIndex,
            question: prefix + 'owed:here == ' + prefix + 'owed:#' + here,
            answers: answers,
            claims: scoped.concat(local).map((c) => ({ answer: c.answer, text: c.text, selector: c.selector })),
          });
        }
      }
      const notHere = byQuestion.get('not-room:' + here) || [];
      if (notHere.length > 0) {
        contradictions.push({
          screen: rootIndex,
          question: 'room #' + here + ' is on screen and is also said to be elsewhere',
          answers: ['on screen', 'elsewhere'],
          claims: notHere.map((c) => ({ answer: c.answer, text: c.text, selector: c.selector })),
        });
      }
    }
    for (const claim of claims) allClaims.push(claim);
  }

  return {
    roots: roots.length,
    elements: elements,
    strings: strings,
    claims: allClaims,
    contradictions: contradictions,
    unlabelledCounts: unlabelled,
    unparsed: unparsed,
    wordlessCounts: wordlessCounts,
    wordlessClaims: wordlessClaims,
    glyphMarks: glyphMarks,
    glyphClaims: glyphClaims,
    unresolvedGlyphs: unresolvedGlyphs,
  };
})`;

export interface AgreementOptions {
  /**
   * A selector for the independent screens on the page. `/gallery` renders six
   * frames side by side and they are six SCREENS, not one — two frames stating
   * different owed counts is the gallery doing its job. `null` analyses the
   * document as one screen.
   */
  readonly roots: string | null;
}

/**
 * The analysis as one evaluable expression, arguments already applied.
 *
 * `page.evaluate(string)` does not invoke a function the string evaluates to —
 * `AUDIT` is `(() => {…})()` for that reason — so the call is baked in here
 * rather than left to each caller to remember. The same string is `eval`'d
 * against jsdom by the unit suite, which is what keeps the browser check and the
 * unit check ONE analyser.
 */
export function agreementScript(options: AgreementOptions): string {
  return `(${AGREEMENT})(${JSON.stringify(options)})`;
}
