/* ---------------------------------------------------------------------------
 * THE FOOTER'S CONTRACT IS IMPLEMENTED.
 *
 * Round 2's gauntlet: the composer printed "↵ send · ⇧↵ newline" with
 * `onKeyDown` undefined, no `value`/`onChange`/ref seam, and an
 * `onSend?: () => void` that took no argument. A consumer could not implement
 * the sentence the component was printing without forking the file — the same
 * species as round 1's `data-hold`, where the label promised a safety the code
 * never had. A contract in the copy needs an implementation or a way for a
 * consumer to add one; this had neither.
 * ------------------------------------------------------------------------- */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Composer } from '../src/components';
import type { ComposerBinding } from '../src/components/model';

afterEach(cleanup);

const FREE: ComposerBinding = { mode: 'free' };
const FOOT = '↵ send · ⇧↵ newline';

function box(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

describe('the composer keeps the promise its footer prints', () => {
  /* CATCHES the exact defect: a footer that says Enter sends while nothing
     handles Enter. If this fails, the copy is a claim about behaviour that does
     not exist. */
  it('Enter sends the draft, and the draft is what arrives', () => {
    const sent: string[] = [];
    render(
      <Composer
        binding={FREE}
        footNote={FOOT}
        onSend={(draft) => sent.push(draft)}
        roomName="users-migration"
      />,
    );
    fireEvent.change(box(), { target: { value: 'hold the cutover' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent).toEqual(['hold the cutover']);
  });

  /* CATCHES: `onSend` going back to a no-argument callback. A send handler that
     is not told what was typed cannot send anything — which is what made the
     footer unimplementable rather than merely unimplemented. */
  it('the send button hands over the draft too', () => {
    const sent: string[] = [];
    render(
      <Composer
        binding={FREE}
        footNote={FOOT}
        onSend={(draft) => sent.push(draft)}
        roomName="users-migration"
      />,
    );
    fireEvent.change(box(), { target: { value: 'typed, therefore quotable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toEqual(['typed, therefore quotable']);
  });

  /* CATCHES: the other half of the same sentence. ⇧↵ is a newline, so it must
     not send — a composer that sends on every Enter cannot write two lines. */
  it('Shift+Enter does not send', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.change(box(), { target: { value: 'first line' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(sent).toEqual([]);
  });

  /* CATCHES: sending emptiness. An empty message is not a message, and the row
     it would produce would carry a quotation minted from nothing. */
  it('an empty or whitespace draft sends nothing', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent).toEqual([]);
  });

  /* CATCHES: the seam disappearing again. #25 and #27 own the draft; without
     `value`/`onChange` they would have to fork this file to hold it. */
  it('a controlled consumer owns the draft', () => {
    const changes: string[] = [];
    const { rerender } = render(
      <Composer
        binding={FREE}
        footNote={FOOT}
        onChange={(draft) => changes.push(draft)}
        roomName="r"
        value="from the consumer"
      />,
    );
    expect(box().value).toBe('from the consumer');
    fireEvent.change(box(), { target: { value: 'edited' } });
    expect(changes).toEqual(['edited']);
    // the component does not hold it: the value only moves when the consumer moves it
    expect(box().value).toBe('from the consumer');
    rerender(
      <Composer
        binding={FREE}
        footNote={FOOT}
        onChange={(draft) => changes.push(draft)}
        roomName="r"
        value="edited"
      />,
    );
    expect(box().value).toBe('edited');
  });

  /* CATCHES: a controlled composer sending the stale element value rather than
     the value the consumer holds. */
  it('a controlled draft is what gets sent', () => {
    const sent: string[] = [];
    render(
      <Composer
        binding={FREE}
        footNote={FOOT}
        onChange={() => undefined}
        onSend={(draft) => sent.push(draft)}
        roomName="r"
        value="the consumer's words"
      />,
    );
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent).toEqual(["the consumer's words"]);
  });

  /* CATCHES: the built-in Enter handling being unoverridable. A consumer that
     wants the key for itself — a slash-command palette, say — must be able to
     take it, which is what `preventDefault` means. */
  it("a consumer's own onKeyDown runs first and can take the key", () => {
    const sent: string[] = [];
    const keys: string[] = [];
    render(
      <Composer
        binding={FREE}
        footNote={FOOT}
        onKeyDown={(event) => {
          keys.push(event.key);
          event.preventDefault();
        }}
        onSend={(draft) => sent.push(draft)}
        roomName="r"
      />,
    );
    fireEvent.change(box(), { target: { value: '/help' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(keys).toEqual(['Enter']);
    expect(sent).toEqual([]);
  });

  /* CATCHES: the ref seam being dropped. Focus management belongs to the
     consumer — binding a reply should put the cursor in the box — and that
     needs the element. */
  it('the textarea ref reaches the consumer', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Composer binding={FREE} footNote={FOOT} roomName="r" textareaRef={ref} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe('TEXTAREA');
  });

  /* CATCHES: the copy and the behaviour drifting apart in the other direction —
     the footer being edited to promise something else. The sentence on screen
     is the sentence this file tests. */
  it('the footer still prints the contract these tests hold it to', () => {
    render(<Composer binding={FREE} footNote="x" roomName="r" />);
    expect(screen.getByText(/send/).textContent?.replace(/\s+/g, ' ')).toContain('↵ send · ⇧↵');
  });
});
