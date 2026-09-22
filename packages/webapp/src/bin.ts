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
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname } from "node:path";
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
import { answerAt } from "./answer.js";
import { browser, docked } from "./browser/dock.js";
import { pages } from "./pages/discover.js";
import { SHELL_AT, shellAt } from "./pages/shell.js";
import { addressOf, serve } from "./server.js";

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

/** The surface, whole: the pages found under `pages/`, and the things that are not pages.
 *  Answering an approval is not a page, the dock's shell is not a page, and neither are the
 *  files the dock's pane is in a browser — none is under `pages/`, none is discovered — so
 *  each is named here, at the path it answers on.
 *
 *  What a browser is sent for the dock is `browser/dock.ts`'s, whole: `browser()` is those
 *  four files at the four paths they answer on, and `docked` is the one line that asks for
 *  the first of them, in every document the pages hand back. That line is not in
 *  `document()` — a document is `renderers.webapp.shell`'s sentence and a page is a fragment
 *  of one, so what the wiring adds is added here, to the replies, and the pages and the
 *  shell go on saying exactly what they said. */
const routes = {
  ...docked(await pages(readings)),
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
