#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { board, currentDatabase, databaseOf, currentWorkspace, listWorkspaces, open } from "@wecode/core";
import { clear, render } from "./render.js";
import { loadViews } from "./views.js";

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
const wsName = values.workspace ?? currentWorkspace();
const views = loadViews();

const draw = (): void => {
  const width = process.stdout.columns ?? 100;
  process.stdout.write(clear + render(board(db), views, width, `workspace ${wsName}`));
  process.stdout.write("\u001b[2m  q quit  r refresh\u001b[0m\n");
};

draw();
const timer = setInterval(draw, 2000);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (key: Buffer) => {
    const k = key.toString();
    if (k === "q" || k === "\u0003") {
      clearInterval(timer);
      process.stdout.write("\u001b[?25h\n");
      process.exit(0);
    }
    if (k === "r") draw();
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  });
}
