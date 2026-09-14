#!/usr/bin/env node
/** The cockpit, wired to a terminal. Everything decided lives in App, everything drawn in
 *  screens.ts; this file only owns the terminal — raw keys in, a frame out, and a terminal
 *  left the way it was found however the process ends. */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { currentDatabase, databaseOf, currentWorkspace, listWorkspaces, open } from "@wecode/core";
import { App } from "./app.js";
import { draw } from "./screens.js";
import { loadViews } from "./views.js";

const CSI = "\u001b[";
const HOME = `${CSI}2J${CSI}H`;
const HIDE = `${CSI}?25l`;
const SHOW = `${CSI}?25h`;
/** Work moves without a keystroke, so the frame cannot only be redrawn by one. */
const TICK = 2000;

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.emitWarning(w);
});

const { values } = parseArgs({
  options: { workspace: { type: "string" }, db: { type: "string" } },
});

const dbPath =
  values.db ?? (values.workspace === undefined ? currentDatabase() : databaseOf(values.workspace));

// Never create one. A board is for looking at work that exists, and open() would happily
// write an empty workspace wherever you happened to be standing.
if (!existsSync(dbPath)) {
  const known = listWorkspaces();
  process.stderr.write(
    `no wecode workspace at ${dbPath}\n` +
      (known.length === 0
        ? "  wecode onboard   in a repository, to make one\n"
        : `  workspaces: ${known.join(", ")}\n  wecode-tui --workspace <name>\n`),
  );
  process.exit(1);
}

const db = open(dbPath);
const app = new App(db, loadViews());
// The frame has one line for a message and no other place to say where you are, so the
// workspace is the first thing it says and the first key replaces it.
app.status = `workspace ${values.workspace ?? currentWorkspace()}`;

const frame = (): void => {
  const width = process.stdout.columns ?? 100;
  const height = process.stdout.rows ?? 24;
  process.stdout.write(HOME + draw(app, width, height));
};

let closed = false;
/** The one way out. A terminal left in raw mode with no cursor is a shell the operator has
 *  to kill, so every exit — a key, a signal, an error — comes through here. */
const leave = (code: number): void => {
  if (!closed) {
    closed = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${SHOW}${HOME}`);
    db.close();
  }
  process.exit(code);
};

process.stdout.write(HIDE);
frame();

const timer = setInterval(() => {
  app.refresh();
  frame();
}, TICK);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk: Buffer) => {
  // A paste, or an arrow key, arrives as one chunk of several characters. Each is a key.
  for (const k of chunk.toString()) {
    if (k === "\u0003") return leave(0);
    app.key(k);
    if (app.quit) return leave(0);
  }
  frame();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => leave(0));
