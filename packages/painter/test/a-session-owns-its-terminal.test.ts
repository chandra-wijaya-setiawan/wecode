/** A session owns its terminal, or owns a queue — and which one it owns is decided by
 *  whether the caller named a command when it opened.
 *
 *  The first half is the story: a session opened with a command starts that command inside
 *  a pty of its own the moment it opens, so the agent runs inside the review rather than
 *  somewhere else polling it. The person's prompts are written into the terminal; resuming
 *  the artefact does not start a second agent beside the first; ending the review ends the
 *  agent with it. The pty runs for real, because a mocked pty proves the mock, and the
 *  whole question is whether the agent is genuinely inside.
 *
 *  The second half is the constraint that makes the first half safe to land: a session
 *  opened with no command keeps the prompt queue and the poll exactly as they were,
 *  because that is how lavish-axi reaches its agent today, and it must not break while
 *  painter replaces it. */
import { afterEach, describe, expect, it } from "vitest";
import {
  end,
  open,
  poll,
  prompts,
  reply,
  sessionOf,
  store,
  terminalOf,
  SessionError,
  type Store,
} from "../src/session.js";
import type { Session as Terminal } from "../src/pty.js";

const ARTEFACT = "/repo/.painter/board.html";
const PAGE = "<html><body><h1>the board</h1></body></html>";

/** An agent that reads one line at a time and marks each one, so "did the prompt reach the
 *  agent inside" is a thing the terminal's output can be asked. */
const READER = { command: "sh", args: ["-c", 'while IFS= read -r l; do echo "GOT[$l]"; done'] };

/** Every terminal any test here opened, so none is left holding the process open. */
const terminals: Terminal[] = [];
afterEach(async () => {
  for (const terminal of terminals.splice(0)) await terminal.close();
});

/** Open the artefact's session on a store, and remember any terminal for the teardown. */
const opened = (held: Store, options: Parameters<typeof open>[3] = {}): string => {
  const session = open(held, ARTEFACT, PAGE, options);
  const terminal = terminalOf(held, session.id);
  if (terminal !== undefined) terminals.push(terminal);
  return session.id;
};

/** Wait until something has said so, polling the accumulated text rather than counting
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

describe("a session opened with a command", () => {
  it("runs the command inside the session, in a terminal the far end believes in", async () => {
    const held = store();
    const id = opened(held, {
      command: "sh",
      args: ["-c", "test -t 0 && echo TTY || echo PIPE; echo INSIDE"],
    });
    const terminal = terminalOf(held, id);
    expect(terminal).toBeDefined();
    expect(sessionOf(held, id)?.terminal).toBe(true);
    await said(() => terminal?.output ?? "", /INSIDE/, "the command never ran");
    // A pty and not a pipe: the agent inside must believe it has a terminal, or it draws
    // no screen and takes no keys — which is the whole point of putting it in one.
    expect(terminal?.output).toContain("TTY");
    expect(terminal?.output).not.toContain("PIPE");
  });

  it("delivers the person's prompt to the agent inside, not to a queue", async () => {
    const held = store();
    const id = opened(held, READER);
    expect(reply(held, id, "make the legend bold").text).toBe("make the legend bold");
    const terminal = terminalOf(held, id);
    await said(() => terminal?.output ?? "", /GOT\[make the legend bold\]/, "the agent never read it");
    // Nothing was queued: the agent is inside and already has it, so there is no backlog
    // for anybody to poll, and nothing to deliver twice.
    expect(prompts(held, id)).toEqual([]);
  });

  it("carries the tag on the record, and the text to the agent", async () => {
    const held = store();
    const id = opened(held, READER);
    expect(reply(held, id, "drawn on", "whiteboard").tag).toBe("whiteboard");
    const terminal = terminalOf(held, id);
    await said(() => terminal?.output ?? "", /GOT\[drawn on\]/, "the agent never read it");
  });

  it("hands a pane the live terminal it owns, not a record of one", async () => {
    const held = store();
    const id = opened(held, READER);
    const terminal = terminalOf(held, id);
    const seen: string[] = [];
    terminal?.watch((chunk) => seen.push(chunk));
    reply(held, id, "a prompt");
    await said(() => terminal?.output ?? "", /GOT\[a prompt\]/, "the agent never read it");
    expect(seen.join("")).toContain("GOT[a prompt]");
  });

  it("refuses to be polled, because its agent is already inside", () => {
    const held = store();
    const id = opened(held, READER);
    expect(() => poll(held, id)).toThrow(SessionError);
    expect(() => poll(held, id)).toThrow(/inside/);
  });

  it("refuses a prompt once the agent has left, rather than queueing it behind nobody", async () => {
    const held = store();
    const id = opened(held, { command: "sh", args: ["-c", "exit 0"] });
    const terminal = terminalOf(held, id);
    expect(await terminal?.left()).toBe(0);
    expect(() => reply(held, id, "too late")).toThrow(/has left/);
    expect(prompts(held, id)).toEqual([]);
    // The agent leaving is not the person ending the review: they can still close it.
    expect(end(held, id).status).toBe("ended");
  });

  it("ends the agent with the review", async () => {
    const held = store();
    const id = opened(held, { command: "sh", args: ["-c", "sleep 30"] });
    const terminal = terminalOf(held, id);
    end(held, id);
    await terminal?.left();
    expect(terminal?.running).toBe(false);
    expect(sessionOf(held, id)?.status).toBe("ended");
  });

  it("does not start a second agent when the same artefact is opened again", async () => {
    const held = store();
    const id = opened(held, READER);
    const one = terminalOf(held, id);
    // Resumed with the same command, and then with none: one artefact, one session, one
    // terminal — the agent already inside keeps running, and nobody is started beside it.
    open(held, ARTEFACT, PAGE, READER);
    open(held, ARTEFACT, PAGE);
    expect(held.sessions.size).toBe(1);
    expect(terminalOf(held, id)).toBe(one);
    reply(held, id, "still the same agent");
    await said(() => one?.output ?? "", /GOT\[still the same agent\]/, "the agent never read it");
  });

  it("starts a fresh agent when an ended session is reopened with a command", async () => {
    const held = store();
    const id = opened(held, { command: "sh", args: ["-c", "echo FIRST"] });
    const one = terminalOf(held, id);
    await said(() => one?.output ?? "", /FIRST/, "the first agent never ran");
    end(held, id);
    const again = open(held, ARTEFACT, PAGE, {
      reopen: true,
      command: "sh",
      args: ["-c", "echo SECOND"],
    });
    expect(again.id).toBe(id);
    const two = terminalOf(held, again.id);
    if (two !== undefined) terminals.push(two);
    expect(two).not.toBe(one);
    await said(() => two?.output ?? "", /SECOND/, "the second agent never ran");
  });
});

describe("a session opened with no command", () => {
  it("keeps the queue and the poll, because that is how lavish-axi works today", async () => {
    const held = store();
    const id = opened(held);
    expect(sessionOf(held, id)?.terminal).toBe(false);
    expect(terminalOf(held, id)).toBeUndefined();
    const waiting = poll(held, id);
    reply(held, id, "the second column is unreadable");
    await expect(waiting).resolves.toEqual({
      kind: "feedback",
      prompts: [{ id: 1, text: "the second column is unreadable" }],
    });
  });

  it("queues for the next poll when nobody is waiting, and shows the backlog without taking it", async () => {
    const held = store();
    const id = opened(held);
    reply(held, id, "queued first");
    expect(prompts(held, id)).toHaveLength(1);
    expect(prompts(held, id)).toHaveLength(1);
    await poll(held, id);
    expect(prompts(held, id)).toEqual([]);
  });
});
