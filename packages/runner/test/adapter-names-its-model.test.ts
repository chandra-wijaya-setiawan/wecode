import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, DEFAULT_MODEL } from "../src/adapters/claude-code.js";
import type { Work } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** Every Claude Code session names its model, and names the assignment's.
 *
 *  The complaint this answers: the adapter passed no `--model` at all, so which model an
 *  attempt ran on was whatever the machine the daemon woke up on happened to default to —
 *  a settings file in somebody's home directory, a variable inherited from a shell. Two
 *  runs of the same assignment were then not the same assignment, and neither the record
 *  nor the operator could say why one of them failed.
 *
 *  A shim on `bin` is how the flags are read: the adapter spawns whatever binary it was
 *  given, so a script that writes its own argv and exits says exactly what the real
 *  harness would have been told. */

/** A shim `claude` that records its arguments, one per line, and succeeds. */
function shim(dir: string): { bin: string; argv: () => readonly string[] } {
  const bin = join(dir, "claude-shim");
  const out = join(dir, "argv");
  writeFileSync(bin, ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > ' + JSON.stringify(out), "exit 0", ""].join("\n"));
  chmodSync(bin, 0o755);
  return {
    bin,
    argv: () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").slice(0, -1) : []),
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

/** Wait for the shim to have run. `start` returns before the child does. */
async function ran(argv: () => readonly string[]): Promise<readonly string[]> {
  for (let i = 0; i < 400; i++) {
    const seen = argv();
    if (seen.length > 0) return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the shim never ran");
}

/** The value of the one `--model` flag, insisting there is exactly one. */
function modelIn(argv: readonly string[]): string {
  const at = argv.indexOf("--model");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(argv.lastIndexOf("--model")).toBe(at);
  return argv[at + 1] as string;
}

const adapterIn = (dir: string, bin: string): ClaudeCodeAdapter =>
  new ClaudeCodeAdapter(bin, join(dir, "logs"), "acceptEdits");

describe("a Claude Code session's model", () => {
  it("is the one the assignment names, not the harness's own default", async () => {
    const dir = tmp("model-named");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir, { model: "claude-haiku-4-5-20251001" }));

    expect(modelIn(await ran(argv))).toBe("claude-haiku-4-5-20251001");
  });

  it("is the adapter's declared default when the assignment names none — never nothing", async () => {
    const dir = tmp("model-default");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir));

    expect(modelIn(await ran(argv))).toBe(DEFAULT_MODEL);
  });

  it("is the adapter's, when the adapter is configured with one", async () => {
    const dir = tmp("model-configured");
    const { bin, argv } = shim(dir);
    const adapter = new ClaudeCodeAdapter(bin, join(dir, "logs"), "acceptEdits", "claude-sonnet-5");

    await adapter.start(work(dir));

    expect(modelIn(await ran(argv))).toBe("claude-sonnet-5");
  });

  it("is named on a resumed session too, which is where the environment would have crept back in", async () => {
    const dir = tmp("model-resume");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).resume(work(dir, { session: "sess-1", model: "claude-opus-5" }));

    const seen = await ran(argv);
    expect(modelIn(seen)).toBe("claude-opus-5");
    expect(seen).toContain("--resume");
  });

  it("is named when an asking session is answered", async () => {
    const dir = tmp("model-answer");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).answer(work(dir, { session: "sess-1", model: "claude-opus-5" }), "yes, go on");

    const seen = await ran(argv);
    expect(modelIn(seen)).toBe("claude-opus-5");
    expect(seen).toContain("yes, go on");
  });

  it("does not disturb the flags the scope becomes", async () => {
    const dir = tmp("model-with-scope");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir, { model: "claude-sonnet-5" }));

    const seen = await ran(argv);
    expect(seen).toContain("--allowedTools");
    expect(seen[seen.indexOf("--allowedTools") + 1]).toBe("Read,Edit");
    expect(seen[seen.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(seen[seen.indexOf("--add-dir") + 1]).toBe(dir);
  });
});

describe("the adapter's model flag", () => {
  it("is passed in the one place every session is spawned, so no entry point can omit it", () => {
    const source = readFileSync(new URL("../src/adapters/claude-code.ts", import.meta.url), "utf8");
    // One occurrence, in `spawn`. A second would be a second way for a caller to be wrong.
    expect(source.match(/"--model"/g)).toHaveLength(1);
    expect(source).toContain('spawnProcess(this.bin, ["--model", work.model ?? this.model, ...args]');
  });
});
