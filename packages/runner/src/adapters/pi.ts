import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Budget } from "@wecode/core";
import { DEFAULT_BUDGET, type Effort } from "../budget.js";
import type { Observation, WorkerAdapter, Work } from "../ports.js";
import { INHERITED } from "./claude-code.js";

/** pi, as a worker.
 *
 *  The third harness, and the first that is not tied to one vendor: pi reaches a model
 *  through a named provider, so the assignment has to name both. `kind` is `agent` for the
 *  same reason the other two are — the kind is what the worker is, the `harness` on the
 *  role is which binary starts it, and the foreman's map is keyed by the first.
 *
 *  Everything harness-specific is here. pi's confinement is an exclusive allowlist
 *  (`--tools`), so unlike Codex the scope really is held by the harness; its stream is
 *  JSON lines under `--mode json`, whose first line names the session. */
export class PiAdapter implements WorkerAdapter {
  readonly kind = "agent";

  constructor(
    private readonly bin = "pi",
    private readonly logDir = join(process.cwd(), ".wecode", "sessions"),
    /** Where the model comes from when the assignment names no provider. `--provider` is
     *  always passed, because pi's own default is a provider this project never chose:
     *  a harness left to infer it runs the same assignment against a different vendor on
     *  a different machine. */
    private readonly provider = DEFAULT_PROVIDER,
    /** The model an assignment that names none is run on. Every spawn passes `--model`, so
     *  the choice is always this adapter's or the assignment's — never the environment's. */
    private readonly model = DEFAULT_MODEL,
    /** How hard the worker is told to think. pi spells it as a level and ours are its
     *  levels, so this is a name rather than a token count. */
    private readonly effort: Effort = DEFAULT_BUDGET.effort,
  ) {}

  /** Sessions this adapter has started and not yet seen finish. A session outlives the tick
   *  that started it — a tick that waited for the agent could never start a second one. */
  private readonly live = new Map<number, Session>();

  async start(work: Work): Promise<Observation> {
    return this.spawn(work, [...this.scopeFlags(work), this.prompt(work)]);
  }

  /** What that session has done since. The observation it ended with, or that it is still
   *  going. */
  async poll(work: Work): Promise<Observation> {
    const session = this.live.get(work.id);
    if (session === undefined) {
      // Nothing here knows about it: the runner restarted while it was running.
      return { phase: "failed", session: work.session, spent: zero(), reason: "lost" };
    }
    if (session.ended !== null) {
      this.live.delete(work.id);
      return session.ended;
    }
    return { phase: "running", session: session.id ?? work.session ?? "", spent: session.spent };
  }

  /** Reattach to a session this process did not start. pi keeps the transcript in the
   *  project's session store, and `--session-id` is the exact-id form, so the thread
   *  continues rather than beginning again; the instruction goes back in because the
   *  resumed run needs to know what it is still for. */
  async resume(work: Work): Promise<Observation> {
    if (work.session === null) return { phase: "failed", session: null, spent: zero(), reason: "lost" };
    return this.spawn(work, ["--session-id", work.session, ...this.scopeFlags(work), this.prompt(work)]);
  }

  /** An answer is a fresh turn on the same session, not an interruption: pi has no queue,
   *  so a live run cannot be pushed into — it must have asked, and by then the turn it
   *  asked in is over. See docs/design/15. */
  async answer(work: Work, answer: string): Promise<Observation> {
    if (work.session === null) return { phase: "failed", session: null, spent: zero(), reason: "lost" };
    return this.spawn(work, ["--session-id", work.session, ...this.scopeFlags(work), answer]);
  }

  /** Killing the process is the whole of it. pi holds no session server to be told, and a
   *  kill this adapter did not make is a session it reports as lost on the next poll. */
  async kill(work: Work): Promise<void> {
    const session = this.live.get(work.id);
    if (session === undefined) return;
    session.child.kill("SIGTERM");
    this.live.delete(work.id);
  }

  /** A role's scope, as flags. This is the whole of the translation.
   *
   *  `--tools` is an exclusive allowlist across built-in, extension and custom tools, so it
   *  is the confinement and not a hint: a role that withholds `write` cannot write. A role
   *  that names no tool at all gets none, which is why the flag is passed even then.
   *
   *  `--no-approve` because the attempt must not depend on whether somebody once trusted
   *  this folder: project-local settings and extensions are the machine leaking in. */
  private scopeFlags(work: Work): string[] {
    const tools = work.scope.tools.map((t) => TOOL_NAMES[t.toLowerCase()] ?? t).filter((t) => t !== "");
    return ["--mode", "json", "--thinking", this.effort, "--no-approve", "--tools", tools.join(",")];
  }

  /** The brief. The same requirements an agent gets through any harness — the instruction,
   *  what earlier attempts learned, what it may change, that it proves the work with tests,
   *  that it stops rather than guessing, and the asking half of a lesson.
   *
   *  Duplicated from claude-code.ts and codex.ts, which is a defect and not a decision:
   *  there should be one brief that all three harnesses are handed, in a module of its own.
   *  This story could change none of those files nor add one. */
  private prompt(work: Work): string {
    const lessons = work.lessons ?? [];
    return [
      work.instruction,
      "",
      ...(lessons.length > 0
        ? ["What earlier attempts on this repository learned:", ...lessons.map((l) => `- ${l}`), ""]
        : []),
      `You may change only: ${work.scope.write.join(", ") || "(nothing)"}.`,
      "Write the tests that prove this work, and run them.",
      "If you need a decision from a person, say so and stop rather than guessing.",
      ASK,
      ...this.before(work),
    ].join("\n");
  }

  /** What happened before, for a retry. A first attempt gets nothing: no heading, no blank
   *  line, exactly the prompt it would have got anyway.
   *
   *  The point is the commit. A new session remembers nothing, but the branch it is standing
   *  on already holds the last attempt, so the choice is read it or redo it. */
  private before(work: Work): string[] {
    const h = work.history;
    if (h === null) return [];
    const out = [
      "",
      "## What happened before",
      "",
      `This is attempt ${h.attempts + 1}; ${plural(h.attempts)} already been made.`,
    ];
    out.push(
      h.commit === null
        ? "The last attempt left no commit on this branch."
        : `The last attempt's work is already committed on this branch as ${h.commit} — read it` +
            " with `git show " +
            h.commit +
            "` before changing anything, and do not redo what is already there.",
    );
    if (h.reason !== null) out.push(`It ended: ${h.reason}.`);
    if (h.failures.length > 0) {
      out.push("", "Still failing:");
      for (const f of h.failures) {
        out.push(f.line === "" ? `- ${f.statement}` : `- ${f.statement} — ${f.line}`);
      }
    }
    return out;
  }

  /** Start a session and return at once. What it does afterwards lands in `live`, and the
   *  next poll reads it. */
  private spawn(work: Work, args: readonly string[]): Promise<Observation> {
    mkdirSync(this.logDir, { recursive: true });
    const log = join(this.logDir, `assignment-${work.id}.jsonl`);

    // Here rather than in each caller: every session this adapter starts goes through this
    // one spawn, so naming the provider and the model here is the whole guarantee that
    // neither is left to pi's own defaults.
    const chosen = modelOf(work.model ?? this.model, this.provider);
    const child = spawnProcess(
      this.bin,
      ["--provider", chosen.provider, "--model", chosen.model, ...args],
      {
        cwd: work.worktree,
        stdio: ["ignore", "pipe", "pipe"],
        env: environmentFor(work),
      },
    );
    const session: Session = { child, id: work.session, spent: zero(), ended: null, last: "" };
    this.live.set(work.id, session);

    let rest = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      appendFileSync(log, chunk);
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const event = parse(line);
        if (event === null) continue;
        const id = sessionIn(event);
        if (id !== null) session.id = id;
        const text = textOf(event);
        if (text !== null) session.last = text;
        const spent = tokensIn(event);
        // pi reports the assistant message's own usage, and a turn's message carries the
        // running total for that message only, so the spends add up across messages.
        if (spent > 0) session.spent = { ...session.spent, tokens: session.spent.tokens + spent };
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => appendFileSync(log, chunk));

    child.on("error", () => {
      session.ended = { phase: "failed", session: session.id, spent: session.spent, reason: "lost" };
    });

    child.on("close", (code) => {
      // A harness that could not be started says so through `error`, and the close that
      // follows it carries a code of its own — overwriting `lost` with `other` there would
      // report a session that ran badly instead of one that never ran.
      if (session.ended !== null) return;
      const lesson = lessonIn(session.last);
      // Exit 0 means the session ended, not that the work is done — the test decides that.
      session.ended =
        code === 0
          ? {
              phase: "succeeded",
              session: session.id ?? "",
              spent: session.spent,
              commit: null,
              ...(lesson === null ? {} : { lesson }),
            }
          : {
              phase: "failed",
              session: session.id,
              spent: session.spent,
              reason: code === null ? "lost" : "other",
              ...(lesson === null ? {} : { lesson }),
            };
    });

    return Promise.resolve({ phase: "running", session: session.id ?? "", spent: zero() });
  }
}

interface Session {
  readonly child: ChildProcess;
  id: string | null;
  spent: Budget;
  ended: Observation | null;
  /** The most recent thing the session said, so the last one is still here at close. */
  last: string;
}

const zero = (): Budget => ({ tokens: 0, seconds: 0 });

/** The provider and the model, out of one name.
 *
 *  pi takes them as two flags and also accepts them as one `provider/id` pattern, and the
 *  record names the model rather than the pair. So a name that carries its provider is
 *  split here and a bare one falls back to the adapter's declared provider — never to pi's,
 *  which is a vendor this project did not choose. A pattern's `:<thinking>` suffix stays on
 *  the model: how hard to think is `--thinking`'s to say, and pi resolves the rest. */
export function modelOf(name: string, fallback: string): { provider: string; model: string } {
  const cut = name.indexOf("/");
  if (cut <= 0 || cut === name.length - 1) return { provider: fallback, model: name };
  return { provider: name.slice(0, cut), model: name.slice(cut + 1) };
}

/** The provider and model used when the assignment names neither.
 *
 *  Literals here, and the one thing in this file that ought not to be: which model a role
 *  works on is the operator's to set, so it belongs beside the role's scope and budget in
 *  config/roles.yaml, carried onto the assignment and read off `work.model`. Until that
 *  path exists these are the declared fallback — explicit, in one place, and not the
 *  environment's. */
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5";

/** The keys pi needs to reach the provider it was given. One list rather than one per
 *  provider: the adapter does not know which vendor the assignment named until it reads the
 *  model, and a key for a provider nobody asked for is never used.
 *
 *  Added to `INHERITED` — claude-code.ts's list of what a worker may inherit at all — and
 *  nothing else is: everything the child would otherwise have got is the daemon's shell
 *  leaking into the attempt. `MAX_THINKING_TOKENS` is deliberately not here; pi is told how
 *  hard to think with `--thinking`, and a stray variable would argue with the flag. */
export const PROVIDER_KEYS: readonly string[] = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "ZAI_API_KEY",
  "CEREBRAS_API_KEY",
];

/** The environment one session is given, built rather than inherited.
 *
 *  Exported because it is the claim the test reads: what is in it, and — the part that
 *  matters — that nothing else is. */
export function environmentFor(
  work: Work,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...INHERITED, ...PROVIDER_KEYS]) {
    const value = ambient[name];
    if (value !== undefined) env[name] = value;
  }
  // Stated, not inherited: which assignment is thinking. It is what makes a stray process
  // on the machine attributable to a row in the record.
  env["WECODE_ASSIGNMENT"] = String(work.id);
  env["WECODE_WORKTREE"] = work.worktree;
  return env;
}

/** The asking half of a lesson. One line, because a lesson that needs a paragraph is a
 *  design document — see docs/design/17. */
const ASK =
  "If you learned something a future attempt on this repository should know, end your " +
  "final message with a single line beginning LESSON:";

/** The reading half. The last `LESSON:` line of the final message, or nothing: an agent
 *  with nothing to say says nothing, and that must not be recorded as a lesson. */
function lessonIn(message: string): string | null {
  let found: string | null = null;
  for (const line of message.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("LESSON:")) continue;
    const body = trimmed.slice("LESSON:".length).trim();
    if (body !== "") found = body;
  }
  return found;
}

/** The session this stream belongs to. pi's first line is a header that names it, and
 *  nothing later repeats it. */
function sessionIn(event: Record<string, unknown>): string | null {
  if (event["type"] !== "session") return null;
  const id = event["id"];
  return typeof id === "string" && id !== "" ? id : null;
}

/** What the session said. An assistant message's text blocks, never a thinking block and
 *  never a tool call: a lesson is something the session chose to say out loud.
 *
 *  Read off `message_end` and `turn_end` — the message as it finally stood. `message_update`
 *  carries a half-streamed copy of the same message, which would leave `last` holding a
 *  sentence that had not finished. */
function textOf(event: Record<string, unknown>): string | null {
  if (!FINAL_MESSAGE.has(String(event["type"] ?? ""))) return null;
  const message = event["message"];
  if (message === null || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m["role"] !== "assistant" || !Array.isArray(m["content"])) return null;
  const parts = m["content"]
    .filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
    .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string);
  return parts.length === 0 ? null : parts.join("\n");
}

const FINAL_MESSAGE = new Set(["message_end", "turn_end"]);

/** What that message cost. pi's usage block is per assistant message and already totalled,
 *  so this is the number as reported and nothing is inferred from it — and it is read off
 *  `message_end` only, or the same message would be counted again at `turn_end`. */
function tokensIn(event: Record<string, unknown>): number {
  if (event["type"] !== "message_end") return 0;
  const message = event["message"];
  if (message === null || typeof message !== "object") return 0;
  const usage = (message as Record<string, unknown>)["usage"];
  if (usage === null || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  if (typeof u["totalTokens"] === "number") return u["totalTokens"];
  const input = typeof u["input"] === "number" ? u["input"] : 0;
  const output = typeof u["output"] === "number" ? u["output"] : 0;
  return input + output;
}

const plural = (n: number): string => (n === 1 ? "one has" : `${n} have`);

/** ours -> pi's. pi's built-in names are lower case and mostly ours already; `glob` is the
 *  one that is spelled differently. An unmapped name is passed through, because `--tools`
 *  covers extension and custom tools too and a role may name one wecode has never heard
 *  of. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "bash",
  read: "read",
  edit: "edit",
  write: "write",
  grep: "grep",
  glob: "find",
  ls: "ls",
};

function parse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const v: unknown = JSON.parse(trimmed);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
