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
 *    - `keyOf` and the screen, which are the terminal — `keyOf` for the keys going up,
 *      and xterm.js for everything coming down, pinned to an exact version in
 *      package.json because a terminal emulator is not a thing to float on whoever
 *      installs next. The screen is xterm.js and not a re-implementation of one: this
 *      pane once kept a hand-written screen that deleted every escape sequence before
 *      writing, which kept the text and lost the terminal — no colour, no cursor
 *      addressing, no clear, no alternate screen, and a TUI drawn in frames it could
 *      not erase. Interpreting the bytes is the terminal's own job, and the bytes reach
 *      it exactly as they left the far end.
 *    - `attach`, which wires those to whatever the page actually put on the screen.
 *
 *  Nothing in this file touches a global. It is a browser module, but every DOM thing it
 *  needs is a parameter — including the terminal instance and the element it opens on —
 *  so the same code that runs in the pane runs under the test runner, and what is proved
 *  is the code that ships rather than a copy of it. */

import type { Terminal } from "@xterm/xterm";

// ─── the wire ───────────────────────────────────────────────────────────────────────

/** Up: what the pane has for the session. `keys` is raw — bytes the keyboard made.
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
 *  because no sequence of keystrokes can say it. */
export type ToSession =
  | { readonly kind: "keys"; readonly data: string }
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number };

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
  if (m["kind"] === "output" && typeof m["chunk"] === "string") return { kind: "output", chunk: m["chunk"] };
  if (m["kind"] === "exit" && typeof m["code"] === "number") return { kind: "exit", code: m["code"] };
  return null;
}

// ─── keystrokes ─────────────────────────────────────────────────────────────────────

/** As much of a `KeyboardEvent` as a terminal cares about. */
export interface Key {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

/** The named keys, and the bytes a terminal sends for them. The arrows are the escape
 *  sequences a program reads to move a cursor; Enter is CR because that is what the key
 *  makes, and Backspace is DEL because that is what a terminal has sent since the vt100.
 *  Getting these wrong is not cosmetic — it is the difference between a session the
 *  designer can drive and one where the arrow keys print letters. */
const NAMED: Readonly<Record<string, string>> = {
  Enter: "\r",
  Tab: "\t",
  Backspace: "\x7f",
  Delete: "\x1b[3~",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

/** The bytes a keypress sends, or "" for a press that sends nothing.
 *
 *  Empty rather than the key's name for the modifiers and the function keys: a lone Shift
 *  press has no bytes, and a pane that sent the string "Shift" would type the word. Meta
 *  is left alone too, because that is the browser's own chord — the designer expects
 *  Cmd-C to copy out of the pane, not to reach the session. */
export function keyOf(event: Key): string {
  if (event.metaKey) return "";
  const { key } = event;
  if (event.ctrlKey) {
    // Ctrl-A..Ctrl-Z are the control codes 1..26; this is how Ctrl-C reaches the session.
    const upper = key.toUpperCase();
    if (upper.length === 1 && upper >= "A" && upper <= "Z") {
      return String.fromCharCode(upper.charCodeAt(0) - 64);
    }
    return "";
  }
  const named = NAMED[key];
  if (named !== undefined) return event.altKey ? `\x1b${named}` : named;
  if ([...key].length !== 1) return "";
  return event.altKey ? `\x1b${key}` : key;
}

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
  /** What has the keyboard focus while the designer is driving the session. */
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
   *  arithmetic is not. */
  readonly fit: (pane: Box, grid: Box) => Size | null;
}

/** Wire the parts to a session.
 *
 *  Keystrokes go up one press at a time and unread — the pane does not know what a key
 *  means and must not, because the meaning is the far end's. A press that makes bytes is
 *  also a press the browser must not act on itself, so it is defaulted-prevented; a press
 *  that makes none is left to the browser, which is how Cmd-C still copies and Tab out of
 *  an unfocused pane still moves focus.
 *
 *  The composer is the other door, and a page need not have one. What is typed there is not
 *  keystrokes: it is a prompt, and it reaches the session only when it is sent, at which
 *  point the box is emptied so that a sent prompt cannot be sent twice. A page that hands in
 *  neither is a page whose only way in is the keyboard, and nothing is wired for the door it
 *  does not have — a listener on an element that is not there is the shape of a pane that
 *  quietly does nothing. */
export function attach(parts: Parts, terminal: Terminal, send: Send): Attached {
  terminal.open(parts.screen);

  parts.keyboard.addEventListener("keydown", ((event: Key & { preventDefault?: () => void }) => {
    const data = keyOf(event);
    if (data === "") return;
    event.preventDefault?.();
    send({ kind: "keys", data });
  }) as (event: never) => void);

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
     *  already there. Told the other way round, every fit costs one frame of garbage. */
    fit(pane: Box, grid: Box): Size | null {
      const size = fits(pane, grid, { cols: terminal.cols, rows: terminal.rows });
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
