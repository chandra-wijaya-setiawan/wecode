// @vitest-environment happy-dom
/** The dock runs a shell: the pane in the document is an xterm.js terminal, and what it is
 *  attached to is the route the operator's login shell answers on.
 *
 *  `the-banner-opens-a-terminal.test.ts` holds the drawing of the dock — that it is there,
 *  closed, down the right edge. This holds the two live halves it says nothing about: the
 *  far end behind `SHELL_AT`, and the pane that reads it.
 *
 *  The pane is not reimplemented here and is not stubbed either. It is the painter's
 *  `attach`, whose shape is `attach(parts, terminal, send)` — the emulator is this
 *  surface's to construct and the painter's to drive, and what comes back is a `receive`
 *  for the frames coming down and the `terminal` itself for anything that wants to read the
 *  screen. So these statements run the real `attach` over a real xterm.js terminal opened
 *  on the dock's own markup, and read the answers off the emulator's buffer rather than off
 *  a transcript of what was written to it: a screen that only kept the text would pass a
 *  test about text and still lose the colour, the cursor and the clear.
 *
 *  Nothing here spawns a shell. Which shell runs is `loginShell`'s one decision and the
 *  painter's `Session` is what runs it; a stand-in for `Shelled` is what lets the route's
 *  own decisions — one shell, a cursor that draws a chunk once, a farewell said once, a key
 *  pressed at a shell that has left — be stated without thirty ptys. */
import { describe, expect, it } from "vitest";
import { userInfo } from "node:os";
import { Terminal } from "@xterm/xterm";
import { DEFAULT_ROWS } from "@wecode/painter/dist/pty.js";
import { encode } from "@wecode/painter/dist/client/terminal.js";
import type { Page, Verb } from "../src/server.js";
import {
  DOCK,
  dock,
  document as documentOf,
  loginShell,
  PARTS,
  SHELL_AT,
  shellAt,
  type Drawn,
  type Opens,
  type Shelled,
  type Wire,
} from "../src/pages/shell.js";

/** A shell that draws what a statement tells it to. The painter's `Session` is one of
 *  these; this one has a hand on the far end. */
class Pretend implements Shelled {
  output = "";
  running = true;
  exit: number | null = null;
  readonly heard: string[] = [];
  readonly opened: { command: string; cwd: string };
  closed = 0;

  constructor(opened: { command: string; cwd: string }) {
    this.opened = opened;
  }

  keys(input: string): void {
    this.heard.push(input);
  }

  prompt(text: string): void {
    this.heard.push(`${text}\r`);
  }

  close(): Promise<number> {
    this.closed += 1;
    this.running = false;
    return Promise.resolve(this.exit ?? 0);
  }

  draws(chunk: string): void {
    this.output += chunk;
  }

  leaves(code: number): void {
    this.running = false;
    this.exit = code;
  }
}

/** The route, with every shell it opened kept for reading. */
function farEnd(where = "/a/workspace") {
  const shells: Pretend[] = [];
  const opens: Opens = (options) => {
    const shell = new Pretend({ ...options });
    shells.push(shell);
    return shell;
  };
  const { route, close } = shellAt(() => where, opens);
  if (typeof route === "function" || route.get === undefined || route.post === undefined) {
    throw new Error("the dock's route answers both GET and POST");
  }
  const get: Page = route.get;
  const post: Verb = route.post;
  const at = (from: number): URL => new URL(`${SHELL_AT}?from=${from}`, "http://board.invalid");
  return {
    shells,
    close,
    /** The last shell the route opened, which is the one it is holding. */
    held: (): Pretend => {
      const last = shells.at(-1);
      if (last === undefined) throw new Error("no shell has been opened");
      return last;
    },
    drawn: (from: number): Drawn => JSON.parse(get(at(from)).body) as Drawn,
    poll: (from: number) => get(at(from)),
    send: (frame: string) => post(at(0), frame),
  };
}

/** The dock as the document draws it, with the pane attached to `wire`. The parts are
 *  queried out of the real markup by the real `PARTS` selectors: a pane wired to elements a
 *  test invented would prove nothing about the dock a reader is served. */
function paneOn(wire: Wire, terminal?: Terminal) {
  const host = globalThis.document.createElement("div");
  host.innerHTML = documentOf("<p>a page</p>");
  const one = (selector: string): Element => {
    const found = host.querySelectorAll(selector);
    if (found.length !== 1) throw new Error(`the dock draws ${found.length} of ${selector}`);
    return found[0] as Element;
  };
  const screen = one(PARTS.screen) as HTMLElement;
  const keyboard = one(PARTS.keyboard) as HTMLInputElement;
  const send = one(PARTS.send);
  const parts = { screen, keyboard, composer: keyboard, send };
  const docked = terminal === undefined ? dock(parts, wire) : dock(parts, wire, terminal);
  return {
    ...docked,
    screen,
    line: keyboard,
    /** A real keypress on the real line, and whether the browser was kept out of it. */
    press: (key: string, held: Partial<KeyboardEventInit> = {}): boolean => {
      const event = new KeyboardEvent("keydown", { key, cancelable: true, ...held });
      keyboard.dispatchEvent(event);
      return event.defaultPrevented;
    },
    submit: (): void => void send.dispatchEvent(new Event("submit", { cancelable: true })),
  };
}

/** The wire the page will hold: `fetch` against `SHELL_AT`, here the route itself. */
const wireTo = (end: ReturnType<typeof farEnd>): Wire => ({
  send: async (frame) => end.send(frame),
  drawn: async (from) => end.drawn(from),
});

/** xterm.js writes on its own turn, so a statement about the screen waits for it. */
const settled = (terminal: Terminal): Promise<void> =>
  new Promise((resolve) => terminal.write("", resolve));

const line = (terminal: Terminal, y: number): string =>
  terminal.buffer.active.getLine(y)?.translateToString(true) ?? "";

describe("the pane is the painter's terminal, on the dock's own markup", () => {
  it("opens the terminal it was given on the element the dock draws", () => {
    const end = farEnd();
    const terminal = new Terminal({ rows: 8, cols: 40 });
    const pane = paneOn(wireTo(end), terminal);
    // The one the pane hands back is the one that was handed in — `Attached.terminal`, not
    // a screen of the dock's own invention.
    expect(pane.terminal).toBe(terminal);
    expect(terminal.element?.parentElement).toBe(pane.screen);
    expect(pane.screen.getAttribute("data-ui")).toBe("shell.dock.output");
    end.close();
  });

  it("makes its own terminal at the pty's row count when the page hands none in", () => {
    const end = farEnd();
    const pane = paneOn(wireTo(end));
    expect(pane.terminal.rows).toBe(DEFAULT_ROWS);
    end.close();
  });

  it("names four parts, each one element of the dock", () => {
    // `paneOn` refuses anything but exactly one match per selector, so reaching here is the
    // statement; this says which four, so a rename in the markup cannot quietly drop one.
    const end = farEnd();
    paneOn(wireTo(end));
    expect(Object.keys(PARTS).sort()).toEqual(["composer", "keyboard", "screen", "send"]);
    expect(PARTS.keyboard).toBe(`#${DOCK}-line`);
    end.close();
  });
});

describe("what the shell draws reaches the emulator", () => {
  it("interprets the shell's escapes instead of keeping its text", async () => {
    const end = farEnd();
    const pane = paneOn(wireTo(end), new Terminal({ rows: 8, cols: 40 }));
    expect(await pane.pump()).toBe(0); // the first poll opens the shell; it has drawn nothing
    end.held().draws("\x1b[32m$\x1b[0m one\r\ntwo\r\n\x1b[1;1H\x1b[2K\x1b[Hredrawn");
    await pane.pump();
    await settled(pane.terminal);
    expect(line(pane.terminal, 0)).toBe("redrawn");
    expect(line(pane.terminal, 1)).toBe("two");
    expect(line(pane.terminal, 0)).not.toContain("[2K");
    end.close();
  });

  it("carries a cursor, so a chunk is drawn once however often the pane pumps", async () => {
    const end = farEnd();
    const pane = paneOn(wireTo(end), new Terminal({ rows: 8, cols: 40 }));
    await pane.pump();
    end.held().draws("once\r\n");
    const at = await pane.pump();
    expect(at).toBe("once\r\n".length);
    expect(await pane.pump()).toBe(at);
    await settled(pane.terminal);
    expect(line(pane.terminal, 0)).toBe("once");
    expect(line(pane.terminal, 1)).toBe("");
    end.close();
  });

  it("says the shell left, once, under its last line", async () => {
    const end = farEnd();
    const pane = paneOn(wireTo(end), new Terminal({ rows: 8, cols: 40 }));
    await pane.pump();
    end.held().draws("goodbye\r\n");
    // The screen first, then the farewell: a pane told the shell had left before it had the
    // last chunk would print it above the shell's own goodbye. The pump that takes the
    // chunk moves the cursor off 0, which is also what stops the next poll from being read
    // as a fresh attach and getting a new shell.
    expect(await pane.pump()).toBe("goodbye\r\n".length);
    end.held().leaves(3);
    await pane.pump();
    await pane.pump();
    await settled(pane.terminal);
    expect(line(pane.terminal, 0)).toBe("goodbye");
    expect(line(pane.terminal, 1)).toBe("[session left with 3]");
    expect(line(pane.terminal, 2)).toBe("");
    end.close();
  });
});

describe("what the designer types reaches the shell", () => {
  it("sends a keypress up unread, and keeps the browser out of it", async () => {
    const end = farEnd();
    const pane = paneOn(wireTo(end), new Terminal({ rows: 8, cols: 40 }));
    await pane.pump();
    expect(pane.press("a")).toBe(true);
    expect(pane.press("ArrowUp")).toBe(true);
    expect(pane.press("c", { ctrlKey: true })).toBe(true);
    expect(pane.press("Enter")).toBe(true);
    await Promise.resolve();
    // The escape sequences, not the key names: the pane does not know what a key means.
    expect(end.held().heard).toEqual(["a", "\x1b[A", "\x03", "\r"]);
    // A press that makes no bytes is the browser's own business.
    expect(pane.press("Shift")).toBe(false);
    end.close();
  });

  it("sends a composed line whole and empties the box", async () => {
    const end = farEnd();
    const pane = paneOn(wireTo(end), new Terminal({ rows: 8, cols: 40 }));
    await pane.pump();
    pane.line.value = "ls -l";
    pane.submit();
    await Promise.resolve();
    expect(end.held().heard).toEqual(["ls -l\r"]);
    expect(pane.line.value).toBe("");
    end.close();
  });
});

describe("the shell behind the dock", () => {
  it("runs the operator's own login shell, where the workspace is", async () => {
    const end = farEnd("/a/workspace");
    await paneOn(wireTo(end)).pump();
    expect(end.held().opened).toEqual({ command: loginShell(), cwd: "/a/workspace" });
    expect(loginShell()).toBe(userInfo().shell ?? process.env["SHELL"] ?? "/bin/sh");
    end.close();
  });

  it("opens nothing until the dock is read, and then opens one shell", () => {
    const end = farEnd();
    expect(end.shells).toHaveLength(0);
    end.drawn(0);
    end.drawn(0);
    end.drawn(4);
    expect(end.shells).toHaveLength(1);
    end.close();
  });

  it("replaces the shell only when a pane attaches fresh to one that has left", () => {
    const end = farEnd();
    end.drawn(0);
    const first = end.held();
    first.draws("bye\r\n");
    first.leaves(0);
    end.drawn(5); // the middle of a session: the same shell, however it ended
    expect(end.shells).toHaveLength(1);
    end.drawn(0); // a dock reopened: a new shell, and the screen from its start
    expect(end.shells).toHaveLength(2);
    expect(end.held()).not.toBe(first);
    end.close();
  });

  it("refuses what is not a frame, and says so when the shell has left", () => {
    const end = farEnd();
    expect(end.send(`{"kind":"keys","data":"x"}`).status).toBe(409); // nothing attached yet
    end.drawn(0);
    expect(end.send("not json").status).toBe(400);
    expect(end.send(encode({ kind: "exit", code: 0 })).status).toBe(400);
    expect(end.send(encode({ kind: "keys", data: "x" })).status).toBe(200);
    end.held().leaves(1);
    expect(end.send(encode({ kind: "keys", data: "x" })).status).toBe(409);
    expect(end.held().heard).toEqual(["x"]);
    end.close();
  });

  it("lets the shell go when the process does", () => {
    const end = farEnd();
    end.drawn(0);
    const shell = end.held();
    end.close();
    expect(shell.closed).toBe(1);
    expect(shell.running).toBe(false);
  });
});
