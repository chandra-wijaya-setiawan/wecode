/** The dock: all of the terminal down the side of every document bar the markup of it.
 *
 *  `pages/shell.ts` draws the dock — an `<aside>` with a way out and a screen in it, and
 *  nothing to type into but the screen itself — and owns the far end it is a pane on.
 *  Everything else about it is here: the names the
 *  markup and the script agree on, the pane itself, the open-or-shut state the root's class
 *  is, and the files a browser is sent so that any of it runs.
 *
 *  It is one file because all of it runs in a page. A pane needs an emulator, and the
 *  emulator is a browser library: the module that renders HTML cannot import it, because
 *  node refuses its named export before a byte is served, which is exactly how this board
 *  once stopped starting. So the pane runs in a file a browser fetches, and the pane, the
 *  turning and the names they share live beside the thing that serves them.
 *
 *  Four files are served and one line refers to them: the `<script>` tag, put into a served
 *  document here rather than in `document()`, because the document is the design's sentence
 *  and what the surface *wires* is the wiring's to say. A page's markup is untouched either
 *  way — the tag goes immediately before `</body>`, after everything a page or the shell
 *  drew.
 *
 *  What is served is not proved by being called: that a browser can fetch and parse it is a
 *  question for a board that is listening, and `the-terminal-runs-in-the-browser.test.ts`
 *  asks a real one. What is *not* served — `dock()` and `docking()` — reads no global and
 *  takes only parameters, which is what lets `the-dock-runs-a-shell.test.ts` drive it. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROWS } from "@wecode/painter/dist/pty.js";
import { attach, encode } from "@wecode/painter/dist/client/terminal.js";
import type { Box, Edges, Parts, Size } from "@wecode/painter/dist/client/terminal.js";
import type { Terminal } from "@xterm/xterm";
import type { Handler, Page, Reply, Routes, Verb } from "../server.js";
/** Type-only, and it must stay that way: the far end is `pages/shell.ts`'s, that file
 *  imports this one for the dock's names, and a value crossing back would be a cycle at
 *  load. `import type` is erased, so this is one module reading the other's sentence about
 *  what a poll answers with rather than keeping a second copy of it. */
import type { Drawn } from "../pages/shell.js";

/** Where a dependency's files sit is the package manager's business: resolved, not pathed. */
const here = createRequire(fileURLToPath(import.meta.url));

// ─── the names the markup and the script share ──────────────────────────────────────

/** What the banner's last control opens, and what it is. The dock is one element of the
 *  document, not one per page, because there is one session behind it: two docks would be
 *  two places the same output could be read and two command lines disagreeing about which
 *  one the next word goes to. */
export const DOCK = "terminal";

/** The class the root element wears while the dock is open, and where a browser remembers
 *  that it is.
 *
 *  It was a popover, which is the browser's own top-layer box: drawn over the page, unable
 *  to make room beside it, and — because the top layer belongs to the document — shut by
 *  every link a reader follows. A sidebar is the other thing: a column of the window, with
 *  the page taking the width that is left, which is one class answering both. And because
 *  this surface is eight documents rather than one, "open" has to survive a navigation, so
 *  it is remembered rather than held in a page that is about to be thrown away. */
export const DOCKED = "docked";
export const REMEMBERED = `wecode.${DOCK}`;

/** The two controls that turn it, under the `data-ui` names they are drawn with. One list,
 *  so the markup and the script that wires it cannot drift. */
export const CONTROLS = {
  open: `[data-ui="shell.terminal"]`,
  shut: `[data-ui="shell.dock.close"]`,
} as const;

/** Where the shell behind the dock answers. The dock's own name, because it is the dock's
 *  far end and not a page: it is not under `pages/`, it is not discovered, and `bin.ts`
 *  names it at the path it is polled on — the way the one other non-page route is named. */
export const SHELL_AT = `/${DOCK}`;

/** Which element of the dock is which part of the pane. One list, so the markup and the
 *  pane cannot drift, under the `data-ui` names the dock is already drawn with.
 *
 *  Two names and one element: the screen is also the keyboard. That is what makes the dock a
 *  terminal the reader clicks and types into rather than a box with a line under it. The
 *  emulator keeps its own focus target inside the screen, so a press anywhere in it bubbles
 *  out to where `attach` listens, which defaults-prevents it and sends the bytes up — Enter
 *  as CR, Ctrl-C as ETX, the arrows as the sequences that walk the far end's own history.
 *  There is no composer and no send, which `Parts` has as optional for exactly this: a
 *  `prompt` frame is still one the route takes — `browser/annotate.ts` sends a reviewer's
 *  round as one — but it is no longer something a reader of the dock types. */
export const PARTS = {
  screen: `[data-ui="shell.dock.output"]`,
  keyboard: `[data-ui="shell.dock.output"]`,
} as const;

// ─── the dock's pane ────────────────────────────────────────────────────────────────

/** Where the pane sends what it has, and where it takes the screen from. Both are the
 *  browser's `fetch` against `SHELL_AT` in the page, and both are a parameter here, so the
 *  pane can be driven against the route itself with no socket and no browser in the way. */
export interface Wire {
  /** A frame going up. */
  readonly send: (frame: string) => Promise<unknown>;
  /** Everything drawn since a cursor. */
  readonly drawn: (from: number) => Promise<Drawn>;
}

export interface Docked {
  /** The emulator behind the pane, for anything that wants to read or size the screen. */
  readonly terminal: Terminal;
  /** Take whatever the shell has drawn since the last pump, and say where the cursor is. */
  readonly pump: () => Promise<number>;
  /** Fit the screen to the box it is drawn in and tell the far end, given the screen's
   *  rectangle, the box the emulator's grid currently fills, and the screen's computed
   *  style — a rectangle is not all room, and what the trim costs is the painter's to
   *  subtract. All three are measured by whoever holds the elements. */
  readonly fit: (pane: Box, grid: Box, trim?: Edges) => Size | null;
}

/** The window a pane's own terminal opens with — the pty's own rows, so the pane holds the
 *  screen the far end was told it was drawing to and not a history of it — and the emulator
 *  that opens on it, required when wanted rather than imported, because the module graph a
 *  binary loads must not hold a browser library. */
const WINDOW = { rows: DEFAULT_ROWS };
const emulator = (): { new (window: { rows: number }): Terminal } =>
  (here("@xterm/xterm") as { Terminal: { new (window: { rows: number }): Terminal } }).Terminal;

/** The dock's pane: an xterm.js terminal, attached to the shell behind the route.
 *
 *  `attach` is the painter's and is not reimplemented here. That is the whole point — the
 *  pane owns the bytes and nothing else, the far end owns the screen, a keystroke goes up
 *  unread and an escape sequence comes down whole. What this adds is the transport: one
 *  frame up per press, and a `pump` that carries the cursor so a chunk is drawn once.
 *
 *  This runs in a browser, where `dockScript` below ships its own source rather than a copy
 *  typed into a string. So it reaches for nothing but its parameters, `attach`, `encode`,
 *  `WINDOW` and `emulator` — the names that script defines again on the browser's side —
 *  and reads no global, which is also what lets a test drive it with no browser at all. */
export function dock(parts: Parts, wire: Wire, terminal: Terminal = new (emulator())(WINDOW)): Docked {
  const pane = attach(parts, terminal, (message) => void wire.send(encode(message)));
  let at = 0;
  return {
    terminal: pane.terminal,
    fit: pane.fit,
    pump: async (): Promise<number> => {
      const drawn = await wire.drawn(at);
      for (const frame of drawn.frames) pane.receive(frame);
      at = drawn.at;
      return at;
    },
  };
}

// ─── opening it ─────────────────────────────────────────────────────────────────────

/** As much of the root element, and of the browser's store, as the sidebar needs. Named
 *  shapes rather than the DOM's own types: a shape a statement can hand in is what lets the
 *  turning be proved with no browser at all. */
export interface Rooted {
  readonly classList: { toggle(name: string, on: boolean): void; contains(name: string): boolean };
}

export interface Remembers {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Sidebar {
  /** Open or shut as the reader left it, applied without being written back. */
  readonly restore: () => void;
  /** Turned by a reader, which is the act that is remembered. */
  readonly turn: (open: boolean) => void;
  /** Read off the root, because a second copy of the state is a second answer. */
  readonly opened: () => boolean;
}

/** The sidebar's one piece of state: a class on the root, a word in the store, and `shown`
 *  for what is neither — the pane, the focus and the poll, which are the wiring's.
 *
 *  `held` may be null, because reaching for `localStorage` throws outright in a document
 *  that is not allowed one, and a dock that forgets is better than a script that died
 *  before it wired anything.
 *
 *  Shipped as its own source, like `dock()`, so it reaches for nothing but its parameters,
 *  `DOCKED` and `REMEMBERED`, and reads no global. */
export function docking(root: Rooted, held: Remembers | null, shown: (open: boolean) => void): Sidebar {
  const show = (open: boolean): void => {
    root.classList.toggle(DOCKED, open);
    shown(open);
  };
  return {
    restore: () => show(held?.getItem(REMEMBERED) === "open"),
    turn: (open: boolean) => {
      held?.setItem(REMEMBERED, open ? "open" : "shut");
      show(open);
    },
    opened: () => root.classList.contains(DOCKED),
  };
}

// ─── what a browser is sent ─────────────────────────────────────────────────────────

/** Where the dock's pane is served from. Four files, and none of them is a page — nothing
 *  under `pages/` answers here — so they sit under the dock's own path, beside the far end
 *  the dock polls, which is `SHELL_AT` itself. */
const BROWSER = {
  /** The script the dock's pane is, and the few lines that start it. */
  dock: `${SHELL_AT}.js`,
  /** The painter's browser half — the wire, `keyOf` and `attach` — served as the file it
   *  already is, so both halves of one terminal are one file. */
  pane: `${SHELL_AT}.pane.js`,
  /** xterm.js at the version this package pins, as its own ES module. */
  emulator: `${SHELL_AT}.emulator.js`,
  /** xterm.js's own sheet, which a terminal is unreadable without. */
  look: `${SHELL_AT}.css`,
} as const;

/** The line that makes the dock a terminal rather than a box. A module, because the script
 *  it asks for imports two others — and deferred by being one, so it runs with the dock's
 *  markup parsed and `one()` below can find it. */
const SCRIPT = `<script type="module" src="${BROWSER.dock}"></script>`;

/** The pane as a browser runs it.
 *
 *  `dock` and `docking` are handed over as their own source rather than written out a
 *  second time: they are what this package's own tests drive against the real route and the
 *  real markup, so what a reader is served is what was proved. Around them is only what no
 *  test runner can stand in for — the emulator, the document and `fetch` — and the free
 *  names they live under, defined again here on the browser's side.
 *
 *  Nothing is attached until the dock is first opened: a sidebar the root's class is not on
 *  is `display: none`, a terminal opened on a box with no size measures a screen of nothing,
 *  and a board nobody opened the dock on should start no shell. While it is open the pane
 *  asks the far end for what has been drawn since its cursor, and a frame going up asks
 *  again as soon as it lands, so an echo does not wait for the next beat. */
const dockScript = (): string =>
  `import { Terminal } from "${BROWSER.emulator}";
import { attach, encode } from "${BROWSER.pane}";

// The names the pane and the sidebar reach for, on this side of the wire.
const WINDOW = { rows: ${DEFAULT_ROWS} };
const emulator = () => Terminal;
const dock = ${String(dock)};
const DOCKED = ${JSON.stringify(DOCKED)};
const REMEMBERED = ${JSON.stringify(REMEMBERED)};
const CONTROLS = ${JSON.stringify(CONTROLS)};
const docking = ${String(docking)};

const PARTS = ${JSON.stringify(PARTS)};
const one = (selector) => {
  const found = window.document.querySelector(selector);
  if (found === null) throw new Error("the dock draws no " + selector);
  return found;
};

// The emulator's own sheet, brought by the emulator: the document's head is the design's
// sentence and nothing else may add to it.
const sheet = window.document.createElement("link");
sheet.rel = "stylesheet";
sheet.href = "${BROWSER.look}";
window.document.head.append(sheet);

const wire = {
  send: (frame) =>
    fetch("${SHELL_AT}", { method: "POST", body: frame }).then((reply) => {
      void beat();
      return reply;
    }),
  drawn: (from) => fetch("${SHELL_AT}?from=" + from).then((reply) => reply.json()),
};

let pane = null;
let beating = null;
let busy = false;

// What the fit is arithmetic on. Only the measuring is here, because reading a rectangle
// and a computed style off an element is a browser's act and nothing else in the fit is:
// the pane takes the trim off the rectangle and divides what is left into cells, and both
// halves of that are the painter's and are proved with no browser at all.
//
// The screen's rectangle is the border box, so the padding the design gives it and any rule
// drawn round it go up as the style rather than being subtracted here — a pane fitted to
// the whole rectangle composes a column whose edge is under the border.
//
// The grid's box is \`.xterm-screen\`, the element xterm draws the cells into — its rectangle
// over the terminal's own cols and rows is one cell, which is how the screen is fitted
// without asking xterm for a measurement it does not publish.
const boxOf = (element) => element.getBoundingClientRect();
const trimOf = (element) => window.getComputedStyle(element);

const gridOf = (terminal) => {
  const drawn = terminal.element && terminal.element.querySelector(".xterm-screen");
  return drawn ? drawn.getBoundingClientRect() : null;
};

// Fit the screen to the panel, and let \`fits\` refuse it. It is asked on every beat rather
// than on a window's resize event, because the box moves for reasons a window does not —
// the dock being opened is one, and so is the emulator finishing its first frame — and
// because a fit that has nothing to do costs three rectangles and an answer of null.
const fit = () => {
  if (pane === null) return;
  const grid = gridOf(pane.terminal);
  if (grid === null) return;
  const screen = one(PARTS.screen);
  pane.fit(boxOf(screen), grid, trimOf(screen));
};

// One poll at a time: two in flight would both ask from the same cursor and the screen
// would be drawn twice. A poll that throws is the board gone, so the beat stops rather than
// filling the console every fiftieth of a second.
const beat = async () => {
  if (pane === null || busy) return;
  busy = true;
  try {
    // Before the poll, so what the far end draws next is drawn at the size it has just
    // been told about rather than at the one the pane has already stopped showing.
    fit();
    await pane.pump();
  } catch {
    window.clearInterval(beating);
    beating = null;
  } finally {
    busy = false;
  }
};

// The store, or nothing at all: the property itself throws in a document that is not
// allowed one, and that must not be what stops the dock from being wired.
let store = null;
try {
  store = window.localStorage;
} catch {
  store = null;
}

const sidebar = docking(window.document.documentElement, store, (open) => {
  one(CONTROLS.open).setAttribute("aria-expanded", String(open));
  if (!open) {
    window.clearInterval(beating);
    beating = null;
    return;
  }
  if (pane === null) {
    const parts = Object.fromEntries(
      Object.entries(PARTS).map(([part, selector]) => [part, one(selector)]),
    );
    pane = dock(parts, wire);
  }
  // The emulator and not the element around it: xterm's own focus target is the one that
  // shows a cursor, and a press there bubbles out to the screen, where \`attach\` listens.
  pane.terminal.focus();
  beating = window.setInterval(() => void beat(), 50);
  void beat();
});

one(CONTROLS.open).addEventListener("click", () => sidebar.turn(!sidebar.opened()));
one(CONTROLS.shut).addEventListener("click", () => sidebar.turn(false));

// Last, and not on a click: a reader who left the dock open meets it open on the next page
// they follow to, which is the whole of why the state is remembered rather than a popover's.
sidebar.restore();
`;

const JS = "text/javascript";
const HTML = "text/html";
const CLOSE = "</body>";

/** A file handed over as it is, read when the route is wired the way the design and the
 *  sheet are: none of them changes under a running board. */
const fileAt = (path: string, type: string): Reply => {
  const held = readFileSync(path, "utf8");
  return { status: 200, type: `${type}; charset=utf-8`, body: held };
};

/** The four files, at the four paths, each answered with what was read at wiring time. */
export const browser = (): Routes => {
  const held: Readonly<Record<string, Reply>> = {
    [BROWSER.dock]: { status: 200, type: `${JS}; charset=utf-8`, body: dockScript() },
    [BROWSER.pane]: fileAt(here.resolve("@wecode/painter/dist/client/terminal.js"), JS),
    [BROWSER.emulator]: fileAt(here.resolve("@xterm/xterm/lib/xterm.mjs"), JS),
    [BROWSER.look]: fileAt(here.resolve("@xterm/xterm/css/xterm.css"), "text/css"),
  };
  return Object.fromEntries(Object.entries(held).map(([at, reply]) => [at, () => reply]));
};

/** One reply, asking for the dock's script. A document and nothing else: a stylesheet, a
 *  redirect, or the JSON the far end answers with has no `</body>` to put a tag before. */
const asking = (reply: Reply): Reply =>
  reply.type.startsWith(HTML) && reply.body.includes(CLOSE)
    ? { ...reply, body: reply.body.replace(CLOSE, `${SCRIPT}${CLOSE}`) }
    : reply;

const asked = (handler: Handler): Handler => {
  if (typeof handler === "function") return (url: URL): Reply => asking(handler(url));
  const { get, post } = handler;
  const wrapped: { get?: Page; post?: Verb } = {};
  if (get !== undefined) wrapped.get = (url: URL): Reply => asking(get(url));
  if (post !== undefined) wrapped.post = (url: URL, body: string): Reply => asking(post(url, body));
  return wrapped;
};

/** The routes given, each answering as it did with the script tag in whatever document it
 *  hands back — one place, over every page there is, so a page added tomorrow carries the
 *  terminal without knowing it, and is still only a fragment. */
export const docked = (routes: Routes): Routes =>
  Object.fromEntries(Object.entries(routes).map(([at, handler]) => [at, asked(handler)]));
