/** The right pane is a terminal on the designer's session.
 *
 *  Four claims, and the last one is the story: the session is a real pty, so the far end
 *  believes it has a terminal; keystrokes go in unread and output comes out whole; a sent
 *  prompt is written to stdin and submitted once, however many newlines the box held; and
 *  the two halves joined are a terminal — a key pressed in the pane reaches the pty, and
 *  what the pty draws lands on the pane's screen.
 *
 *  The pty half runs for real, because a mocked pty proves the mock and the whole question
 *  is whether the far end sees a terminal. `script` allocates it, the same way the tui's
 *  harness does and for the same reason: no pty binding can be added to this tree without
 *  a native build. The browser half runs for real too, against fakes for the parts of the
 *  page it writes to — `terminal.ts` takes every DOM thing as a parameter precisely so
 *  what is exercised here is the module that ships, not a copy of it. */
import { afterEach, describe, expect, it } from "vitest";
import { attach, decode, encode, IDS, keyOf, pane, Screen } from "../src/client/terminal.js";
import type { Parts, ToSession } from "../src/client/terminal.js";
import { DEFAULT_COLS, ENTER, Session, SessionError } from "../src/pty.js";

const open = (options: Parameters<typeof Session.open>[0]): Session => {
  const session = Session.open(options);
  sessions.push(session);
  return session;
};

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

/** Wait until something has said so. Polling the accumulated text rather than counting
 *  chunks: a pty splits where it likes, and a test that assumed one write is one chunk
 *  would be flaky for a reason that has nothing to do with what it is checking. */
async function said(text: () => string, wanted: RegExp, why: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (wanted.test(text())) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${why}: never said ${wanted}, only ${JSON.stringify(text())}`);
}

const until = (session: Session, wanted: RegExp, why: string): Promise<void> =>
  said(() => session.output, wanted, why);

describe("the session is a pty", () => {
  it("gives the far end a terminal, and not a pipe", async () => {
    const session = open({ command: "sh", args: ["-c", "test -t 0 && echo TTY || echo PIPE"] });
    await until(session, /TTY|PIPE/, "the far end never said");
    expect(session.output).toContain("TTY");
    expect(session.output).not.toContain("PIPE");
  });

  /** A pane that lies about its size gets a screen that does not fit it, and a pty nobody
   *  sizes is 0x0, which is worse than either. */
  it("tells the far end the size it was given, and a size when it was given none", async () => {
    const sized = open({ command: "sh", args: ["-c", "stty size"], cols: 132, rows: 24 });
    await until(sized, /\d+ \d+/, "stty never reported");
    expect(sized.output).toContain("24 132");
    const bare = open({ command: "sh", args: ["-c", "stty size"] });
    await until(bare, /\d+ \d+/, "stty never reported");
    expect(bare.output.trim()).toMatch(new RegExp(`\\d+ ${DEFAULT_COLS}`));
    expect(bare.output).not.toContain("0 0");
  });

  it("runs where it was told to, and with the environment it was given", async () => {
    const args = ["-c", "printf '%s|%s\\n' \"$PWD\" \"$MARK\""];
    const session = open({ command: "sh", args, cwd: "/tmp", env: { MARK: "here" } });
    await until(session, /\|/, "the far end never printed");
    expect(session.output).toContain("/tmp|here");
  });
});

describe("keystrokes in, output out", () => {
  it("passes a keystroke through unread", async () => {
    const session = open({ command: "cat" });
    session.keys("hello");
    session.keys(ENTER);
    await until(session, /hello[\s\S]*hello/, "cat never echoed and answered");
    // Once from the pty's own echo of the key, once from cat writing it back: the bytes
    // went in as keys and came out as output.
    expect([...session.output.matchAll(/hello/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("lets a control key reach the far end, which a filtered pane could not", async () => {
    const session = open({ command: "sh", args: ["-c", "trap 'echo CAUGHT; exit 7' INT; sleep 30"] });
    await new Promise((r) => setTimeout(r, 300));
    session.keys("\x03");
    await until(session, /CAUGHT/, "Ctrl-C never reached the far end");
    expect(await session.left()).toBe(7);
  });

  it("hands a watcher the chunks as they come, and stops when it stops watching", async () => {
    const session = open({ command: "cat" });
    const seen: string[] = [];
    const stop = session.watch((chunk) => seen.push(chunk));
    session.keys(`first${ENTER}`);
    await until(session, /first/, "never echoed the first");
    expect(seen.join("")).toContain("first");
    stop();
    const at = seen.length;
    session.keys(`second${ENTER}`);
    await until(session, /second/, "never echoed the second");
    expect(seen.length).toBe(at);
  });

  it("keeps everything drawn, so a pane that attaches late attaches to the screen", async () => {
    const session = open({ command: "sh", args: ["-c", "echo early; sleep 30"] });
    await until(session, /early/, "the far end never printed");
    // A watcher added now sees nothing of `early` — replaying `output` is what makes the
    // late pane's screen the session's screen.
    const seen: string[] = [];
    session.watch((chunk) => seen.push(chunk));
    expect(seen.join("")).not.toContain("early");
    expect(session.output).toContain("early");
  });

  it("reports how it left, and refuses keys afterwards", async () => {
    const session = open({ command: "sh", args: ["-c", "exit 3"] });
    expect(await session.left()).toBe(3);
    expect(session.running).toBe(false);
    expect(session.exit).toBe(3);
    expect(() => session.keys("x")).toThrow(SessionError);
    expect(() => session.prompt("x")).toThrow(/has left/);
    // Closing something already gone is the same answer, not a second kill.
    expect(await session.close()).toBe(3);
  });
});

describe("a sent prompt is written to stdin", () => {
  /** A far end that reads one line at a time and marks each one, so "how many lines did it
   *  see" is a thing the output can be asked. */
  const reader = { command: "sh", args: ["-c", "while IFS= read -r l; do echo \"GOT[$l]\"; done"] };

  it("reaches the session, submitted, without the designer pressing anything", async () => {
    const session = open(reader);
    session.prompt("draw the board");
    await until(session, /GOT\[/, "the prompt was never read");
    expect(session.output).toContain("GOT[draw the board]");
  });

  it("is one submit however many newlines the box held", async () => {
    const session = open(reader);
    session.prompt("first line\nsecond line\r\nthird");
    await until(session, /GOT\[first line second line third\]/, "the prompt was never read");
    // Long enough for a second line to have arrived, if the newlines had submitted.
    await new Promise((r) => setTimeout(r, 400));
    expect([...session.output.matchAll(/GOT\[/g)]).toHaveLength(1);
  });

  it("is a whole prompt, where the same text as keystrokes would sit unsent", async () => {
    const session = open(reader);
    session.keys("typed but not sent");
    await new Promise((r) => setTimeout(r, 400));
    expect(session.output).not.toContain("GOT[");
    session.prompt("and now this");
    await until(session, /GOT\[/, "the prompt was never read");
    // The typed bytes were already in the far end's line, so the one line it reads holds
    // both: the prompt supplied the submit the keystrokes never did.
    expect(session.output).toContain("GOT[typed but not sentand now this]");
  });
});

describe("the keyboard", () => {
  it("sends a printable key as itself", () => {
    for (const key of ["a", "Z", " ", "é"]) expect(keyOf({ key }), key).toBe(key);
  });

  /** The bytes a terminal has sent for these since the vt100 — Enter is CR and not NL,
   *  because that is what the key makes. Getting them wrong is not cosmetic: it is the
   *  difference between a session the designer can drive and one where the arrows print
   *  letters. */
  it("sends the named keys the bytes a terminal sends", () => {
    const named = {
      Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b", Delete: "\x1b[3~",
      ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
    };
    for (const [key, bytes] of Object.entries(named)) expect(keyOf({ key }), key).toBe(bytes);
  });

  it("turns a control chord into its control code, so Ctrl-C interrupts", () => {
    expect(keyOf({ key: "c", ctrlKey: true })).toBe("\x03");
    expect(keyOf({ key: "C", ctrlKey: true })).toBe("\x03");
    expect(keyOf({ key: "a", ctrlKey: true })).toBe("\x01");
  });

  it("prefixes an alt chord with escape, which is what meta-as-escape means", () => {
    expect(keyOf({ key: "b", altKey: true })).toBe("\x1bb");
    expect(keyOf({ key: "Enter", altKey: true })).toBe("\x1b\r");
  });

  /** A lone modifier has no bytes, and Cmd is the browser's own chord: a pane that sent
   *  either would type the word "Shift" and could never be copied out of. */
  it("sends nothing for a press that is not a character", () => {
    for (const key of ["Shift", "Control", "Alt", "CapsLock", "F5", "Meta"]) {
      expect(keyOf({ key }), key).toBe("");
    }
    expect(keyOf({ key: "c", metaKey: true })).toBe("");
  });
});

describe("the screen", () => {
  it("shows what was written, and drops the escapes rather than printing them", () => {
    expect(new Screen().write("hello\nworld").text).toBe("hello\nworld");
    const screen = new Screen().write("\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m");
    expect(screen.text).toBe("red and bold");
    expect(screen.text).not.toContain("[31m");
  });

  it("overwrites the line on a carriage return, so a spinner is one line", () => {
    const screen = new Screen();
    for (const frame of ["|", "/", "-", "\\"]) screen.write(`\r${frame} working`);
    expect(screen.text).toBe("\\ working");
    expect(screen.rows).toBe(1);
  });

  it("takes a character off on a backspace", () => {
    expect(new Screen().write("abcd\b\bX").text).toBe("abXd");
  });

  it("keeps a window rather than a history", () => {
    const screen = new Screen();
    for (let i = 0; i < 50; i++) screen.write(`line ${i}\n`);
    screen.clamp(5);
    expect(screen.rows).toBe(5);
    expect(screen.text).toContain("line 49");
    expect(screen.text).not.toContain("line 40");
  });
});

describe("the wire", () => {
  it("carries a message there and back unchanged, escapes and control bytes and all", () => {
    const messages = [
      { kind: "keys", data: "\x03" },
      { kind: "prompt", text: "a prompt\nwith a newline" },
      { kind: "output", chunk: "\x1b[31mred" },
      { kind: "exit", code: 7 },
    ] as const;
    for (const message of messages) expect(decode(encode(message))).toEqual(message);
  });

  it("refuses a frame that is not one, rather than dying on it", () => {
    for (const frame of ["", "not json", "[]", "null", '{"kind":"keys"}', '{"kind":"nope"}', '{"kind":"exit","code":"7"}']) {
      expect(decode(frame), frame).toBeNull();
    }
  });
});

/** The parts of a page, faked down to what the pane writes to and listens on. */
function parts(): Parts & { press: (e: object) => void; click: () => void; typed: (s: string) => void } {
  const handlers = new Map<string, ((event: never) => void)[]>();
  const on = (type: string, handler: (event: never) => void): void =>
    void handlers.set(type, [...(handlers.get(type) ?? []), handler]);
  const fire = (type: string, event: object): void => {
    for (const h of handlers.get(type) ?? []) (h as (e: object) => void)(event);
  };
  const composer = { value: "" };
  return {
    screen: { textContent: null, scrollTop: 0, scrollHeight: 999 },
    keyboard: { addEventListener: on },
    composer,
    send: { addEventListener: on },
    press: (event) => fire("keydown", event),
    click: () => fire("click", {}),
    typed: (s) => void (composer.value = s),
  };
}

describe("the pane, wired", () => {
  /** A pane, and everything it sent. */
  const wired = (rows = 0) => {
    const page = parts();
    const sent: ToSession[] = [];
    return { page, sent, ...attach(page, (m) => sent.push(m), rows) };
  };

  it("sends a keypress up as keys, and keeps the browser out of it", () => {
    const { page, sent } = wired();
    let prevented = 0;
    page.press({ key: "a", preventDefault: () => (prevented += 1) });
    page.press({ key: "Enter", preventDefault: () => (prevented += 1) });
    expect(sent).toEqual([{ kind: "keys", data: "a" }, { kind: "keys", data: "\r" }]);
    expect(prevented).toBe(2);
  });

  it("sends nothing, and prevents nothing, for a press that makes no bytes", () => {
    const { page, sent } = wired();
    let prevented = 0;
    page.press({ key: "Shift", preventDefault: () => (prevented += 1) });
    page.press({ key: "c", metaKey: true, preventDefault: () => (prevented += 1) });
    expect(sent).toEqual([]);
    expect(prevented).toBe(0);
  });

  it("sends the composed prompt as a prompt, and empties the box", () => {
    const { page, sent } = wired();
    page.typed("draw the board\nin four panels");
    page.click();
    expect(sent).toEqual([{ kind: "prompt", text: "draw the board\nin four panels" }]);
    expect(page.composer.value).toBe("");
    // Emptied, so a second send is not the same prompt twice — and an empty box, or one
    // holding only whitespace, is not a prompt at all.
    page.click();
    page.typed("   \n  ");
    page.click();
    expect(sent).toHaveLength(1);
  });

  it("draws what comes down, says how the session left, and ignores a frame that is not one", () => {
    const { page, receive } = wired();
    receive(encode({ kind: "output", chunk: "\x1b[32mgreen\x1b[0m\nand more" }));
    expect(page.screen.textContent).toBe("green\nand more");
    expect(page.screen.scrollTop).toBe(page.screen.scrollHeight);
    receive("garbage");
    expect(page.screen.textContent).toBe("green\nand more");
    receive(encode({ kind: "exit", code: 2 }));
    expect(page.screen.textContent).toContain("[session left with 2]");
  });

  it("holds a window when it was given one", () => {
    const { page, receive } = wired(3);
    receive(encode({ kind: "output", chunk: "a\nb\nc\nd\ne" }));
    expect(page.screen.textContent).toBe("c\nd\ne");
  });
});

describe("the right pane's markup", () => {
  const markup = pane();

  it("is the right pane, and a screen rather than a transcript", () => {
    expect(markup).toContain(`<section id="${IDS.pane}" class="pane pane-right">`);
    // Preformatted, because the far end laid the columns out already; focusable, because
    // the designer types into it.
    expect(markup).toContain(`<pre id="${IDS.screen}"`);
    expect(markup).toContain('tabindex="0"');
  });

  it("carries a box to compose a prompt in and a way to send it, under the ids it is read by", () => {
    expect(markup).toContain(`<textarea id="${IDS.composer}"`);
    expect(markup).toContain(`<button id="${IDS.send}"`);
    // Every id from the one list, so a rename is one edit and not two.
    for (const id of Object.values(IDS)) expect(markup, id).toContain(`id="${id}"`);
  });

  it("is a fragment, and never a document of its own", () => {
    expect(markup).not.toContain("<!doctype");
    expect(markup).not.toContain("<html");
  });
});

describe("the two halves are a terminal", () => {
  /** The pane and the pty, joined the way a socket would join them — and nothing else
   *  mocked. A key pressed in the browser reaches the pty; what the pty draws lands on the
   *  browser's screen. That round trip is the story. */
  const joined = (options: Parameters<typeof Session.open>[0]) => {
    const session = open(options);
    const page = parts();
    const wired = attach(page, (message) => {
      if (message.kind === "keys") session.keys(message.data);
      else session.prompt(message.text);
    });
    session.watch((chunk) => wired.receive(encode({ kind: "output", chunk })));
    return { session, page };
  };

  const shown = (page: ReturnType<typeof parts>, wanted: RegExp): Promise<void> =>
    said(() => page.screen.textContent ?? "", wanted, "the screen");

  const ECHO = { command: "sh", args: ["-c", "while IFS= read -r l; do echo \"you said $l\"; done"] };

  it("puts a keystroke through to the pty and the result back on the screen", async () => {
    const { page } = joined(ECHO);
    for (const key of [..."hello"]) page.press({ key });
    page.press({ key: "Enter" });
    await shown(page, /you said hello/);
  });

  it("puts a sent prompt through the same way, without a keypress", async () => {
    const { page } = joined(ECHO);
    page.typed("a prompt");
    page.click();
    await shown(page, /you said a prompt/);
  });

  it("shows the far end's redraw as a redraw, and not as a hundred lines", async () => {
    const { page, session } = joined({
      command: "sh",
      args: ["-c", "for i in 1 2 3 4 5; do printf '\\r%s%%' \"$i\"; sleep 0.05; done; printf '\\ndone\\n'"],
    });
    await shown(page, /done/);
    await session.left();
    const lines = (page.screen.textContent ?? "").split("\n");
    // The five frames overwrote one line, so the screen is that line plus the two after.
    expect(lines.filter((l) => l.includes("%"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("5%"))).toBe(true);
  });
});
