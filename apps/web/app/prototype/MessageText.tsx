'use client';

/* MESSAGE TEXT — inline rendering of a chat body for the DESIGN shells.
 *
 * #151 marriage table: mentions/rich text is **bind-shipped** — the shipped
 * `MessageBody` wins and the prototype's hand-rolled `RichText` regex is DELETED.
 * The plain conversation rows now render through `TimelineRow` (which uses
 * `MessageBody`/`RichMessageBody` itself). This component survives only for the
 * DESIGN SHELLS the shipped grammar does not yet own — a turn's conclusion prose
 * and an inline-image row (both blocked on #159/attachments) — because those keep
 * the one thing the shipped primitive has no segment for: the `==highlight==`
 * mark, a design-CSS affordance rendered as a `<mark>`.
 *
 * #161's note, handled: a highlight interior that itself contains a backtick or
 * an `@mention` must be tokenized ONCE, correctly. This splits on the highlight
 * FIRST, then hands both the outer runs and each highlight's interior to the ONE
 * lossless tokenizer (`messageBody`, conversation-model.ts) — which uses
 * `matchAll`, not a shared `/g` regex, so no `lastIndex` state carries between the
 * calls. Everything but the highlight goes through the shipped `MessageBody` door.
 */

import type { ReactNode } from 'react';
import { MessageBody } from '@/src/components/primitives/MessageBody';
import { messageBody } from './conversation-model';
import styles from './prototype.module.css';

/* the design-only highlight; `matchAll` gives a fresh iterator, never shared state */
const HIGHLIGHT = /==([^=]+)==/g;

export function MessageText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(HIGHLIGHT)) {
    const index = match.index ?? 0;
    if (index > last) {
      out.push(<MessageBody key={`b${key++}`} body={messageBody(text.slice(last, index))} />);
    }
    /* the highlighted run still goes through the shipped MessageBody door — the
       `<mark>` is a design-CSS wrapper, and its interior is tokenized by the same
       lossless `messageBody`, so a backtick or `@mention` inside it renders as
       code/mention exactly once. */
    out.push(
      <mark key={`h${key++}`} className={styles.hl}>
        <MessageBody body={messageBody(match[1] ?? '')} />
      </mark>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) {
    out.push(<MessageBody key={`b${key++}`} body={messageBody(text.slice(last))} />);
  }
  return <>{out}</>;
}
