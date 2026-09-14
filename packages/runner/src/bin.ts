#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildBehind,
  buildSha,
  currentDatabase,
  heldMessage,
  open,
  readLease,
  recordBuildDrift,
  releaseLease,
  renewLease,
  runnerId,
  takeLease,
} from "@wecode/core";
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

const everyMs = Number(values.interval ?? 15) * 1000;

// One runner per workspace. Two of them mark each other's sessions lost — each polls, finds
// a session it has no memory of starting, and calls it lost — so the second must not start
// at all rather than start and be careful.
const me = runnerId();
// The commit this process was built from, resolved once, here, before any work: a checkout
// moves on under a running process and the lease must say what is running, not what is
// checked out. Nothing below ever restarts on account of it — a runner that replaces itself
// mid-attempt is a worse problem than a stale one — it only tells the truth about itself.
const built = buildSha();
const taken = takeLease(db, me, everyMs, undefined, built);
if (!taken.ok) {
  process.stderr.write(`${heldMessage(taken.held, taken.ageMs)}\n`);
  db.close();
  process.exit(1);
}

const letGo = (): void => releaseLease(db, me);

// Measured by the holder, because the holder is the one reader with a repository to ask:
// the cockpit is opened wherever the operator is standing. Re-measured every tick, so the
// drift a person sees grows as the base does rather than dating from startup.
const measure = (): void => recordBuildDrift(db, me, buildBehind(built));
const describeBuild = (): string => {
  if (built === null) return "  build unknown\n";
  const behind = buildBehind(built);
  const drift = behind === null || behind === 0 ? "" : `  ${behind} behind the base — a restart is owed`;
  return `  build ${built.slice(0, 12)}${drift}\n`;
};

measure();

if (values.once === true) {
  say(await runner.tick());
  letGo();
} else {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => (letGo(), stop.abort()));
  }
  process.stdout.write(
    `wecode-runner  ${dbPath}\n  budget ${budgetPath}  max_open ${budget.max_open}  every ${everyMs / 1000}s\n  lease ${me}\n${describeBuild()}`,
  );
  // Renewed on every tick, from the same loop that does the work: a runner that is wedged
  // stops renewing, and the lease goes stale, which is the point of measuring it in ticks.
  await loop(runner, everyMs, stop.signal, (t) => {
    if (!stop.signal.aborted && !renewLease(db, me)) {
      const holder = readLease(db)?.holder ?? "nobody";
      process.stderr.write(`lost the runner lease to ${holder} — stopping\n`);
      stop.abort();
    }
    if (!stop.signal.aborted) measure();
    say(t);
  });
  letGo();
}

db.close();
