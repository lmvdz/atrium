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
  ];

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
  let elements = 0;
  let strings = 0;
  let wordlessCounts = 0;
  let wordlessClaims = 0;

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
      const scoped = byQuestion.get('owed:#' + here) || [];
      const local = byQuestion.get('owed:here') || [];
      const answers = Array.from(new Set(scoped.concat(local).map((c) => c.answer)));
      if (answers.length > 1) {
        contradictions.push({
          screen: rootIndex,
          question: 'owed:here == owed:#' + here,
          answers: answers,
          claims: scoped.concat(local).map((c) => ({ answer: c.answer, text: c.text, selector: c.selector })),
        });
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
