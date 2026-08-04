'use client';

import type { ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAttribution } from '../model/ledger';
import type { Quotation } from '../model/quotation';
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

export function hasRichMessageSyntax(source: string): boolean {
  return RICH_BLOCK.test(source);
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

export function RichMessageBody({ citation }: { readonly citation: Quotation }) {
  const source = useAttribution(citation, 'RichMessageBody').text;
  return (
    <div className={styles.rich} data-authored-source={source} data-rich-message="true">
      <Markdown
        components={{
          a: ({ children, ...props }) => (
            <a {...props} rel="noreferrer noopener" target="_blank">
              {children}
            </a>
          ),
          code: (props) => <Code {...props} citation={citation} />,
          img: SafeImage,
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {source}
      </Markdown>
    </div>
  );
}
