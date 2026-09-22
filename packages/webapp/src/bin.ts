#!/usr/bin/env node
/** The board in a browser, wired to a workspace. This file owns the process — which
 *  database, which port, and a socket closed however the process ends. Everything drawn is
 *  a page's under `pages/`, everything routed is `server.ts`'s, and which pages there are
 *  is the `pages/` directory's: this file names none of them.
 *
 *  What it does name is the readings — the handful of questions a page can be served from,
 *  each a way of reading this database. A page picks one by name; a new page that asks a
 *  question nobody has asked yet adds a reading here, and a new page that asks an existing
 *  one needs nothing here at all.
 *
 *  Which workspace, and the refusal to make one, are read the same way `wecode-tui` reads
 *  them: a board is for looking at work that exists, and `open()` would cheerfully write an
 *  empty workspace wherever the operator happened to be standing. */
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  board,
  currentDatabase,
  currentWorkspace,
  databaseOf,
  listWorkspaces,
  open,
  tree,
  waitingApprovals,
} from "@wecode/core";
import { DEFAULT_ROWS } from "@wecode/painter/dist/pty.js";
import { answerAt } from "./answer.js";
import { pages } from "./pages/discover.js";
import { dock, DOCK, PARTS, SHELL_AT, shellAt } from "./pages/shell.js";
import { addressOf, serve, type Reply, type Routes } from "./server.js";

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.emitWarning(w);
});

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    db: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    operator: { type: "string" },
  },
});

/** Who an approval answered here is recorded as. The flag, else the actor the rest of
 *  wecode already reads out of the environment, else nobody — and nobody is a refusal at
 *  the verb rather than a guess at the port, because a webapp that picked a signatory on
 *  startup would pick one for every answer given through it. */
const operator = (): string | null => values.operator ?? process.env["WECODE_ACTOR"] ?? null;

const dbPath =
  values.db ?? (values.workspace === undefined ? currentDatabase() : databaseOf(values.workspace));

if (!existsSync(dbPath)) {
  const known = listWorkspaces();
  process.stderr.write(
    `no wecode workspace at ${dbPath}\n` +
      (known.length === 0
        ? "  wecode onboard   in a repository, to make one\n"
        : `  workspaces: ${known.join(", ")}\n  wecode-webapp --workspace <name>\n`),
  );
  process.exit(1);
}

/** A default port, so that the usual case is a bare command. A second copy against another
 *  workspace is `--port 0`, which takes whatever is free, and the line printed below says
 *  which that turned out to be. */
const port = values.port === undefined ? 4321 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`${String(values.port)} is not a port\n`);
  process.exit(2);
}

const db = open(dbPath);

/** Every question a page may be served from, each a function so that it is asked again on
 *  every request: work moves without anybody reloading, and a surface served from readings
 *  taken when the process booted is a surface that is wrong by the time it is read. */
const readings = {
  record: () => tree(db),
  board: () => board(db),
  approvals: () => waitingApprovals(db),
};

/** The shell behind the dock, opened where this board's workspace is. The database's own
 *  directory rather than wherever the operator happened to start the process, so
 *  `--workspace` and `--db` move the shell with the board — and it is certainly a directory
 *  that exists, because the check above has just said the database in it does. */
const shell = shellAt(() => dirname(dbPath));

// ─── the dock's browser half ────────────────────────────────────────────────────────

/** Where the dock's pane is served from. Four files, and none of them is a page — nothing
 *  under `pages/` answers here — so they sit under the dock's own path, named beside the
 *  dock's far end.
 *
 *  They are wired here and not in `pages/shell.ts` for two reasons: the surface's whole
 *  route table is this file's, which is already where the far end is named, and `shell.ts`
 *  is over the tree's line ceiling as it stands, with the split into a `pages/dock.ts` still
 *  to come. */
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
 *  again as soon as it lands, so an echo does not wait for the next beat.
 *
 *  One line is still missing, and it is the line that asks for this file: a
 *  `<script type="module" src="/terminal.js">` before `</body>`. It is not in `document()`
 *  because `test/the-banner-opens-a-terminal.test.ts` states that no document of this
 *  surface carries a script — a rule from the days when none was served, and one that has to
 *  be withdrawn where it is written rather than routed around from the wiring. Until it is,
 *  this half is served and proved to parse and the dock stays the markup-only popover it has
 *  always been. */
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
const browser = (): Routes => {
  const held: Readonly<Record<string, Reply>> = {
    [BROWSER.dock]: { status: 200, type: `${JS}; charset=utf-8`, body: dockScript() },
    [BROWSER.pane]: fileAt(here.resolve("@wecode/painter/dist/client/terminal.js"), JS),
    [BROWSER.emulator]: fileAt(here.resolve("@xterm/xterm/lib/xterm.mjs"), JS),
    [BROWSER.look]: fileAt(here.resolve("@xterm/xterm/css/xterm.css"), "text/css"),
  };
  return Object.fromEntries(Object.entries(held).map(([at, reply]) => [at, () => reply]));
};

/** The surface, whole: the pages found under `pages/`, and the things that are not pages.
 *  Answering an approval is not a page, the dock's shell is not a page, and neither are the
 *  files the dock's pane is in a browser — none is under `pages/`, none is discovered — so
 *  each is named here, at the path it answers on. */
const routes = {
  ...(await pages(readings)),
  "/answer": answerAt(() => db, operator),
  [SHELL_AT]: shell.route,
  ...browser(),
};

/** The way out, and it is installed before there is a socket to close. Ctrl-C can arrive at
 *  any moment, including the one between binding a port and saying which port it was: a
 *  board interrupted in that window used to die of the signal's own default action, with its
 *  database and the operator's shell left to the operating system to tidy. So the handler
 *  exists first, and copes with a server that is not there yet. */
let server: Server | undefined;
let closed = false;
const leave = (code: number): void => {
  if (closed) process.exit(code);
  closed = true;
  shell.close();
  if (server === undefined) {
    db.close();
    process.exit(code);
  }
  server.close(() => {
    db.close();
    process.exit(code);
  });
};

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => leave(0));

/** One socket, on one host. The pages, the one verb, the dock's shell and the dock's pane
 *  all answer on it, so the shell is reachable exactly where the board is and nowhere else:
 *  a shell given a listener of its own would be a second decision about who can reach the
 *  operator's machine, taken here rather than by whoever passed `--host`. */
server = await serve(routes, port, values.host ?? "127.0.0.1");
process.stdout.write(`workspace ${values.workspace ?? currentWorkspace()} at ${addressOf(server)}\n`);
