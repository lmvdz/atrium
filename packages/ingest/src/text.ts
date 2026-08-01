import type { IngestAttachment } from './validate.js';

const BYTE_ORDER_MARK = 0xfeff;

/**
 * A message body is stored **verbatim** — the bytes the source handed us, with
 * nothing rewritten.
 *
 * Round 1 ran bodies through NFC composition and a trailing-whitespace strip.
 * Both are lossy, and the second one is quietly destructive: two trailing
 * spaces are a Markdown hard line break, so stripping them rewrites the
 * author's paragraphing. Round 2 removes all of it.
 *
 * Determinism does not need normalisation. It comes from the source bytes
 * being stable and from canonical *serialisation* — fixed key order, `(ts, id)`
 * message order, no ingestion clock. JSON string escaping carries CR, LF, tabs,
 * combining marks and lone surrogates through unchanged, so a rerun is still
 * byte-identical while the corpus stays faithful to what people actually wrote.
 *
 * This is the identity function. It exists to be *named*: every adapter routes
 * bodies through it, so the guarantee is visible at the call site rather than
 * being an absence someone re-adds a `.trim()` to later.
 */
export function verbatimBody(input: string): string {
  return input;
}

/**
 * Line-ending and BOM normalisation for a *pasted document* that is about to be
 * parsed — not for a message body.
 *
 * The markdown converter splits its input into lines to find speaker headers,
 * so it needs `\r\n` and a leading BOM out of the way to tokenise at all. That
 * is a property of the parser, not of the text it extracts: what ends up in a
 * message body is decided by {@link trimBlockBody}, and everything inside a
 * block survives untouched.
 */
export function normalizeDocument(input: string): string {
  const withoutBom = input.charCodeAt(0) === BYTE_ORDER_MARK ? input.slice(1) : input;
  return withoutBom.replace(/\r\n?/g, '\n');
}

/**
 * Trim the blank lines that separate one transcript block from the next.
 *
 * Only *whole* blank lines go: the leading run before the first content line
 * and the trailing run after the last. Trailing spaces on a content line are
 * content — that is the Markdown hard break round 1 was eating — and interior
 * blank lines are the author's paragraphs.
 */
export function trimBlockBody(input: string): string {
  return input.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

/**
 * Hosts that only ever serve GitHub's own uploads. A link to one of these is a
 * real attachment rather than a citation.
 */
const ATTACHMENT_HOSTS = new Set([
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'media.githubusercontent.com',
]);

/** Hosts that serve uploads under one path prefix and ordinary pages elsewhere. */
const ATTACHMENT_PATHS = new Map<string, readonly string[]>([
  ['github.com', ['/user-attachments/']],
  ['www.github.com', ['/user-attachments/']],
]);

/**
 * Is this URL a GitHub upload?
 *
 * Parsed, not substring-matched. Round 1 asked `url.includes(host)`, which says
 * yes to `https://evil.test/?next=https://user-images.githubusercontent.com/x`
 * and to `https://user-images.githubusercontent.com.evil.test/x` — the host
 * appears in the string in both, and is the actual origin in neither. Comparing
 * `URL.hostname` exactly closes both, and an unparseable URL is simply not one.
 */
export function isAttachmentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (ATTACHMENT_HOSTS.has(host)) return true;
  const prefixes = ATTACHMENT_PATHS.get(host) ?? [];
  return prefixes.some((prefix) => parsed.pathname.startsWith(prefix));
}

/** `![alt](url)` — an inline image. Always an attachment, whatever the host. */
const INLINE_IMAGE = /!\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?[^)]*\)/g;
/** `[text](url)` — an inline link. An attachment only if it points at an upload. */
const INLINE_LINK = /(^|[^!])\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?[^)]*\)/g;
/** `![alt][ref]`, `![alt][]`, `![ref]` — reference-style images. */
const REFERENCE_IMAGE = /!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?/g;
/** `[text][ref]` and `[text][]` — reference-style links. */
const REFERENCE_LINK = /(^|[^!])\[([^\]\n]*)\]\[([^\]\n]*)\]/g;
/** `[ref]: https://url "title"` — a link reference definition. */
const REFERENCE_DEFINITION =
  /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*<?(\S+?)>?[ \t]*(?:"[^"]*"|'[^']*')?[ \t]*$/gm;
const HTML_IMAGE_TAG = /<img\b[^>]*>/gi;
const HTML_SRC = /\bsrc=["']?([^"'\s>]+)["']?/i;
const HTML_ALT = /\balt=["']([^"']*)["']/i;
/** `<https://…>` — a markdown autolink. */
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/g;
/**
 * A URL sitting on its own in prose. GitHub renders a bare upload URL as the
 * upload, so it is an attachment even with no markdown around it. Brackets,
 * quotes and angle brackets terminate the match so this never swallows the
 * closing punctuation of a construct one of the regexes above already handled.
 */
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]+/g;
/** Sentence punctuation is not part of a URL people typed into a paragraph. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function nameFor(alt: string, url: string): string {
  const trimmed = alt.trim();
  if (trimmed !== '') return trimmed;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return decodeURIComponent(last);
  } catch {
    // fall through to the constant below
  }
  return 'attachment';
}

interface Candidate {
  /** Offset in the body, so the output is in order of appearance. */
  at: number;
  alt: string;
  url: string;
}

/** `[ref]: url` definitions, keyed by the normalised label markdown matches on. */
function referenceDefinitions(body: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const match of body.matchAll(REFERENCE_DEFINITION)) {
    const label = (match[1] ?? '').trim().toLowerCase();
    const url = match[2];
    if (label !== '' && url !== undefined && !definitions.has(label)) definitions.set(label, url);
  }
  return definitions;
}

/**
 * Pull attachments out of a body: every embedded image (inline, reference-style
 * or HTML), plus any link, autolink or bare URL that points at a GitHub upload
 * host.
 *
 * Two properties the byte-identity guarantee leans on: results come back in
 * **order of appearance in the body** — round 1 returned them grouped by
 * syntax, so an HTML image could jump ahead of a link that preceded it — and
 * they are deduplicated by URL, first occurrence winning, so the richest name
 * (an author's alt text) beats a later filename fallback for the same file.
 */
export function extractAttachments(body: string): IngestAttachment[] {
  const definitions = referenceDefinitions(body);
  const candidates: Candidate[] = [];
  const add = (at: number, alt: string, url: string, uploadsOnly: boolean): void => {
    if (uploadsOnly && !isAttachmentUrl(url)) return;
    candidates.push({ at, alt, url });
  };

  for (const match of body.matchAll(INLINE_IMAGE)) {
    const [, alt = '', url] = match;
    if (url) add(match.index, alt, url, false);
  }
  for (const match of body.matchAll(INLINE_LINK)) {
    const [, lead = '', alt = '', url] = match;
    if (url) add(match.index + lead.length, alt, url, true);
  }
  for (const match of body.matchAll(REFERENCE_IMAGE)) {
    const [, alt = '', label] = match;
    // `![alt](url)` also matches here; the inline pass already claimed it.
    if (label === undefined && body.startsWith('(', match.index + match[0].length)) continue;
    const key = (label === undefined || label.trim() === '' ? alt : label).trim().toLowerCase();
    const url = definitions.get(key);
    if (url) add(match.index, alt, url, false);
  }
  for (const match of body.matchAll(REFERENCE_LINK)) {
    const [, lead = '', alt = '', label = ''] = match;
    const key = (label.trim() === '' ? alt : label).trim().toLowerCase();
    const url = definitions.get(key);
    if (url) add(match.index + lead.length, alt, url, true);
  }
  for (const match of body.matchAll(HTML_IMAGE_TAG)) {
    const url = HTML_SRC.exec(match[0])?.[1];
    if (url) add(match.index, HTML_ALT.exec(match[0])?.[1] ?? '', url, false);
  }
  for (const match of body.matchAll(AUTOLINK)) {
    const url = match[1];
    if (url) add(match.index, '', url, true);
  }
  for (const match of body.matchAll(BARE_URL)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    if (url) add(match.index, '', url, true);
  }

  candidates.sort((a, b) => a.at - b.at);
  const found = new Map<string, IngestAttachment>();
  for (const candidate of candidates) {
    if (found.has(candidate.url)) continue;
    found.set(candidate.url, { name: nameFor(candidate.alt, candidate.url), url: candidate.url });
  }
  return [...found.values()];
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Normalise an ISO-8601 timestamp to UTC with a `Z` offset.
 *
 * Only offset-bearing input is accepted, on purpose: `new Date('2024-03-01
 * 09:04')` resolves against the *host's* timezone, which would make the output
 * depend on where the CLI ran. Callers starting from an offsetless string must
 * choose an offset themselves before calling this.
 */
export function normalizeTimestamp(value: string): string {
  const trimmed = value.trim();
  if (!ISO_WITH_OFFSET.test(trimmed)) {
    throw new Error(`timestamp is not ISO-8601 with an offset: ${JSON.stringify(value)}`);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`unparseable timestamp: ${JSON.stringify(value)}`);
  }
  return parsed.toISOString();
}
