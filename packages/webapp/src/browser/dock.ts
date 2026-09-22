/** The dock's browser half: the files a reader's browser asks for, and the one line in the
 *  document that asks for the first of them.
 *
 *  Everything about the dock that runs in a page is here, and nothing about it is in the
 *  document. That is the whole shape of this file. `pages/shell.ts` draws the dock — an
 *  `<aside popover>` with a screen and a command line in it — and owns the far end and
 *  `dock()`, the pane. But a pane needs an emulator, and the emulator is a browser library:
 *  the module that renders HTML cannot import it, because node refuses its named export
 *  before a byte is served, which is exactly how this board once stopped starting. So the
 *  pane runs in a file a browser fetches, and this is the file that says what is in it.
 *
 *  Four files are served and one line refers to them. The line is the `<script>` tag, and
 *  it is put into a served document here rather than in `document()` — the document is the
 *  design's sentence and a page is a fragment, so what the surface *wires* is the wiring's
 *  to say. A page's markup is untouched either way: the tag goes in immediately before
 *  `</body>`, after everything a page or the shell drew.
 *
 *  Nothing here runs under the test runner, and it must not be proved by being called: what
 *  matters about a served script is that a browser can fetch it and parse it, which is a
 *  question for a board that is listening. `test/the-terminal-runs-in-the-browser.test.ts`
 *  asks a real one. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROWS } from "@wecode/painter/dist/pty.js";
import { dock, DOCK, PARTS, SHELL_AT } from "../pages/shell.js";
import type { Handler, Page, Reply, Routes, Verb } from "../server.js";

/** Where the dock's pane is served from. Four files, and none of them is a page — nothing
 *  under `pages/` answers here — so they sit under the dock's own path, beside the far end
 *  the dock polls, which is `SHELL_AT` itself. */
const BROWSER = {
  /** The script the dock's pane is, and the few lines that start it. */
  dock: `${SHELL_AT}.js`,
  /** The painter's browser half — the wire, `keyOf` and `attach` — served as the file it
   *  already is, so both halves of one terminal are one file and not two to keep right. */
  pane: `${SHELL_AT}.pane.js`,
  /** xterm.js at the version this package pins, as its own ES module. */
  emulator: `${SHELL_AT}.emulator.js`,
  /** xterm.js's own sheet, which a terminal is unreadable without. */
  look: `${SHELL_AT}.css`,
} as const;

/** The line that makes the dock a terminal rather than a box. A module, because the script
 *  it asks for imports two others; deferred by being a module as well, so it runs with the
 *  dock's markup already parsed and `one()` below can find it. */
const SCRIPT = `<script type="module" src="${BROWSER.dock}"></script>`;

/** The pane as a browser runs it.
 *
 *  `dock` is handed over as its own source rather than written out a second time: it is
 *  `pages/shell.ts`'s function, the one the pane's own tests drive against the real route,
 *  so what a reader is served is the pane that was proved. Around it is only what no test
 *  runner can stand in for — the emulator, the document and `fetch` — and the four free
 *  names that function lives under, defined again here on the browser's side.
 *
 *  Nothing is attached until the dock is first opened. A popover is not displayed until
 *  then, and a terminal opened on a box with no size measures a screen of nothing; it is
 *  also how a board nobody opened the dock on never starts a shell. While it is open the
 *  pane asks the far end for what has been drawn since its cursor, and a frame going up asks
 *  again as soon as it lands, so an echo does not wait for the next beat. */
const dockScript = (): string =>
  `import { Terminal } from "${BROWSER.emulator}";
import { attach, encode } from "${BROWSER.pane}";

// The names the pane reaches for, on this side of the wire.
const WINDOW = { rows: ${DEFAULT_ROWS} };
const emulator = () => Terminal;
const dock = ${String(dock)};

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

// One poll at a time: two in flight would both ask from the same cursor and the screen
// would be drawn twice. A poll that throws is the board gone, so the beat stops rather than
// filling the console every fiftieth of a second.
const beat = async () => {
  if (pane === null || busy) return;
  busy = true;
  try {
    await pane.pump();
  } catch {
    window.clearInterval(beating);
    beating = null;
  } finally {
    busy = false;
  }
};

one("#${DOCK}").addEventListener("toggle", (event) => {
  if (event.newState !== "open") {
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
  one(PARTS.keyboard).focus();
  beating = window.setInterval(() => void beat(), 50);
  void beat();
});
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

/** Where a dependency's files sit is the package manager's business, so they are resolved
 *  rather than reached for by path — and resolved now, while somebody is watching the board
 *  start, rather than leaving a dock that is dead on a page nobody has opened yet. */
const here = createRequire(fileURLToPath(import.meta.url));

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
 *  redirect from the one verb, or the JSON the far end answers with are all replies of this
 *  surface and none of them has a `</body>` to put a tag before. */
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
 *  hands back. This is how the dock's browser half is referred to at all: one place, over
 *  every page there is, so a page added tomorrow carries the terminal without knowing it —
 *  and a page is still only a fragment, which is what keeps the document the design's. */
export const docked = (routes: Routes): Routes =>
  Object.fromEntries(Object.entries(routes).map(([at, handler]) => [at, asked(handler)]));
