'use client';

/* MESSAGE TEXT — inline rendering of a chat body.
 *
 * #151 marriage table: mentions/rich text is **bind-shipped** — the shipped
 * `MessageBody` wins and the prototype's hand-rolled `RichText` regex is
 * DELETED. `MessageBody` is the same primitive `TimelineRow` paints a real
 * message through, and its output goes through the covenant's attribution door
 * (`segmentText`), which is why it is exempt from the printed-strings guard the
 * prototype's `RichText` tripped.
 *
 * The design keeps ONE thing the shipped primitive has no segment for: the
 * `==highlight==` mark. That is a design-CSS affordance, not message logic, so
 * per the marriage rule ("the design contributes CSS/interaction language") the
 * highlight is preserved here as a `<mark>` and everything else is delegated to
 * `MessageBody`.
 *
 * SEAM(#155): today the body arrives as a plain string and is adapted to
 * `BodySegment[]` by `toBody` below. When messages arrive as real ledger
 * `MessageRecord`s, the segments come pre-parsed from the record and this
 * adapter is deleted — the `<MessageBody>` call stays. */

import type { ReactNode } from 'react';
import type { BodySegment } from '@/src/components/model/records';
import { MessageBody } from '@/src/components/primitives/MessageBody';
import styles from './prototype.module.css';

/* the prototype's inline conventions: `code`, @mention, ==highlight==.
   Everything but the highlight becomes a shipped BodySegment. */
const TOKEN = /(`[^`]+`|@[\w-]+|==[^=]+==)/g;

/* SEAM(#155): a plain string → shipped `BodySegment[]`. The real feed hands the
   record's own segments; this adapter only exists while the body is a literal. */
function toBody(text: string): BodySegment[] {
  const body: BodySegment[] = [];
  let last = 0;
  let m = TOKEN.exec(text);
  while (m !== null) {
    if (m.index > last) body.push({ kind: 'text', text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) body.push({ kind: 'code', text: tok.slice(1, -1) });
    else if (tok.startsWith('==')) body.push({ kind: 'text', text: tok.slice(2, -2) });
    else body.push({ kind: 'mention', text: tok.slice(1) });
    last = m.index + tok.length;
    m = TOKEN.exec(text);
  }
  if (last < text.length) body.push({ kind: 'text', text: text.slice(last) });
  return body;
}

export function MessageText({ text }: { text: string }) {
  /* split on the design-only highlight; delegate every other run to the shipped
     MessageBody so mentions and code render through the covenant door. */
  const out: ReactNode[] = [];
  const re = /==([^=]+)==/g;
  let last = 0;
  let key = 0;
  let m = re.exec(text);
  while (m !== null) {
    if (m.index > last) {
      const run = text.slice(last, m.index);
      out.push(<MessageBody key={`b${key++}`} body={toBody(run)} />);
    }
    /* the highlighted text still goes through the shipped MessageBody door — the
       `<mark>` is a design-CSS wrapper, it prints no caller string of its own. */
    out.push(
      <mark key={`h${key++}`} className={styles.hl}>
        <MessageBody body={toBody(m[1] ?? '')} />
      </mark>,
    );
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length)
    out.push(<MessageBody key={`b${key++}`} body={toBody(text.slice(last))} />);
  return <>{out}</>;
}
