import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Budget } from "@wecode/core";
import { DEFAULT_BUDGET, THINKING_TOKENS, type Effort } from "../budget.js";
import type { Observation, WorkerAdapter, Work } from "../ports.js";
import { denialsIn, type WriteDenials } from "./denials.js";

/** Claude Code, as a worker.
 *
 *  Everything harness-specific is here: the flags a scope becomes, the shape of what it
 *  prints, how a session is resumed. Nothing above this file learns which harness ran. */
export class ClaudeCodeAdapter implements WorkerAdapter, WriteDenials {
  readonly kind = "agent";

  constructor(
    private readonly bin = "claude",
    private readonly logDir = join(process.cwd(), ".wecode", "sessions"),
    /** Edits inside the worktree are accepted without asking. The confinement is the
     *  worktree and the allowed-tools list, not a prompt nobody is at the terminal to
     *  answer — an agent that stops to ask permission has burned an attempt and proved
     *  nothing. Never `bypassPermissions`: the tool list is still a list. */
    private readonly permissionMode = "acceptEdits",
    /** The model an assignment that names none is run on. Every spawn passes `--model`,
     *  so the choice is always this adapter's or the assignment's — never whatever the
     *  harness would have inferred from the machine it woke up on. */
    private readonly model = DEFAULT_MODEL,
    /** How hard the worker is told to think. Stated on every spawn for the same reason the
     *  model is: an effort nobody named is the machine's, and then the attempt's outcome
     *  says nothing about the work. */
    private readonly effort: Effort = DEFAULT_BUDGET.effort,
  ) {}

  /** Sessions this adapter has started and not yet seen finish. The runner is one long
   *  process, so a session outlives the tick that started it — which is the whole point:
   *  a tick that waited for the agent could never start a second one, and the attention
   *  budget was unreachable. */
  private readonly live = new Map<number, Session>();

  /** Writes the permission gate refused, per assignment, waiting to be carried to the
   *  record. Kept outside `live` on purpose: a session that ends is dropped from `live` by
   *  the poll that reads it, and the refusal that burned the attempt must outlive it — it
   *  is the one thing the next reader of the board needs. */
  private readonly denied = new Map<number, Set<string>>();

  takeRefusedWrites(assignment: number): readonly string[] {
    const paths = this.denied.get(assignment);
    if (paths === undefined) return [];
    this.denied.delete(assignment);
    return [...paths];
  }

  async start(work: Work): Promise<Observation> {
    return this.spawn(work, [
      "-p",
      this.prompt(work),
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.scopeFlags(work),
    ]);
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

  /** Reattach to a session this process did not start. Claude Code keeps the transcript, so
   *  `--resume` continues the attempt rather than beginning it again; the instruction goes
   *  back in because the resumed run needs to know what it is still for. */
  async resume(work: Work): Promise<Observation> {
    if (work.session === null) return { phase: "failed", session: null, spent: zero(), reason: "lost" };
    return this.spawn(work, [
      "--resume",
      work.session,
      "-p",
      this.prompt(work),
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.scopeFlags(work),
    ]);
  }

  async answer(work: Work, answer: string): Promise<Observation> {
    if (work.session === null) return { phase: "failed", session: null, spent: zero(), reason: "lost" };
    return this.spawn(work, [
      "--resume",
      work.session,
      "-p",
      answer,
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.scopeFlags(work),
    ]);
  }

  async kill(work: Work): Promise<void> {
    const session = this.live.get(work.id);
    if (session !== undefined) {
      session.child.kill("SIGTERM");
      this.live.delete(work.id);
    }
    if (work.session === null) return;
    await new Promise<void>((resolve) => {
      const p = spawnProcess(this.bin, ["stop", work.session as string], {
        stdio: "ignore",
        env: environmentFor(work, this.effort),
      });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
  }

  /** A role's scope, as flags. This is the whole of the translation.
   *
   *  Tool names are the harness's, not ours: a role says `write`, Claude Code calls it
   *  `Write`, and a name it does not recognise is not an error — it is a permission gate
   *  that silently refuses every edit. The first live run lost a session to exactly that. */
  private scopeFlags(work: Work): string[] {
    const flags = ["--add-dir", work.worktree, "--permission-mode", this.permissionMode];
    const tools = work.scope.tools.map((t) => TOOL_NAMES[t.toLowerCase()] ?? t).filter((t) => t !== "");
    if (tools.length > 0) flags.push("--allowedTools", tools.join(","));
    return flags;
  }

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
   *  The point is the commit. A new session remembers nothing, but the branch it is
   *  standing on already holds the last attempt, so the choice is read it or redo it. */
  private before(work: Work): string[] {
    const h = work.history;
    if (h === null) return [];
    const out = [
      "",
      "## What happened before",
      "",
      `This is attempt ${h.attempts + 1}; ${plural(h.attempts)} already been made.`,
    ];
    if (h.commit !== null) {
      out.push(
        `The last attempt's work is already committed on this branch as ${h.commit} — read it` +
          " with `git show " +
          h.commit +
          "` before changing anything, and do not redo what is already there.",
      );
    } else {
      out.push("The last attempt left no commit on this branch.");
    }
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

    // Here rather than in each caller: every session this adapter starts goes through
    // this one spawn, so naming the model here is the whole guarantee that none of them
    // is left to the environment.
    const child = spawnProcess(this.bin, ["--model", work.model ?? this.model, ...args], {
      cwd: work.worktree,
      stdio: ["ignore", "pipe", "pipe"],
      env: environmentFor(work, this.effort),
    });
    const session: Session = { child, id: work.session, spent: zero(), ended: null, last: "" };
    this.live.set(work.id, session);

    let rest = "";
    // Correlates a denied tool_result back to the tool_use that named the path, so it
    // spans the whole stream rather than one chunk of it.
    const asked = new Map<string, string>();
    child.stdout?.on("data", (chunk: Buffer) => {
      appendFileSync(log, chunk);
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const event = parse(line);
        if (event === null) continue;
        if (typeof event["session_id"] === "string") session.id = event["session_id"];
        for (const path of denialsIn(event, asked, work.worktree)) {
          const paths = this.denied.get(work.id) ?? new Set<string>();
          paths.add(path);
          this.denied.set(work.id, paths);
        }
        const text = textOf(event);
        if (text !== null) session.last = text;
        const usage = event["usage"];
        if (usage !== null && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          const input = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
          const output = typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
          session.spent = {
            tokens: session.spent.tokens + input + output,
            seconds: session.spent.seconds,
          };
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => appendFileSync(log, chunk));

    child.on("error", () => {
      session.ended = { phase: "failed", session: session.id, spent: session.spent, reason: "lost" };
    });

    child.on("close", (code) => {
      const lesson = lessonIn(session.last);
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

/** The model used when the assignment does not name one.
 *
 *  A literal here, and the one thing in this file that ought not to be: which model a role
 *  works on is the operator's to set, so it belongs beside the role's scope and budget in
 *  config/roles.yaml, carried onto the assignment and read off `work.model`. That path
 *  needs core, so until it exists this constant is the declared fallback — explicit, in
 *  one place, and not the environment's. */
export const DEFAULT_MODEL = "claude-opus-5";

/** The only variables a worker inherits from whatever started the runner.
 *
 *  Everything else the child would have got by default — a settings path, a model, a
 *  thinking budget, a half-finished login, an editor, a repo's own tooling switches — is
 *  the daemon's shell leaking into the attempt, and the reason one assignment behaved
 *  differently on two machines. A name here is a claim that the harness cannot start
 *  without it (reaching the API, or finding a binary); the rest is built below. */
export const INHERITED: readonly string[] = [
  // Finding and running the harness at all.
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  // Reaching Anthropic: credentials, endpoint, and the network in between.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/** The environment one session is given, built rather than inherited.
 *
 *  Exported because it is the claim the test reads: what is in it, and — the part that
 *  matters — that nothing else is. */
export function environmentFor(
  work: Work,
  effort: Effort,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = ambient[name];
    if (value !== undefined) env[name] = value;
  }
  // Stated, not inherited: how hard to think, and which assignment is thinking. The second
  // is what makes a stray process on the machine attributable to a row in the record.
  env["MAX_THINKING_TOKENS"] = String(THINKING_TOKENS[effort]);
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

/** What the session said, out of whichever event shape carried it. A `result` event is the
 *  final message; an `assistant` event is one on the way to it. */
function textOf(event: Record<string, unknown>): string | null {
  if (typeof event["result"] === "string") return event["result"];
  const message = event["message"];
  if (message === null || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
    .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string);
  return parts.length === 0 ? null : parts.join("\n");
}

const plural = (n: number): string => (n === 1 ? "one has" : `${n} have`);

/** ours -> Claude Code's. An unmapped name is passed through, so a role can name a tool
 *  wecode has never heard of. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
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
