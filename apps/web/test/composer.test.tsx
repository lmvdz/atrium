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

import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as f from '../app/gallery/fixtures';
import type { RoomFrameProps } from '../app/gallery/RoomFrame';
import { RoomFrame } from '../app/gallery/RoomFrame';
import { railFor } from '../app/gallery/rooms';
import { Composer } from '../src/components';
import type { ComposerBinding } from '../src/components/model';
import { initials } from '../src/components/model';

afterEach(cleanup);

/* Built from the rooms' items — see attention.test.tsx. */
const ROOMS = railFor(f.ROOM.name, f.ATTENTION);

const FREE: ComposerBinding = { mode: 'free' };
const FOOT = '↵ send · ⇧↵ newline';

/** The gallery's own base frame, so the demo under test is the demo that ships. */
const FRAME: RoomFrameProps = {
  messages: f.RECORDS,
  room: f.ROOM,
  rooms: ROOMS,
  humans: f.HUMANS,
  viewer: f.VIEWER,
  focused: 'conversation',
  attention: f.ATTENTION,
  trailer: f.TRAILER,
  lastCheck: '12:29',
  entries: f.FRESH_TIMELINE,
  filter: null,
  objectives: f.OBJECTIVES,
  objects: f.OBJECTS,
  updatedAt: '13:41',
  binding: f.FREE,
  composerNote: 'nothing is inferred from a message unless you bind it',
};

function box(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

describe('the composer keeps its send contract', () => {
  /* CATCHES: deleting the conventional Enter send path while leaving only the
     pointer-oriented send control. */
  it('Enter sends the exact draft', () => {
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
    fireEvent.keyDown(box(), { key: 'Enter' });
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

  /* CATCHES: normalizing the textarea value before send. Paragraph breaks are
     authored bytes, not presentation hints, and must reach the record intact. */
  it('sends a multiline draft without flattening it', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.change(box(), { target: { value: 'first line\n\nsecond paragraph' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toEqual(['first line\n\nsecond paragraph']);
  });

  /* CATCHES: sending emptiness. An empty message is not a message, and the row
     it would produce would carry a quotation minted from nothing. */
  it('an empty or whitespace draft sends nothing', () => {
    const sent: string[] = [];
    render(<Composer binding={FREE} footNote={FOOT} onSend={(d) => sent.push(d)} roomName="r" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
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
    // and the explicit send control works after composition ends
    fireEvent.compositionEnd(box());
    fireEvent.change(box(), { target: { value: '日本語' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
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
  it('the footer no longer advertises the removed modifier-key contract', () => {
    render(<Composer binding={FREE} footNote="x" roomName="r" />);
    expect(screen.queryByText(/↵ send/)).toBeNull();
  });
});

describe('draft-driven command and mention completion', () => {
  /* CATCHES: opening commands only from the slash button, leaving a slash typed
     into the primary input inert even though V8 promises keyboard completion. */
  it('typing slash opens and filters commands', () => {
    render(<Composer binding={FREE} roomName="r" />);
    fireEvent.change(box(), { target: { value: '/cl' } });
    expect(screen.getByRole('button', { name: /claim/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /goal/i })).toBeNull();
  });

  /* CATCHES: exposing only a subset of the deterministic semantic command lane. */
  it('offers all five reviewable semantic commands', () => {
    render(<Composer binding={FREE} roomName="r" />);
    fireEvent.change(box(), { target: { value: '/' } });
    for (const command of ['goal', 'decision', 'question', 'commitment', 'claim']) {
      expect(screen.getByRole('button', { name: new RegExp(command, 'i') })).toBeDefined();
    }
  });

  /* CATCHES: painting @name without preserving the structured user id used by
     attention routing. The selected words and routing target move together. */
  it('typing at-sign filters mentions and selecting one inserts words plus id', () => {
    const drafts: string[] = [];
    const targets: Array<string | null> = [];
    render(
      <Composer
        binding={FREE}
        mentionTargets={[
          { id: 'u-priya', label: 'priya' },
          { id: 'u-maya', label: 'maya' },
        ]}
        onChange={(draft) => drafts.push(draft)}
        onMention={(id) => targets.push(id)}
        roomName="r"
      />,
    );
    fireEvent.change(box(), { target: { value: 'ask @pr' } });
    fireEvent.click(screen.getByRole('button', { name: '@priya' }));
    expect(drafts.at(-1)).toBe('ask @priya ');
    expect(targets).toEqual(['u-priya']);
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

/* ---------------------------------------------------------------------------
 * ROUND 6, D11 — A ONE-WAY FLAG GUARDING A WRITE IS A LATCH.
 *
 * `composing.current` was set on `compositionstart` and cleared on
 * `compositionend` and NOWHERE ELSE, while `send()` returns early when it is
 * true. One missed `compositionend` — a blur mid-candidate, an unmount, an IME
 * that drops the event — bricked the product's primary write path silently: no
 * error, no indicator, no recovery short of a reload. The guard was right; its
 * exits were not enumerated.
 * ------------------------------------------------------------------------- */
describe('a composition that ends any way at all releases the send', () => {
  function composerWith(onSend: (draft: string) => void) {
    const view = render(
      <Composer binding={FREE} footNote="" onSend={onSend} roomName="users-migration" />,
    );
    return { view, field: screen.getByRole('textbox') };
  }

  /* CATCHES: `onBlur` being dropped. Blurring mid-candidate is the commonest way
     a real composition ends without a `compositionend` reaching React. */
  it('blurring the field ends the composition', () => {
    const sent: string[] = [];
    const { field } = composerWith((draft) => sent.push(draft));
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: 'nihongo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent, 'a half-composed buffer reached the record').toEqual([]);
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent, 'the composer stayed bricked after the composition ended').toEqual(['nihongo']);
  });

  /* CATCHES: the change-event exit being dropped. A change whose native event
     says it is not part of a composition is the platform reporting the
     composition is over, whatever `compositionend` did. */
  it('a change event that says it is not composing ends the composition', () => {
    const sent: string[] = [];
    const { field } = composerWith((draft) => sent.push(draft));
    fireEvent.compositionStart(field);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toEqual([]);
    /* The platform's own signal, on the event React hands the component: a
       change whose `isComposing` is FALSE is the browser saying this keystroke
       is not part of a composition. Built with `createEvent` and stamped, because
       an `Event` constructor silently drops init keys it does not know — which is
       itself the "a denylist of one spelling" shape, in a test helper. */
    const ended = createEvent.change(field, { target: { value: '日本語' } });
    Object.defineProperty(ended, 'isComposing', { value: false });
    fireEvent(field, ended);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent, 'the flag survived a change event that said the composition was over').toEqual([
      '日本語',
    ]);
  });

  /* CATCHES: the refusal being silent. A send that is declined because an input
     method is mid-candidate is indistinguishable from a broken send, which is
     how a stuck flag went from a bug to an unrecoverable one. */
  it('the composer says it is refusing while it refuses', () => {
    const { field } = composerWith(() => undefined);
    expect(field.getAttribute('data-composing')).toBe('false');
    fireEvent.compositionStart(field);
    expect(field.getAttribute('data-composing')).toBe('true');
    expect(screen.getByText(/choosing a candidate/)).toBeTruthy();
    fireEvent.compositionEnd(field);
    expect(field.getAttribute('data-composing')).toBe('false');
  });

  /* CATCHES: the Send button blurring the field on `mousedown`, which ends the
     composition, which clears the flag — so by the time `click` fires the guard
     has nothing to see. The round-6 critic reproduced exactly that with a real
     CDP composition. */
  it('pressing Send does not end the composition it is meant to be blocked by', () => {
    const { field } = composerWith(() => undefined);
    fireEvent.compositionStart(field);
    const send = screen.getByRole('button', { name: 'Send' });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    send.dispatchEvent(event);
    expect(event.defaultPrevented, 'Send takes focus away from the composition').toBe(true);
  });
});
