#!/usr/bin/env node
import { resolve } from "node:path";
import { board, open } from "@wecode/core";
import { clear, render } from "./render.js";
import { loadViews } from "./views.js";

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.emitWarning(w);
});

const dbPath = process.env["WECODE_DB"] ?? resolve(process.cwd(), ".wecode/wecode.db");
const db = open(dbPath);
const views = loadViews();

const draw = (): void => {
  const width = process.stdout.columns ?? 100;
  process.stdout.write(clear + render(board(db), views, width, dbPath));
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
