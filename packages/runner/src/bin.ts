#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentDatabase, open } from "@wecode/core";
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

// The workspace, not a repository: one runner serves every project in it, under one
// attention budget — which is the budget of one person.
const dbPath = values.db ?? currentDatabase();
// The attention budget is one person's, so it belongs to the workspace — not to whichever
// directory the runner happened to be started in. A project's own config/budget.yaml is
// the fallback, for a workspace that has never had one written.
const workspaceBudget = join(dirname(currentDatabase()), "budget.yaml");
const budgetPath =
  values.budget ??
  (existsSync(workspaceBudget) ? workspaceBudget : resolve(process.cwd(), "config/budget.yaml"));

if (!existsSync(dbPath)) {
  process.stderr.write(`no wecode workspace at ${dbPath}\n  wecode onboard   in a repository\n`);
  process.exit(1);
}

const db = open(dbPath);
const budget = existsSync(budgetPath) ? loadBudget(budgetPath) : DEFAULT_BUDGET;

const runner = new Runner(db, {
  budget,
  adapters: { agent: new ClaudeCodeAdapter() },
  ...(values.root === undefined ? {} : { repoRoot: values.root }),
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
    t.settled.length > 0 ? `settled ${t.settled.join(", ")}` : null,
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
  process.stdout.write(
    `wecode-runner  ${dbPath}\n  budget ${budgetPath}  max_open ${budget.max_open}  every ${everyMs / 1000}s\n`,
  );
  await loop(runner, everyMs, stop.signal, say);
}

db.close();
