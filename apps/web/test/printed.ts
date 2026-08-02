/* ---------------------------------------------------------------------------
 * THE DENOMINATOR: EVERY CALLER-SUPPLIED STRING THE PAGE PRINTS.
 *
 * `test/system-voice.test.tsx` took its denominator from the elements that carry
 * `data-voice="system"` — a set the PAGE CHOOSES BY WRITING AN ATTRIBUTE. Its own
 * header names that failure ("the address came from a receipt instead of from a
 * count") and then reproduces it: the set of page-authored string sinks is not
 * the set of elements the page remembered to mark. The blind cross-lineage review
 * of round 6's fix found four sinks outside it — `ProvenanceEntry.note`,
 * `CorrectionEntry.heading`, `RowTag.label` and `AttentionItem.facts` — two of
 * them inside the receipt, one of them inside the same `<button>` as a resolved
 * quotation and on the line immediately after the quoted words.
 *
 * So this module enumerates the other way round, and the denominator does not
 * come from the claim:
 *
 *   1. EVERY PLACE A STRING REACHES A READER. Every `{…}` rendered as a JSX
 *      CHILD, plus every announced-text attribute (`aria-label`, `title`,
 *      `placeholder`, `alt`, `aria-description`) — a string announced to a
 *      screen reader is a string the page printed.
 *
 *   2. NARROWED BY TYPE, NOT BY ATTRIBUTE. A site is only interesting when its
 *      expression's type can actually be a free string. A closed union of string
 *      literals (`Glyph`, `'here' | 'idle' | 'away'`) is not caller text: the set
 *      of values it can hold is enumerable from the type. Numbers, booleans and
 *      elements are not text at all.
 *
 *   3. AND THEN THE PROVENANCE IS TRACED, ALLOWLIST-FIRST. A site passes only
 *      when the analysis can walk the expression back to something compliant: a
 *      literal in the source, a value resolved out of the record register, or a
 *      call to one of the doors. Anything it cannot walk back is REPORTED, not
 *      passed — a denylist of the ways a string can arrive is unbounded, and past
 *      the analysis's bound the honest answer is "I could not check this", which
 *      is a refusal (CONVENTIONS, `slot()`'s node budget).
 *
 * The dataflow is deliberately separable from the type predicate so the analyser
 * itself can be exercised against synthetic source with the type question stubbed
 * out — an instrument with no self-test is a claim, not a measurement.
 * ------------------------------------------------------------------------- */

import ts from 'typescript';
import { announcesText, CHILDREN_PROPS } from '../src/components/model/printed-surface';

/** One string the page prints that the analysis could not trace to a checked source. */
export interface PrintedFinding {
  readonly file: string;
  readonly line: number;
  /** `children` for rendered text, otherwise the attribute that announces it */
  readonly where: string;
  readonly expr: string;
  readonly why: string;
}

export interface Analysis {
  readonly findings: readonly PrintedFinding[];
  /** how many printed sites were examined at all — the denominator of the sweep */
  readonly sites: number;
  /** how many of those could carry a free string, and were therefore traced */
  readonly traced: number;
}

/**
 * The doors, and what each one buys. Named here rather than in the test so the
 * mutation ledger and the test agree about what a door is.
 *
 *   THE REGISTER. A value resolved out of the page's record ledger is not
 *   caller text at all: it is a row of the register, and the register is what
 *   every other guarantee in this codebase is stated against. Its members (the
 *   actor, the words, the time, the room) are the one place a person's own
 *   sentence is allowed to reach the screen.
 */
const REGISTER_DOORS: ReadonlySet<string> = new Set([
  'useAttribution',
  'useCitedRecord',
  'resolveCitation',
  'resolveQuotation',
]);

/**
 *   THE PAGE'S OWN VOICE. `systemText` for a string the page states, held to the
 *   whole system-voice rule; `statementText`/`rationaleText` for the two branded
 *   page-authored types; `offeredText` for the copy ON a control the page offers,
 *   which keeps its pronouns (CONVENTIONS: "the first-person ban is scoped to the
 *   system's framing, not to the payload it reports") and is bounded to controls
 *   by `test/printed-strings.test.tsx`.
 */
const TEXT_DOORS: ReadonlySet<string> = new Set([
  'systemText',
  'statementText',
  'rationaleText',
  'offeredText',
]);

/**
 * Calls that COMPOSE without inventing: everything they can print, they were
 * given. They are not doors — each argument still has to be compliant on its own
 * — which is exactly how `list(item.facts)` and `text(entry.note)` are reported
 * rather than laundered.
 */
const COMPOSERS: ReadonlySet<string> = new Set([
  'plural',
  'text',
  'maybe',
  'list',
  'initials',
  'String',
  'Number',
  'glyphFor',
  'quotationRef',
  'Boolean',
]);

/**
 * Methods that reshape a string without adding one. The RECEIVER has to be
 * compliant; the separators and counts do not.
 */
const SHAPE_METHODS: ReadonlySet<string> = new Set([
  'join',
  'toUpperCase',
  'toLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'slice',
  'at',
  'concat',
  'repeat',
  'normalize',
  'padStart',
  'padEnd',
  'toString',
  'toFixed',
  'toLocaleString',
]);

/**
 * Methods that REPLACE each element with whatever their callback returns, so the
 * result's provenance is the callback's, not the receiver's.
 */
const MAPPING_METHODS: ReadonlySet<string> = new Set(['map', 'flatMap']);

/**
 * Methods that select from the receiver without changing an element, so the
 * result's provenance is the receiver's.
 */
const SELECTING_METHODS: ReadonlySet<string> = new Set([
  'filter',
  'find',
  'findLast',
  'sort',
  'toSorted',
  'reverse',
  'toReversed',
]);

/** Array methods whose callback's first parameter is an ELEMENT of the receiver. */
const ELEMENT_METHODS: ReadonlySet<string> = new Set([
  ...MAPPING_METHODS,
  ...SELECTING_METHODS,
  'forEach',
  'some',
  'every',
]);

/**
 * Attributes whose value is announced or displayed to a reader.
 *
 * RE-EXPORTED FROM `src`, not written here — r8 D6. The runtime door in
 * `model/slot.ts` enforces the same rule and used to know none of these, so
 * `slot(<span title="priya said: I approve dropping users_legacy">ok</span>)`
 * passed while the bare string threw. One rule enforced from two lists is
 * enforced at the weaker one; see `model/printed-surface.ts` for the list and
 * for which attributes are deliberately NOT on it.
 */
export { ANNOUNCED_ATTRIBUTES } from '../src/components/model/printed-surface';

const MAX_DEPTH = 32;

export interface AnalyseOptions {
  /**
   * Whether this expression can carry a free string. The real sweep asks the
   * TypeScript checker; the self-test says yes to everything, so the dataflow is
   * exercised without a program.
   */
  readonly isFreeString: (node: ts.Node) => boolean;
  /**
   * Whether this expression is a `Slot`. A `Slot` can only be built by `slot()`,
   * which walks the tree it is handed and puts every RAW STRING in it through
   * `systemText` — so a slot boundary is a checked one. The real sweep asks the
   * checker; the default is syntactic, for the self-test.
   */
  readonly isSlot?: (node: ts.Node) => boolean;
  /**
   * Whether this expression IS or CONTAINS a free string — an array of them, a
   * record with one on it. A composer's argument is a container: `list(facts)`
   * joins the elements, so asking "can `facts` be a string" and passing when it
   * cannot is the same hole as at a call site. Defaults to `isFreeString`, which
   * is the strictest answer when the type question is stubbed out.
   */
  readonly holdsString?: (node: ts.Node) => boolean;
  readonly relative: string;
}

export function analyseSource(file: ts.SourceFile, options: AnalyseOptions): Analysis {
  return new FileAnalysis(file, options).run();
}

class FileAnalysis {
  private readonly exported: ReadonlySet<string>;
  /**
   * A parameter of a function whose body this analysis is currently reading,
   * bound to the ARGUMENT at the call site it came from.
   *
   * SUBSTITUTION, NOT TRUST. The first version marked the parameters "checked"
   * and verified the arguments separately, which over-refused a helper that
   * never touches its argument's strings (`nextPageLabel(fold)` returns two
   * literals and a count off a `PinFold` full of caller text) and under-refused
   * one that does. Resolving the parameter to the argument only where the body
   * actually reads it is the honest version: `fold.nextPage.length` never asks,
   * and `fold.open.title` would.
   */
  private readonly bound = new Map<ts.Node, ts.Node>();
  /** Functions whose returns are currently being checked, so recursion terminates. */
  private readonly inFlight = new Set<ts.Node>();

  constructor(
    private readonly file: ts.SourceFile,
    private readonly options: AnalyseOptions,
  ) {
    this.exported = exportedNames(file);
  }

  run(): Analysis {
    const findings: PrintedFinding[] = [];
    let sites = 0;
    let traced = 0;
    const visit = (node: ts.Node): void => {
      for (const site of printedSites(node)) {
        sites += 1;
        if (!this.options.isFreeString(site.expression)) continue;
        traced += 1;
        const why = this.compliant(site.expression, 0);
        if (why !== null) {
          findings.push({
            file: this.options.relative,
            line:
              this.file.getLineAndCharacterOfPosition(site.expression.getStart(this.file)).line + 1,
            where: site.where,
            expr: oneLine(site.expression.getText(this.file)),
            why,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.file);
    return { findings, sites, traced };
  }

  /**
   * null when the expression traces back to something checked; otherwise why not.
   *
   * `container` distinguishes "this value is printed" from "this value HOLDS what
   * is printed". A `.map` receiver is an array — asking whether an array can be a
   * string and passing when it cannot is how the elements of a caller's array
   * would walk straight through, so the type narrowing is switched off for the
   * whole of a container trace. It only ever makes the analysis stricter.
   */
  private compliant(node: ts.Node, depth: number, container = false): string | null {
    if (depth > MAX_DEPTH) {
      return `the analysis could not reach a source in ${MAX_DEPTH} steps — an untraced value is a refusal, not a pass`;
    }
    /* A sub-expression that cannot BE a string cannot carry caller text: a count,
       a page number, a state record read for its shape. The same narrowing the
       sweep applies at the top, applied on the way down, so a template holding
       `${fold.page + 1}` is not reported for the provenance of a number. */
    if (!container && depth > 0 && !this.options.isFreeString(node)) return null;
    const next = depth + 1;

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    ) {
      return null;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      return null;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      return this.compliant(node.expression, next, container);
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        const why = this.compliant(span.expression, next, container);
        if (why !== null) return why;
      }
      return null;
    }
    if (ts.isConditionalExpression(node)) {
      return (
        this.compliant(node.whenTrue, next, container) ??
        this.compliant(node.whenFalse, next, container)
      );
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken)
        return this.compliant(node.right, next, container);
      if (op === ts.SyntaxKind.CommaToken) return this.compliant(node.right, next, container);
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      ) {
        return (
          this.compliant(node.left, next, container) ?? this.compliant(node.right, next, container)
        );
      }
      /* A comparison renders as a boolean, which React prints as nothing. */
      return null;
    }
    if (ts.isPrefixUnaryExpression(node)) return this.compliant(node.operand, next, container);
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        const why = this.compliant(element, next, container);
        if (why !== null) return why;
      }
      return null;
    }
    if (ts.isObjectLiteralExpression(node)) {
      /* A lookup table written in this file — `CLASS_LABEL`, `PRESENCE_LABEL`,
         `KIND_LABEL`. Every value it can yield is written here, so indexing it
         with anything cannot produce a string a caller supplied. A spread is the
         one shape that breaks that, and it is refused. */
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          return 'a lookup table built with a spread can hold values written elsewhere';
        }
        if (ts.isPropertyAssignment(property)) {
          const why = this.compliant(property.initializer, next, container);
          if (why !== null) return why;
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          const why = this.compliant(property.name, next, container);
          if (why !== null) return why;
          continue;
        }
        return 'a lookup table with a member this analysis cannot read';
      }
      return null;
    }
    if (ts.isCallExpression(node)) return this.callCompliant(node, next, container);
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.getText(this.file);
      /* A count is not text. */
      if (name === 'length' || name === 'size') return null;
      /* A `Slot`'s node is whatever `slot()` validated — and `slot()` puts every
         raw string it walks through the same door this analysis is about, so a
         slot boundary is a checked one rather than a hole. */
      if (name === 'node' && this.isSlotTyped(node.expression)) return null;
      /* WHEN THE OBJECT IS WRITTEN IN THIS FILE, READ THE PROPERTY THAT IS
         ACTUALLY PRINTED. `FRAMES` is an array of literals whose `title` and
         `note` are prose typed here and whose `props` holds a spread; asking
         about the whole object refuses the spread and reports two hand-written
         captions as caller text. That is a real cost: the first version of this
         analysis forced the gallery's own editorial prose through the
         system-voice door, which refused the word "says" — round 4's mistake
         (holding a payload to the interface's rule) reproduced by round 7's own
         instrument. */
      const literals = this.objectLiteralsFor(node.expression, next);
      if (literals !== undefined && literals.length > 0) {
        let sawProperty = false;
        for (const literal of literals) {
          for (const property of literal.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            if (property.name.getText(this.file).replace(/['"]/g, '') !== name) continue;
            sawProperty = true;
            const why = this.compliant(property.initializer, next, container);
            if (why !== null) return why;
          }
        }
        if (sawProperty) return null;
      }
      /* THE OBJECT IS A CONTAINER. `entry.note` is a string; `entry` is a record
         that HOLDS it. Recursing in value mode would ask "can `entry` be a
         string", find that a record cannot, and pass — which silently empties
         this whole sweep. Round 7 wrote that bug and the exemption list caught
         it: `Voice.tsx {part.text}` stopped matching, and an exemption that
         matches nothing is exactly the signal it exists to give. */
      return this.compliant(node.expression, next, true);
    }
    if (ts.isElementAccessExpression(node)) return this.compliant(node.expression, next, true);
    if (ts.isIdentifier(node)) return this.identifierCompliant(node, next, container);
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      return 'a value read off `this` cannot be traced to a source';
    }
    return `${ts.SyntaxKind[node.kind]} is not a shape this analysis can trace — an untraced value is a refusal, not a pass`;
  }

  private isSlotTyped(node: ts.Node): boolean {
    if (this.options.isSlot !== undefined) return this.options.isSlot(node);
    /* The syntactic fallback, for the self-test: every `Slot` in this library is
       either the result of a `slot(...)` call or a value declared `Slot`. */
    if (ts.isCallExpression(node)) return node.expression.getText(this.file) === 'slot';
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return false;
    const root = ts.isIdentifier(node) ? node : rootIdentifier(node);
    if (root === undefined) return false;
    const declared = this.declarationOf(root);
    if (declared === undefined) return false;
    const typeNode = declaredTypeNode(declared, root.getText(this.file));
    return typeNode !== undefined && /(^|\W)Slot(\W|$)/.test(typeNode.getText(this.file));
  }

  private callCompliant(call: ts.CallExpression, depth: number, container: boolean): string | null {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      const name = callee.getText(this.file);
      if (REGISTER_DOORS.has(name) || TEXT_DOORS.has(name)) return null;
      if (COMPOSERS.has(name)) return this.argumentsCompliant(call, depth);
      const local = this.localFunction(callee);
      if (local !== undefined) return this.localCallCompliant(call, local, depth, container);
      return `${name}() is not one of the doors a printed string may come through (${[...TEXT_DOORS].join(', ')}), a composer, or a function declared in this file`;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.getText(this.file);
      if (SHAPE_METHODS.has(method)) {
        return (
          this.compliant(callee.expression, depth + 1, container) ??
          this.argumentsCompliant(call, depth)
        );
      }
      if (MAPPING_METHODS.has(method)) {
        /* The result is whatever the callback returns, so the receiver's
           provenance says nothing about it. */
        const callback = call.arguments[0];
        if (callback === undefined || !ts.isFunctionLike(callback)) {
          return `.${method}() with a callback this analysis cannot read`;
        }
        return this.returnsCompliant(callback, depth + 1, container);
      }
      if (SELECTING_METHODS.has(method))
        return this.compliant(callee.expression, depth + 1, container);
      return `.${method}() is not a shape this analysis can trace`;
    }
    return 'a call whose callee is not a name cannot be traced';
  }

  /**
   * The object literals a value can be, when they are written in this file.
   *
   * `undefined` means "this analysis cannot say", which sends the caller back to
   * the ordinary container trace — the conservative direction. It never PASSES
   * anything on its own; all it does is narrow which property gets checked.
   */
  private objectLiteralsFor(
    node: ts.Node,
    depth: number,
  ): readonly ts.ObjectLiteralExpression[] | undefined {
    if (depth > MAX_DEPTH) return undefined;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
      return this.objectLiteralsFor(node.expression, depth + 1);
    }
    if (ts.isObjectLiteralExpression(node)) return [node];
    if (ts.isArrayLiteralExpression(node)) {
      const out: ts.ObjectLiteralExpression[] = [];
      for (const element of node.elements) {
        const nested = this.objectLiteralsFor(element, depth + 1);
        if (nested === undefined) return undefined;
        out.push(...nested);
      }
      return out;
    }
    if (ts.isIdentifier(node)) {
      const declaration = this.declarationOf(node);
      if (declaration === undefined) return undefined;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
        return this.objectLiteralsFor(declaration.initializer, depth + 1);
      }
      if (ts.isParameter(declaration)) {
        const call = arrayCallbackHost(declaration.parent);
        if (call !== undefined && ts.isPropertyAccessExpression(call.expression)) {
          return this.objectLiteralsFor(call.expression.expression, depth + 1);
        }
      }
      return undefined;
    }
    return undefined;
  }

  /** A function declared in this file, by name — the only ones whose body is readable here. */
  private localFunction(id: ts.Identifier): ts.SignatureDeclarationBase | undefined {
    const declaration = this.declarationOf(id);
    if (declaration === undefined) return undefined;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const initializer = declaration.initializer;
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        return initializer;
    }
    return undefined;
  }

  /**
   * A call to a function whose body is in this file: check the ARGUMENTS at this
   * call site, then check the function's RETURNS with its parameters trusted.
   * That is what makes a page-composed helper traceable without making an
   * exemption out of its name.
   */
  private localCallCompliant(
    call: ts.CallExpression,
    fn: ts.SignatureDeclarationBase,
    depth: number,
    container: boolean,
  ): string | null {
    if (this.inFlight.has(fn)) return null;
    this.inFlight.add(fn);
    fn.parameters.forEach((parameter, index) => {
      const argument = call.arguments[index];
      if (argument !== undefined) this.bound.set(parameter, argument);
    });
    try {
      return this.returnsCompliant(fn, depth + 1, container);
    } finally {
      for (const parameter of fn.parameters) this.bound.delete(parameter);
      this.inFlight.delete(fn);
    }
  }

  /** Every value a function-like can hand back, checked. */
  private returnsCompliant(
    fn: ts.SignatureDeclarationBase,
    depth: number,
    container = false,
  ): string | null {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body === undefined) return 'a function with no body cannot be traced';
    if (!ts.isBlock(body)) return this.compliant(body, depth, container);
    const returns: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== fn) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined)
        returns.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(body);
    if (returns.length === 0) return 'a function this analysis found no return value in';
    for (const value of returns) {
      const why = this.compliant(value, depth, container);
      if (why !== null) return why;
    }
    return null;
  }

  private argumentsCompliant(call: ts.CallExpression, depth: number): string | null {
    const holds = this.options.holdsString ?? this.options.isFreeString;
    for (const argument of call.arguments) {
      /* THE ARGUMENT IS A CONTAINER. Round 7 filtered on `isFreeString` and
         traced in value mode, so `list(item.facts)` — an ARRAY of caller strings
         joined by `·` and printed on the open card's meta line — was skipped on
         the grounds that an array is not a string. That is one of the four sinks
         this file was written for, passed by the file itself. Found by running
         the sweep against r6, where it reported 64 of the 68 it should have. */
      if (!holds(argument)) continue;
      const why = this.compliant(argument, depth + 1, true);
      if (why !== null) return why;
    }
    return null;
  }

  private identifierCompliant(id: ts.Identifier, depth: number, container: boolean): string | null {
    const name = id.getText(this.file);
    if (name === 'undefined') return null;
    const declaration = this.declarationOf(id);
    if (declaration === undefined) {
      return `\`${name}\` is not declared in this file, so its provenance is outside what this sweep can see`;
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (declaration.initializer === undefined) {
        return `\`${name}\` is declared without an initialiser, so nothing here says where its value comes from`;
      }
      return this.compliant(declaration.initializer, depth + 1, container);
    }
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const owner = pattern.parent;
      if (ts.isVariableDeclaration(owner)) {
        if (owner.initializer === undefined) {
          return `\`${name}\` is destructured from a declaration with no initialiser`;
        }
        return this.compliant(owner.initializer, depth + 1, container);
      }
      if (ts.isParameter(owner)) {
        const property = (declaration.propertyName ?? declaration.name).getText(this.file);
        return this.parameterCompliant(owner, property, depth + 1, container);
      }
      return `\`${name}\` is bound by a pattern this analysis cannot trace`;
    }
    if (ts.isParameter(declaration)) {
      return this.parameterCompliant(declaration, null, depth + 1, container);
    }
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
      return `\`${name}\` is imported, so its provenance is outside this file`;
    }
    return `\`${name}\` resolves to a ${ts.SyntaxKind[declaration.kind]}, which this analysis cannot trace`;
  }

  /**
   * A parameter is caller data by default. The two ways it is not:
   *
   *   - it is the element of something compliant (an array method's callback), or
   *   - it is a prop of a component declared IN THIS FILE and never exported, in
   *     which case every call site is in this file and can be read.
   *
   * `children` is compliant by construction of the sweep: JSX children passed at
   * a call site are themselves printed sites, so they were already checked where
   * they were written.
   */
  private parameterCompliant(
    parameter: ts.ParameterDeclaration,
    property: string | null,
    depth: number,
    container: boolean,
  ): string | null {
    const argument = this.bound.get(parameter);
    if (argument !== undefined) return this.compliant(argument, depth, container);
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);

    const call = arrayCallbackHost(fn);
    if (call !== undefined && ts.isPropertyAccessExpression(call.expression)) {
      /* Parameter 0 is the element; 1 is the index and 2 is the array itself. */
      /* The receiver is a CONTAINER: what is printed is an element of it, so the
         type narrowing that asks "can this be a string" would pass an array of
         caller strings on the grounds that an array is not a string. */
      if (index === 0) return this.compliant(call.expression.expression, depth, true);
      if (index === 1) return null;
      return this.compliant(call.expression.expression, depth, true);
    }

    if (property === 'children') return null;

    const owner = componentName(fn, this.file);
    if (owner === undefined) {
      return 'a parameter of a function this analysis cannot name; its call sites cannot be enumerated';
    }
    if (this.exported.has(owner)) {
      return `\`${property ?? owner}\` is a prop of the exported \`${owner}\`, so any caller supplies it — it needs a door on the render path`;
    }
    if (property === null) {
      return `a positional parameter of \`${owner}\` — this analysis only traces props by name`;
    }

    const sites = this.jsxCallSites(owner);
    if (sites.length === 0) {
      return `\`${owner}\` is declared here and rendered nowhere in this file, so \`${property}\` has no call site to read`;
    }
    for (const site of sites) {
      for (const attribute of site.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          return `\`${owner}\` is rendered with a spread, so what reaches \`${property}\` cannot be read from the call site`;
        }
      }
      const attribute = site.attributes.properties.find(
        (candidate): candidate is ts.JsxAttribute =>
          ts.isJsxAttribute(candidate) && candidate.name.getText(this.file) === property,
      );
      if (attribute === undefined) continue;
      const initializer = attribute.initializer;
      if (initializer === undefined) continue;
      if (ts.isStringLiteral(initializer)) continue;
      if (ts.isJsxExpression(initializer)) {
        if (initializer.expression === undefined) continue;
        /* THE CALL-SITE VALUE IS A CONTAINER WHEN A PROPERTY OF IT IS PRINTED.
           Round 7 shipped this in value mode and it emptied the sweep of every
           LOCAL component: `<ProvenanceRow entry={entry}/>` passes a
           `ProvenanceEntry`, the type narrowing asked "can a ProvenanceEntry be
           a string", found that it cannot, and passed — so `{note}`,
           `{entry.heading}`, `{entry.tag.label}` and `{facts}`, the four sinks
           this whole file exists for, all reported clean. Caught by running the
           sweep against r6, where it found 53 of the 68 it should have. */
        const why = this.compliant(initializer.expression, depth, container);
        if (why !== null) return why;
        continue;
      }
      return `\`${owner}\`'s \`${property}\` is passed a value this analysis cannot trace`;
    }
    return null;
  }

  private jsxCallSites(name: string): readonly (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] {
    const out: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(this.file) === name) {
        out.push(node);
      } else if (ts.isJsxOpeningElement(node) && node.tagName.getText(this.file) === name) {
        out.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(this.file);
    return out;
  }

  /** Lexical lookup, innermost scope out. Deliberately syntactic — see the header. */
  private declarationOf(id: ts.Identifier): ts.Declaration | undefined {
    const name = id.getText(this.file);
    let scope: ts.Node | undefined = id.parent;
    while (scope !== undefined) {
      const found = declarationIn(scope, name, this.file);
      if (found !== undefined) return found;
      scope = scope.parent;
    }
    return undefined;
  }
}

/* --- syntax helpers ------------------------------------------------------- */

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function rootIdentifier(node: ts.PropertyAccessExpression): ts.Identifier | undefined {
  let current: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}

function declaredTypeNode(declaration: ts.Declaration, name: string): ts.TypeNode | undefined {
  if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) return declaration.type;
  if (ts.isBindingElement(declaration)) {
    const owner = declaration.parent.parent;
    if (ts.isParameter(owner) && owner.type !== undefined) {
      return memberTypeNode(owner.type, name);
    }
    if (ts.isVariableDeclaration(owner) && owner.type !== undefined) {
      return memberTypeNode(owner.type, name);
    }
  }
  return undefined;
}

function memberTypeNode(type: ts.TypeNode, name: string): ts.TypeNode | undefined {
  if (ts.isTypeLiteralNode(type)) {
    for (const member of type.members) {
      if (ts.isPropertySignature(member) && member.name.getText() === name) return member.type;
    }
  }
  return undefined;
}

/** The `xs.map(cb)` (or filter/find/…) a callback belongs to, if any. */
function arrayCallbackHost(fn: ts.SignatureDeclarationBase): ts.CallExpression | undefined {
  const parent = fn.parent;
  if (parent === undefined || !ts.isCallExpression(parent)) return undefined;
  if (!parent.arguments.includes(fn as unknown as ts.Expression)) return undefined;
  if (!ts.isPropertyAccessExpression(parent.expression)) return undefined;
  return ELEMENT_METHODS.has(parent.expression.name.getText()) ? parent : undefined;
}

/** The name a function-like was declared under, when it has one. */
function componentName(fn: ts.SignatureDeclarationBase, file: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return fn.name.getText(file);
  const parent = fn.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.getText(file);
  }
  return undefined;
}

function declarationIn(
  scope: ts.Node,
  name: string,
  file: ts.SourceFile,
): ts.Declaration | undefined {
  if (ts.isSourceFile(scope)) {
    for (const statement of scope.statements) {
      const found = fromStatement(statement, name, file);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (ts.isBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    for (const statement of scope.statements) {
      const found = fromStatement(statement, name, file);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      const found = fromBinding(parameter.name, name, file, parameter);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return undefined;
}

function fromStatement(
  statement: ts.Statement,
  name: string,
  file: ts.SourceFile,
): ts.Declaration | undefined {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      const found = fromBinding(declaration.name, name, file, declaration);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (ts.isFunctionDeclaration(statement) && statement.name?.getText(file) === name) {
    return statement;
  }
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return undefined;
    if (clause.name?.getText(file) === name) return clause;
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.name.getText(file) === name) return element;
      }
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      if (bindings.name.getText(file) === name) return bindings;
    }
  }
  return undefined;
}

function fromBinding(
  binding: ts.BindingName,
  name: string,
  file: ts.SourceFile,
  owner: ts.Declaration,
): ts.Declaration | undefined {
  if (ts.isIdentifier(binding)) return binding.getText(file) === name ? owner : undefined;
  for (const element of binding.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      if (element.name.getText(file) === name) return element;
      continue;
    }
    const nested = fromBinding(element.name, name, file, element);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function exportedNames(file: ts.SourceFile): ReadonlySet<string> {
  const out = new Set<string>();
  for (const statement of file.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      out.add(statement.name.getText(file));
    }
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) out.add(declaration.name.getText(file));
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          out.add((element.propertyName ?? element.name).getText(file));
        }
      }
    }
  }
  return out;
}

interface PrintedSite {
  readonly expression: ts.Expression;
  readonly where: string;
}

/* ---------------------------------------------------------------------------
 * THE NODE-TYPE DENOMINATOR — r8 D4.
 *
 * Round 7 enumerated two shapes: a JSX expression in CHILD position, and six
 * announced attributes. Everything else the platform prints was outside the
 * count, and the r8 blind review measured each of these against the shipped
 * analyser and found it unreported:
 *
 *   - `children={x}` written as a JSX ATTRIBUTE. React renders it exactly as it
 *     renders nested children; the analyser only looked at child position.
 *   - `dangerouslySetInnerHTML` — LIVE at `app/layout.tsx:39`, and benign there
 *     only because the value happens to be a module constant. The widest sink on
 *     the platform and it was not in the sink set.
 *   - `aria-roledescription`, `aria-placeholder`, `aria-keyshortcuts` — three
 *     more strings a screen reader speaks.
 *   - `label=` / `value=` on `<optgroup>` and `<option>`, which the user agent
 *     paints.
 *   - `React.createElement(tag, null, x)` — the same tree, written the other way.
 *     The whole analysis keyed on JSX syntax.
 *   - any `data-*`, printable by a CSS rule using `content: attr(…)`.
 *
 * The control the review ran alongside them — `title={p.free}` — WAS reported, so
 * this was a hole in the shape list and not in the dataflow.
 *
 * The attribute half now comes from `model/printed-surface.ts`, shared with the
 * runtime door. The `data-*` half cannot come from a list at all: whether one is
 * printed is a fact about a STYLESHEET, so `printed-strings.test.tsx` derives it
 * from the app's own CSS and passes it in. `createElement` is handled here.
 * ------------------------------------------------------------------------- */

/**
 * `data-*` attributes a CSS rule in this app prints with `content: attr(…)`.
 * Empty by default, and supplied by the sweep from the stylesheets — a list
 * written here would be a claim about CSS made in TypeScript.
 */
let cssPrintedAttributes: ReadonlySet<string> = new Set();

export function setCssPrintedAttributes(names: Iterable<string>): void {
  cssPrintedAttributes = new Set([...names].map((name) => name.toLowerCase()));
}

/** Every attribute name a `content: attr(…)` in this stylesheet source prints. */
export function attributesPrintedByCss(css: string): readonly string[] {
  const out = new Set<string>();
  for (const hit of css.matchAll(/\battr\(\s*([-\w]+)/g)) {
    const name = hit[1];
    if (name !== undefined) out.add(name.toLowerCase());
  }
  return [...out].sort();
}

/** The tag an attribute sits on, when it is an intrinsic one. */
function hostTag(attribute: ts.JsxAttribute): string | undefined {
  const owner = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(owner) && !ts.isJsxSelfClosingElement(owner)) return undefined;
  const name = owner.tagName.getText();
  /* An intrinsic element is lowercase; anything else is a component, and a
     component's `value` prop is not an `<option>`'s. */
  return /^[a-z]/.test(name) ? name : undefined;
}

/** Every place THIS node puts a string in front of a reader. */
function printedSites(node: ts.Node): readonly PrintedSite[] {
  if (ts.isJsxExpression(node)) {
    const parent = node.parent;
    if (parent === undefined) return [];
    if (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) return [];
    if (node.expression === undefined) return [];
    return [{ expression: node.expression, where: 'children' }];
  }
  if (ts.isJsxAttribute(node)) {
    const name = node.name.getText();
    const initializer = node.initializer;
    if (initializer === undefined) return [];
    /* `children={x}` and `dangerouslySetInnerHTML={{__html: x}}` are CONTENT
       wearing an attribute's clothes. The second one is reported as a site in
       its own right whatever its value: writing into the document by string is
       the one sink where "traced to a literal" is the only acceptable answer,
       and the analysis says so by looking at `__html`. */
    if (CHILDREN_PROPS.includes(name)) {
      if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) return [];
      const inner = innerHtmlValue(initializer.expression) ?? initializer.expression;
      return [{ expression: inner, where: name === 'children' ? 'children' : name }];
    }
    if (!announcesText(name, hostTag(node)) && !cssPrintedAttributes.has(name.toLowerCase())) {
      return [];
    }
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
      return [{ expression: initializer.expression, where: name }];
    }
    return [];
  }
  /* `React.createElement(tag, props, …children)` — the same tree, written the
     other way. The analyser keyed on JSX syntax, so a file that reached for the
     function form was outside the count entirely. */
  if (ts.isCallExpression(node)) return createElementSites(node);
  return [];
}

/** The `__html` of a `dangerouslySetInnerHTML` object literal, when it is one. */
function innerHtmlValue(expression: ts.Expression): ts.Expression | undefined {
  if (!ts.isObjectLiteralExpression(expression)) return undefined;
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (property.name.getText().replace(/['"]/g, '') !== '__html') continue;
    return property.initializer;
  }
  return undefined;
}

function isCreateElement(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.getText() === 'createElement';
  if (ts.isPropertyAccessExpression(callee)) return callee.name.getText() === 'createElement';
  return false;
}

function createElementSites(call: ts.CallExpression): readonly PrintedSite[] {
  if (!isCreateElement(call.expression)) return [];
  const out: PrintedSite[] = [];
  const [type, props, ...children] = call.arguments;
  const tag =
    type !== undefined && ts.isStringLiteral(type) && /^[a-z]/.test(type.text)
      ? type.text
      : undefined;
  if (props !== undefined && ts.isObjectLiteralExpression(props)) {
    for (const property of props.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText().replace(/['"]/g, '');
      if (CHILDREN_PROPS.includes(name)) {
        out.push({
          expression: innerHtmlValue(property.initializer) ?? property.initializer,
          where: name === 'children' ? 'children' : name,
        });
        continue;
      }
      if (!announcesText(name, tag) && !cssPrintedAttributes.has(name.toLowerCase())) continue;
      out.push({ expression: property.initializer, where: name });
    }
  }
  for (const child of children) {
    if (ts.isSpreadElement(child)) {
      out.push({ expression: child.expression, where: 'children' });
      continue;
    }
    out.push({ expression: child, where: 'children' });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * THE PAYLOAD DOOR'S BOUND — r8 D3, AND THE BOUND WAS NOT THE BOUND.
 *
 * `offeredText` is the weaker door: it keeps its pronouns, because round 4
 * already shipped the mistake of refusing "Keep it behind our retention window"
 * on a button. CONVENTIONS states the bound as "the offered exemption belongs to
 * a CONTROL and not to whoever reaches for the laxer function", and round 7
 * implemented it as
 *
 *   containsTag(enclosingFunction(call), CONTROLS)
 *
 * which asks "does the function this call sits in render a control ANYWHERE" —
 * a question about the FILE, not about the STRING. Measured on r7:
 * `title={offeredText(item.title, 'AttentionCard summary')}` on the `<article>`
 * passed, including the test literally named "the payload door is only used on
 * the copy of a control", with the suite green at 408. Quantified with the
 * test's own predicate, 23 of the 52 strong-door call sites sat in a function
 * that would have accepted `offeredText` just as readily.
 *
 * And the test's comment promised a second clause — "Asserted as the list below"
 * — under `const renders = owner !== undefined && containsTag(…) && true;`.
 * THERE WAS NO LIST BELOW, and `&& true` is what a deleted clause leaves behind.
 *
 * So the bound is re-stated as a question about the STRING'S DESTINATION, and it
 * has exactly two accepted shapes. Both are needed and both are narrow:
 *
 *   LEXICAL — the call sits inside a control element's subtree, as its child or
 *   as one of its attributes. This is five of the seven shipped sites.
 *
 *   NAMED BY A CONTROL — the call's value reaches an element whose `id` a
 *   control references through `aria-labelledby`/`aria-describedby`. `HoldToAct`
 *   paints its contract line into an `.srOnly` span that the button points at,
 *   which is the accessible description of that button and nothing else's. A
 *   rule that could not see that would push the copy back inside the control and
 *   make the page worse to satisfy a test.
 *
 * A call whose result flows through a `const` is followed to EVERY use of that
 * const, and every one of them has to satisfy one of the two. `HoldToAct`
 * composes `spoken` and `contract` at the top of the component and paints them
 * in three places; that is one-checked-read discipline, not a loophole, and it
 * is admissible precisely because all three places are checked.
 *
 * WHAT THIS ENUMERATES FROM: the file's own syntax tree. WHAT EXECUTES THAT IT
 * DOES NOT SEE: a const exported and used in another file (there are none —
 * every `offeredText` result is consumed in the function that computed it, and
 * `printed-strings.test.tsx` asserts the shipped host list), and a control
 * assembled at runtime from a variable tag.
 * ------------------------------------------------------------------------- */

/** Tags that ARE a control: something a person presses. */
export const CONTROL_TAGS: ReadonlySet<string> = new Set([
  'button',
  'HoldToAct',
  'a',
  'summary',
  'input',
]);

/** Attributes by which a control claims another element's text as its own. */
const NAMING_ATTRIBUTES: readonly string[] = ['aria-labelledby', 'aria-describedby'];

export interface OfferedSite {
  readonly line: number;
  readonly expr: string;
  /** the control this string is the copy of, or `null` when it is not one's */
  readonly host: string | null;
}

/** Every `offeredText` call in this file, each bound to the control it serves. */
export function offeredCallSites(file: ts.SourceFile): readonly OfferedSite[] {
  const named = idsNamedByControls(file);
  const out: OfferedSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.getText(file) === 'offeredText'
    ) {
      out.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        expr: oneLine(node.getText(file)),
        host: hostOf(node, file, named),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** Identifiers a control points at with `aria-labelledby`/`aria-describedby`. */
function idsNamedByControls(file: ts.SourceFile): ReadonlySet<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening !== undefined && CONTROL_TAGS.has(opening.tagName.getText(file))) {
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        if (!NAMING_ATTRIBUTES.includes(attribute.name.getText(file))) continue;
        collectIdentifiers(attribute, file, out);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

function collectIdentifiers(root: ts.Node, file: ts.SourceFile, into: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) into.add(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/** The JSX elements a node sits inside, innermost first. */
function jsxAncestors(node: ts.Node): readonly (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] {
  const out: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isJsxSelfClosingElement(current) || ts.isJsxOpeningElement(current)) out.push(current);
    else if (ts.isJsxElement(current)) out.push(current.openingElement);
    current = current.parent;
  }
  return out;
}

/** The control a value printed HERE is the copy of, or null. */
function directHost(node: ts.Node, file: ts.SourceFile, named: ReadonlySet<string>): string | null {
  for (const element of jsxAncestors(node)) {
    const tag = element.tagName.getText(file);
    if (CONTROL_TAGS.has(tag)) return `<${tag}>`;
    for (const attribute of element.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue;
      if (attribute.name.getText(file) !== 'id') continue;
      const ids = new Set<string>();
      collectIdentifiers(attribute, file, ids);
      for (const id of ids) {
        if (id !== 'id' && named.has(id)) return `<${tag} id={${id}}> named by a control`;
      }
    }
  }
  return null;
}

function hostOf(
  call: ts.CallExpression,
  file: ts.SourceFile,
  named: ReadonlySet<string>,
): string | null {
  const here = directHost(call, file, named);
  if (here !== null) return here;

  /* THE VALUE FLOWS THROUGH A CONST. Follow it to every use, and require every
     one of them to land on a control — an alias whose uses are not all checked
     is an alias that launders the door. */
  const declaration = enclosingConst(call);
  if (declaration === undefined || !ts.isIdentifier(declaration.name)) return null;
  const owner = enclosingFunctionOf(declaration);
  if (owner === undefined) return null;
  const name = declaration.name.getText(file);
  const uses = usesOf(name, owner, declaration, file);
  if (uses.length === 0) return null;
  const hosts = new Set<string>();
  for (const use of uses) {
    const host = directHost(use, file, named);
    if (host === null) return null;
    hosts.add(host);
  }
  return [...hosts].sort().join(' + ');
}

/** The `const x = …` a node sits in the initialiser of, without crossing a function. */
function enclosingConst(node: ts.Node): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return undefined;
    if (ts.isVariableDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function enclosingFunctionOf(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** Every read of `name` inside `owner`, other than the declaration's own name. */
function usesOf(
  name: string,
  owner: ts.Node,
  declaration: ts.VariableDeclaration,
  file: ts.SourceFile,
): readonly ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.getText(file) === name && node !== declaration.name) {
      /* A property NAME is not a read of the variable. */
      const parent = node.parent;
      const isMemberName =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isMemberName) out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(owner);
  return out;
}
