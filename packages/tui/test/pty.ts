/** The cockpit as an operator meets it: the built binary, in a real terminal, driven by
 *  keystrokes. Every other test in here renders App or Cockpit directly, which proves what
 *  is drawn but never that the process draws it — raw mode, the tty size, the frame that
 *  only appears because Ink was told it is talking to a terminal. This drives dist/bin.js
 *  through a pty and hands back the frame as text.
 *
 *  There is no pty binding in the dependency tree and none can be added without a native
 *  build, so the pty is util-linux's `script`, which allocates one and copies both ways.
 *  `stty` inside it gives the terminal a size; without that the pty is 0x0 and the cockpit
 *  falls back to a width nobody asked for. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** Ink brackets every frame it writes in synchronised-update markers, so the frames are
 *  delimited in the stream itself and no guess about where one ends is needed. */
const BEGIN = "[?2026h";
const END = "[?2026l";
const ANSI = /\[[0-9;?]*[a-zA-Z]/g;

/** Everything ansi, gone, and every line's trailing padding with it: what is left is what
 *  a reader sees on the screen. */
export const text = (frame: string): string =>
  frame
    .replace(ANSI, "")
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export interface Options {
  /** The workspace database to look at. A cockpit is never given one to create. */
  readonly db: string;
  readonly cols?: number;
  readonly rows?: number;
  /** How long any one frame is allowed to take. */
  readonly timeout?: number;
}

/** A running cockpit. Keys go in, frames come out, and it is closed however the test ends. */
export class Cockpit {
  private readonly child: ChildProcess;
  private readonly timeout: number;
  private pending = "";
  private readonly frames: string[] = [];
  private readonly waiting: (() => void)[] = [];
  private done: number | null = null;

  private constructor(child: ChildProcess, timeout: number) {
    this.child = child;
    this.timeout = timeout;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.take(chunk));
    child.on("exit", (code) => {
      this.done = code ?? 0;
      this.wake();
    });
  }

  /** Start one and wait for the frame it opens on. */
  static async open(options: Options): Promise<Cockpit> {
    if (!existsSync(BIN)) throw new Error(`no built cockpit at ${BIN} — run \`pnpm -r build\``);
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 40;
    const inner = `stty rows ${rows} cols ${cols}; exec node ${quote(BIN)} --db ${quote(options.db)}`;
    const child = spawn("script", ["-qfec", inner, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    });
    const cockpit = new Cockpit(child, options.timeout ?? 15_000);
    await cockpit.settle(1);
    return cockpit;
  }

  private take(chunk: string): void {
    this.pending += chunk;
    for (;;) {
      const from = this.pending.indexOf(BEGIN);
      if (from < 0) return;
      const to = this.pending.indexOf(END, from);
      if (to < 0) return;
      this.frames.push(this.pending.slice(from + BEGIN.length, to));
      this.pending = this.pending.slice(to + END.length);
      this.wake();
    }
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  /** Wait until `count` frames have been drawn. */
  private async settle(count: number): Promise<void> {
    while (this.frames.length < count) {
      if (this.done !== null) {
        throw new Error(`the cockpit left with ${this.done} after ${this.frames.length} frames`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame in time")), this.timeout);
        this.waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The last frame drawn, as text. */
  frame(): string {
    const last = this.frames.at(-1);
    if (last === undefined) throw new Error("nothing has been drawn");
    return text(last);
  }

  /** How many frames have been drawn. Ink writes nothing when a redraw would say the same
   *  thing, so this counts the times the screen actually changed. */
  get drawn(): number {
    return this.frames.length;
  }

  /** Press keys and hand back the frame they redrew. */
  async press(keys: string): Promise<string> {
    const next = this.frames.length + 1;
    this.child.stdin?.write(keys);
    await this.settle(next);
    return this.frame();
  }

  /** Quit the way an operator does, and hand back the exit code. */
  async quit(): Promise<number> {
    this.child.stdin?.write("q");
    return this.leave();
  }

  /** Close it however it got here. Safe to call twice. */
  async close(): Promise<number> {
    if (this.done === null) this.child.kill("SIGTERM");
    return this.leave();
  }

  private async leave(): Promise<number> {
    while (this.done === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the cockpit would not leave")), this.timeout);
        this.waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.done;
  }
}
