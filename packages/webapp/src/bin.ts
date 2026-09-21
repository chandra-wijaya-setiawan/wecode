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

/** The surface, whole: the pages found under `pages/`, and the two things that are not
 *  pages. Answering an approval is not a page and neither is the dock's shell — neither is
 *  under `pages/` and neither is discovered — so both are named, at the paths they answer
 *  on. */
const routes = {
  ...(await pages(readings)),
  "/answer": answerAt(() => db, operator),
  [SHELL_AT]: shell.route,
};

/** One socket, on one host. The pages, the one verb and the dock's shell all answer on it,
 *  so the shell is reachable exactly where the board is and nowhere else: a shell given a
 *  listener of its own would be a second decision about who can reach the operator's
 *  machine, taken here rather than by whoever passed `--host`. */
const server = await serve(routes, port, values.host ?? "127.0.0.1");
process.stdout.write(`workspace ${values.workspace ?? currentWorkspace()} at ${addressOf(server)}\n`);

let closed = false;
const leave = (code: number): void => {
  if (closed) process.exit(code);
  closed = true;
  shell.close();
  server.close(() => {
    db.close();
    process.exit(code);
  });
};

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => leave(0));
