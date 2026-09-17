import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, INHERITED, environmentFor } from "../src/adapters/claude-code.js";
import { DEFAULT_BUDGET, THINKING_TOKENS, loadBudget } from "../src/budget.js";
import type { Work } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A worker's environment is built, and its effort is stated.
 *
 *  The complaint this answers: `spawnProcess` was given `cwd` and `stdio` and no `env`, so
 *  the session inherited every variable of whichever shell started the daemon — a settings
 *  path, a proxy, a half-finished login, a thinking budget somebody exported months ago.
 *  Two runs of one assignment were then not one assignment, and no attempt's outcome could
 *  be attributed to the work rather than to the machine.
 *
 *  A shim on `bin` reads the answer: the adapter spawns whatever binary it was given, so a
 *  script that writes its own environment says exactly what the real harness would have
 *  been handed. */

/** A shim `claude` that records its environment, one `NAME=value` per line, and succeeds. */
function shim(dir: string): { bin: string; env: () => Readonly<Record<string, string>> | null } {
  const bin = join(dir, "claude-shim");
  const out = join(dir, "env");
  writeFileSync(bin, ["#!/usr/bin/env bash", "env > " + JSON.stringify(out), "exit 0", ""].join("\n"));
  chmodSync(bin, 0o755);
  return {
    bin,
    env: () => {
      if (!existsSync(out)) return null;
      const seen: Record<string, string> = {};
      for (const line of readFileSync(out, "utf8").split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) seen[line.slice(0, at)] = line.slice(at + 1);
      }
      return Object.keys(seen).length === 0 ? null : seen;
    },
  };
}

function work(dir: string, over: Partial<Work> = {}): Work {
  return {
    id: 42,
    objective_type: "task",
    objective_id: 7,
    instruction: "make the thing",
    scope: { write: ["packages/runner/src/**"], tools: ["read", "edit"] },
    budget: { tokens: 1000, seconds: 60 },
    worktree: dir,
    session: null,
    history: null,
    ...over,
  };
}

/** Wait for the shim to have run. `start` returns before the child does. */
async function ran(env: () => Readonly<Record<string, string>> | null): Promise<Readonly<Record<string, string>>> {
  for (let i = 0; i < 400; i++) {
    const seen = env();
    if (seen !== null) return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the shim never ran");
}

describe("the environment a Claude Code session is spawned with", () => {
  it("carries the effort, and the assignment it is being spent on", async () => {
    const dir = tmp("env-built");
    const { bin, env } = shim(dir);

    await new ClaudeCodeAdapter(bin, join(dir, "logs"), "acceptEdits", "claude-opus-5", "low").start(work(dir));

    const seen = await ran(env);
    expect(seen["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS.low));
    expect(seen["WECODE_ASSIGNMENT"]).toBe("42");
    expect(seen["WECODE_WORKTREE"]).toBe(dir);
  });

  it("states the declared effort when the adapter is configured with none", async () => {
    const dir = tmp("env-default-effort");
    const { bin, env } = shim(dir);

    await new ClaudeCodeAdapter(bin, join(dir, "logs")).start(work(dir));

    const seen = await ran(env);
    expect(seen["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS[DEFAULT_BUDGET.effort]));
  });

  it("does not carry a variable of the daemon's that nothing here asked for", async () => {
    const dir = tmp("env-not-inherited");
    const { bin, env } = shim(dir);
    // Set on the runner's own process: the leak this story is about.
    process.env["WECODE_TEST_LEAK"] = "from the daemon's shell";
    process.env["MAX_THINKING_TOKENS"] = "1";
    try {
      await new ClaudeCodeAdapter(bin, join(dir, "logs"), "acceptEdits", "claude-opus-5", "high").start(work(dir));

      const seen = await ran(env);
      expect(seen["WECODE_TEST_LEAK"]).toBeUndefined();
      // The built value wins over the one that was already in the environment.
      expect(seen["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS.high));
    } finally {
      delete process.env["WECODE_TEST_LEAK"];
      delete process.env["MAX_THINKING_TOKENS"];
    }
  });

  it("carries the few variables without which the harness could not start", async () => {
    const dir = tmp("env-inherited");
    const { bin, env } = shim(dir);

    await new ClaudeCodeAdapter(bin, join(dir, "logs")).start(work(dir));

    const seen = await ran(env);
    expect(seen["PATH"]).toBe(process.env["PATH"]);
    expect(seen["HOME"]).toBe(process.env["HOME"]);
    // Bash sets a handful of its own (`_`, `PWD`, `SHLVL`): every other name is ours.
    const ours = Object.keys(seen).filter((k) => !["_", "PWD", "SHLVL"].includes(k));
    for (const name of ours) {
      expect(INHERITED.concat(["MAX_THINKING_TOKENS", "WECODE_ASSIGNMENT", "WECODE_WORKTREE"])).toContain(name);
    }
  });
});

describe("the built environment", () => {
  it("passes through only a named variable, and only when the runner has it", () => {
    const built = environmentFor(work("/w"), "medium", { PATH: "/bin", SOMETHING_ELSE: "x" });

    expect(built["PATH"]).toBe("/bin");
    expect(built["SOMETHING_ELSE"]).toBeUndefined();
    expect(built["HOME"]).toBeUndefined();
    expect(built["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS.medium));
  });

  it("is built at the one place a session is spawned, so no entry point can inherit instead", () => {
    const source = readFileSync(new URL("../src/adapters/claude-code.ts", import.meta.url), "utf8");
    // Every spawn in the file names an env. Two spawns, two `env:`.
    expect(source.match(/spawnProcess\(/g)).toHaveLength(2);
    expect(source.match(/env: environmentFor\(work, this\.effort\)/g)).toHaveLength(2);
  });

  it("names no thinking budget of its own — the number is the operator's, in budget.yaml", () => {
    const source = readFileSync(new URL("../src/adapters/claude-code.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/MAX_THINKING_TOKENS"\] = "\d/);
  });
});

describe("the effort in budget.yaml", () => {
  it("is read when the operator sets one, and defaults when they do not", () => {
    const dir = tmp("effort-config");
    const path = join(dir, "budget.yaml");

    writeFileSync(path, "max_open: 2\neffort: low\n");
    expect(loadBudget(path).effort).toBe("low");

    writeFileSync(path, "max_open: 2\n");
    expect(loadBudget(path).effort).toBe(DEFAULT_BUDGET.effort);
  });

  it("is refused when it is not one of the levels, rather than silently meaning nothing", () => {
    const dir = tmp("effort-bad");
    const path = join(dir, "budget.yaml");
    writeFileSync(path, "effort: enormous\n");

    expect(() => loadBudget(path)).toThrow(/effort must be one of/);
  });
});
