/** A comment on the artefact, and where it goes.
 *
 *  When the session owns no terminal, a comment is queued for a poller — an agent
 *  somewhere else calls `poll`, takes the words and answers — and that is still what
 *  happens. But a session can own a pty, the pane the agent itself is sitting in, and a
 *  comment typed into that terminal is read where the operator is already watching, and
 *  answered where they can see it happen. So the rule under test: the comment is typed
 *  into the terminal the session owns, as a line of input followed by a return, and
 *  queued only when there is none.
 *
 *  The terminals are real ptys, driven the way the right pane drives them, because a
 *  mocked pty proves the mock and the whole question is what the far end reads. The far
 *  ends are `read` loops that mark every line they take, so "what did the agent get, and
 *  when" is a thing the output can be asked. */
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { answer, own, serve, sessionUrl } from "../src/server.js";
import { end, open, poll, prompts, SessionError, store, type Store } from "../src/index.js";
import { Session } from "../src/pty.js";

const ARTEFACT = "/repo/.painter/board.html";
const PAGE = "<html><body><h1>the board</h1></body></html>";

const opened = (): { store: Store; id: string } => {
  const held = store();
  const session = open(held, ARTEFACT, PAGE);
  return { store: held, id: session.id };
};

/** A far end that reads one line at a time and marks each one it takes. */
const READER = { command: "sh", args: ["-c", 'while IFS= read -r l; do echo "GOT[$l]"; done'] };

/** A far end that works first and reads after — `sleep` standing in for the agent's turn,
 *  which is the period in which it is producing and not reading. */
const BUSY = {
  command: "sh",
  args: ["-c", 'echo working; sleep 1; echo done; while IFS= read -r l; do echo "GOT[$l]"; done'],
};

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

const seat = (options: Parameters<typeof Session.open>[0]): Session => {
  const session = Session.open(options);
  sessions.push(session);
  return session;
};

/** Wait until something has said so, polling the accumulated text rather than counting
 *  chunks: a pty splits where it likes. */
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

/** The reviewer's one move: a comment posted at the session from the page. */
const comment = (at: Store, id: string, text: string, tag?: string): Promise<ReturnType<typeof answer>> =>
  answer(
    at,
    "POST",
    `/session/${id}/reply`,
    JSON.stringify(tag === undefined ? { text } : { text, tag }),
  );

describe("a comment on a session that owns no terminal", () => {
  it("is queued for a poller, as it always was", async () => {
    const { store: held, id } = opened();
    const reply = await comment(held, id, "the legend overlaps the axis");
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ id: 1, text: "the legend overlaps the axis" });
    expect(prompts(held, id).map((p) => p.text)).toEqual(["the legend overlaps the axis"]);
    expect((await poll(held, id)).prompts[0]?.text).toBe("the legend overlaps the axis");
  });
});

describe("a comment on a session that owns a terminal", () => {
  it("is typed into the terminal as one line of input, submitted by its return", async () => {
    const { store: held, id } = opened();
    const agent = seat(READER);
    own(held, id, agent);
    const reply = await comment(held, id, "the heading is off-centre");
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ typed: "the heading is off-centre" });
    // The return is what submits it: the reader, which only completes a line on one, has it.
    await until(agent, /GOT\[the heading is off-centre\]/, "the agent never read the comment");
    // And nothing was queued, so no poller is quietly waiting on words already delivered.
    expect(prompts(held, id)).toEqual([]);
  });

  it("is one submit however many lines the comment was written on", async () => {
    const { store: held, id } = opened();
    const agent = seat(READER);
    own(held, id, agent);
    await comment(held, id, "first line\nsecond line\r\nthird");
    await until(agent, /GOT\[first line second line third\]/, "the agent never read the comment");
    // Long enough for a stray return to have submitted a second, shorter line, if it had.
    await new Promise((r) => setTimeout(r, 400));
    expect([...agent.output.matchAll(/GOT\[/g)]).toHaveLength(1);
  });

  it("keeps the tag on the way through, because the reply is the record of what was said", async () => {
    const { store: held, id } = opened();
    const agent = seat(READER);
    own(held, id, agent);
    const reply = await comment(held, id, "drawn on", "whiteboard");
    expect(JSON.parse(reply.body)).toEqual({ typed: "drawn on", tag: "whiteboard" });
  });

  it("goes to the terminal seated now, not the one it replaced", async () => {
    const { store: held, id } = opened();
    const before = seat(READER);
    const now = seat(READER);
    own(held, id, before);
    own(held, id, now);
    await comment(held, id, "to whoever is sitting there now");
    await until(now, /GOT\[to whoever is sitting there now\]/, "the new agent never read it");
    await new Promise((r) => setTimeout(r, 300));
    expect(before.output).not.toContain("GOT[");
  });
});

describe("a comment made while the agent is mid-turn", () => {
  it("waits in the input and is read when the turn ends — it does not cut the turn short", async () => {
    const { store: held, id } = opened();
    const agent = seat(BUSY);
    own(held, id, agent);
    await until(agent, /working/, "the turn never started");
    const reply = await comment(held, id, "while you were working");
    expect(reply.status).toBe(200);
    // The line discipline echoes it at once, so the operator watches the comment land on
    // the screen even though the agent has not read it yet.
    await until(agent, /while you were working/, "the comment was never echoed");
    await until(agent, /done/, "the turn never finished");
    await until(agent, /GOT\[while you were working\]/, "the agent never read the comment");
    const out = agent.output;
    // The echo came before the turn finished; the reading came after it. The comment was
    // neither lost nor able to cut the turn short — it waited, and the agent got it whole.
    expect(out.indexOf("while you were working")).toBeLessThan(out.indexOf("done"));
    expect(out.indexOf("done")).toBeLessThan(out.indexOf("GOT[while you were working]"));
    expect(prompts(held, id)).toEqual([]);
  });

  it("keeps the order of the comments made behind one turn", async () => {
    const { store: held, id } = opened();
    const agent = seat(BUSY);
    own(held, id, agent);
    await until(agent, /working/, "the turn never started");
    await comment(held, id, "said first");
    await comment(held, id, "said second");
    await until(agent, /GOT\[said second\]/, "the agent never read the second comment");
    const out = agent.output;
    expect(out.indexOf("GOT[said first]")).toBeLessThan(out.indexOf("GOT[said second]"));
  });
});

describe("refusals", () => {
  it("refuses a comment when the agent's session has left, and queues nothing", async () => {
    const { store: held, id } = opened();
    const agent = seat({ command: "sh", args: ["-c", "exit 0"] });
    expect(await agent.left()).toBe(0);
    own(held, id, agent);
    const reply = await comment(held, id, "anybody there?");
    expect(reply.status).toBe(409);
    expect(reply.body).toContain("the comment was not sent");
    expect(prompts(held, id)).toEqual([]);
  });

  it("refuses a comment on a review the person has ended, terminal or not", async () => {
    const { store: held, id } = opened();
    const agent = seat(READER);
    own(held, id, agent);
    end(held, id);
    expect((await comment(held, id, "too late")).status).toBe(409);
    const bare = opened();
    end(bare.store, bare.id);
    expect((await comment(bare.store, bare.id, "too late")).status).toBe(409);
    expect(prompts(held, id)).toEqual([]);
  });

  it("refuses to seat a terminal on a session nobody opened", () => {
    const held = store();
    const agent = seat(READER);
    expect(() => own(held, "deadbeef", agent)).toThrow(SessionError);
  });
});

describe("over the socket", () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.close();
    server = undefined;
  });

  it("carries a comment from the page to the agent in the pane", async () => {
    const { store: held, id } = opened();
    const agent = seat(READER);
    own(held, id, agent);
    server = await serve(held);
    const at = sessionUrl(server, id);
    const page = await fetch(at);
    expect(page.status).toBe(200);
    const reply = await fetch(`${at}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "the axis labels are truncated" }),
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ typed: "the axis labels are truncated" });
    await until(agent, /GOT\[the axis labels are truncated\]/, "the agent never read it");
  });
});
