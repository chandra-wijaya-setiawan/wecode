import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Budget } from "@wecode/core";
import type { Observation, WorkerAdapter, Work } from "../ports.js";

/** Codex, as a worker.
 *
 *  The same kind of worker as Claude Code — an agent — reached through a different harness.
 *  `kind` is therefore `agent` and not `codex`: the kind is what the worker is, the
 *  `harness` on the role is which binary starts it, and the foreman's map is keyed by the
 *  first. Nothing above this file learns which of the two ran.
 *
 *  Everything harness-specific is here, and it is not the same translation Claude Code
 *  gets. Codex has no per-tool allowlist: its confinement is a sandbox mode, so a scope
 *  becomes `--sandbox` rather than `--allowedTools`, and a role that withholds `bash`
 *  still gets a shell — under a sandbox that cannot leave the worktree. Whether the
 *  attempt stayed inside the paths it was given is then the judge's reading of the diff,
 *  not a gate the harness held. See docs/design/11. */
export class CodexAdapter implements WorkerAdapter {
  readonly kind = "agent";

  constructor(
    private readonly bin = "codex",
    private readonly logDir = join(process.cwd(), ".wecode", "sessions"),
  ) {}

  /** Sessions this adapter has started and not yet seen finish. A session outlives the tick
   *  that started it — a tick that waited for the agent could never start a second one. */
  private readonly live = new Map<number, Session>();

  /** `exec`, because nobody is at the terminal: `codex` on its own is the TUI, and the
   *  non-interactive form is the one that can be started and left. The prompt goes last,
   *  positionally, which is where `exec` takes it. */
  async start(work: Work): Promise<Observation> {
    return this.spawn(work, ["exec", ...this.execFlags(work), this.prompt(work)]);
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

  /** Reattach to a session this process did not start. Codex keeps the thread, so
   *  `exec resume <id>` continues the attempt rather than beginning it again; the
   *  instruction goes back in because the resumed run needs to know what it is still for. */
  async resume(work: Work): Promise<Observation> {
    if (work.session === null) return { phase: "failed", session: null, spent: zero(), reason: "lost" };
    return this.spawn(work, ["exec", "resume", work.session, ...this.execFlags(work), this.prompt(work)]);
  }

  /** An answer goes to the session that asked, while it is still going: `queue` hands text
   *  to a live thread, which is the one thing Claude Code has no equivalent of, and the
   *  session carries on rather than being started again. It reports `running` because
   *  nothing has been observed yet — the queued turn is what will be.
   *
   *  A session this process no longer holds cannot be queued into and then watched, so the
   *  answer is delivered the way a resume is, as the prompt of the continued thread. */
  async answer(work: Work, answer: string): Promise<Observation> {
    const session = this.live.get(work.id);
    if (session !== undefined && session.ended === null && session.id !== null) {
      await this.run(["queue", session.id, answer]);
      return { phase: "running", session: session.id, spent: session.spent };
    }
    if (work.session === null) return { phase: "failed", session: null, spent: zero(), reason: "lost" };
    return this.spawn(work, ["exec", "resume", work.session, ...this.execFlags(work), answer]);
  }

  /** Killing the process is the whole of it. Codex holds no session server to be told, so
   *  there is no second command here — and a kill this adapter did not make is a session it
   *  will report as lost on the next poll, which is the same answer. */
  async kill(work: Work): Promise<void> {
    const session = this.live.get(work.id);
    if (session === undefined) return;
    session.child.kill("SIGTERM");
    this.live.delete(work.id);
  }

  /** A role's scope, as flags. This is the whole of the translation.
   *
   *  `--sandbox` is the confinement and it has two settings that matter: a role that may
   *  write gets `workspace-write`, which is the worktree and nothing above it, and a role
   *  that may not gets `read-only`. `--ask-for-approval never` for the reason Claude Code
   *  gets `acceptEdits`: an agent that stops to ask permission has burned an attempt and
   *  proved nothing. Never `danger-full-access` — the sandbox is still a sandbox. */
  private execFlags(work: Work): string[] {
    const tools = work.scope.tools.map((t) => t.toLowerCase());
    const flags = [
      "--json",
      "-C",
      work.worktree,
      "--sandbox",
      writes(work, tools) ? "workspace-write" : "read-only",
      "--ask-for-approval",
      "never",
    ];
    // The few tools that are a flag rather than a name on a list. An ours-name with no
    // flag is not withheld and not an error: the sandbox is what holds this harness in.
    for (const tool of tools) {
      const flag = TOOL_FLAGS[tool];
      if (flag !== undefined && !flags.includes(flag)) flags.push(flag);
    }
    return flags;
  }

  /** The brief. The same requirements an agent gets through any harness — the instruction,
   *  what earlier attempts learned, what it may change, that it proves the work with tests,
   *  that it stops rather than guessing, and the asking half of a lesson.
   *
   *  Duplicated from claude-code.ts, which is a defect and not a decision: there should be
   *  one brief that both harnesses are handed, in a module of its own. This story could
   *  change neither that file nor add one. */
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
   *  The point is the commit. A new thread remembers nothing, but the branch it is standing
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

    const child = spawnProcess(this.bin, [...args], {
      cwd: work.worktree,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        // Codex reports the turn's running total rather than a delta, so the larger number
        // is the true spend: adding them up would count the first turn once per event.
        if (spent > session.spent.tokens) session.spent = { ...session.spent, tokens: spent };
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

  /** A one-shot command whose output is nobody's observation — `queue`, and only `queue`.
   *  It either delivered the text or it did not, and the session it was delivered to is
   *  what the next poll reads. */
  private run(args: readonly string[]): Promise<void> {
    return new Promise<void>((resolve) => {
      const p = spawnProcess(this.bin, [...args], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
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

/** Whether this scope is allowed to change the tree. A role with no writable path and no
 *  writing tool is a reader, and reading is what the sandbox should let it do. */
const writes = (work: Work, tools: readonly string[]): boolean =>
  work.scope.write.length > 0 || tools.some((t) => WRITERS.has(t));

const WRITERS = new Set(["write", "edit", "multiedit", "notebookedit"]);

/** ours -> a Codex flag. Only for the handful Codex spells as a flag rather than as an
 *  entry on an allowlist it does not have. */
const TOOL_FLAGS: Readonly<Record<string, string>> = { websearch: "--search" };

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

/** The thread this stream belongs to, whichever way the harness named it.
 *
 *  Two shapes, because codex-cli has used both and an adapter is the only thing allowed to
 *  know that: the older line wraps everything in `msg` and calls it `session_id`, the newer
 *  one is flat and calls it `thread_id`. Reading both costs three lines here and saves the
 *  runner a version check it has no business making. */
function sessionIn(event: Record<string, unknown>): string | null {
  for (const holder of [event, envelope(event)]) {
    for (const key of ["session_id", "thread_id", "conversation_id"]) {
      const v = holder[key];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return null;
}

/** What the session said, out of whichever event shape carried it. The agent's message,
 *  never a reasoning summary and never a tool call: a lesson is something the session
 *  chose to say at the end. */
function textOf(event: Record<string, unknown>): string | null {
  for (const holder of [event, envelope(event)]) {
    if (!AGENT_MESSAGE.has(String(holder["type"] ?? ""))) continue;
    for (const key of ["message", "text", "last_agent_message"]) {
      const v = holder[key];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return null;
}

const AGENT_MESSAGE = new Set(["agent_message", "task_complete", "turn.completed", "item.completed"]);

/** The turn's spend so far. Codex counts the thread's total in a usage block, so this is
 *  the number as reported and nothing is inferred from it. */
function tokensIn(event: Record<string, unknown>): number {
  for (const holder of [event, envelope(event)]) {
    for (const key of ["usage", "total_token_usage", "info"]) {
      const inner = holder[key];
      if (inner === null || typeof inner !== "object") continue;
      const found = tokensIn(inner as Record<string, unknown>);
      if (found > 0) return found;
    }
    const input = holder["input_tokens"];
    const output = holder["output_tokens"];
    if (typeof input === "number" || typeof output === "number") {
      return (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
    }
  }
  return 0;
}

/** The inner half of an older line: `{"id":"0","msg":{...}}`. An event that is already flat
 *  has none, and an empty object reads the same as a missing one everywhere above. */
function envelope(event: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["msg", "item"]) {
    const inner = event[key];
    if (inner !== null && typeof inner === "object") return inner as Record<string, unknown>;
  }
  return {};
}

const plural = (n: number): string => (n === 1 ? "one has" : `${n} have`);

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
