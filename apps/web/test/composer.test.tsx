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
import * as f from '../app/gallery/fixtures';
import type { RoomFrameProps } from '../app/gallery/RoomFrame';
import { RoomFrame } from '../app/gallery/RoomFrame';
import { Composer } from '../src/components';
import type { ComposerBinding } from '../src/components/model';
import { initials } from '../src/components/model';

afterEach(cleanup);

const FREE: ComposerBinding = { mode: 'free' };
const FOOT = '↵ send · ⇧↵ newline';

/** The gallery's own base frame, so the demo under test is the demo that ships. */
const FRAME: RoomFrameProps = {
  messages: f.RECORDS,
  room: f.ROOM,
  rooms: f.ROOMS,
  humans: f.HUMANS,
  viewer: f.VIEWER,
  viewerNote: 'here · 4 owed to you',
  focused: 'conversation',
  attention: f.ATTENTION,
  trailer: f.TRAILER,
  lastCheck: '12:29',
  entries: f.FRESH_TIMELINE,
  filtered: false,
  objectives: f.OBJECTIVES,
  objects: f.OBJECTS,
  updatedAt: '13:41',
  binding: f.FREE,
  composerNote: 'nothing is inferred from a message unless you bind it',
};

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

  /* ---------------------------------------------------------------------
   * ENTER WHILE AN IME IS COMPOSING IS NOT A SEND.
   *
   * Round 4's gauntlet: `Composer.tsx` never checked `isComposing`, so a CJK
   * user pressing Enter to ACCEPT A CANDIDATE sent the half-composed romaji as
   * a real message — `origin: 'typed'`, quotable, attributed, permanently on
   * their record as words they did not write. It is the no-synthesized-speech
   * invariant reached from the input end. Every CJK user's first keystroke
   * sequence.
   * ------------------------------------------------------------------- */
  it('Enter does not send while an IME is composing', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.change(box(), { target: { value: 'にほんg' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(sent, 'accepting an IME candidate sent a half-composed message').toEqual([]);
    // and the same key AFTER composition ends does send, so this is not a mute
    fireEvent.compositionEnd(box());
    fireEvent.change(box(), { target: { value: '日本語' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent).toEqual(['日本語']);
  });

  /* CATCHES: reading only `isComposing`. Browsers that predate it — and some
     IMEs on Safari — report keyCode 229 and leave `isComposing` false, so a
     check that reads one signal passes on exactly the platforms most likely to
     fail. */
  it('the legacy keyCode 229 composition signal is honoured too', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.change(box(), { target: { value: 'nihongo' } });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    expect(sent).toEqual([]);
  });

  /* CATCHES: the IME guard being placed before the consumer's handler, which
     would take the key away from a consumer that wants every keystroke. */
  it('a consumer still sees the composing keystroke', () => {
    const keys: string[] = [];
    render(
      <Composer
        binding={FREE}
        footNote={FOOT}
        onKeyDown={(event) => keys.push(event.key)}
        roomName="r"
      />,
    );
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(keys).toEqual(['Enter']);
  });

  /* CATCHES: the copy and the behaviour drifting apart in the other direction —
     the footer being edited to promise something else. The sentence on screen
     is the sentence this file tests. */
  it('the footer still prints the contract these tests hold it to', () => {
    render(<Composer binding={FREE} footNote="x" roomName="r" />);
    expect(screen.getByText(/send/).textContent?.replace(/\s+/g, ' ')).toContain('↵ send · ⇧↵');
  });
});

/* ---------------------------------------------------------------------------
 * THE DEMO SHOWS THE WHOLE SEAM, NOT MOST OF IT.
 *
 * Round 3's gauntlet: `RoomFrame` forwarded four of the composer's props and
 * not `onKeyDown`/`textareaRef`. Nobody was forced to fork — the props are on
 * <Composer> — but the frame whose entire job is "here is the library working"
 * showed a narrower library than the one that shipped, which is the same defect
 * as round 2's dead demo at a smaller scale.
 * ------------------------------------------------------------------------- */
describe('the gallery frame forwards every composer seam', () => {
  /* CATCHES: dropping `onKeyDown` or `textareaRef` from RoomFrameHandlers or
     from the <Composer> call. Asserted BEHAVIOURALLY through a rendered frame
     rather than by reading the props table, because a prop that is declared and
     not passed is exactly the shape of the defect. */
  it('a consumer’s key handler and ref reach the textarea through RoomFrame', () => {
    const keys: string[] = [];
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <RoomFrame
        {...FRAME}
        handlers={{
          composerRef: ref,
          onComposerKeyDown: (event) => keys.push(event.key),
        }}
      />,
    );
    const textarea = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(keys, 'RoomFrame drops onKeyDown on the way to the composer').toEqual(['Escape']);
    expect(ref.current, 'RoomFrame drops textareaRef on the way to the composer').toBe(textarea);
  });

  /* CATCHES: the workspace monogram going back to a hardcoded "LV". It is a
     free string beside a derived name — the smallest instance of the defect
     class this whole ticket has been closing — and `initials()` already existed
     and was already used by the rail and the room head. */
  it('the workspace monogram is derived from the viewer, not typed in', () => {
    const mateo = { ...FRAME.viewer, name: 'mateo alvarez' };
    render(<RoomFrame {...FRAME} viewer={mateo} />);
    const you = screen.getByTitle(/^mateo alvarez/);
    expect(you.textContent, 'the monogram does not follow the viewer').toBe(
      initials('mateo alvarez'),
    );
    expect(you.textContent).not.toBe('LV');
  });
});

/* ---------------------------------------------------------------------------
 * THE SEND BUTTON IS A SEND TOO.
 *
 * Round 5's IME guard read the key event, so it covered Enter and left the
 * button — clicking Send while a candidate list was open still put
 * half-composed romaji on the record as `origin: 'typed'`. Found by the
 * round-5 blind review. The invariant is about what reaches the record, not
 * about which control reached it.
 * ------------------------------------------------------------------------- */
describe('nothing sends a half-composed buffer', () => {
  it('the Send button refuses while an IME is composing', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.compositionStart(box());
    fireEvent.change(box(), { target: { value: 'にほんg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent, 'clicking Send mid-composition sent the candidate buffer').toEqual([]);
    // and after composition ends the same click sends
    fireEvent.compositionEnd(box());
    fireEvent.change(box(), { target: { value: '日本語' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toEqual(['日本語']);
  });

  /* CATCHES: the Enter guard being narrowed back to the key event alone. A
     composition that started and has not ended is composing, whatever the
     individual keystroke reports. */
  it('Enter refuses while a composition is open, even without the event flag', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.compositionStart(box());
    fireEvent.change(box(), { target: { value: 'nihongo' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent).toEqual([]);
  });
});
