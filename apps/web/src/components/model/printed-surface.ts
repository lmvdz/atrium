/* ---------------------------------------------------------------------------
 * THE SINK SURFACE — ONE LIST, TWO ENFORCERS.
 *
 * CONVENTIONS: "the sink set is every string the page prints, not the elements
 * the page marked." Round 7 wrote that rule and then implemented it twice, in
 * two places, from two different lists:
 *
 *   - the STATIC half (`test/printed.ts`) knew six announced attributes;
 *   - the RUNTIME half (`model/slot.ts`) knew none, so `slot('priya said: I
 *     approve dropping users_legacy')` threw and
 *     `slot(<span title="priya said: I approve dropping users_legacy">ok</span>)`
 *     passed — and the same via `alt`, `placeholder`, `aria-label` and an
 *     `<optgroup label>`. The r8 blind review found that disagreement (D6), and
 *     it is the same defect as two enumerators with two hand-written node sets:
 *     a rule enforced from two lists is enforced at the weaker one.
 *
 * So the list lives HERE, in `src`, imported by both. A sink added for the sweep
 * is a sink the slot door refuses on the same commit, because there is nothing
 * left to keep in sync.
 *
 * WHAT THIS ENUMERATES FROM — and the honest answer to "what executes that this
 * does not list":
 *
 *   UNIVERSAL. Attributes the platform turns into text on ANY element: the ones
 *   a user agent paints (`title`, `placeholder`, `alt`) and the ones an
 *   accessibility tree exposes as a STRING (`aria-label`, `aria-description`,
 *   `aria-valuetext`, `aria-roledescription`, `aria-placeholder`,
 *   `aria-keyshortcuts`, and the two braille strings). Taken from the ARIA
 *   attribute table, filtered to the ones whose value type is a string.
 *
 *   NOT HERE, DELIBERATELY: `aria-labelledby`, `aria-describedby`,
 *   `aria-details`, `aria-errormessage`, `aria-controls`, `aria-owns`. Their
 *   value is an ID REFERENCE, not text — the text they announce is the referenced
 *   element's, and that element is its own printed site. Putting them in this
 *   list would check an id against the system-voice rule and check the sentence
 *   nowhere.
 *
 *   TAG-SCOPED. `label` and `value` are only text on the elements where the
 *   platform paints them: `<optgroup label>`, `<option label>`, `<option value>`
 *   as the option's visible text when it has no children, and `value` on the
 *   three `<input>` types that render their value as their face. Everywhere else
 *   `value` is a form value and `label` is an ordinary prop name, so a universal
 *   entry would report `<LedgerContext.Provider value={ledger}>`.
 *
 * WHAT EXECUTES THAT THIS DOES NOT LIST: CSS. `content: attr(data-x)` prints any
 * attribute at all, so the attribute set is only closed relative to a stylesheet
 * — which is why `test/printed-strings.test.tsx` derives the CSS-printed
 * attributes from the app's own `.css` files rather than from this list, and
 * asserts the derivation is live. Today no rule in this app uses `attr()`.
 * ------------------------------------------------------------------------- */

/**
 * Attributes whose value is painted or announced as text on ANY element.
 *
 * Compared case-INSENSITIVELY by both enforcers: HTML folds attribute names, so
 * `TITLE=` and `aria-Label=` reach the DOM as `title` and `aria-label` and are
 * found by `querySelector`. That is the round-6 case-sensitivity finding, in the
 * axis this list lives in.
 */
export const ANNOUNCED_ATTRIBUTES: readonly string[] = [
  'aria-braillelabel',
  'aria-brailleroledescription',
  'aria-description',
  'aria-keyshortcuts',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'alt',
  'placeholder',
  'title',
];

/** The same list, folded, because every comparison against it folds. */
export const ANNOUNCED_ATTRIBUTES_FOLDED: ReadonlySet<string> = new Set(
  ANNOUNCED_ATTRIBUTES.map((name) => name.toLowerCase()),
);

/**
 * Attributes that are text only on particular elements, keyed by the lowercase
 * tag. `input` is here for `type="button" | "submit" | "reset"`, where the value
 * IS the button's face; on every other input type the value is what the person
 * typed, which is their own words and not the page printing anything.
 */
export const TAG_SCOPED_TEXT_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['optgroup', new Set(['label'])],
  ['option', new Set(['label', 'value'])],
  ['input', new Set(['value'])],
]);

/**
 * Props that are CHILDREN by another name. React renders `children` passed as an
 * attribute exactly as it renders nested JSX, and `dangerouslySetInnerHTML`
 * writes its `__html` straight into the document — the widest sink on the
 * platform, live in this app at `app/layout.tsx` and benign there only because
 * the value is a module constant.
 */
export const CHILDREN_PROPS: readonly string[] = ['children', 'dangerouslySetInnerHTML'];

/** Is this attribute's value text a reader receives, on this element? */
export function announcesText(attribute: string, tag: string | undefined): boolean {
  const name = attribute.toLowerCase();
  if (ANNOUNCED_ATTRIBUTES_FOLDED.has(name)) return true;
  if (tag === undefined) return false;
  return TAG_SCOPED_TEXT_ATTRIBUTES.get(tag.toLowerCase())?.has(name) === true;
}
