#!/usr/bin/env node
import { run } from "./run.js";

// node:sqlite is experimental and says so on every invocation. The operator is not the one
// who chose it; the warning is noise on a tool they run all day.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.emitWarning(w);
});

process.exitCode = run(process.argv.slice(2));
