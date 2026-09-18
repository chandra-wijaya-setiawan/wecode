import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasWriteDenials } from "../src/adapters/denials.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  environmentFor,
  modelOf,
  PiAdapter,
  PROVIDER_KEYS,
} from "../src/adapters/pi.js";
import type { History, Observation, WorkerAdapter, Work } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** One call the fake harness was made: where it ran, what it was given, and the environment
 *  it was given it in. */
interface Call {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** A harness that is not pi.
 *
 *  It records every call — cwd, argv and environment, NUL-delimited, because the prompt is
 *  a paragraph with newlines in it — then prints the events the test gave it and exits with
 *  the code the test gave it. That is the whole of the adapter's side of the contract: a
 *  binary that takes flags and prints JSON lines. Running the real pi would prove the model
 *  rather than the adapter, and would need a network, a key and somebody's money.
 *
 *  It is handed over as `bin`, not on PATH: the adapter takes the binary to start, so a
 *  fake needs no shim. */
function fakePi(opts: { events?: readonly string[]; exit?: number; delayMs?: number } = {}) {
  const dir = tmp("pi-fake-");
  const calls = join(dir, "calls");
  const events = join(dir, "events.jsonl");
  const bin = join(dir, "pi");

  writeFileSync(events, (opts.events ?? []).join("\n") + (opts.events?.length ? "\n" : ""));
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `{ printf 'CALL\\0%s\\0' "$PWD"; printf '%s\\0' "$@"; printf 'ENV\\0';` +
        ` env -0; } >> ${JSON.stringify(calls)}`,
      `cat ${JSON.stringify(events)}`,
      // After the events, never before: the real harness names the session on its first
      // line, and a fake that went quiet first would let the adapter pass by waiting.
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
        for (; j < tokens.length && tokens[j] !== "ENV"; j++) args.push(tokens[j] as string);
        const env: Record<string, string> = {};
        let k = j + 1;
        for (; k < tokens.length && tokens[k] !== "CALL"; k++) {
          const cut = (tokens[k] as string).indexOf("=");
          if (cut > 0) env[(tokens[k] as string).slice(0, cut)] = (tokens[k] as string).slice(cut + 1);
        }
        out.push({ cwd: tokens[i + 1] as string, args, env });
        i = k - 1;
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
    scope: { write: ["packages/runner/src/adapters/pi.ts"], tools: ["read", "write", "bash"] },
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

/** pi's stream: a session header first, then events. */
const EVENTS = [
  '{"type":"session","version":3,"id":"018f-abc","timestamp":"2026-09-18T00:00:00Z","cwd":"/w"}',
  '{"type":"agent_start"}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},' +
    '{"type":"text","text":"done\\nLESSON: pi takes --provider"}],"usage":{"input":100,"output":20,' +
    '"totalTokens":120,"cost":{"total":0}}}}',
  '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text",' +
    '"text":"done\\nLESSON: pi takes --provider"}],"usage":{"totalTokens":120}},"toolResults":[]}',
];

/** A session that said nothing worth keeping. */
const QUIET = [
  '{"type":"session","version":3,"id":"018f-quiet"}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"all good"}],' +
    '"usage":{"totalTokens":7,"cost":{"total":0}}}}',
];

const flat = (call: Call | undefined): string => (call?.args ?? []).join(" ");

/** What the harness was given as `--<name>`, on the call in question. */
const valueOf = (call: Call | undefined, name: string): string | undefined => {
  const args = call?.args ?? [];
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

describe("the pi worker adapter", () => {
  it("is a worker adapter, of the same kind as the other harnesses", () => {
    const adapter: WorkerAdapter = new PiAdapter();
    // Not "pi": the kind is what the worker is and the harness is which binary starts it,
    // so the foreman's map — keyed by the worker's kind — can hold any of the three.
    expect(adapter.kind).toBe("agent");
  });

  it("starts a non-interactive session in the assignment's worktree and returns at once", async () => {
    const dir = tmp("pi-start");
    const fake = fakePi({ events: EVENTS, delayMs: 300 });
    const adapter = new PiAdapter(fake.bin, fake.logDir);
    const w = work(dir);

    const seen = await adapter.start(w);

    expect(seen.phase).toBe("running");
    expect(await settled(adapter, w)).toMatchObject({ phase: "succeeded" });
    const call = fake.calls()[0];
    expect(call?.cwd).toBe(dir);
    // `--mode json` is both the stream this adapter reads and the reason nobody is asked
    // anything: it is one of pi's non-interactive modes.
    expect(valueOf(call, "mode")).toBe("json");
  });

  describe("the provider and the model", () => {
    const chosenBy = async (over: Partial<Work>, adapterArgs: readonly string[] = []) => {
      const dir = tmp("pi-model");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir, ...(adapterArgs as [string?, string?]));
      const w = work(dir, over);
      await adapter.start(w);
      await settled(adapter, w);
      const call = fake.calls()[0];
      return { provider: valueOf(call, "provider"), model: valueOf(call, "model"), args: call?.args ?? [] };
    };

    it("takes both from the work, when the work names both", async () => {
      // The whole point of this adapter: pi reaches a model through a provider, and the
      // assignment names the pair so the attempt is attributable to it rather than to
      // whichever vendor the machine was last configured for.
      expect(await chosenBy({ model: "openai/gpt-5-codex" })).toMatchObject({
        provider: "openai",
        model: "gpt-5-codex",
      });
    });

    it("keeps a thinking suffix on the model, because that half is pi's to resolve", async () => {
      expect(await chosenBy({ model: "anthropic/sonnet:high" })).toMatchObject({
        provider: "anthropic",
        model: "sonnet:high",
      });
    });

    it("falls back to its own declared provider for a model that names none", async () => {
      expect(await chosenBy({ model: "claude-opus-5" })).toMatchObject({
        provider: DEFAULT_PROVIDER,
        model: "claude-opus-5",
      });
    });

    it("names both even when the work names neither, so pi never picks for itself", async () => {
      // pi's own default provider is a vendor this project did not choose. An adapter that
      // left the flag off would run the assignment against it.
      expect(await chosenBy({})).toMatchObject({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
    });

    it("prefers the work's pair over the one the adapter was configured with", async () => {
      // Which model a role works on is the operator's to set, and the assignment's to
      // override: the record names it so two machines run the same attempt the same way.
      expect(await chosenBy({ model: "google/gemini-3-pro" }, ["mistral", "mistral-large"])).toMatchObject({
        provider: "google",
        model: "gemini-3-pro",
      });
      expect(await chosenBy({}, ["mistral", "mistral-large"])).toMatchObject({
        provider: "mistral",
        model: "mistral-large",
      });
    });

    it("states how hard to think rather than leaving it to the machine", async () => {
      const { args } = await chosenBy({});
      const at = args.indexOf("--thinking");
      expect(at).not.toBe(-1);
      expect(args[at + 1]).toBe("high");
    });

    it("splits a name only where a provider prefix really is one", () => {
      expect(modelOf("openai/gpt-5", "anthropic")).toEqual({ provider: "openai", model: "gpt-5" });
      expect(modelOf("sonnet", "anthropic")).toEqual({ provider: "anthropic", model: "sonnet" });
      // Not a pair: a leading or trailing slash names no provider and no model.
      expect(modelOf("/gpt-5", "anthropic")).toEqual({ provider: "anthropic", model: "/gpt-5" });
      expect(modelOf("openai/", "anthropic")).toEqual({ provider: "anthropic", model: "openai/" });
    });
  });

  describe("a scope, as flags", () => {
    const toolsOf = async (tools: readonly string[], write: readonly string[] = ["src/**"]) => {
      const dir = tmp("pi-tools");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir, { scope: { write: [...write], tools: [...tools] } });
      await adapter.start(w);
      await settled(adapter, w);
      return { value: valueOf(fake.calls()[0], "tools"), flat: flat(fake.calls()[0]) };
    };

    it("hands the role's tools over in pi's own names", async () => {
      // `glob` is ours; `find` is pi's. A name the harness does not recognise is a gate
      // that refuses silently, which is how the first live Claude Code run was lost.
      expect((await toolsOf(["read", "glob", "grep"])).value).toBe("read,find,grep");
    });

    it("passes a name it has no mapping for through, so a role may name an extension's tool", async () => {
      expect((await toolsOf(["read", "web_search"])).value).toBe("read,web_search");
    });

    it("gives a role that may not write no writing tool, which is the confinement", async () => {
      // `--tools` is an exclusive allowlist across built-in, extension and custom tools, so
      // unlike Codex's sandbox this really is held by the harness.
      const seen = await toolsOf(["read", "grep"], []);
      expect(seen.value).toBe("read,grep");
      expect(seen.value).not.toContain("write");
      expect(seen.value).not.toContain("edit");
    });

    it("passes the flag even for a role that names no tool, rather than leaving it open", async () => {
      expect((await toolsOf([], [])).value).toBe("");
    });

    it("refuses whatever this folder was once trusted with", async () => {
      // Project-local settings and extensions are the machine leaking into the attempt, and
      // whether they load would otherwise depend on a saved decision in somebody's home.
      expect((await toolsOf(["read"])).flat).toContain("--no-approve");
    });
  });

  describe("the environment one session gets", () => {
    it("is built rather than inherited, and names the assignment that is thinking", () => {
      const env = environmentFor(work("/w/three"), {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-oai",
        MY_EDITOR: "vi",
        CLAUDE_CODE_SETTINGS: "somebody's",
      });

      expect(env["PATH"]).toBe("/usr/bin");
      expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant");
      expect(env["OPENAI_API_KEY"]).toBe("sk-oai");
      expect(env["WECODE_ASSIGNMENT"]).toBe("1");
      expect(env["WECODE_WORKTREE"]).toBe("/w/three");
      // Everything the child would otherwise have got is the daemon's shell, and the reason
      // one assignment behaved differently on two machines.
      expect(env).not.toHaveProperty("MY_EDITOR");
      expect(env).not.toHaveProperty("CLAUDE_CODE_SETTINGS");
    });

    it("carries a key for every provider pi can be pointed at", () => {
      // The adapter does not know which vendor the assignment named until it reads the
      // model, so one list — and a key for a provider nobody asked for is never used.
      expect(PROVIDER_KEYS).toContain("OPENAI_API_KEY");
      expect(PROVIDER_KEYS).toContain("GEMINI_API_KEY");
    });

    it("sets no thinking-token variable, because the flag already said it", () => {
      // A variable and a flag that both claim to set the effort is one of them being wrong.
      expect(environmentFor(work("/w"), { MAX_THINKING_TOKENS: "31999" })).not.toHaveProperty(
        "MAX_THINKING_TOKENS",
      );
    });

    it("is the environment the harness is actually started in", async () => {
      const dir = tmp("pi-env");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir, { id: 9 });

      await adapter.start(w);
      await settled(adapter, w);

      expect(fake.calls()[0]?.env["WECODE_ASSIGNMENT"]).toBe("9");
      expect(fake.calls()[0]?.env["WECODE_WORKTREE"]).toBe(dir);
    });
  });

  describe("the brief", () => {
    const briefOf = async (over: Partial<Work> = {}): Promise<string> => {
      const dir = tmp("pi-brief");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir, over);
      await adapter.start(w);
      await settled(adapter, w);
      // The prompt is positional and last, which is where pi takes its messages.
      return (fake.calls()[0]?.args ?? []).at(-1) ?? "";
    };

    it("carries every requirement an agent gets through any harness", async () => {
      const brief = await briefOf({ lessons: ["the repo has no prettier config"] });

      expect(brief).toContain("make the adapter real");
      expect(brief).toContain("What earlier attempts on this repository learned:");
      expect(brief).toContain("- the repo has no prettier config");
      expect(brief).toContain("You may change only: packages/runner/src/adapters/pi.ts.");
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
        failures: [{ statement: "the adapter names the provider", line: "expected undefined to be 'openai'" }],
      };
      const brief = await briefOf({ history });

      expect(brief).toContain("This is attempt 3; 2 have already been made.");
      expect(brief).toContain("git show deadbee");
      expect(brief).toContain("It ended: timeout.");
      expect(brief).toContain("- the adapter names the provider — expected undefined to be 'openai'");
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
    it("takes the session id off the header and the spend off the message", async () => {
      const dir = tmp("pi-read");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({
        phase: "succeeded",
        session: "018f-abc",
        // 120 once. `turn_end` repeats the message the `message_end` before it already
        // accounted for, and counting both would double every turn.
        spent: { tokens: 120, seconds: 0 },
        commit: null,
      });
    });

    it("adds up the messages of a session rather than keeping the last one", async () => {
      const dir = tmp("pi-total");
      const fake = fakePi({
        events: [
          '{"type":"session","id":"018f-sum"}',
          '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"totalTokens":100}}}',
          '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"totalTokens":40}}}',
        ],
      });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      // pi's usage is per message, not a running thread total, so the spend is the sum.
      expect((await settled(adapter, w)).spent.tokens).toBe(140);
    });

    it("counts input and output when the message reports no total", async () => {
      const dir = tmp("pi-parts");
      const fake = fakePi({
        events: [
          '{"type":"session","id":"018f-parts"}',
          '{"type":"message_end","message":{"role":"assistant","content":[],' +
            '"usage":{"input":30,"output":5,"cacheRead":0,"cacheWrite":0}}}',
        ],
      });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect((await settled(adapter, w)).spent.tokens).toBe(35);
    });

    it("takes the lesson the session ended with, and invents none", async () => {
      const dir = tmp("pi-lesson");
      const fake = fakePi({ events: EVENTS });
      const quiet = fakePi({ events: QUIET });
      const said = new PiAdapter(fake.bin, fake.logDir);
      const silent = new PiAdapter(quiet.bin, quiet.logDir);
      const w = work(dir);

      await said.start(w);
      await silent.start(w);

      expect(await settled(said, w)).toMatchObject({ lesson: "pi takes --provider" });
      expect(await settled(silent, w)).not.toHaveProperty("lesson");
    });

    it("reads what the session said out loud, not what it was thinking", async () => {
      const dir = tmp("pi-thinking");
      const fake = fakePi({
        events: [
          '{"type":"session","id":"018f-think"}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking",' +
            '"thinking":"LESSON: never say this"},{"type":"text","text":"ok"}],"usage":{"totalTokens":1}}}',
        ],
      });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      // A lesson is something the session chose to say, never a scratchpad it left open.
      expect(await settled(adapter, w)).not.toHaveProperty("lesson");
    });

    it("ignores a half-streamed copy of a message", async () => {
      const dir = tmp("pi-partial");
      const fake = fakePi({
        events: [
          '{"type":"session","id":"018f-part"}',
          '{"type":"message_update","message":{"role":"assistant","content":[{"type":"text",' +
            '"text":"LESSON: half a sen"}],"usage":{"totalTokens":9}},"assistantMessageEvent":{"type":"text_delta"}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text",' +
            '"text":"LESSON: half a sentence is not a lesson"}],"usage":{"totalTokens":9}}}',
        ],
      });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      const seen = await settled(adapter, w);
      expect(seen).toMatchObject({ lesson: "half a sentence is not a lesson" });
      // Once, off the finished message — not again off the partial that preceded it.
      expect(seen.spent.tokens).toBe(9);
    });

    it("keeps the session's own transcript beside the assignment", async () => {
      const dir = tmp("pi-log");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir, { id: 42 });

      await adapter.start(w);
      await settled(adapter, w);

      expect(readFileSync(join(fake.logDir, "assignment-42.jsonl"), "utf8")).toContain("018f-abc");
    });

    it("is not hurt by a line that is not an event", async () => {
      const dir = tmp("pi-noise");
      const fake = fakePi({
        events: ["Updating model catalog...", "", '{"type":"session","id":"018f-n"}', "null", "{oops"],
      });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({ phase: "succeeded", session: "018f-n" });
    });
  });

  describe("how a session ends", () => {
    it("reports a clean exit as the session ending, and claims no commit for it", async () => {
      const dir = tmp("pi-clean");
      const fake = fakePi({ events: EVENTS, exit: 0 });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      // Exit 0 means the session ended, not that the work is done: the test decides that,
      // so there is no verdict and no commit here.
      expect(await settled(adapter, w)).toMatchObject({ phase: "succeeded", commit: null });
    });

    it("reports a bad exit as failed, and still carries the lesson", async () => {
      const dir = tmp("pi-bad");
      const fake = fakePi({ events: EVENTS, exit: 1 });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({
        phase: "failed",
        reason: "other",
        session: "018f-abc",
        lesson: "pi takes --provider",
      });
    });

    it("reports a harness it could not start as lost", async () => {
      const dir = tmp("pi-missing");
      const adapter = new PiAdapter(join(dir, "no-such-pi"), join(dir, "logs"));
      const w = work(dir);

      await adapter.start(w);

      expect(await settled(adapter, w)).toMatchObject({ phase: "failed", reason: "lost" });
    });

    it("reports a session it has never heard of as lost", async () => {
      const dir = tmp("pi-unknown");
      const fake = fakePi();
      const adapter = new PiAdapter(fake.bin, fake.logDir);

      expect(await adapter.poll(work(dir, { session: "018f-old" }))).toMatchObject({
        phase: "failed",
        reason: "lost",
        session: "018f-old",
      });
    });
  });

  describe("picking a session back up", () => {
    it("continues the session rather than beginning it again", async () => {
      const dir = tmp("pi-resume");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir, { session: "018f-abc" });

      const seen = await adapter.resume(w);
      await settled(adapter, w);

      expect(seen.phase).toBe("running");
      // The exact-id form: a partial match could pick up somebody else's thread.
      expect(valueOf(fake.calls()[0], "session-id")).toBe("018f-abc");
      // The resumed run still needs to know what it is for.
      expect((fake.calls()[0]?.args ?? []).at(-1)).toContain("make the adapter real");
      // And it is still the assignment's model, not whatever the stored session used.
      expect(valueOf(fake.calls()[0], "provider")).toBe(DEFAULT_PROVIDER);
    });

    it("says lost when there is no session to resume", async () => {
      const dir = tmp("pi-resume-none");
      const fake = fakePi();
      const adapter = new PiAdapter(fake.bin, fake.logDir);

      expect(await adapter.resume(work(dir))).toMatchObject({ phase: "failed", reason: "lost" });
      expect(fake.calls()).toEqual([]);
    });
  });

  describe("answering", () => {
    it("delivers the answer as a fresh turn on the same session", async () => {
      const dir = tmp("pi-answer");
      const fake = fakePi({ events: EVENTS });
      const adapter = new PiAdapter(fake.bin, fake.logDir);
      const w = work(dir, { session: "018f-abc" });

      const seen = await adapter.answer(w, "yes, drop the column");
      await settled(adapter, w);

      // pi has no queue: a live run cannot be pushed into, so an answer is the next turn.
      expect(seen.phase).toBe("running");
      expect(valueOf(fake.calls()[0], "session-id")).toBe("018f-abc");
      expect((fake.calls()[0]?.args ?? []).at(-1)).toBe("yes, drop the column");
    });

    it("says lost when there is no session an answer could be for", async () => {
      const dir = tmp("pi-answer-none");
      const fake = fakePi();
      const adapter = new PiAdapter(fake.bin, fake.logDir);

      expect(await adapter.answer(work(dir), "yes")).toMatchObject({ phase: "failed", reason: "lost" });
      expect(fake.calls()).toEqual([]);
    });
  });

  it("kills the process, because there is no session server to tell", async () => {
    const dir = tmp("pi-kill");
    const fake = fakePi({ events: EVENTS, delayMs: 10_000 });
    const adapter = new PiAdapter(fake.bin, fake.logDir);
    const w = work(dir);

    await adapter.start(w);
    await identified(adapter, w);
    await adapter.kill(w);

    expect(await adapter.poll(w)).toMatchObject({ phase: "failed", reason: "lost" });
    // One call, and no second binary run to tell anybody about the kill.
    expect(fake.calls()).toHaveLength(1);
  }, 15_000);

  it("offers no reading of which writes were refused, because it cannot see one", () => {
    // pi's confinement is the allowlist, and a tool that is not on it is not offered to the
    // model at all — so there is no refused write to name. `WriteDenials` is structural for
    // exactly this reason: the foreman asks only whoever can answer.
    expect(hasWriteDenials(new PiAdapter())).toBe(false);
  });

  it("holds nothing it could judge with", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/pi.ts"), "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // The record is reached through the engine and the store, and neither is importable
    // from here. Types only out of core: a type cannot enter a verdict.
    for (const forbidden of ["Engine", "DatabaseSync", "queries", "verdict", ".apply("]) {
      expect(code, `pi.ts must not mention ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).toContain('import type { Budget } from "@wecode/core"');
    expect(code.match(/^import (?!type )/gm)?.join("\n") ?? "").not.toContain("@wecode/core");
  });
});
