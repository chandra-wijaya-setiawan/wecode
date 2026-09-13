#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { open } from "@wecode/core";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { DEFAULT_BUDGET, loadBudget } from "./budget.js";
import { loop, Runner, type Tick } from "./daemon.js";

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.emitWarning(w);
});

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    budget: { type: "string" },
    interval: { type: "string" },
    once: { type: "boolean" },
    root: { type: "string" },
  },
});

const dbPath = values.db ?? process.env["WECODE_DB"] ?? resolve(process.cwd(), ".wecode/wecode.db");
const budgetPath = values.budget ?? resolve(process.cwd(), "config/budget.yaml");
const repoRoot = values.root ?? process.cwd();

const db = open(dbPath);
const budget = existsSync(budgetPath) ? loadBudget(budgetPath) : DEFAULT_BUDGET;

const runner = new Runner(db, {
  budget,
  repoRoot,
  worktreeRoot: resolve(repoRoot, ".wecode/worktrees"),
  adapters: { agent: new ClaudeCodeAdapter() },
});

const say = (t: Tick): void => {
  const parts = [
    t.allocated.created !== null ? `allocated #${t.allocated.created}` : null,
    t.foreman.started.length > 0 ? `started ${t.foreman.started.join(",")}` : null,
    t.foreman.failed.length > 0 ? `failed ${t.foreman.failed.join(",")}` : null,
    t.scripts.passed.length > 0 ? `passed ${t.scripts.passed.join(",")}` : null,
    t.scripts.failed.length > 0 ? `test failed ${t.scripts.failed.join(",")}` : null,
    t.merged.length > 0 ? `merged ${t.merged.join(",")}` : null,
    t.exhausted.length > 0 ? `out of attempts ${t.exhausted.join(",")}` : null,
  ].filter((p) => p !== null);
  if (parts.length === 0) return; // a quiet tick says nothing
  process.stdout.write(`${new Date().toISOString()}  ${parts.join("  ")}\n`);
};

if (values.once === true) {
  say(await runner.tick());
} else {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => stop.abort());
  }
  const everyMs = Number(values.interval ?? 15) * 1000;
  process.stdout.write(`wecode-runner  every ${everyMs / 1000}s  max_open ${budget.max_open}\n`);
  await loop(runner, everyMs, stop.signal, say);
}

db.close();
