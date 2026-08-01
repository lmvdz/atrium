import type { IngestAttachment } from './validate.js';

const BYTE_ORDER_MARK = 0xfeff;

/**
 * Text normalisation shared by every adapter. Deterministic and lossless in
 * the ways that matter: line endings and Unicode composition are normalised,
 * the body itself is left alone (markdown hard breaks, code indentation and
 * quoted replies all survive).
 */
export function normalizeText(input: string): string {
  const withoutBom = input.charCodeAt(0) === BYTE_ORDER_MARK ? input.slice(1) : input;
  return withoutBom
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

/** GitHub's upload hosts. A link to one of these is a real attachment. */
const ATTACHMENT_HOSTS = [
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'raw.githubusercontent.com',
  'github.com/user-attachments/',
  'objects.githubusercontent.com',
];

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;
const MARKDOWN_LINK = /(^|[^!])\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;
const HTML_IMAGE_TAG = /<img\b[^>]*>/gi;
const HTML_SRC = /\bsrc=["'](https?:\/\/[^"']+)["']/i;
const HTML_ALT = /\balt=["']([^"']*)["']/i;

function isAttachmentHost(url: string): boolean {
  return ATTACHMENT_HOSTS.some((host) => url.includes(host));
}

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

/**
 * Pull attachments out of a markdown body: every embedded image, plus links
 * that point at a GitHub upload host. Order of appearance, deduplicated by
 * URL — both properties the byte-identity guarantee depends on.
 */
export function extractAttachments(body: string): IngestAttachment[] {
  const found = new Map<string, IngestAttachment>();

  const add = (alt: string, url: string): void => {
    if (found.has(url)) return;
    found.set(url, { name: nameFor(alt, url), url });
  };

  for (const match of body.matchAll(MARKDOWN_IMAGE)) {
    const [, alt = '', url] = match;
    if (url) add(alt, url);
  }
  for (const match of body.matchAll(HTML_IMAGE_TAG)) {
    const tag = match[0];
    const url = HTML_SRC.exec(tag)?.[1];
    if (url) add(HTML_ALT.exec(tag)?.[1] ?? '', url);
  }
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const [, , alt = '', url] = match;
    if (url && isAttachmentHost(url)) add(alt, url);
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
