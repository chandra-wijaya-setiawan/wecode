/** The designer's session, as a terminal the pane can hold: a real pty with the session
 *  running inside it, keystrokes going in and output coming out.
 *
 *  Why a pty and not a pipe. A session run down a pipe is not the session: the program on
 *  the far end asks `isatty` and gets no, so it draws no frame, takes no raw keys, echoes
 *  nothing, and the pane shows a log instead of a screen. The whole point of this pane is
 *  that the designer sees what they would see in their own terminal, so the far end must
 *  believe it has one.
 *
 *  Why node-pty and not `script`. This terminal was first built on util-linux's `script`,
 *  which allocates a pty, execs a command inside it and copies both ways — but a size can
 *  be given to it exactly once, as an `stty` before the command starts, and never again.
 *  A pane is not opened once and sized once: its window moves, and every move has to reach
 *  the session or the agent inside keeps drawing at the size it opened at, whatever the
 *  window now does. node-pty holds the pty itself and exposes `resize` on it, so the size
 *  is a thing the holder can change for as long as the session runs. The price is a
 *  native build: the pty is a C++ addon compiled by node-gyp when it is installed, and the
 *  workspace allows that build beside esbuild's in `pnpm-workspace.yaml` — a machine with
 *  no toolchain cannot install this package at all.
 *
 *  What this file is not. It does not know about the pane, a socket, or a browser. It
 *  turns a command into an object that takes keystrokes and emits output, and the transport
 *  between that object and the screen is somebody else's sentence. */
import { spawn, type IPty } from "node-pty";

export class SessionError extends Error {}

export interface SessionOptions {
  /** The program to run in the pty, and its arguments. The program is exec'd directly —
   *  not through a shell — so it is a path or a name to find on one, and the arguments
   *  arrive verbatim with no quoting to get wrong. */
  readonly command: string;
  /** The rest may be given as `undefined` as well as left out, because the caller is
   *  often forwarding options it was itself given — `exactOptionalPropertyTypes` would
   *  otherwise make a plain pass-through a type error. */
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The size the far end is told the terminal is. A pane that lies about its size draws
   *  a screen that does not fit it, so these are not decoration. */
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
}

export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;

/** What a terminal sends when the user presses Enter. A pty's line discipline maps CR to
 *  NL on the way in, so CR is what a key sends and NL is what the program reads — sending
 *  NL happens to work through the same path, but it is not what a keyboard does, and a far
 *  end in raw mode can tell the difference. */
export const ENTER = "\r";

/** One chunk of what the session drew. Bytes as the pty produced them, escape sequences
 *  and all: interpreting them is the screen's job, and a pane that is handed pre-stripped
 *  text cannot draw colour, cursor moves or a redraw. */
export type Output = (chunk: string) => void;

/** A running session. Keystrokes in, output out, and closed however the holder ends. */
export class Session {
  private readonly pty: IPty;
  private readonly listeners = new Set<Output>();
  private readonly leaving: ((code: number) => void)[] = [];
  private code: number | null = null;
  /** Everything drawn so far, so a screen that attaches late is not attaching to nothing. */
  private drawn = "";

  private constructor(pty: IPty) {
    this.pty = pty;
    pty.onData((chunk: string) => {
      this.drawn += chunk;
      for (const listener of this.listeners) listener(chunk);
    });
    pty.onExit(({ exitCode, signal }) => {
      // A death by signal carries no exit code the far end chose, so it is not reported
      // as the clean zero the pty hands back for one: it is a leaving, and it left wrong.
      this.code = signal ? 1 : exitCode;
      for (const done of this.leaving.splice(0)) done(this.code);
    });
  }

  /** Start one. The command is exec'd inside the pty rather than run under a shell that
   *  outlives it, so the session's exit is the pty's exit and nothing lingers holding it
   *  open. */
  static open(options: SessionOptions): Session {
    const pty = spawn(options.command, [...(options.args ?? [])], {
      name: "xterm-256color",
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { TERM: "xterm-256color", ...process.env, ...options.env },
    });
    return new Session(pty);
  }

  /** Whether the session is still running. */
  get running(): boolean {
    return this.code === null;
  }

  /** The exit code, or null while it is still running. */
  get exit(): number | null {
    return this.code;
  }

  /** Everything the session has drawn since it opened. A pane that attaches to a session
   *  already running replays this first and then follows `watch`, so what is on its screen
   *  is what is on the session's screen and not just what happened after it looked. */
  get output(): string {
    return this.drawn;
  }

  /** Follow the output. Hands back the way to stop following. */
  watch(listener: Output): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Keystrokes, verbatim. This is the raw side: what is written here is what the pty
   *  receives, control bytes and all, because a pane that filters keys is a pane the
   *  designer cannot press Ctrl-C in. */
  keys(input: string): void {
    if (!this.running) throw new SessionError("the session has left");
    this.pty.write(input);
  }

  /** Tell the far end the terminal is now this size. A pane calls this every time its
   *  window moves, because the size the session opened at is a fact about the window the
   *  moment it opened and about nothing after: the far end is told the new one, and the
   *  running program hears it as the window-change a real terminal would have sent. */
  resize(cols: number, rows: number): void {
    if (!this.running) throw new SessionError("the session has left");
    this.pty.resize(cols, rows);
  }

  /** A prompt the designer sent from the pane rather than typed: the text, then the key
   *  that submits it.
   *
   *  It goes down the same stdin as the keystrokes, because there is no other way in — the
   *  far end is a program reading a terminal, not a service with an API. The one thing
   *  this does that `keys` does not is guarantee the submit: a prompt is a thing the
   *  designer has finished writing, and a prompt that arrives without its Enter sits in the
   *  far end's composer looking sent.
   *
   *  Newlines inside the text are the hazard. A prompt written in a textarea carries them,
   *  and each one would submit early, turning one prompt into several half-prompts. So
   *  they are not passed through: the text is sent as its lines, and only the end of the
   *  whole prompt is an Enter. What a far end does with the fragments is its business; what
   *  this guarantees is that it sees one submit, at the end. */
  prompt(text: string): void {
    if (!this.running) throw new SessionError("the session has left");
    this.pty.write(text.replaceAll("\r\n", "\n").replaceAll("\n", " ") + ENTER);
  }

  /** Close it however it got here, and hand back the exit code. Safe to call twice. */
  async close(): Promise<number> {
    if (this.code !== null) return this.code;
    this.pty.kill();
    return this.left();
  }

  /** Wait for it to leave on its own. */
  async left(): Promise<number> {
    if (this.code !== null) return this.code;
    return new Promise<number>((done) => this.leaving.push(done));
  }
}
