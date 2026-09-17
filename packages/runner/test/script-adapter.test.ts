import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptAdapter } from "../src/adapters/script.js";
import type { Observation, WorkerAdapter, Work } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** An assignment of one shell command, in a directory of its own. */
function work(command: string, dir: string, id = 1): Work {
  return {
    id,
    objective_type: "task",
    objective_id: 7,
    instruction: command,
    scope: { write: [], tools: [] },
    budget: { tokens: 0, seconds: 60 },
    worktree: dir,
    session: null,
    history: null,
  };
}

/** Poll until the run is no longer running. The adapter is level-triggered exactly as the
 *  foreman reads it: the observation arrives on a later poll, never from `start`. */
async function settled(adapter: WorkerAdapter, w: Work): Promise<Observation> {
  for (let i = 0; i < 400; i++) {
    const seen = await adapter.poll(w);
    if (seen.phase !== "running") return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the run never ended");
}

describe("the script worker adapter", () => {
  it("is a worker adapter of its own kind", () => {
    const adapter: WorkerAdapter = new ScriptAdapter();
    expect(adapter.kind).toBe("script");
  });

  it("starts the command and returns before it finishes", async () => {
    const dir = tmp("script-start");
    const adapter = new ScriptAdapter(60_000, "bash", join(dir, "logs"));
    const w = work("sleep 0.4; echo done", dir);

    const seen = await adapter.start(w);

    expect(seen.phase).toBe("running");
    expect(await settled(adapter, w)).toMatchObject({ phase: "succeeded" });
  });

  it("runs the command in the assignment's worktree, and keeps its output", async () => {
    const dir = tmp("script-cwd");
    const logs = join(dir, "logs");
    const adapter = new ScriptAdapter(60_000, "bash", logs);
    const w = work("pwd", dir, 42);

    await adapter.start(w);
    await settled(adapter, w);

    expect(readFileSync(join(logs, "assignment-42.log"), "utf8")).toContain(dir);
  });

  it("reports what the exit code says, and reads nothing else", async () => {
    const dir = tmp("script-exit");
    const adapter = new ScriptAdapter(60_000, "bash", join(dir, "logs"));

    // Whichever way the output leans, the exit code is the whole of the observation: an
    // adapter that believed the text would be judging the run instead of reporting it.
    const lying = work("echo 'FAILED: 3 tests red'; exit 0", dir, 1);
    const sulking = work("echo 'all tests passed'; exit 1", dir, 2);

    await adapter.start(lying);
    await adapter.start(sulking);

    expect(await settled(adapter, lying)).toMatchObject({ phase: "succeeded", commit: null });
    expect(await settled(adapter, sulking)).toMatchObject({ phase: "failed", reason: "other" });
  });

  it("never reports a verdict, a commit or a lesson of its own", async () => {
    const dir = tmp("script-silent");
    const adapter = new ScriptAdapter(60_000, "bash", join(dir, "logs"));
    const w = work("echo 'LESSON: trust me'; echo 'the test passes'; exit 0", dir);

    await adapter.start(w);
    const seen = await settled(adapter, w);

    expect(seen).toEqual({
      phase: "succeeded",
      session: "script-1",
      spent: { tokens: 0, seconds: expect.any(Number) },
      commit: null,
    });
    expect(seen).not.toHaveProperty("lesson");
  });

  it("never asks, so it never reaches waiting", async () => {
    const dir = tmp("script-never-asks");
    const adapter = new ScriptAdapter(60_000, "bash", join(dir, "logs"));
    // A command that would make an agent stop and ask: there is nobody to ask, and a
    // script's only answer is its exit code.
    const w = work("read -r answer < /dev/null; exit 0", dir);

    const phases = [(await adapter.start(w)).phase, (await settled(adapter, w)).phase];

    expect(phases).not.toContain("waiting");
    expect(await adapter.answer(w, "yes")).toMatchObject({ phase: "failed", reason: "lost" });
  });

  it("kills the run at its own timeout, whatever the foreman's deadline is", async () => {
    const dir = tmp("script-timeout");
    const adapter = new ScriptAdapter(150, "bash", join(dir, "logs"));
    // Long past any tick, and the budget says an hour: nothing but the adapter's own
    // timeout can end this.
    const w = { ...work("sleep 120", dir), budget: { tokens: 0, seconds: 3600 } };

    await adapter.start(w);
    const seen = await settled(adapter, w);

    expect(seen).toMatchObject({ phase: "failed", reason: "timeout" });
  });

  it("does not let the close its timeout caused overwrite the timeout", async () => {
    const dir = tmp("script-timeout-close");
    const adapter = new ScriptAdapter(150, "bash", join(dir, "logs"));
    const w = work("sleep 120", dir);

    await adapter.start(w);
    const seen = await settled(adapter, w);
    await new Promise((r) => setTimeout(r, 100));

    expect(seen).toMatchObject({ reason: "timeout" });
  });

  it("says lost rather than running the command again", async () => {
    const dir = tmp("script-resume");
    const adapter = new ScriptAdapter(60_000, "bash", join(dir, "logs"));
    const marker = join(dir, "ran");
    const w = { ...work(`touch ${marker}`, dir), session: "script-1" };

    expect(await adapter.resume(w)).toMatchObject({ phase: "failed", reason: "lost" });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("reports a run it has never heard of as lost", async () => {
    const dir = tmp("script-unknown");
    const adapter = new ScriptAdapter(60_000, "bash", join(dir, "logs"));

    expect(await adapter.poll(work("true", dir))).toMatchObject({ phase: "failed", reason: "lost" });
  });

  it("kill stops the run, and nothing is claimed for it", async () => {
    const dir = tmp("script-kill");
    const adapter = new ScriptAdapter(60_000, "bash", join(dir, "logs"));
    const marker = join(dir, "finished");
    const w = work(`sleep 30; touch ${marker}`, dir);

    await adapter.start(w);
    await adapter.kill(w);

    expect(await adapter.poll(w)).toMatchObject({ phase: "failed", reason: "lost" });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("holds nothing it could judge with", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/script.ts"), "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // The record is reached through the engine and the store, and neither is importable
    // from here. Types only out of core: a type cannot enter a verdict.
    for (const forbidden of ["Engine", "DatabaseSync", "queries", "verdict", ".apply("]) {
      expect(code, `script.ts must not mention ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).toContain('import type { Budget } from "@wecode/core"');
    expect(code.match(/^import (?!type )/gm)?.join("\n") ?? "").not.toContain("@wecode/core");
  });
});
