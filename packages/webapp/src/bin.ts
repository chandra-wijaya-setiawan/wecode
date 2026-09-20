#!/usr/bin/env node
/** The board in a browser, wired to a workspace. This file owns the process — which
 *  database, which port, and a socket closed however the process ends. Everything drawn is
 *  a page's under `pages/`, everything routed is `server.ts`'s, and which page answers which
 *  path is here — the one place a reader can see the whole surface at once.
 *
 *  Which workspace, and the refusal to make one, are read the same way `wecode-tui` reads
 *  them: a board is for looking at work that exists, and `open()` would cheerfully write an
 *  empty workspace wherever the operator happened to be standing. */
import { existsSync } from "node:fs";
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
import { boardAt } from "./pages/board.js";
import { decisionsAt } from "./pages/decisions.js";
import { tasksAt } from "./pages/tasks.js";
import { treeAt } from "./pages/tree.js";
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

/** The surface, whole. Each page is read fresh per request, so the routes are bound to a
 *  way of reading the workspace rather than to a reading of it. */
const routes = {
  "/": boardAt(() => board(db)),
  "/tree": treeAt(() => tree(db)),
  "/tasks": tasksAt(() => tree(db)),
  "/decisions": decisionsAt(() => waitingApprovals(db)),
  "/answer": answerAt(() => db, operator),
};

const server = await serve(routes, port, values.host ?? "127.0.0.1");
process.stdout.write(`workspace ${values.workspace ?? currentWorkspace()} at ${addressOf(server)}\n`);

let closed = false;
const leave = (code: number): void => {
  if (closed) process.exit(code);
  closed = true;
  server.close(() => {
    db.close();
    process.exit(code);
  });
};

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => leave(0));
