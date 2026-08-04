import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichMessageBody } from '../src/components';
import { AttributionLedger } from '../src/components/model/ledger';
import type { MessageRecord } from '../src/components/model/quotation';
import { quotationFrom } from '../src/components/model/quotation';
import type { BodySegment } from '../src/components/model/records';

function rich(source: string, body?: readonly BodySegment[]) {
  const record: MessageRecord = {
    id: 'rich-message',
    actor: 'lars',
    at: '12:00',
    origin: 'typed',
    room: 'general',
    text: source,
  };
  const citation = quotationFrom(record);
  if (citation === null) throw new Error('typed record produced no citation');
  return render(
    <AttributionLedger messages={[record]} room="general">
      <RichMessageBody body={body} citation={citation} />
    </AttributionLedger>,
  );
}

describe('lossless rich message rendering', () => {
  /* CATCHES: rendering Markdown through raw HTML, which turns authored input
     into an executable DOM sink. */
  it('renders GFM while refusing authored HTML', () => {
    const source = '**ready**\n\n- [x] tests\n- [ ] deploy\n\n<script>alert(1)</script>';
    const { container } = rich(source);
    expect(screen.getByText('ready').tagName).toBe('STRONG');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.querySelector('script')).toBeNull();
    expect(
      container.querySelector('[data-authored-source]')?.getAttribute('data-authored-source'),
    ).toBe(source);
  });

  /* CATCHES: treating a unified diff as undifferentiated preformatted text. */
  it('renders diff lines with derived addition, removal, and hunk roles', () => {
    const source = '```diff\n@@ -1 +1 @@\n-old\n+new\n```';
    const { container } = rich(source);
    expect(container.querySelector('[data-code-language="diff"]')).not.toBeNull();
    expect(container.textContent).toContain('-old');
    expect(container.textContent).toContain('+new');
  });

  /* CATCHES: flattening harness output back into an undifferentiated code
     fence, which removes the machine-readable distinction the shell uses to
     present terminal, tool, test, and artifact output without rewriting it. */
  it.each([
    ['terminal', 'terminal', '$ pnpm test\n30 passed'],
    ['tool-result', 'tool', '{"path":"src/app.tsx"}'],
    ['test-result', 'test', 'PASS composer.test.tsx'],
    ['artifact', 'artifact', 'report.json\napplication/json'],
  ])('preserves a %s fence as an authored %s block', (language, kind, words) => {
    const source = `\`\`\`${language}\n${words}\n\`\`\``;
    const { container } = rich(source);
    const block = container.querySelector(`[data-structured-code="${kind}"]`);
    expect(block).not.toBeNull();
    expect(block?.getAttribute('data-code-language')).toBe(language);
    expect(block?.textContent).toBe(`${words}\n`);
    expect(
      container.querySelector('[data-authored-source]')?.getAttribute('data-authored-source'),
    ).toBe(source);
  });

  /* CATCHES: selecting a structured mention making the entire message fall
     back to plain inline runs, so surrounding Markdown stops being rich. */
  it('renders Markdown and a certified mention in the same authored body', () => {
    const source = '**Please review** @Grace\n\n```ts\nconst ready = true;\n```';
    const body: readonly BodySegment[] = [
      { kind: 'text', text: '**Please review** ' },
      { kind: 'mention', text: 'Grace' },
      { kind: 'text', text: '\n\n```ts\nconst ready = true;\n```' },
    ];
    const { container } = rich(source, body);
    expect(screen.getByText('Please review').tagName).toBe('STRONG');
    expect(container.querySelector('[data-rich-mention]')?.textContent).toBe('@Grace');
    expect(
      container.querySelector('[data-authored-source]')?.getAttribute('data-authored-source'),
    ).toBe(source);
  });

  /* CATCHES: retaining a language label on a fence while rendering every token
     with the same style, which claims syntax highlighting without performing it. */
  it('tokenizes supported code without changing its authored text', () => {
    const source = '```ts\nconst answer = "yes";\n```';
    const { container } = rich(source);
    const code = container.querySelector('[data-syntax-highlighted="true"]');
    expect(code?.textContent).toBe('const answer = "yes";\n');
    expect(code?.querySelectorAll('[class]').length).toBeGreaterThan(1);
    expect(
      container.querySelector('[data-authored-source]')?.getAttribute('data-authored-source'),
    ).toBe(source);
  });
});
