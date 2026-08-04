'use client';

import { Highlight, type Language } from 'prism-react-renderer';
import type { ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAttribution } from '../model/ledger';
import type { Quotation } from '../model/quotation';
import type { BodySegment } from '../model/records';
import { segmentText } from '../model/records';
import styles from './rich-message.module.css';

const RICH_BLOCK =
  /(^|\n)(?:#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|~~~|\|.+\|\s*$)|\[[ xX]\]\s|\*\*[^*]+\*\*|~~[^~]+~~|`[^`\n]+`|https?:\/\//m;

type StructuredCodeKind = 'terminal' | 'tool' | 'test' | 'artifact';

const STRUCTURED_CODE_KIND: Readonly<Record<string, StructuredCodeKind>> = {
  artifact: 'artifact',
  bash: 'terminal',
  console: 'terminal',
  sh: 'terminal',
  shell: 'terminal',
  tap: 'test',
  terminal: 'terminal',
  test: 'test',
  'test-result': 'test',
  tool: 'tool',
  'tool-call': 'tool',
  'tool-result': 'tool',
  zsh: 'terminal',
};

const HIGHLIGHT_LANGUAGES = new Set<Language>([
  'bash',
  'css',
  'graphql',
  'java',
  'javascript',
  'js',
  'json',
  'jsx',
  'markup',
  'python',
  'sql',
  'tsx',
  'typescript',
  'yaml',
]);

function tokenClass(types: readonly string[]): string | undefined {
  const tone = [
    'comment',
    'keyword',
    'string',
    'number',
    'function',
    'operator',
    'punctuation',
  ].find((type) => types.includes(type));
  return tone === undefined ? undefined : styles[`syntax${tone[0]?.toUpperCase()}${tone.slice(1)}`];
}

function HighlightedCode({
  source,
  language,
  sourceLanguage,
  citation,
  sourceStart,
  className,
  structuredKind,
  props,
}: {
  readonly source: string;
  readonly language: Language;
  readonly sourceLanguage: string;
  readonly citation: Quotation;
  readonly sourceStart: number;
  readonly className?: string;
  readonly structuredKind?: StructuredCodeKind;
  readonly props: Omit<ComponentPropsWithoutRef<'code'>, 'children' | 'className'>;
}) {
  const terminalNewline = source.endsWith('\n');
  const highlightedSource = terminalNewline ? source.slice(0, -1) : source;
  return (
    <Highlight code={highlightedSource} language={language}>
      {({ tokens }) => (
        <code
          className={[className, structuredKind && styles[structuredKind]]
            .filter(Boolean)
            .join(' ')}
          data-code-language={sourceLanguage}
          data-structured-code={structuredKind}
          data-syntax-highlighted="true"
          {...props}
        >
          {tokens.map((line, lineIndex) => {
            const precedingLines = tokens
              .slice(0, lineIndex)
              .reduce(
                (length, prior) =>
                  length + prior.reduce((n, token) => n + token.content.length, 0) + 1,
                0,
              );
            let withinLine = 0;
            return (
              // Prism's line array is an ordered projection of the immutable source.
              // biome-ignore lint/suspicious/noArrayIndexKey: source-position identity is stable here
              <span key={`line-${lineIndex}`}>
                {line.map((token, tokenIndex) => {
                  const start = sourceStart + precedingLines + withinLine;
                  withinLine += token.content.length;
                  return (
                    <span
                      className={tokenClass(token.types)}
                      // biome-ignore lint/suspicious/noArrayIndexKey: source-position identity is stable here
                      key={`token-${tokenIndex}`}
                    >
                      <SyntaxToken
                        citation={citation}
                        end={start + token.content.length}
                        start={start}
                      />
                    </span>
                  );
                })}
                {lineIndex < tokens.length - 1 ? '\n' : null}
              </span>
            );
          })}
          {terminalNewline ? '\n' : null}
        </code>
      )}
    </Highlight>
  );
}

function SyntaxToken({
  citation,
  start,
  end,
}: {
  readonly citation: Quotation;
  readonly start: number;
  readonly end: number;
}) {
  const source = useAttribution(citation, 'RichMessageBody syntax token').text;
  return <>{source.slice(start, end)}</>;
}

export function hasRichMessageSyntax(source: string): boolean {
  return RICH_BLOCK.test(source);
}

function mentionMarkdown(body: readonly BodySegment[]): string {
  return body
    .map((segment, index) => {
      const words = segmentText(segment);
      if (segment.kind !== 'mention') return words;
      const label = words.replace(/[\\[\]]/g, '\\$&');
      return `[${label}](#atrium-mention-${index})`;
    })
    .join('');
}

function Code({
  citation,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'code'> & { readonly citation: Quotation }) {
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1]?.toLowerCase();
  const source = String(children).replace(/\n$/, '');
  const authored = useAttribution(citation, 'RichMessageBody code').text;
  if (language === 'diff' || language === 'patch') {
    const sourceStart = Math.max(0, authored.indexOf(source));
    let offset = 0;
    return (
      <code className={styles.diff} data-code-language={language} {...props}>
        {source.split('\n').map((line, index) => {
          const localStart = offset;
          const start = sourceStart + localStart;
          const end = start + line.length;
          offset = localStart + line.length + 1;
          const tone =
            line.startsWith('+++') || line.startsWith('---')
              ? styles.diffFile
              : line.startsWith('+')
                ? styles.diffAdd
                : line.startsWith('-')
                  ? styles.diffRemove
                  : line.startsWith('@@')
                    ? styles.diffHunk
                    : undefined;
          return (
            // The immutable source string owns this order; diff lines may be byte-identical.
            // biome-ignore lint/suspicious/noArrayIndexKey: source-position identity is the stable identity here
            <span className={tone} key={`${index}-${line}`}>
              <DiffLine citation={citation} end={end} start={start} />
            </span>
          );
        })}
      </code>
    );
  }
  const structuredKind = language === undefined ? undefined : STRUCTURED_CODE_KIND[language];
  const highlightLanguage = language === 'ts' ? 'typescript' : language;
  if (highlightLanguage !== undefined && HIGHLIGHT_LANGUAGES.has(highlightLanguage as Language)) {
    return (
      <HighlightedCode
        citation={citation}
        className={className}
        language={highlightLanguage as Language}
        props={props}
        source={String(children)}
        sourceLanguage={language ?? highlightLanguage}
        sourceStart={Math.max(0, authored.indexOf(String(children).replace(/\n$/, '')))}
        structuredKind={structuredKind}
      />
    );
  }
  return (
    <code
      className={[className, structuredKind && styles[structuredKind]].filter(Boolean).join(' ')}
      data-code-language={language ?? 'text'}
      data-structured-code={structuredKind}
      {...props}
    >
      {children}
    </code>
  );
}

function DiffLine({
  citation,
  start,
  end,
}: {
  readonly citation: Quotation;
  readonly start: number;
  readonly end: number;
}) {
  const source = useAttribution(citation, 'RichMessageBody diff line').text;
  return <>{source.slice(start, end)}</>;
}

function SafeImage() {
  return <span className={styles.blockedImage}>[remote image blocked]</span>;
}

export function RichMessageBody({
  citation,
  body,
}: {
  readonly citation: Quotation;
  readonly body?: readonly BodySegment[];
}) {
  const source = useAttribution(citation, 'RichMessageBody').text;
  const markdown = body === undefined ? source : mentionMarkdown(body);
  return (
    <div className={styles.rich} data-authored-source={source} data-rich-message="true">
      <Markdown
        components={{
          a: ({ children, href, ...props }) =>
            href?.startsWith('#atrium-mention-') ? (
              <span className={styles.mention} data-rich-mention="true">
                {children}
              </span>
            ) : (
              <a {...props} href={href} rel="noreferrer noopener" target="_blank">
                {children}
              </a>
            ),
          code: (props) => <Code {...props} citation={citation} />,
          img: SafeImage,
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {markdown}
      </Markdown>
    </div>
  );
}
