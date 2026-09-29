/** The right pane: the designer's session, on a screen, in a browser.
 *
 *  The pane is a terminal and not a transcript. A transcript is what you get when the
 *  browser is handed finished lines — it scrolls, it never redraws, and the program on the
 *  far end cannot clear it, colour it or move its cursor, so anything that draws a frame
 *  looks like torn garbage. A terminal is the other contract: the far end owns the screen,
 *  the pane owns nothing but the bytes, and every keystroke the designer makes goes
 *  through unread.
 *
 *  Three things live here, and they are separate on purpose:
 *    - the wire, which is the only thing the two halves have to agree on;
 *    - the screen, which is the terminal: xterm.js, pinned to an exact version in
 *      package.json because a terminal emulator is not a thing to float on whoever
 *      installs next. The screen is xterm.js and not a re-implementation of one: this
 *      pane once kept a hand-written screen that deleted every escape sequence before
 *      writing, which kept the text and lost the terminal — no colour, no cursor
 *      addressing, no clear, no alternate screen, and a TUI drawn in frames it could
 *      not erase. Interpreting the bytes is the terminal's own job, and the bytes reach
 *      it exactly as they left the far end. Both directions are its own: what comes down
 *      is written to it unread, and what goes up is what it said in `onData`.
 *    - `attach`, which wires those to whatever the page actually put on the screen.
 *
 *  Nothing in this file touches a global. It is a browser module, but every DOM thing it
 *  needs is a parameter — including the terminal instance and the element it opens on —
 *  so the same code that runs in the pane runs under the test runner, and what is proved
 *  is the code that ships rather than a copy of it. */

import type { Terminal } from "@xterm/xterm";

// ─── the wire ───────────────────────────────────────────────────────────────────────

/** Up: what the pane has for the session. `keys` is raw — the bytes the emulator made of
 *  what the designer did, which is a press, a paste, a composed character, or the terminal's
 *  own answer to a question the far end asked it.
 *  `prompt` is a whole message the designer composed and sent, which the far side
 *  submits; they are different messages because they are different acts, and a pane that
 *  sent a prompt as keystrokes could not tell a half-typed line from a sent one.
 *
 *  `resize` is neither: it is not something the designer said, it is the window they are
 *  reading in. A pty is opened at a size and keeps drawing at that size until it is told
 *  another one, so a pane whose box changed and said nothing has a far end composing
 *  frames for a screen that is no longer there — wrapped lines, a status bar in the
 *  middle of the pane, a full-screen program redrawing at the wrong width. It goes up the
 *  same wire as the keys because it is the same session, and it is a message of its own
 *  because no sequence of keystrokes can say it.
 *
 *  `restart` is about the session rather than in it, which is why no keystroke can say it
 *  either. A far end wedges — a program that reads no keys, a shell that will not take an
 *  interrupt — and every byte the pane can send goes to the thing that has stopped reading
 *  them. It carries nothing, because there is nothing to say: the session ends and another
 *  opens in its place, and what comes back down is the new one's first frame. */
export type ToSession =
  | { readonly kind: "keys"; readonly data: string }
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number }
  | { readonly kind: "restart" };

/** Down: what the session has for the pane. Output is a chunk of the pty's bytes, escapes
 *  and all — the screen interprets them, because that is what a terminal is. */
export type FromSession =
  | { readonly kind: "output"; readonly chunk: string }
  | { readonly kind: "exit"; readonly code: number };

export const encode = (message: ToSession | FromSession): string => JSON.stringify(message);

/** A count of cells off the wire. Whole and at least one, because a pty resized to nought
 *  columns is a pty nothing can draw on, and a fraction of a column is not a thing. */
const whole = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** A frame off the wire, or null if it is not one. Null rather than a throw: a socket can
 *  be handed anything, and a pane that dies on one bad frame is a pane that dies. */
export function decode(frame: string): ToSession | FromSession | null {
  let read: unknown;
  try {
    read = JSON.parse(frame);
  } catch {
    return null;
  }
  if (read === null || typeof read !== "object") return null;
  const m = read as Record<string, unknown>;
  if (m["kind"] === "keys" && typeof m["data"] === "string") return { kind: "keys", data: m["data"] };
  if (m["kind"] === "prompt" && typeof m["text"] === "string") return { kind: "prompt", text: m["text"] };
  if (m["kind"] === "resize" && whole(m["cols"]) && whole(m["rows"])) {
    return { kind: "resize", cols: m["cols"] as number, rows: m["rows"] as number };
  }
  // Nothing but the word: a restart that carried a field would be a restart something could
  // get wrong, and there is nothing about ending a session to get right.
  if (m["kind"] === "restart") return { kind: "restart" };
  if (m["kind"] === "output" && typeof m["chunk"] === "string") return { kind: "output", chunk: m["chunk"] };
  if (m["kind"] === "exit" && typeof m["code"] === "number") return { kind: "exit", code: m["code"] };
  return null;
}

// ─── keystrokes ─────────────────────────────────────────────────────────────────────

/** There is no key table here, and that is the change this file is about.
 *
 *  There used to be one: a listener on the page's own element read each `keydown` and
 *  translated it — Enter to CR, the arrows to `\x1b[A` and friends, Ctrl-A..Z to the
 *  control codes. It was a second, poorer copy of something the emulator already does, and
 *  a copy that cannot be made right. Four things it got wrong, every one of them a thing
 *  the designer does:
 *    - the arrows under DECCKM. A program that asks for application cursor keys — vim,
 *      readline in some modes, every full-screen thing — is answered `\x1bOA`, not
 *      `\x1b[A`. Only the emulator knows which mode it is in, because only the emulator
 *      read the escape sequence that set it.
 *    - a paste. It arrives as no keydown at all, so nothing went up, and under bracketed
 *      paste it must go up wrapped in `\x1b[200~`/`\x1b[201~` so the far end can tell a
 *      pasted newline from a pressed one.
 *    - a composed character. An IME makes its letter on `compositionend`, and the keydowns
 *      before it are the composition rather than what was typed.
 *    - the terminal's own answers. A far end that asks "what are you?" or "where is your
 *      cursor?" is owed a reply, and no key was pressed to make one.
 *
 *  `attach` below takes `terminal.onData` instead, which is the emulator saying what just
 *  happened in bytes. All four come up that one door, and the pane stays what it is meant
 *  to be: the thing that carries bytes and knows nothing about them. */

// ─── the screen ─────────────────────────────────────────────────────────────────────

/** Where xterm.js opens. Named through xterm's own declaration of `open`, because this
 *  file compiles without the DOM's types and must not guess at an element's shape: the
 *  pane asks for whatever xterm.js says it can open on, and the page gives it that. */
export type Mount = Parameters<Terminal["open"]>[0];

// ─── fitting the screen to the box it is in ─────────────────────────────────────────

/** A box, in pixels. */
export interface Box {
  readonly width: number;
  readonly height: number;
}

/** A screen, in cells. */
export interface Size {
  readonly cols: number;
  readonly rows: number;
}

/** As much of a computed style as a box is measured from: the sides of an element that are
 *  not room. Strings, because that is what a browser hands back, and every one optional
 *  because this is a shape a `CSSStyleDeclaration` happens to have and not one anybody
 *  builds. */
export interface Edges {
  readonly paddingTop?: string;
  readonly paddingRight?: string;
  readonly paddingBottom?: string;
  readonly paddingLeft?: string;
  readonly borderTopWidth?: string;
  readonly borderRightWidth?: string;
  readonly borderBottomWidth?: string;
  readonly borderLeftWidth?: string;
}

/** A length off a computed style, or nought. Nought and not a refusal: a browser answers
 *  `"0px"` for a side with nothing on it, `"medium"` for a border width nobody gave a
 *  length, and nothing at all for a property it does not know — and a measurement that
 *  threw on any of those is a pane that never fits. */
const length = (said: string | undefined): number => Number.parseFloat(said ?? "") || 0;

/** The part of an element's rectangle a cell may be drawn in.
 *
 *  A rectangle is the border box: everything the browser painted, which includes the
 *  padding the design asked for around the screen and any rule drawn round it. Neither is
 *  somewhere the emulator may put a cell. A pane fitted to the whole rectangle is told it
 *  is wider than it is, so the far end composes a column whose right-hand edge is under the
 *  border — a frame drawn to the edge of a screen the reader cannot see the edge of.
 *
 *  Never below nought, because a box smaller than its own trim is a pane so narrow there is
 *  nothing in it, and `fits` has an answer for that already. */
export function roomIn(rect: Box, edges: Edges): Box {
  const spent = (near: string | undefined, far: string | undefined): number =>
    length(near) + length(far);
  return {
    width: Math.max(
      0,
      rect.width - spent(edges.paddingLeft, edges.paddingRight) - spent(edges.borderLeftWidth, edges.borderRightWidth),
    ),
    height: Math.max(
      0,
      rect.height - spent(edges.paddingTop, edges.paddingBottom) - spent(edges.borderTopWidth, edges.borderBottomWidth),
    ),
  };
}

/** What the pane's box holds, in the cells the emulator is drawing now — or null when
 *  there is nothing to apply.
 *
 *  Pixels in, cells out, and nothing else: no element, no emulator and no browser. The
 *  cell is not measured, it is divided out of what is already on the screen — the grid
 *  xterm has drawn is `now.cols` by `now.rows` cells and takes `grid` pixels, so one cell
 *  is `grid.width / now.cols` across. That is the whole trick, and it is why this needs
 *  none of xterm's internals to ask the question the fit addon asks: the emulator has
 *  already told us how big a cell is by drawing some.
 *
 *  Null has three causes and they are one answer — there is no resize to make:
 *    - nothing is drawn yet, so a cell has no size and the division is a guess. A pane
 *      fitted before its first frame would resize to whatever zero divided by zero is.
 *    - the box will not hold a single cell, which is a dock the reader has shut or a
 *      window dragged to nothing. A pty told it is nought columns wide is a pty every
 *      program on it draws garbage into.
 *    - it already fits, which is the common case: the fit runs on every window resize,
 *      and a frame up the wire per pixel of drag is a frame the far end redraws for. */
export function fits(pane: Box, grid: Box, now: Size): Size | null {
  const width = grid.width / now.cols;
  const height = grid.height / now.rows;
  if (!(width > 0) || !(height > 0)) return null;
  const cols = Math.floor(pane.width / width);
  const rows = Math.floor(pane.height / height);
  if (!(cols >= 1) || !(rows >= 1)) return null;
  if (cols === now.cols && rows === now.rows) return null;
  return { cols, rows };
}

// ─── the pane ───────────────────────────────────────────────────────────────────────

/** As much of an element as the pane listens to. */
export interface Listens {
  addEventListener(type: string, handler: (event: never) => void): void;
}

/** The parts of the page this pane drives. Named, so the markup can move without this
 *  file moving with it. */
export interface Parts {
  /** Where xterm.js opens — the screen the far end draws on, owned by the far end. */
  readonly screen: Mount;
  /** What the page lets a reader put the focus on, which is not where the typing happens:
   *  the emulator builds its own focus target inside the screen, and that is the element
   *  the bytes come out of. A page whose screen is focusable in its own right — a `tabindex`
   *  on it, which is how a reader tabs to a terminal — can be focused with the emulator
   *  beside it holding nothing, and then every press goes nowhere. So this is handed the
   *  focus on, once, to the thing that types. It is the screen itself in every page here. */
  readonly keyboard: Listens;
  /** The box a prompt is composed in, and what sending it looks like — the form, or the
   *  button. Both optional, and only useful together: a pane that has no composer has no
   *  send either, and one without the other is a door with nothing behind it.
   *
   *  Optional because the composer is no longer what a pane is. It was there when the
   *  screen was a transcript and a whole line was the only thing that could be said; now
   *  the screen is a terminal, the keyboard reaches the far end a keystroke at a time, and
   *  a second box to type into is a second place the next word might go — the reader types
   *  a line into it, presses enter at the screen, and neither of them has their sentence.
   *  So a pane may simply be a screen, and `pane()` below is one. */
  readonly composer?: { value: string };
  readonly send?: Listens;
}

/** Where the pane sends what it has. */
export type Send = (message: ToSession) => void;

export interface Attached {
  /** Take a frame from the session. */
  readonly receive: (frame: string) => void;
  /** The xterm.js terminal behind the pane, for anything that wants to read or size it. */
  readonly terminal: Terminal;
  /** Fit the screen to the box it is drawn in, and tell the session. Hands back the size
   *  it settled on, or null when there was no resize to make. The two boxes are the
   *  caller's to measure, because measuring an element is the page's business and the
   *  arithmetic is not — and `trim` is the screen's computed style, handed over for the
   *  same reason: a browser reads it, `roomIn` above says what it costs. */
  readonly fit: (pane: Box, grid: Box, trim?: Edges) => Size | null;
}

/** Wire the parts to a session.
 *
 *  What goes up is what the emulator said, unread — the pane does not know what a key means
 *  and must not, because the meaning is the far end's. `onData` is one door for all of it: a
 *  press, a paste, a composed character, and the terminal's own answer to a question the far
 *  end asked. The emulator has already decided what the browser may do with the press that
 *  made it — it defaults-prevents the ones it took and leaves the rest, which is how Cmd-C
 *  still copies out of the pane — so there is nothing for this file to decide either.
 *
 *  The composer is the other door, and a page need not have one. What is typed there is not
 *  keystrokes: it is a prompt, and it reaches the session only when it is sent, at which
 *  point the box is emptied so that a sent prompt cannot be sent twice. A page that hands in
 *  neither is a page whose only way in is the keyboard, and nothing is wired for the door it
 *  does not have — a listener on an element that is not there is the shape of a pane that
 *  quietly does nothing. */
export function attach(parts: Parts, terminal: Terminal, send: Send): Attached {
  terminal.open(parts.screen);

  terminal.onData((data: string) => send({ kind: "keys", data }));

  // …and the focus handed on, so that the emulator is what a reader is typing into. The
  // screen is focusable in its own right and is the element a page names, so it is the one
  // a tab-stop lands on; the emulator's target is inside it and is the one that types.
  parts.keyboard.addEventListener("focus", (() => terminal.focus()) as (event: never) => void);

  const { composer, send: sends } = parts;
  if (composer !== undefined && sends !== undefined) {
    const sendPrompt = ((event?: { preventDefault?: () => void }) => {
      event?.preventDefault?.();
      const text = composer.value;
      if (text.trim() === "") return;
      composer.value = "";
      send({ kind: "prompt", text });
    }) as (event: never) => void;

    // Both, because `send` may be the form or the button inside it, and a button inside a
    // form raises only the form's submit.
    sends.addEventListener("submit", sendPrompt);
    sends.addEventListener("click", sendPrompt);
  }

  return {
    terminal,
    /** Both ends, in one act, in this order: the emulator is resized first so the screen
     *  the reader is looking at is the right shape before the far end starts drawing to
     *  it, and the frame goes up second so what arrives next is drawn at the size that is
     *  already there. Told the other way round, every fit costs one frame of garbage.
     *
     *  The trim comes off before anything is divided, because what a caller measured is a
     *  rectangle and a rectangle is not all room. Absent, nothing comes off — a pane whose
     *  screen the design gives no padding and no border has a box that is already the
     *  whole of it, and saying so is not something a page should have to. */
    fit(pane: Box, grid: Box, trim?: Edges): Size | null {
      const room = trim === undefined ? pane : roomIn(pane, trim);
      const size = fits(room, grid, { cols: terminal.cols, rows: terminal.rows });
      if (size === null) return null;
      terminal.resize(size.cols, size.rows);
      send({ kind: "resize", cols: size.cols, rows: size.rows });
      return size;
    },
    receive(frame: string): void {
      const message = decode(frame);
      if (message === null) return;
      if (message.kind === "output") {
        // Verbatim, because the pane owns the bytes and the terminal owns the meaning.
        terminal.write(message.chunk);
      } else if (message.kind === "exit") {
        // A farewell on a line of its own: CRLF and not a bare LF, because a LF alone moves
        // down without returning and would staircase, and no leading CRLF at all when the
        // far end already ended its own last line.
        const lead = terminal.buffer.active.cursorX === 0 ? "" : "\r\n";
        terminal.write(`${lead}[session left with ${message.code}]\r\n`);
      }
    },
  };
}

/** The ids the markup and this file agree on. One list, so a rename is one edit. */
export const IDS = {
  pane: "session",
  screen: "session-screen",
} as const;

/** The right pane's markup: a screen, and nothing else in it.
 *
 *  A `<div>` for the screen because xterm.js builds its own element inside whatever it is
 *  given — a `<pre>` would only sit between the terminal and its text — and it is focusable
 *  because the designer types into it.
 *
 *  Nothing else, because the pane is the session and the session is the whole of it. The
 *  composer that used to sit under the screen was a box the designer typed a line into and
 *  pressed a button to send, which is what a transcript needs and what a terminal is
 *  instead of: the screen takes the keys itself, one at a time, and the far end's own shell
 *  is what a line is composed in. Two boxes were two answers to where the next word goes,
 *  and the one below could only ever say a whole line — no Ctrl-C, no arrow through the
 *  history, nothing half-typed. With it gone the screen has the pane's whole box, which is
 *  what `fit` above is for: the emulator's grid is however many cells the pane holds, and
 *  the far end is told. */
export const pane = (): string =>
  `<section id="${IDS.pane}" class="pane pane-right">` +
  `<div id="${IDS.screen}" class="screen" tabindex="0" aria-label="the designer's session"></div>` +
  `</section>`;
