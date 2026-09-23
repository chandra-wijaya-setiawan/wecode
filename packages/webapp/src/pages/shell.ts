/** The frame every page of the web surface wears, read off the design rather than written
 *  out in each page — the word at the top, the row of ways in under it, and the look.
 *
 *  `packages/tui/config/design.yaml` is one design with three renderers on it: a terminal,
 *  a wireframe and this. Its `renderers.webapp.shell` block says what a document of this
 *  surface is — its doctype, its language, its title, the one banner it carries and the one
 *  element its markup goes inside. This file is the only thing that turns those words into
 *  markup, so a page is a fragment plus `shelled()` and never a document of its own: two
 *  pages each spelling their own `<!doctype>` are two answers to what the surface looks
 *  like, and they drift on the first rename.
 *
 *  The design and the parser that reads it are both `@wecode/tui`'s, borrowed through the
 *  dependency this package already has rather than declared a second time. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { html, text, type Handler, type Page, type Reply, type Verb } from "../server.js";
import { pathOf } from "./discover.js";
/** The dock's far end and the dock's pane, both the painter's. Deep specifiers because the
 *  package's barrel offers the review session and not these two modules; the pty is
 *  `pty.ts` and the browser half is `client/terminal.ts`, and a copy of either here would be
 *  a second terminal to keep right. `@xterm/xterm` is a type here and never a value: it is a
 *  browser library shipped as CommonJS and this module is the one that renders HTML, and a
 *  server that imports it does not start — node refuses the named export before a byte. */
import { DEFAULT_ROWS, Session } from "@wecode/painter/dist/pty.js";
import { attach, decode, encode } from "@wecode/painter/dist/client/terminal.js";
import type { Box, Parts, Size } from "@wecode/painter/dist/client/terminal.js";
import type { Terminal } from "@xterm/xterm";

/** Where the design is, and what reads it. Both are resolved through `@wecode/tui`, because
 *  where a dependency's files sit is the package manager's business — and `createRequire`
 *  rather than `import.meta.resolve`, which the test runner's loader does not implement. */
const here = createRequire(fileURLToPath(import.meta.url));
const DESIGN = here.resolve("@wecode/tui/config/design.yaml");
const { parse } = createRequire(here.resolve("@wecode/tui"))("yaml") as {
  parse: (text: string) => unknown;
};

export class ShellError extends Error {}

/** The declared shell. Every field is a sentence of the document and none of them is this
 *  file's to choose. */
export interface Shell {
  readonly doctype: string;
  readonly lang: string;
  readonly charset: string;
  readonly viewport: string;
  readonly title: string;
  readonly banner: string;
  /** The element the whole of a page's markup goes inside. */
  readonly body: string;
}

const FIELDS = ["doctype", "lang", "charset", "viewport", "title", "banner", "body"] as const;

const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The `renderers.webapp` block of the design at `path`. */
const webappOf = (path: string): Record<string, unknown> =>
  mapOf(mapOf(mapOf(parse(readFileSync(path, "utf8")))["renderers"])["webapp"]);

/** The shell `renderers.webapp` declares. A field the design does not say is a refusal and
 *  never a default: a document drawn from a half-read design is a document nothing gates. */
export function loadShell(path: string = DESIGN): Shell {
  const block = mapOf(webappOf(path)["shell"]);
  const shell: Record<string, string> = {};
  for (const field of FIELDS) {
    const said = block[field];
    if (typeof said !== "string") {
      throw new ShellError(`${path}: renderers.webapp.shell declares no ${field}`);
    }
    shell[field] = said;
  }
  return shell as unknown as Shell;
}

/** One name in the banner: the page it opens, and the word the reader is offered for it.
 *  Where it answers is not declared — that is `discover.ts`'s one answer, asked for here
 *  rather than said twice. */
export interface Tab {
  readonly page: string;
  readonly says: string;
  readonly at: string;
}

/** The order `renderers.webapp.banner` declares. As with the shell, nothing is defaulted:
 *  a banner built out of whatever this file guessed is a banner nobody signed, and the
 *  order a reader meets the surface in is a decision about the surface. */
export function loadBanner(path: string = DESIGN): readonly Tab[] {
  const said = mapOf(webappOf(path)["banner"])["order"];
  if (!Array.isArray(said)) {
    throw new ShellError(`${path}: renderers.webapp.banner declares no order`);
  }
  return said.map((row, at) => {
    const held = mapOf(row);
    for (const field of ["page", "says"]) {
      if (typeof held[field] !== "string") {
        throw new ShellError(`${path}: renderers.webapp.banner.order[${at}] declares no ${field}`);
      }
    }
    const page = held["page"] as string;
    return { page, says: held["says"] as string, at: pathOf(page) };
  });
}

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
 *  so the markup below and the script that wires it cannot drift. */
export const CONTROLS = {
  open: `[data-ui="shell.terminal"]`,
  shut: `[data-ui="shell.dock.close"]`,
} as const;

/** The button that ends the banner. It names what it turns rather than targeting a popover,
 *  and whether it is open now is said by `aria-expanded`, which the script keeps true — the
 *  state is a class on the root and a reader on a screen reader is owed it too. */
const terminalButton = (): string =>
  `<button type="button" aria-controls="${DOCK}" aria-expanded="false" ` +
  `data-ui="shell.terminal">terminal</button>`;

/** The dock down the side: what the shell has said, and the line the next word is typed
 *  on. Both drawn empty, because what fills them is the far end — the shell behind
 *  `SHELL_AT`, which `dock()` attaches this markup to, naming its elements in `PARTS`. */
const dockOf = (): string =>
  `<aside id="${DOCK}" data-ui="shell.dock">` +
  `<button type="button" data-ui="shell.dock.close">close</button>` +
  `<pre data-ui="shell.dock.output"></pre>` +
  `<form data-ui="shell.dock.command">` +
  `<label for="${DOCK}-line">&gt;</label>` +
  `<input id="${DOCK}-line" name="line" type="text" autocomplete="off">` +
  `</form></aside>`;

/** The banner as markup: the word, and under it one row of ways in, in the declared order,
 *  ending in the control that opens the dock. */
const bannerOf = (banner: string, tabs: readonly Tab[]): string =>
  `<h1>${banner}</h1><nav>` +
  tabs.map((tab) => `<a href="${tab.at}">${tab.says}</a>`).join("") +
  terminalButton() +
  `</nav>`;

/** The look `renderers.webapp` declares: the tokens every rule spends, the shape each page
 *  is allowed to name, and the rules themselves — the frame's, then one block per page. */
export interface Look {
  readonly scheme: string;
  readonly palette: Readonly<Record<string, string>>;
  readonly type: Readonly<Record<string, string>>;
  readonly roots: Readonly<Record<string, readonly string[]>>;
  readonly frame: Rules;
  readonly pages: Readonly<Record<string, Rules>>;
}

/** Selector to declarations. A value that is itself a map is a wrapper — an `@media` query
 *  — and holds selectors of its own. */
export type Rules = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

const stringsOf = (v: unknown, said: string): Record<string, string> => {
  const map = mapOf(v);
  for (const [key, held] of Object.entries(map)) {
    if (typeof held !== "string") throw new ShellError(`${said}.${key} is not a word`);
  }
  return map as Record<string, string>;
};

/** The look, read off the design. As with the shell, a block the design does not declare is
 *  a refusal: a surface styled from half a design is a surface nothing signed. */
export function loadLook(path: string = DESIGN): Look {
  const block = mapOf(webappOf(path)["look"]);
  for (const field of ["scheme", "palette", "type", "roots", "frame", "pages"]) {
    if (!(field in block)) throw new ShellError(`${path}: renderers.webapp.look declares no ${field}`);
  }
  const roots: Record<string, readonly string[]> = {};
  for (const [page, said] of Object.entries(mapOf(block["roots"]))) {
    if (!Array.isArray(said) || said.some((s) => typeof s !== "string")) {
      throw new ShellError(`${path}: renderers.webapp.look.roots.${page} is not a list of shapes`);
    }
    roots[page] = said as string[];
  }
  const pages: Record<string, Rules> = {};
  for (const [page, said] of Object.entries(mapOf(block["pages"]))) pages[page] = mapOf(said) as Rules;
  return {
    scheme: String(block["scheme"]),
    palette: stringsOf(block["palette"], "palette"),
    type: stringsOf(block["type"], "type"),
    roots,
    frame: mapOf(block["frame"]) as Rules,
    pages,
  };
}

const rule = (selector: string, declarations: string): string => `${selector} { ${declarations} }\n`;

/** The declared rules as text. A nested map is a query, and its own rules go inside it. */
const rulesOf = (rules: Rules, indent = ""): string =>
  Object.entries(rules)
    .map(([selector, held]) =>
      typeof held === "string"
        ? indent + rule(selector, held)
        : `${indent}${selector} {\n${rulesOf(held as Rules, `${indent}  `)}${indent}}\n`,
    )
    .join("");

/** The whole surface's stylesheet, built from the declared look and from nothing else.
 *
 *  Every page's block is in it, in every document: a page is a fragment and the sheet is the
 *  surface's, so a page cannot be served in a look of its own — and that is safe because
 *  each block is scoped to a shape only its page draws, declared as that page's `roots`. */
export function stylesheet(look: Look = loadLook()): string {
  const tokens = [
    `color-scheme: ${look.scheme}`,
    ...Object.entries(look.palette).map(([name, held]) => `--${name}: ${held}`),
    ...Object.entries(look.type).map(([name, held]) => `--${name}: ${held}`),
  ].join("; ");
  return (
    rule(":root", tokens) +
    rulesOf(look.frame) +
    Object.values(look.pages)
      .map((page) => rulesOf(page))
      .join("")
  );
}

/** The document: the declared frame, with the page's own markup inside the one element the
 *  design gives it, wearing the declared look.
 *
 *  `retired` is the stylesheet a page used to hand in. It is taken and dropped: the look is
 *  the design's now, so a page that still passes one is served the signed sheet anyway. The
 *  parameter stays only so such a page still compiles; nothing in it reaches the document. */
export function document(
  contents: string,
  retired = "",
  shell: Shell = loadShell(),
  css: string = stylesheet(),
  tabs: readonly Tab[] = loadBanner(),
): string {
  void retired;
  const { doctype, lang, charset, viewport, title, banner, body } = shell;
  return (
    `${doctype}\n<html lang="${lang}"><head><meta charset="${charset}">` +
    `<meta name="viewport" content="${viewport}">` +
    `<title>${title}</title><style>${css}</style></head>` +
    `<body><${body}>${bannerOf(banner, tabs)}${contents}</${body}>${dockOf()}</body></html>\n`
  );
}

/** What a page says, without saying it in a document. A page is given the target so it can
 *  read its own query; what it hands back is markup for the inside of the shell. */
export type Contents = (url: URL) => string;

/** A page, wearing the shell. This is the only way a page of this package becomes a reply,
 *  so "every page is in the shell" is a fact about the code and not a habit. The frame and
 *  the sheet are read when the page is wired, not on every request — the design does not
 *  change under a running server. What does change is the work, which is `contents`. */
export const shelled = (
  contents: Contents,
  retired = "",
  shell: Shell = loadShell(),
  css: string = stylesheet(),
  tabs: readonly Tab[] = loadBanner(),
): Page =>
  (url: URL): Reply => html(document(contents(url), retired, shell, css, tabs));

// ─── the far end ────────────────────────────────────────────────────────────────────

/** Where the shell behind the dock answers. The dock's own name, because it is the dock's
 *  far end and not a page: it is not under `pages/`, it is not discovered, and `bin.ts`
 *  names it at the path it is polled on — the way the one other non-page route is named. */
export const SHELL_AT = `/${DOCK}`;

/** Whose shell the dock runs. The login shell out of the password database, else what the
 *  operator's own terminal put in the environment; `/bin/sh` is the last resort and not a
 *  choice, because a dock that always ran `sh` is a dock none of their prompt is in. */
export const loginShell = (): string => userInfo().shell ?? process.env["SHELL"] ?? "/bin/sh";

/** As much of a pty as the dock needs: what it has drawn, whether it is still there, and
 *  the two ways in. The painter's `Session` is one of these — naming the shape rather than
 *  the class is what lets the route's decisions be proved without spawning a shell per
 *  claim, while the shell that actually runs is the painter's and not a stand-in. */
export interface Shelled {
  readonly output: string;
  readonly running: boolean;
  readonly exit: number | null;
  keys(input: string): void;
  prompt(text: string): void;
  close(): Promise<number>;
  /** Tell the far end the window is now this many cells. Optional because this shape is
   *  what the dock *asks* of a pty rather than what a pty is — a stand-in that cannot be
   *  resized is still a shell the route's own decisions can be stated against. The
   *  painter's `Session` has it, and that is the one that runs. */
  resize?(cols: number, rows: number): void;
}

/** How one is opened: a command, and where it runs. */
export type Opens = (options: { readonly command: string; readonly cwd: string }) => Shelled;

/** One poll of the shell: everything it has drawn since the cursor asked from, as frames
 *  the pane's own `receive` takes verbatim, and the cursor to ask from next. Frames because
 *  the wire is the painter's and the pane must not be taught a second one; a cursor rather
 *  than a stream because a reply of this surface is whole — `server.ts` writes a body and
 *  ends it — and a pane holding a cursor cannot lose a chunk to a dropped connection. */
export interface Drawn {
  readonly at: number;
  readonly frames: readonly string[];
}

const json = (value: unknown): Reply => ({
  status: 200,
  type: "application/json; charset=utf-8",
  body: JSON.stringify(value),
});

/** The shell the dock is a pane on, and the way to let go of it.
 *
 *  It is opened on the first poll and not before: a board nobody has opened the dock on
 *  should not have a shell running behind it. It is one shell, because there is one dock,
 *  and two shells would be two screens the next keystroke could go to.
 *
 *  GET is the pane attaching, `?from=<n>` being how much of the screen it already holds.
 *  `from=0` is a pane attaching fresh, and that is also the one thing that replaces a shell
 *  which has left: a dock reopened after `exit` gets a new shell, and a dock in the middle
 *  of a session that re-reads from 0 gets the screen it already had.
 *
 *  POST is a frame going the other way — the keystrokes, unread, because what a key means
 *  is the far end's, and the pane's size, which is news about the window rather than
 *  anything the designer said. A frame that is not one is refused rather than guessed at,
 *  and a key pressed at a shell that has left is told so rather than dropped. */
export function shellAt(
  where: () => string,
  opens: Opens = (options) => Session.open(options),
): { readonly route: Handler; readonly close: () => void } {
  let held: Shelled | null = null;
  let told = false;

  const opened = (fresh: boolean): Shelled => {
    if (held === null || (fresh && !held.running)) {
      held = opens({ command: loginShell(), cwd: where() });
      told = false;
    }
    return held;
  };

  const get: Page = (url) => {
    const asked = Number(url.searchParams.get("from") ?? 0);
    const from = Number.isInteger(asked) && asked >= 0 ? asked : 0;
    const shell = opened(from === 0);
    const drawn = shell.output;
    const frames: string[] = [];
    if (from < drawn.length) frames.push(encode({ kind: "output", chunk: drawn.slice(from) }));
    // Once, and only after the screen has been handed over: a pane told twice that the
    // shell left would print it twice, and one told before the last chunk would print it
    // above the shell's own goodbye.
    if (!shell.running && !told) {
      told = true;
      frames.push(encode({ kind: "exit", code: shell.exit ?? 0 }));
    }
    return json({ at: drawn.length, frames } satisfies Drawn);
  };

  const post: Verb = (_url, body) => {
    const message = decode(body);
    if (message === null || message.kind === "output" || message.kind === "exit") {
      return text(400, "that is not a frame the shell takes — keys, prompt or resize");
    }
    if (held === null || !held.running) return text(409, "the shell has left — attach again");
    if (message.kind === "keys") held.keys(message.data);
    else if (message.kind === "prompt") held.prompt(message.text);
    // Answered whether or not the pty can take it: a size is the pane telling the far end
    // about its window, not a request that can fail, and a reader whose dock returned 500
    // for dragging a window would have nothing to do about it.
    else held.resize?.(message.cols, message.rows);
    return json({ at: held.output.length });
  };

  /** The process that owns the socket owns this too. A board killed at the terminal must
   *  not leave the operator's shell running behind it, and the kill is not waited on —
   *  a shutdown that hangs on a shell refusing to die is a shutdown nobody can use. */
  const close = (): void => {
    void held?.close();
    held = null;
  };

  return { route: { get, post }, close };
}

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
  /** Fit the screen to the box it is drawn in and tell the far end, given the pane's box
   *  and the box the emulator's grid currently fills. Both are measured by whoever holds
   *  the elements: this module renders HTML on a server and has none. */
  readonly fit: (pane: Box, grid: Box) => Size | null;
}

/** The window a pane's own terminal opens with — the pty's own rows, so the pane holds the
 *  screen the far end was told it was drawing to and not a history of it — and the emulator
 *  that opens on it, required when it is wanted rather than imported at the top of the file,
 *  because the module graph a binary loads must not hold a browser library. */
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
 *  This function runs in a browser, where `bin.ts` ships its own source rather than a copy
 *  typed into a string. So it may reach for nothing but its parameters, `attach`, `encode`,
 *  `WINDOW` and `emulator` — the names that file defines again on the browser's side — and
 *  it reads no global, which is also what lets these tests drive it with no browser. */
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

/** Which element of the dock is which part of the pane. One list, so the markup above and
 *  the pane cannot drift, under the `data-ui` names the dock is already drawn with.
 *
 *  The line is both the keyboard and the composer: it is where the designer's keys are, and
 *  `attach` defaults-prevents every press that makes bytes, so Enter goes down the wire as
 *  CR instead of submitting the form. The form is wired all the same — a submit that does
 *  arrive carries a whole line, which must not be dropped. */
export const PARTS = {
  screen: `[data-ui="shell.dock.output"]`,
  keyboard: `#${DOCK}-line`,
  composer: `#${DOCK}-line`,
  send: `[data-ui="shell.dock.command"]`,
} as const;

// ─── opening it ─────────────────────────────────────────────────────────────────────

/** As much of the root element, and of the browser's store, as the sidebar needs. Named
 *  shapes rather than the DOM's own types, for the reason the pane's parts are: this module
 *  renders HTML on a server and must not reach for a browser's types, and a shape a
 *  statement can hand in is what lets the turning be proved with no browser at all. */
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
 *  Like `dock()`, this runs in a browser, where `browser/dock.ts` ships its own source
 *  rather than a copy typed into a string. So it reaches for nothing but its parameters and
 *  `DOCKED` and `REMEMBERED` — the two names that file defines again on the browser's
 *  side — and it reads no global, which is what lets these tests turn it. */
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
