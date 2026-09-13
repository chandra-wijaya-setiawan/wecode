import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Budget } from "@wecode/core";
import type { Observation, WorkerAdapter, Work } from "../ports.js";

/** Claude Code, as a worker.
 *
 *  Everything harness-specific is here: the flags a scope becomes, the shape of what it
 *  prints, how a session is resumed. Nothing above this file learns which harness ran. */
export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly kind = "agent";

  constructor(
    private readonly bin = "claude",
    private readonly logDir = join(process.cwd(), ".wecode", "sessions"),
  ) {}

  async start(work: Work): Promise<Observation> {
    return this.run(work, [
      "-p",
      this.prompt(work),
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.scopeFlags(work),
    ]);
  }

  /** There is nothing to poll: the process is the session, and run() waits for it. A tick
   *  that finds an assignment already running takes it as still running. */
  async poll(work: Work): Promise<Observation> {
    return { phase: "running", session: work.session ?? "", spent: zero() };
  }

  async answer(work: Work, answer: string): Promise<Observation> {
    if (work.session === null) return { phase: "failed", session: null, spent: zero(), reason: "lost" };
    return this.run(work, [
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
    if (work.session === null) return;
    await new Promise<void>((resolve) => {
      const p = spawn(this.bin, ["stop", work.session as string], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
  }

  /** A role's scope, as flags. This is the whole of the translation. */
  private scopeFlags(work: Work): string[] {
    const flags = ["--add-dir", work.worktree];
    if (work.scope.tools.length > 0) flags.push("--allowedTools", work.scope.tools.join(","));
    return flags;
  }

  private prompt(work: Work): string {
    return [
      work.instruction,
      "",
      `You may change only: ${work.scope.write.join(", ") || "(nothing)"}.`,
      "Write the tests that prove this work, and run them.",
      "If you need a decision from a person, say so and stop rather than guessing.",
    ].join("\n");
  }

  private run(work: Work, args: readonly string[]): Promise<Observation> {
    mkdirSync(this.logDir, { recursive: true });
    const log = join(this.logDir, `assignment-${work.id}.jsonl`);

    return new Promise((resolve) => {
      // stdin is closed: the harness waits on it otherwise, and nothing is going to type.
      const child = spawn(this.bin, [...args], { cwd: work.worktree, stdio: ["ignore", "pipe", "pipe"] });
      let session: string | null = work.session;
      let spent: Budget = zero();
      let rest = "";

      child.stdout.on("data", (chunk: Buffer) => {
        appendFileSync(log, chunk);
        rest += chunk.toString();
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          const event = parse(line);
          if (event === null) continue;
          if (typeof event["session_id"] === "string") session = event["session_id"];
          const usage = event["usage"];
          if (usage !== null && typeof usage === "object") {
            const u = usage as Record<string, unknown>;
            const input = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
            const output = typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
            spent = { tokens: spent.tokens + input + output, seconds: spent.seconds };
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => appendFileSync(log, chunk));
      child.on("error", () => resolve({ phase: "failed", session, spent, reason: "lost" }));
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ phase: "succeeded", session: session ?? "", spent, commit: null });
          return;
        }
        resolve({ phase: "failed", session, spent, reason: code === null ? "lost" : "other" });
      });
    });
  }
}

const zero = (): Budget => ({ tokens: 0, seconds: 0 });

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
