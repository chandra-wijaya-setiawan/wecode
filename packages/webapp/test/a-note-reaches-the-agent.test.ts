/** A note a reviewer writes on a sketch reaches the agent.
 *
 *  Not "a function returns a string": reaches it. The last statements here run a real pty
 *  behind a real socket with a program reading its standard input, drive the painter's own
 *  overlay the way a reviewer drives it — point, say what is wrong, queue, send — and read
 *  back what that program got. Everything between the click and the far end is the code that
 *  ships: the painter's `pick`, its `PromptQueue`, its `Overlay`, its wire, and this
 *  surface's own `shellAt` route.
 *
 *  What this package adds is the host — the answer to "where does a round go" — and the
 *  answer is the dock's own far end, so a note and a keystroke reach one session in the order
 *  the reviewer made them. That is stated twice: against the route with a stand-in shell,
 *  where a send that fails can be arranged, and against a pty, where it cannot.
 *
 *  Nothing below reimplements the loop. The overlay is imported and the served files are
 *  compared byte for byte with the painter's own — the painter wrote its own terminal
 *  emulator once, and that is the thing this surface had to throw away for xterm. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Overlay } from "@wecode/painter/dist/client/overlay.js";
import { decode, encode } from "@wecode/painter/dist/client/terminal.js";
import { pickElement, type PickTarget } from "@wecode/painter/dist/client/pick.js";
import type { QueuedPrompt } from "@wecode/painter/dist/client/queue.js";
import { Session } from "@wecode/painter/dist/pty.js";
import { LANDED, NOTES_AT, REVIEW, REVIEW_AT, lineOf, noteOf } from "../src/browser/annotate.js";
import { review, sending, type Posts } from "../src/browser/annotate.js";
import { SHELL_AT, shellAt, type Drawn, type Opens, type Shelled } from "../src/pages/shell.js";
import { addressOf, answer, serve, type Routes } from "../src/index.js";

const here = createRequire(fileURLToPath(import.meta.url));

/** What is being reviewed: a selector with nothing to hold it is ambiguous across two. */
const ABOUT = "sketch 491";

// ─── a page, as picking knows one ───────────────────────────────────────────────────

interface NodeSpec {
  readonly tag: string;
  readonly id?: string;
  readonly text?: string;
  readonly children?: readonly NodeSpec[];
}

/** A tree of `PickTarget`s — the shape a browser adapter wraps a DOM node in. */
function page(spec: NodeSpec, parent: PickTarget | null = null): PickTarget {
  const children: PickTarget[] = [];
  const node: PickTarget = { tagName: spec.tag, id: spec.id, text: spec.text, parent, children };
  for (const child of spec.children ?? []) children.push(page(child, node));
  return node;
}

/** The sketch as it would be framed, and the nth node of a tag in it, depth first. */
const SKETCH = page({
  tag: "MAIN",
  id: "sketch",
  children: [
    { tag: "H1", text: "  the board\n" },
    { tag: "P", text: "eight tasks" },
    { tag: "P", text: "two blocked" },
  ],
});

const find = (tag: string, nth = 0): PickTarget => {
  const hits: PickTarget[] = [];
  (function walk(node: PickTarget): void {
    if (node.tagName === tag) hits.push(node);
    for (const child of node.children) walk(child);
  })(SKETCH);
  const hit = hits[nth];
  if (hit === undefined) throw new Error(`no ${tag}[${nth}] in the sketch`);
  return hit;
};

/** A note against a node, described by the same `pickElement` the overlay itself uses, and
 *  the round the overlay makes of the simplest move there is: one note on the heading. */
const queued = (tag: string, said: string, nth = 0): QueuedPrompt => ({
  pick: pickElement(find(tag, nth)),
  prompt: said,
});
const oneNote = (said: string): readonly QueuedPrompt[] => [queued("H1", said)];

// ─── a shell with a hand on the far end ─────────────────────────────────────────────

/** A shell that hears what is typed at it, and that can be told to leave — which is how a
 *  send that does not land is arranged. The painter's `Session` is one of these. */
class Pretend implements Shelled {
  output = "";
  running = true;
  exit: number | null = null;
  readonly heard: string[] = [];
  keys(input: string): void { this.heard.push(input); }
  prompt(text: string): void { this.heard.push(`${text}\r`); }
  close(): Promise<number> { this.running = false; return Promise.resolve(0); }
  leaves(code: number): void { this.running = false; this.exit = code; }
}

/** The dock's far end: a poll, which is what opens the shell, and a post of a frame. */
function farEnd(): { held: () => Pretend; open: () => void; post: Posts; close: () => void } {
  const shells: Pretend[] = [];
  const { route, close } = shellAt(() => "/a/workspace", (() => {
    const shell = new Pretend();
    shells.push(shell);
    return shell;
  }) as Opens);
  const routes: Routes = { [NOTES_AT]: route };
  const held = (): Pretend => {
    const last = shells.at(-1);
    if (last === undefined) throw new Error("no shell has been opened");
    return last;
  };
  return {
    held,
    open: () => void answer(routes, "GET", `${NOTES_AT}?from=0`),
    post: async (frame) => answer(routes, "POST", NOTES_AT, frame),
    close,
  };
}

// ─── the words a round carries ──────────────────────────────────────────────────────

describe("a note says where it points and what was said", () => {
  it("carries the css path, the tag and the words that were showing", () => {
    // All three parts of the pick, because the agent never sees the page: the path finds the
    // node in the source, the tag is what it turned out to be, the words are how to know it.
    const note = lineOf(queued("H1", "the heading is too quiet"));
    expect(note).toContain("main#sketch > h1");
    expect(note).toContain("<h1>");
    expect(note).toContain(`showing "the board"`);
    expect(note).toContain("the heading is too quiet");
  });

  it("quotes the exact words for a stretch of prose, because those are what to change", () => {
    // And does not call it an element: a text pick's tag is the word "text", not a node.
    const note = lineOf({
      pick: { kind: "text", selector: "main#sketch > p", tag: "text", text: "two blocked" },
      prompt: "say which two",
    });
    expect(note).toContain(`the words "two blocked"`);
    expect(note).not.toContain("<text>");
  });

  it("keeps a message to the page free of a selector it does not have", () => {
    // The strip's notes belong to the page, and `pickMessage` gives them no selector at all;
    // dressing that up as a place would send the agent looking for one.
    const said = "the rows are in the wrong order";
    const pick = { kind: "message", selector: "", tag: "message", text: "" } as const;
    expect(lineOf({ pick, prompt: said })).toBe(`about the page — ${said}`);
  });
});

describe("a round is one line, in the order it was written", () => {
  const round = [queued("H1", "the heading is too quiet"), queued("P", "say how many", 1)];

  it("numbers the notes and names what was reviewed", () => {
    // Numbered, so an agent answering six notes can say which one it is answering.
    const said = noteOf(round, ABOUT);
    expect(said).toContain("2 notes");
    expect(said).toContain(ABOUT);
    expect(said.indexOf("(1)")).toBeLessThan(said.indexOf("(2)"));
    expect(said.indexOf("too quiet")).toBeLessThan(said.indexOf("say how many"));
  });

  it("is one line however many the reviewer typed", () => {
    // The far end submits a prompt with a return, so a newline inside it would submit early
    // and turn one round into several half-rounds.
    const said = noteOf(oneNote("too quiet\n\nand the wrong weight\r\n"), ABOUT);
    expect(said).not.toMatch(/[\r\n]/);
    expect(said).toContain("too quiet and the wrong weight");
    expect(said).toContain("1 note");
  });

  it("says when it is the last round, so nobody waits for a reviewer who has gone", () => {
    expect(noteOf(round, ABOUT, true)).toContain("and the last");
    expect(noteOf(round, ABOUT, false)).not.toContain("and the last");
  });
});

// ─── the round goes where the keystrokes go ─────────────────────────────────────────

describe("a round is typed at the shell the dock already holds", () => {
  it("goes to the dock's own far end and not to a route of its own", () => {
    expect(NOTES_AT).toBe(SHELL_AT);
  });

  it("arrives as a prompt frame, which is what guarantees the submit", async () => {
    const end = farEnd();
    end.open();
    const overlay = new Overlay(sending(end.post, ABOUT));
    overlay.setPicking(true);
    expect(overlay.pick(find("H1"))).toBe(true);
    expect(overlay.annotate("the heading is too quiet")).toBe(true);
    expect(await overlay.send()).toBe(true);
    // A prompt and not keys: a round sent as keystrokes would sit in the agent's composer
    // looking sent, and `prompt` is the one that guarantees the return.
    expect(end.held().heard).toEqual([`${noteOf(oneNote("the heading is too quiet"), ABOUT)}\r`]);
    end.close();
  });

  it("shares the session with the keystrokes, in the order the reviewer made them", async () => {
    const end = farEnd();
    end.open();
    const overlay = new Overlay(sending(end.post, ABOUT));
    overlay.setPicking(true);
    overlay.pick(find("H1"));
    overlay.annotate("too quiet");
    // A keypress on the dock's command line, the way the pane sends one, on the same path.
    await end.post(encode({ kind: "keys", data: "\x03" }));
    await overlay.send();
    await end.post(encode({ kind: "keys", data: "\r" }));
    expect(end.held().heard[0]).toBe("\x03");
    expect(end.held().heard[1]).toContain("too quiet");
    expect(end.held().heard[2]).toBe("\r");
    end.close();
  });

  it("is the painter's own wire, so a note and a keypress are one message format", async () => {
    const sent: string[] = [];
    const overlay = new Overlay(
      sending(async (frame) => (sent.push(frame), { status: LANDED }), ABOUT),
    );
    overlay.setPicking(true);
    overlay.pick(find("H1"));
    overlay.annotate("too quiet");
    await overlay.send();
    // Read back through the painter's own decoder, not the JSON this test happens to want.
    expect(sent).toHaveLength(1);
    const text = noteOf(oneNote("too quiet"), ABOUT);
    expect(decode(sent[0] as string)).toEqual({ kind: "prompt", text });
  });

  it("keeps the reviewer's words when the far end refuses the round", async () => {
    // 409 for a shell that has left, 400 for a frame it could not read: neither landed, so
    // the host says false rather than swallowing the status and losing what was written.
    const end = farEnd();
    end.open();
    end.held().leaves(1);
    const refusals: Posts[] = [end.post, async () => ({ status: 400 })];
    for (const post of refusals) {
      const overlay = new Overlay(sending(post, ABOUT));
      overlay.setPicking(true);
      overlay.pick(find("H1"));
      overlay.annotate("too quiet");
      expect(await overlay.send()).toBe(false);
      expect(overlay.queued()).toHaveLength(1);
      expect(overlay.view().pills[0]).toContain("too quiet");
    }
    end.close();
  });
});

// ─── the loop a browser runs is the painter's ───────────────────────────────────────

const PAINTER = ["overlay", "pick", "queue", "overlay.css"] as const;

describe("the review loop is served, not rewritten", () => {
  const served = review();
  const paths = [REVIEW.overlay, REVIEW.pick, REVIEW.queue, REVIEW.look];

  it("hands over the painter's own files, byte for byte", () => {
    PAINTER.forEach((module, at) => {
      const path = paths[at] as string;
      const reply = answer(served, "GET", path);
      expect(reply.status, path).toBe(200);
      expect(reply.type, path).toContain("text/javascript");
      const own = readFileSync(here.resolve(`@wecode/painter/dist/client/${module}.js`), "utf8");
      expect(reply.body, `${path} is not the painter's ${module}`).toBe(own);
    });
  });

  it("writes no second loop of its own in this package", () => {
    const at = new URL("../src/browser/annotate.ts", import.meta.url);
    const source = readFileSync(fileURLToPath(at), "utf8");
    const own = ["class Overlay", "class PromptQueue", "function selectorFor", "function pickElement"];
    for (const written of own) expect(source, `annotate.ts writes a ${written}`).not.toContain(written);
    expect(source).toContain(`from "@wecode/painter/dist/client/overlay.js"`);
  });
});

// ─── and it reaches the agent ───────────────────────────────────────────────────────

/** A far end that marks every line it reads. `printf`, so nothing said is interpreted. */
const READER = {
  command: "sh",
  args: ["-c", 'while IFS= read -r l; do printf "AGENT-READ<<%s>>\\n" "$l"; done'],
} as const;

/** How long the agent gets: a cold pty is not a defect, and a note that never comes is. */
const PATIENCE = 20_000;

const boards: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of boards.splice(0)) await stop();
});

/** The dock's far end on a real pty, on a real socket. Nothing is stubbed between the round
 *  and the program — `shellAt` is this surface's and `Session` is the painter's — and the one
 *  thing arranged is which program sits in the pty, so what it read can be asked. */
async function board(): Promise<{ at: string; post: Posts; poll: () => Promise<Drawn> }> {
  const opened: Session[] = [];
  const { route, close } = shellAt(() => process.cwd(), (() => {
    const session = Session.open({ ...READER });
    opened.push(session);
    return session;
  }) as Opens);
  const server: Server = await serve({ ...review(), [NOTES_AT]: route }, 0);
  const at = addressOf(server);
  boards.push(async () => {
    close();
    for (const session of opened) await session.close();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    at,
    post: (frame) => fetch(`${at}${NOTES_AT}`, { method: "POST", body: frame }),
    poll: async () => (await fetch(`${at}${NOTES_AT}?from=0`)).json() as Promise<Drawn>,
  };
}

/** Everything the far end has drawn, read out of the painter's frames the way the pane reads
 *  them, polled until it says what is waited for: a pty is a process, and the poll after the
 *  one that started it is very often empty. */
async function until(poll: () => Promise<Drawn>, wanted: string): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let held = "";
  while (Date.now() < deadline) {
    held = (await poll()).frames
      .map((frame) => decode(frame))
      .map((message) => (message?.kind === "output" ? message.chunk : ""))
      .join("");
    if (held.includes(wanted)) return held;
    await new Promise((resume) => setTimeout(resume, 50));
  }
  expect(held, `the far end never said ${wanted} in ${PATIENCE}ms`).toContain(wanted);
  return held;
}

describe("a note a reviewer wrote reaches the program reading the shell", () => {
  it("is read as one whole line by a far end that never saw the page", async () => {
    const end = await board();
    // The first poll opens the session, and is also the pane attaching.
    await end.poll();
    // The reviewer's whole move, through the painter's own machine.
    const overlay = new Overlay(sending(end.post, ABOUT));
    overlay.setPicking(true);
    expect(overlay.pick(find("H1"))).toBe(true);
    expect(overlay.annotate("the heading is too quiet")).toBe(true);
    expect(overlay.pick(find("P", 1))).toBe(true);
    expect(overlay.annotate("say which two are blocked")).toBe(true);
    expect(overlay.view().pills).toHaveLength(2);
    expect(await overlay.send()).toBe(true);
    // And a program on the far end of a pty read it: not the echo of the line but the marked
    // copy, whole, which only a round that arrived with its return can be.
    const round = noteOf(
      [queued("H1", "the heading is too quiet"), queued("P", "say which two are blocked", 1)],
      ABOUT,
    );
    const screen = await until(end.poll, "AGENT-READ<<");
    expect(screen).toContain(`AGENT-READ<<${round}>>`);
    // Which means the selector reached it, and the agent can find the heading in the source.
    expect(screen).toContain("main#sketch > h1");
  }, PATIENCE);

  it("empties the queue only once the far end has it, and the strip can say so", async () => {
    const end = await board();
    await end.poll();
    const overlay = new Overlay(sending(end.post, ABOUT));
    overlay.setPicking(true);
    overlay.pick(find("P"));
    overlay.annotate("eight is the wrong count");
    expect(await overlay.send()).toBe(true);
    expect(overlay.queued()).toHaveLength(0);
    await until(end.poll, "eight is the wrong count");
    // The loop goes round: what came back shows in the strip, and is answered from there.
    overlay.receive("AGENT-READ: fixed");
    expect(overlay.view().strip.log).toEqual(["AGENT-READ: fixed"]);
  }, PATIENCE);

  it("serves the loop and the far end on one socket, at the paths a browser asks for", async () => {
    const end = await board();
    for (const at of Object.values(REVIEW)) {
      expect(at.startsWith(`${REVIEW_AT}/`), at).toBe(true);
      const reply = await fetch(`${end.at}${at}`);
      expect(reply.status, at).toBe(200);
      expect(reply.headers.get("content-type"), at).toContain("text/javascript");
      expect((await reply.text()).length, `${at} is empty`).toBeGreaterThan(0);
    }
    // And the imports the browser chases next: `overlay.js` was compiled with `./pick.js` in
    // it, so served apart they resolve against the root and the loop dies on its first.
    const overlay = await (await fetch(`${end.at}${REVIEW.overlay}`)).text();
    const imports = [...overlay.matchAll(/from "([^"]+)"/g)].map(([, at]) => at as string);
    expect(imports.length, "the overlay imports nothing").toBeGreaterThan(0);
    for (const spec of imports) {
      const reply = await fetch(new URL(spec, `${end.at}${REVIEW.overlay}`));
      expect(reply.status, spec).toBe(200);
    }
  }, PATIENCE);
});
