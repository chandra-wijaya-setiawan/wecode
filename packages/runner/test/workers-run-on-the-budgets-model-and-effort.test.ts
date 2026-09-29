import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../src/adapter-for.js";
import { DEFAULT_MODEL } from "../src/adapters/claude-code.js";
import { BudgetConfigError, DEFAULT_BUDGET, THINKING_TOKENS, loadBudget, type BudgetConfig } from "../src/budget.js";
import type { Work } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A worker runs on the model and the effort budget.yaml names.
 *
 *  The complaint this answers: the runner built its worker with `new ClaudeCodeAdapter()`,
 *  taking every default the adapter declares for itself. The `effort` the operator had
 *  written in budget.yaml was therefore read by nothing — the file said `low` and every
 *  session still thought at `high` — and the model was a literal in the adapter, which the
 *  operator had no way to change at all. Changing a declaration and seeing nothing change
 *  is worse than having no setting: it is a setting that lies.
 *
 *  Proved through `adapterFor`, which is the whole of that wiring, so no daemon is started:
 *  `bin.ts` around it takes a lease, opens a database and runs a clock.
 *
 *  A shim named `claude`, first on PATH, is how the spawn is read — the adapter is given no
 *  binary here, so what it spawns is resolved by name exactly as on a real machine, and a
 *  script that writes its own argv and environment says precisely what the harness would
 *  have been handed. */

/** A shim `claude` that records its arguments and its environment, and succeeds.
 *
 *  The environment is written first, so argv appearing means both are there. One event is
 *  printed last, because a transcript is only written for a session that says something —
 *  a silent worker would leave nowhere to look for where the transcript went. */
function shim(dir: string): { argv: () => readonly string[]; env: () => Readonly<Record<string, string>> } {
  const bin = join(dir, "claude");
  const argv = join(dir, "argv");
  const env = join(dir, "env");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      "env > " + JSON.stringify(env),
      'printf "%s\\n" "$@" > ' + JSON.stringify(argv),
      "echo '{\"type\":\"system\",\"subtype\":\"init\"}'",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return {
    argv: () => (existsSync(argv) ? readFileSync(argv, "utf8").split("\n").slice(0, -1) : []),
    env: () => {
      const seen: Record<string, string> = {};
      if (!existsSync(env)) return seen;
      for (const line of readFileSync(env, "utf8").split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) seen[line.slice(0, at)] = line.slice(at + 1);
      }
      return seen;
    },
  };
}

function work(dir: string, over: Partial<Work> = {}): Work {
  return {
    id: 1,
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

interface Spawned {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The directory `adapterFor` was told to write transcripts to. */
  readonly logs: string;
}

/** Poll until `ready`, or give up and say so. `start` returns before the child has run, so
 *  nothing the child does is there the moment the call comes back. */
async function until(ready: () => boolean): Promise<boolean> {
  for (let i = 0; i < 400; i++) {
    if (ready()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Start one assignment on the worker this budget builds, and report what was spawned. */
async function spawnedBy(budget: BudgetConfig, over: Partial<Work> = {}): Promise<Spawned> {
  const dir = tmp("budget-model-");
  const logs = join(dir, "logs");
  const seen = shim(dir);
  const path = process.env["PATH"];
  // The shim is found the way the real binary is: by name, on PATH. `environmentFor` builds
  // the child's PATH out of this one, and it is the child's that resolves the spawn.
  process.env["PATH"] = `${dir}${delimiter}${path ?? ""}`;
  try {
    await adapterFor(budget, logs).start(work(dir, over));
    if (!(await until(() => seen.argv().length > 0))) throw new Error("the shim never ran");
    return { argv: seen.argv(), env: seen.env(), logs };
  } finally {
    if (path === undefined) delete process.env["PATH"];
    else process.env["PATH"] = path;
  }
}

/** The value of the one `--model` flag, insisting there is exactly one. */
function modelIn(argv: readonly string[]): string {
  const at = argv.indexOf("--model");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(argv.lastIndexOf("--model")).toBe(at);
  return argv[at + 1] as string;
}

/** A budget.yaml with the given body, loaded. */
function loaded(body: string): BudgetConfig {
  const path = join(tmp("budget-yaml-"), "budget.yaml");
  writeFileSync(path, body);
  return loadBudget(path);
}

describe("the model in budget.yaml", () => {
  it("is read when the operator names one", () => {
    expect(loaded("max_open: 2\nmodel: claude-opus-5-5\n").model).toBe("claude-opus-5-5");
  });

  it("is absent when they do not, so the adapter's declared default stands", () => {
    expect(loaded("max_open: 2\n").model).toBeUndefined();
    expect(DEFAULT_BUDGET.model).toBeUndefined();
  });

  it("is an allowed key beside the others, not an unknown one", () => {
    expect(() => loaded("model: claude-opus-5-5\neffort: low\nmax_open: 2\n")).not.toThrow();
    // And the check still refuses what it was written for, so allowing `model` did not
    // widen it: a key nobody reads is a setting an operator thinks is in force.
    expect(() => loaded("modelo: claude-opus-5-5\n")).toThrow(/unknown key: modelo/);
  });

  it("is refused when it is not a name, rather than reaching the harness as a flag nobody meant", () => {
    for (const body of ["model: 5\n", "model: true\n", "model:\n", 'model: ""\n', "model: '   '\n", "model: [a]\n"]) {
      expect(() => loaded(body), body).toThrow(BudgetConfigError);
      expect(() => loaded(body), body).toThrow(/model must be a non-empty string/);
    }
  });
});

describe("the worker the runner builds from a budget", () => {
  it("spawns claude on the model and at the effort the operator declared", async () => {
    const budget = loaded("max_open: 2\nmodel: claude-opus-5-5\neffort: low\n");

    const spawned = await spawnedBy(budget);

    expect(modelIn(spawned.argv)).toBe("claude-opus-5-5");
    expect(spawned.env["MAX_THINKING_TOKENS"]).toBe("4000");
    // The number is the level's, not this test's arithmetic.
    expect(spawned.env["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS.low));
  });

  it("carries a declared effort other than the default, so the level is genuinely read", async () => {
    const spawned = await spawnedBy(loaded("max_open: 2\neffort: medium\n"));

    expect(spawned.env["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS.medium));
  });

  it("falls back to what the adapter declares when the budget names neither — never to the machine", async () => {
    const budget = loaded("max_open: 2\n");

    const spawned = await spawnedBy(budget);

    expect(modelIn(spawned.argv)).toBe(DEFAULT_MODEL);
    expect(spawned.env["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS[DEFAULT_BUDGET.effort]));
  });

  it("is still beaten by an assignment that names its own model — the record decides before the file", async () => {
    const budget = loaded("max_open: 2\nmodel: claude-opus-5-5\neffort: low\n");

    const spawned = await spawnedBy(budget, { model: "claude-haiku-4-5-20251001" });

    expect(modelIn(spawned.argv)).toBe("claude-haiku-4-5-20251001");
    // The effort is the operator's either way: an assignment does not name one.
    expect(spawned.env["MAX_THINKING_TOKENS"]).toBe(String(THINKING_TOKENS.low));
  });

  it("writes the session's transcript where it was told to, rather than under the working directory", async () => {
    const spawned = await spawnedBy(loaded("max_open: 2\nmodel: claude-opus-5-5\n"));

    // An ignored `sessions` argument is otherwise silent — the spawn still happens and
    // still carries the model — and its only trace is a transcript dropped in whatever
    // directory the process happens to be in, which during a proof is this repository.
    expect(await until(() => existsSync(join(spawned.logs, "assignment-1.jsonl")))).toBe(true);
  });

  it("is sealed and confined as before — building it from the budget gave nothing else away", async () => {
    const spawned = await spawnedBy(loaded("max_open: 2\nmodel: claude-opus-5-5\n"));

    expect(spawned.argv).toContain("--safe-mode");
    expect(spawned.argv[spawned.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(spawned.argv[spawned.argv.indexOf("--allowedTools") + 1]).toBe("Read,Edit");
  });
});

describe("the daemon's own wiring", () => {
  it("builds its worker through that one function, so no default can creep back in", () => {
    const source = readFileSync(new URL("../src/bin.ts", import.meta.url), "utf8");

    expect(source).toMatch(/adapterFor\(budget\b/);
    // The construction left this file: a second `new ClaudeCodeAdapter()` here is exactly
    // the bug — an adapter built without the budget in hand.
    expect(source).not.toMatch(/new ClaudeCodeAdapter\(/);
  });

  it("restates nothing the adapter already declares for itself", () => {
    const source = readFileSync(new URL("../src/adapter-for.ts", import.meta.url), "utf8");

    // What is passed is proved above, by what the spawn was handed. This is the other half:
    // no binary and no permission mode written a second time, so each has one place to
    // change. The shape of the call is deliberately not pinned.
    expect(source).not.toMatch(/"claude"/);
    expect(source).not.toMatch(/acceptEdits/);
  });
});
