/** A pane's terminal can be resized, or it is only a recording of one. The pane sits in a
 *  window, the window moves, and each move has to reach the session: the agent inside must
 *  be told the terminal is now this size, while it runs, with no keystroke sent and no
 *  reopening of the session. The first pty here was built on util-linux's `script`, which
 *  takes a size exactly once — an `stty` before the command starts — and never again, so a
 *  pane could open a terminal and then never move it: the agent inside stayed at the size
 *  it opened at, whatever the window did. This is the proof that it now can be moved: a
 *  session opened at one size, resized again and again, and a program inside that says
 *  what size it believes it is each time that belief changes. */
import { afterEach, describe, expect, it } from "vitest";
import { Session, SessionError } from "../src/pty.js";

/** An agent that watches the size it has been told it is, and says so out loud every time
 *  it changes. `stty size` asks the pty itself, so what this prints is what the far end
 *  believes, not what the pane asked for — and it never reads a keystroke, so the only way
 *  a new size can reach it is the pty being resized underneath the running program. */
const WATCHER = {
  command: "sh",
  args: [
    "-c",
    'p=""; while :; do s=$(stty size); if [ "$s" != "$p" ]; then p="$s"; echo "SIZE[$s]"; fi; sleep 0.1; done',
  ],
};

/** Every terminal any test here opened, so none is left holding the process open. */
const terminals: Session[] = [];
afterEach(async () => {
  for (const terminal of terminals.splice(0)) await terminal.close();
});

/** Wait until something has said so, polling the accumulated text rather than counting
 *  chunks: a pty splits where it likes, and a watcher on a timer says nothing for a
 *  moment, so a test that assumed one write is one chunk would be flaky for a reason that
 *  has nothing to do with what it is checking. */
async function said(text: () => string, wanted: RegExp, why: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (wanted.test(text())) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${why}: never said ${wanted}, only ${JSON.stringify(text())}`);
}

describe("a session the pane holds", () => {
  it("opens at the size it was given", async () => {
    const terminal = Session.open({ ...WATCHER, cols: 132, rows: 26 });
    terminals.push(terminal);
    await said(() => terminal.output, /SIZE\[26 132\]/, "the far end never heard the size it opened at");
  });

  it("is told a new size while it runs, with no keystroke sent", async () => {
    const terminal = Session.open(WATCHER);
    terminals.push(terminal);
    // The default size first: the far end starts by believing 30 rows of 100 columns.
    await said(() => terminal.output, /SIZE\[30 100\]/, "the far end never heard the size it opened at");
    // The move itself: no key goes in, no session is reopened — the pane only says the
    // window is now this shape, and the running program hears it and redraws.
    terminal.resize(120, 40);
    await said(() => terminal.output, /SIZE\[40 120\]/, "the far end was never told the new size");
  });

  it("can be resized again and again, whatever the window does", async () => {
    const terminal = Session.open({ ...WATCHER, cols: 80, rows: 24 });
    terminals.push(terminal);
    await said(() => terminal.output, /SIZE\[24 80\]/, "the far end never heard the size it opened at");
    // A window does not move once: it is dragged, maximised, tiled. Every move must land,
    // and land in order, or the agent draws for a window that is already somewhere else.
    terminal.resize(61, 17);
    await said(() => terminal.output, /SIZE\[17 61\]/, "the far end was never told the first new size");
    terminal.resize(200, 50);
    await said(() => terminal.output, /SIZE\[50 200\]/, "the far end was never told the second new size");
  });

  it("refuses a resize once the session has left, as it refuses a keystroke", async () => {
    const terminal = Session.open({ command: "sh", args: ["-c", "exit 0"] });
    expect(await terminal.left()).toBe(0);
    expect(() => terminal.resize(80, 24)).toThrow(SessionError);
    expect(() => terminal.resize(80, 24)).toThrow(/has left/);
  });
});
