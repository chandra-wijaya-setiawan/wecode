import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Budget } from "@wecode/core";
import type { Observation, WorkerAdapter, Work } from "../ports.js";

/** A script, as a worker.
 *
 *  The assignment's instruction is a shell command rather than a brief, and the worker is
 *  whatever that command does. Everything harness-specific is here: the shell, the timeout
 *  the run is given, and the fact that an exit code is the only thing this worker ever
 *  says. Nothing above this file learns that no agent ran.
 *
 *  It reports; it never judges. An exit code becomes `succeeded` or `failed` and nothing
 *  else — not a verdict on a test, not a pass, not a widened scope. The script may print
 *  whatever it likes and none of it is read: whether a test passed is the examiner's
 *  observation and whether a verdict may be entered is the engine's decision, so an
 *  adapter that took the output for an answer would be the one component lying about the
 *  record. That is why this module holds no database, no engine and no verb. */
export class ScriptAdapter implements WorkerAdapter {
  readonly kind = "script";

  constructor(
    /** Its own, and deliberately not the foreman's deadline. The foreman judges an
     *  assignment overdue from `last_seen`, which a restart backdates and a long tick
     *  stretches; a script has no session to reattach to, so a run nobody bounded would
     *  outlive every tick that could have killed it. The adapter that starts the process
     *  is the only thing holding the handle, so it is the thing that must time it out. */
    private readonly timeoutMs = 15 * 60 * 1000,
    private readonly shell = "bash",
    private readonly logDir = join(process.cwd(), ".wecode", "sessions"),
  ) {}

  /** Runs this adapter has started and not yet seen finish. A run outlives the tick that
   *  started it, exactly as an agent session does — a tick that waited for the script could
   *  never start a second one. */
  private readonly live = new Map<number, Run>();

  async start(work: Work): Promise<Observation> {
    return this.run(work, work.instruction);
  }

  /** What the run has done since: the observation it ended with, or that it is still
   *  going. */
  async poll(work: Work): Promise<Observation> {
    const run = this.live.get(work.id);
    if (run === undefined) {
      // Nothing here knows about it: the runner restarted while it was running.
      return { phase: "failed", session: work.session, spent: zero(), reason: "lost" };
    }
    if (run.ended !== null) {
      this.live.delete(work.id);
      return run.ended;
    }
    return { phase: "running", session: run.id, spent: elapsed(run) };
  }

  /** A script keeps no transcript, so there is nothing to continue. Reattaching would mean
   *  running the command a second time, and a command that has already half-run is not the
   *  same command — so this says lost, which is an answer rather than an error, and the
   *  foreman fails the attempt as it would have anyway. */
  async resume(work: Work): Promise<Observation> {
    return { phase: "failed", session: work.session, spent: zero(), reason: "lost" };
  }

  /** A script never asks, so it never reaches `waiting` and an answer can only be meant for
   *  a run this adapter has lost. Re-running the command on somebody's answer would be this
   *  adapter deciding what the answer meant. */
  async answer(work: Work, _answer: string): Promise<Observation> {
    return { phase: "failed", session: work.session, spent: zero(), reason: "lost" };
  }

  async kill(work: Work): Promise<void> {
    const run = this.live.get(work.id);
    if (run === undefined) return;
    clearTimeout(run.timer);
    run.child.kill("SIGKILL");
    this.live.delete(work.id);
  }

  /** Start the command and return at once. What it does afterwards lands in `live`, and the
   *  next poll reads it. */
  private run(work: Work, command: string): Promise<Observation> {
    mkdirSync(this.logDir, { recursive: true });
    const log = join(this.logDir, `assignment-${work.id}.log`);

    const child = spawnProcess(this.shell, ["-lc", command], {
      cwd: work.worktree,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const id = work.session ?? `script-${work.id}`;
    const run: Run = {
      child,
      id,
      started: Date.now(),
      ended: null,
      timer: setTimeout(() => {
        // Its own timeout, fired here rather than reported: the process must actually stop,
        // and then the observation is what stopping it left behind.
        run.ended = { phase: "failed", session: id, spent: elapsed(run), reason: "timeout" };
        child.kill("SIGKILL");
      }, this.timeoutMs),
    };
    // Node keeps the process alive for a pending timer, and a 15-minute one would hold the
    // runner open long after the tick that set it.
    run.timer.unref?.();
    this.live.set(work.id, run);

    child.stdout?.on("data", (chunk: Buffer) => appendFileSync(log, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendFileSync(log, chunk));

    child.on("error", () => {
      clearTimeout(run.timer);
      run.ended = { phase: "failed", session: id, spent: elapsed(run), reason: "lost" };
    });

    child.on("close", (code) => {
      clearTimeout(run.timer);
      // A timeout already said what this run came to, and the close it caused must not
      // overwrite it with `other`.
      if (run.ended !== null) return;
      run.ended =
        code === 0
          ? { phase: "succeeded", session: id, spent: elapsed(run), commit: null }
          : { phase: "failed", session: id, spent: elapsed(run), reason: code === null ? "lost" : "other" };
    });

    return Promise.resolve({ phase: "running", session: id, spent: zero() });
  }
}

interface Run {
  readonly child: ChildProcess;
  readonly id: string;
  readonly started: number;
  readonly timer: NodeJS.Timeout;
  ended: Observation | null;
}

const zero = (): Budget => ({ tokens: 0, seconds: 0 });

/** What the run has spent. Seconds only: a script burns no tokens, and reporting a guess
 *  as a spend would put a number in the record that nothing measured. */
const elapsed = (run: Run): Budget => ({
  tokens: 0,
  seconds: Math.round((Date.now() - run.started) / 1000),
});
