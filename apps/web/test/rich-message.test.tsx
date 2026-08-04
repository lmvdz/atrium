import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichMessageBody } from '../src/components';
import { AttributionLedger } from '../src/components/model/ledger';
import type { MessageRecord } from '../src/components/model/quotation';
import { quotationFrom } from '../src/components/model/quotation';

function rich(source: string) {
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
      <RichMessageBody citation={citation} />
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
});
