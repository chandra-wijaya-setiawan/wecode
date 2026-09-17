import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import { hasWriteDenials } from "../src/adapters/denials.js";
import type { History, Observation, WorkerAdapter, Work } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** One call the fake harness was made: where it ran, and what it was given. */
interface Call {
  readonly cwd: string;
  readonly args: readonly string[];
}

/** A harness that is not Codex.
 *
 *  It records every call — cwd and argv, NUL-delimited, because the prompt is a paragraph
 *  with newlines in it — then prints the events the test gave it and exits with the code
 *  the test gave it. That is the whole of what the adapter's side of the contract is: a
 *  binary that takes flags and prints JSONL. Running the real Codex would prove the model
 *  rather than the adapter, and would need a network, a key and somebody's money.
 *
 *  It is handed over as `bin`, not on PATH: the adapter takes the binary to start, so a
 *  fake needs no shim and no environment. */
function fakeCodex(opts: { events?: readonly string[]; exit?: number; delayMs?: number } = {}) {
  const dir = tmp("codex-fake-");
  const calls = join(dir, "calls");
  const events = join(dir, "events.jsonl");
  const bin = join(dir, "codex");

  writeFileSync(events, (opts.events ?? []).join("\n") + (opts.events?.length ? "\n" : ""));
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `{ printf 'CALL\\0%s\\0' "$PWD"; printf '%s\\0' "$@"; } >> ${JSON.stringify(calls)}`,
      `cat ${JSON.stringify(events)}`,
      // After the events, never before: the real harness names the thread on its first
      // line, and a fake that went quiet first would let the adapter pass this by waiting.
      ...(opts.delayMs === undefined ? [] : [`sleep ${opts.delayMs / 1000}`]),
      `exit ${opts.exit ?? 0}`,
      "",
    ].join("\n"),
  );
  // A new script lands 644, and an adapter that spawned it would report failed/lost.
  chmodSync(bin, 0o755);

  return {
    bin,
    logDir: join(dir, "logs"),
    /** Every call so far, in order. */
    calls(): readonly Call[] {
      let raw: string;
      try {
        raw = readFileSync(calls, "utf8");
      } catch {
        return [];
      }
      const out: Call[] = [];
      const tokens = raw.split("\0").slice(0, -1);
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== "CALL") continue;
        const args: string[] = [];
        let j = i + 2;
        for (; j < tokens.length && tokens[j] !== "CALL"; j++) args.push(tokens[j] as string);
        out.push({ cwd: tokens[i + 1] as string, args });
        i = j - 1;
      }
      return out;
    },
  };
}

function work(dir: string, over: Partial<Work> = {}): Work {
  return {
    id: 1,
    objective_type: "task",
    objective_id: 7,
    instruction: "make the adapter real",
    scope: { write: ["packages/runner/src/adapters/codex.ts"], tools: ["read", "write", "bash"] },
    budget: { tokens: 40_000, seconds: 900 },
    worktree: dir,
    session: null,
    history: null,
    ...over,
  };
}

/** Poll until the session is no longer running. The adapter is level-triggered exactly as
 *  the foreman reads it: the observation arrives on a later poll, never from `start`. */
async function settled(adapter: WorkerAdapter, w: Work): Promise<Observation> {
  for (let i = 0; i < 400; i++) {
    const seen = await adapter.poll(w);
    if (seen.phase !== "running") return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the session never ended");
}

/** Poll until the adapter has read the session id out of the stream. */
async function identified(adapter: WorkerAdapter, w: Work): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const seen = await adapter.poll(w);
    if (seen.session !== null && seen.session !== "") return seen.session;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the session was never identified");
}

/** The newer event shape: flat, and a `thread_id`. */
const NEW = [
  '{"type":"thread.started","thread_id":"th_42"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"done\\nLESSON: codex takes -C"}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
];

/** The older one: everything inside `msg`, and a `session_id`. */
const OLD = [
  '{"id":"0","msg":{"type":"session_configured","session_id":"sess-9"}}',
  '{"id":"1","msg":{"type":"agent_message","message":"all good"}}',
  '{"id":"2","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7,"output_tokens":3}}}}',
];

const flat = (call: Call | undefined): string => (call?.args ?? []).join(" ");

describe("the codex worker adapter", () => {
  it("is a worker adapter, of the same kind as the other harness", () => {
    const adapter: WorkerAdapter = new CodexAdapter();
    // Not "codex": the kind is what the worker is and the harness is which binary starts
    // it, so the foreman's map — keyed by the worker's kind — can hold either.
    expect(adapter.kind).toBe("agent");
  });

  it("starts a non-interactive session in the assignment's worktree and returns at once", async () => {
    const dir = tmp("codex-start");
    const fake = fakeCodex({ events: NEW, delayMs: 300 });
    const adapter = new CodexAdapter(fake.bin, fake.logDir);
    const w = work(dir);

    const seen = await adapter.start(w);

    expect(seen.phase).toBe("running");
    expect(await settled(adapter, w)).toMatchObject({ phase: "succeeded" });
    const call = fake.calls()[0];
    expect(call?.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(call?.cwd).toBe(dir);
  });

  describe("a scope, as flags", () => {
    it("confines a writing role to the worktree and never asks anybody", async () => {
      const dir = tmp("codex-sandbox-write");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);

      await adapter.start(work(dir));
      await settled(adapter, work(dir));

      expect(flat(fake.calls()[0])).toContain(`-C ${dir}`);
      expect(flat(fake.calls()[0])).toContain("--sandbox workspace-write");
      // Nobody is at the terminal: an agent that stops to ask has burned the attempt.
      expect(flat(fake.calls()[0])).toContain("--ask-for-approval never");
      expect(flat(fake.calls()[0])).not.toContain("danger-full-access");
    });

    it("gives a role that may not write a read-only sandbox", async () => {
      const dir = tmp("codex-sandbox-read");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir, { scope: { write: [], tools: ["read", "grep", "bash"] } });

      await adapter.start(w);
      await settled(adapter, w);

      expect(flat(fake.calls()[0])).toContain("--sandbox read-only");
    });

    it("passes the tools Codex spells as a flag, and withholds no name it has no list for", async () => {
      const dir = tmp("codex-tools");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir, { scope: { write: ["src/**"], tools: ["read", "websearch", "glob"] } });

      await adapter.start(w);
      await settled(adapter, w);

      const args = fake.calls()[0]?.args ?? [];
      expect(args).toContain("--search");
      // There is no `--allowedTools` here. Codex has no per-tool allowlist, so inventing
      // one would be this adapter reporting a confinement the harness is not holding.
      expect(flat(fake.calls()[0])).not.toContain("--allowedTools");
      expect(args).not.toContain("glob");
    });
  });

  describe("the brief", () => {
    const briefOf = async (over: Partial<Work> = {}): Promise<string> => {
      const dir = tmp("codex-brief");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir, over);
      await adapter.start(w);
      await settled(adapter, w);
      // The prompt is positional and last, which is where `codex exec` takes it.
      return (fake.calls()[0]?.args ?? []).at(-1) ?? "";
    };

    it("carries every requirement an agent gets through any harness", async () => {
      const brief = await briefOf({ lessons: ["the repo has no prettier config"] });

      expect(brief).toContain("make the adapter real");
      expect(brief).toContain("What earlier attempts on this repository learned:");
      expect(brief).toContain("- the repo has no prettier config");
      expect(brief).toContain("You may change only: packages/runner/src/adapters/codex.ts.");
      expect(brief).toContain("Write the tests that prove this work, and run them.");
      expect(brief).toContain("If you need a decision from a person, say so and stop rather than guessing.");
      expect(brief).toContain("end your final message with a single line beginning LESSON:");
    });

    it("says nothing about lessons or earlier attempts when there are none", async () => {
      const brief = await briefOf();

      expect(brief).not.toContain("earlier attempts");
      expect(brief).not.toContain("What happened before");
      expect(brief).toContain("You may change only:");
    });

    it("points a retry at the commit the last attempt left, and at what is still red", async () => {
      const history: History = {
        attempts: 2,
        reason: "timeout",
        commit: "deadbee",
        failures: [{ statement: "the adapter reports the session id", line: "expected '' to be 'th_42'" }],
      };
      const brief = await briefOf({ history });

      expect(brief).toContain("This is attempt 3; 2 have already been made.");
      expect(brief).toContain("git show deadbee");
      expect(brief).toContain("It ended: timeout.");
      expect(brief).toContain("- the adapter reports the session id — expected '' to be 'th_42'");
    });

    it("says so when the last attempt left no commit", async () => {
      const brief = await briefOf({
        history: { attempts: 1, reason: "other", commit: null, failures: [] },
      });

      expect(brief).toContain("This is attempt 2; one has already been made.");
      expect(brief).toContain("The last attempt left no commit on this branch.");
    });

    it("says (nothing) rather than an empty scope line", async () => {
      expect(await briefOf({ scope: { write: [], tools: ["read"] } })).toContain(
        "You may change only: (nothing).",
      );
    });
  });

  describe("what it reads off the stream", () => {
    it("takes the session id and the spend from the newer event shape", async () => {
      const dir = tmp("codex-new");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({
        phase: "succeeded",
        session: "th_42",
        spent: { tokens: 120, seconds: 0 },
        commit: null,
      });
    });

    it("takes them from the older one too, because the adapter is where a version lives", async () => {
      const dir = tmp("codex-old");
      const fake = fakeCodex({ events: OLD });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({ session: "sess-9", spent: { tokens: 10, seconds: 0 } });
    });

    it("reports the total once rather than adding up every report of it", async () => {
      const dir = tmp("codex-total");
      const fake = fakeCodex({
        events: [
          '{"type":"thread.started","thread_id":"th_1"}',
          '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":0}}',
          '{"type":"turn.completed","usage":{"input_tokens":140,"output_tokens":10}}',
        ],
      });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      // 150, the last total — not 250, the sum of two reports of the same thread.
      expect((await settled(adapter, w)).spent.tokens).toBe(150);
    });

    it("takes the lesson the session ended with, and invents none", async () => {
      const dir = tmp("codex-lesson");
      const fake = fakeCodex({ events: NEW });
      const quiet = fakeCodex({ events: OLD });
      const said = new CodexAdapter(fake.bin, fake.logDir);
      const silent = new CodexAdapter(quiet.bin, quiet.logDir);
      const w = work(dir);

      await said.start(w);
      await silent.start(w);

      expect(await settled(said, w)).toMatchObject({ lesson: "codex takes -C" });
      expect(await settled(silent, w)).not.toHaveProperty("lesson");
    });

    it("keeps the session's own transcript beside the assignment", async () => {
      const dir = tmp("codex-log");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir, { id: 42 });

      await adapter.start(w);
      await settled(adapter, w);

      expect(readFileSync(join(fake.logDir, "assignment-42.jsonl"), "utf8")).toContain("th_42");
    });

    it("is not hurt by a line that is not an event", async () => {
      const dir = tmp("codex-noise");
      const fake = fakeCodex({
        events: ["Reading config...", "", '{"type":"thread.started","thread_id":"th_3"}', "null", "{oops"],
      });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({ phase: "succeeded", session: "th_3" });
    });
  });

  describe("how a session ends", () => {
    it("reports a clean exit as the session ending, and claims no commit for it", async () => {
      const dir = tmp("codex-clean");
      const fake = fakeCodex({ events: NEW, exit: 0 });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      // Exit 0 means the session ended, not that the work is done: the test decides that,
      // so there is no verdict and no commit here.
      expect(await settled(adapter, w)).toMatchObject({ phase: "succeeded", commit: null });
    });

    it("reports a bad exit as failed, and still carries the lesson", async () => {
      const dir = tmp("codex-bad");
      const fake = fakeCodex({ events: NEW, exit: 1 });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({
        phase: "failed",
        reason: "other",
        session: "th_42",
        lesson: "codex takes -C",
      });
    });

    it("reports a harness it could not start as lost", async () => {
      const dir = tmp("codex-missing");
      const adapter = new CodexAdapter(join(dir, "no-such-codex"), join(dir, "logs"));
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({ phase: "failed", reason: "lost" });
    });

    it("reports a session it has never heard of as lost", async () => {
      const dir = tmp("codex-unknown");
      const fake = fakeCodex();
      const adapter = new CodexAdapter(fake.bin, fake.logDir);

      expect(await adapter.poll(work(dir, { session: "th_9" }))).toMatchObject({
        phase: "failed",
        reason: "lost",
        session: "th_9",
      });
    });
  });

  describe("picking a session back up", () => {
    it("continues the thread rather than beginning it again", async () => {
      const dir = tmp("codex-resume");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir, { session: "th_42" });

      const seen = await adapter.resume(w);
      await settled(adapter, w);

      expect(seen.phase).toBe("running");
      expect(fake.calls()[0]?.args.slice(0, 3)).toEqual(["exec", "resume", "th_42"]);
      // The resumed run still needs to know what it is for.
      expect((fake.calls()[0]?.args ?? []).at(-1)).toContain("make the adapter real");
    });

    it("says lost when there is no session to resume", async () => {
      const dir = tmp("codex-resume-none");
      const fake = fakeCodex();
      const adapter = new CodexAdapter(fake.bin, fake.logDir);

      expect(await adapter.resume(work(dir))).toMatchObject({ phase: "failed", reason: "lost" });
      expect(fake.calls()).toEqual([]);
    });
  });

  describe("answering", () => {
    it("hands the answer to the session that asked, which carries on", async () => {
      const dir = tmp("codex-answer-live");
      const fake = fakeCodex({ events: NEW, delayMs: 1500 });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);
      await identified(adapter, w);
      const seen = await adapter.answer(w, "yes, drop the column");

      expect(seen).toMatchObject({ phase: "running", session: "th_42" });
      expect(fake.calls()[1]?.args).toEqual(["queue", "th_42", "yes, drop the column"]);
      // One session, not two: queueing does not start the harness again.
      expect(fake.calls().filter((c) => c.args[0] === "exec")).toHaveLength(1);
      await adapter.kill(w);
    }, 15_000);

    it("delivers it as the prompt of a continued thread when the session is not ours", async () => {
      const dir = tmp("codex-answer-cold");
      const fake = fakeCodex({ events: NEW });
      const adapter = new CodexAdapter(fake.bin, fake.logDir);
      const w = work(dir, { session: "th_42" });

      const seen = await adapter.answer(w, "yes, drop the column");
      await settled(adapter, w);

      expect(seen.phase).toBe("running");
      expect(fake.calls()[0]?.args.slice(0, 3)).toEqual(["exec", "resume", "th_42"]);
      expect((fake.calls()[0]?.args ?? []).at(-1)).toBe("yes, drop the column");
    });

    it("says lost when there is no session an answer could be for", async () => {
      const dir = tmp("codex-answer-none");
      const fake = fakeCodex();
      const adapter = new CodexAdapter(fake.bin, fake.logDir);

      expect(await adapter.answer(work(dir), "yes")).toMatchObject({ phase: "failed", reason: "lost" });
      expect(fake.calls()).toEqual([]);
    });
  });

  it("kills the process, because there is no session server to tell", async () => {
    const dir = tmp("codex-kill");
    const fake = fakeCodex({ events: NEW, delayMs: 10_000 });
    const adapter = new CodexAdapter(fake.bin, fake.logDir);
    const w = work(dir);

    await adapter.start(w);
    await identified(adapter, w);
    await adapter.kill(w);

    expect(await adapter.poll(w)).toMatchObject({ phase: "failed", reason: "lost" });
    expect(fake.calls().map((c) => c.args[0])).toEqual(["exec"]);
  }, 15_000);

  it("offers no reading of which writes were refused, because it cannot see one", () => {
    // Codex confines by sandbox, and a sandbox that refuses a write does not name the path
    // it refused. `WriteDenials` is structural for exactly this reason: an adapter that
    // cannot observe a denial must not be made to pretend it can, and the foreman asks
    // only whoever can answer.
    expect(hasWriteDenials(new CodexAdapter())).toBe(false);
  });

  it("holds nothing it could judge with", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/codex.ts"), "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // The record is reached through the engine and the store, and neither is importable
    // from here. Types only out of core: a type cannot enter a verdict.
    for (const forbidden of ["Engine", "DatabaseSync", "queries", "verdict", ".apply("]) {
      expect(code, `codex.ts must not mention ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).toContain('import type { Budget } from "@wecode/core"');
    expect(code.match(/^import (?!type )/gm)?.join("\n") ?? "").not.toContain("@wecode/core");
  });
});
