/** A person reads an artefact and marks it up; an agent, somewhere else entirely, is
 *  waiting to be told what they said. Everything in this file is that one sentence: the
 *  session that holds the marks, the frame that puts the artefact where they can be made,
 *  and the server that carries them between the two. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  addressOf,
  answer,
  end,
  frame,
  idOf,
  marks,
  open,
  poll,
  prompts,
  reload,
  reply,
  serve,
  SessionError,
  sessionOf,
  sessionUrl,
  store,
  type Store,
} from "../src/index.js";

const ARTEFACT = "/repo/.painter/board.html";
const PAGE = "<html><body><h1>the board</h1></body></html>";

const opened = (): { store: Store; id: string } => {
  const held = store();
  const session = open(held, ARTEFACT, PAGE);
  return { store: held, id: session.id };
};

describe("opening an artefact", () => {
  it("makes a session that holds the artefact as it was given", () => {
    const { store: held, id } = opened();
    const session = sessionOf(held, id);
    expect(session?.artefact).toBe(ARTEFACT);
    expect(session?.body).toBe(PAGE);
    expect(session?.status).toBe("open");
    expect(session?.pending).toEqual([]);
  });

  it("resumes the same session for the same artefact rather than starting a second", () => {
    const { store: held, id } = opened();
    const again = open(held, ARTEFACT, PAGE);
    expect(again.id).toBe(id);
    expect(held.sessions.size).toBe(1);
  });

  it("gives two artefacts two sessions", () => {
    const held = store();
    open(held, ARTEFACT, PAGE);
    open(held, "/repo/.painter/other.html", PAGE);
    expect(held.sessions.size).toBe(2);
    expect(idOf(ARTEFACT)).not.toBe(idOf("/repo/.painter/other.html"));
  });

  it("refuses to reopen what the person ended, until somebody says they asked", () => {
    const { store: held, id } = opened();
    end(held, id);
    expect(() => open(held, ARTEFACT, PAGE)).toThrow(SessionError);
    expect(() => open(held, ARTEFACT, PAGE)).toThrow(/reopen it only when they ask/);
    expect(open(held, ARTEFACT, PAGE, { reopen: true }).status).toBe("open");
  });

  it("refreshes the body on a resume, because the caller has just read the file", () => {
    const { store: held, id } = opened();
    const again = open(held, ARTEFACT, "<html><body>redrawn</body></html>");
    expect(again.body).toContain("redrawn");
    expect(again.revision).toBe(2);
    expect(sessionOf(held, id)?.revision).toBe(2);
  });
});

describe("reloading", () => {
  it("moves the revision when the artefact changed", () => {
    const { store: held, id } = opened();
    expect(reload(held, id, "<html><body>again</body></html>").revision).toBe(2);
  });

  it("leaves the revision alone when it did not, so nothing redraws for nothing", () => {
    const { store: held, id } = opened();
    expect(reload(held, id, PAGE).revision).toBe(1);
  });
});

describe("framing", () => {
  it("leaves the artefact's own bytes untouched", () => {
    const { store: held, id } = opened();
    const framed = frame(sessionOf(held, id) as never);
    expect(framed).toContain("<h1>the board</h1>");
    expect(framed.indexOf("<h1>")).toBeLessThan(framed.indexOf("painter-session"));
  });

  it("puts the chrome inside the body, ahead of the closing tag", () => {
    const { store: held, id } = opened();
    const framed = frame(sessionOf(held, id) as never);
    expect(framed.indexOf("painter-session")).toBeLessThan(framed.lastIndexOf("</body>"));
  });

  it("appends the chrome when the artefact is not a whole document", () => {
    const held = store();
    const session = open(held, "/repo/.painter/fragment.html", "<p>a fragment</p>");
    expect(frame(session).startsWith("<p>a fragment</p>")).toBe(true);
    expect(frame(session)).toContain("painter-session");
  });

  it("carries the session and its revision as data a reader can find", () => {
    const { store: held, id } = opened();
    expect(marks(sessionOf(held, id) as never)).toBe(
      `<meta name="painter-session" content="${id}" data-revision="1">`,
    );
  });
});

describe("prompts, replies and the poll", () => {
  it("queues what the person sent, and reading the queue does not take it", () => {
    const { store: held, id } = opened();
    reply(held, id, "the second column is unreadable");
    expect(prompts(held, id).map((p) => p.text)).toEqual(["the second column is unreadable"]);
    expect(prompts(held, id)).toHaveLength(1);
  });

  it("keeps the tag a whiteboard prompt carries, and omits it otherwise", () => {
    const { store: held, id } = opened();
    expect(reply(held, id, "plain")).toEqual({ id: 1, text: "plain" });
    expect(reply(held, id, "drawn on", "whiteboard").tag).toBe("whiteboard");
  });

  it("hands a waiting agent the prompt as soon as it is sent", async () => {
    const { store: held, id } = opened();
    const waiting = poll(held, id);
    reply(held, id, "make the totals bold");
    await expect(waiting).resolves.toEqual({
      kind: "feedback",
      prompts: [{ id: 1, text: "make the totals bold" }],
    });
  });

  it("returns at once when feedback was queued before anyone waited", async () => {
    const { store: held, id } = opened();
    reply(held, id, "queued first");
    expect((await poll(held, id)).prompts.map((p) => p.text)).toEqual(["queued first"]);
  });

  it("drains the queue on a poll, so the same feedback is never acted on twice", async () => {
    const { store: held, id } = opened();
    reply(held, id, "once");
    await poll(held, id);
    expect(prompts(held, id)).toEqual([]);
  });

  it("wakes one waiter only, so two agents never act on the same prompt", async () => {
    const { store: held, id } = opened();
    const first = poll(held, id);
    let secondWoke = false;
    void poll(held, id).then(() => {
      secondWoke = true;
    });
    reply(held, id, "for one of you");
    await first;
    await Promise.resolve();
    expect(secondWoke).toBe(false);
  });

  it("refuses a prompt against an ended session", () => {
    const { store: held, id } = opened();
    end(held, id);
    expect(() => reply(held, id, "too late")).toThrow(/has ended/);
  });

  it("refuses to work on a session that does not exist", () => {
    expect(() => prompts(store(), "deadbeef")).toThrow(SessionError);
  });
});

describe("ending", () => {
  it("delivers the final feedback once, with the ending", async () => {
    const { store: held, id } = opened();
    reply(held, id, "send and end");
    end(held, id);
    expect(await poll(held, id)).toEqual({
      kind: "ended",
      prompts: [{ id: 1, text: "send and end" }],
    });
    expect((await poll(held, id)).prompts).toEqual([]);
  });

  it("wakes every waiter rather than leaving one hung on a promise", async () => {
    const { store: held, id } = opened();
    const both = Promise.all([poll(held, id), poll(held, id)]);
    end(held, id);
    expect((await both).map((w) => w.kind)).toEqual(["ended", "ended"]);
  });

  it("says the session is ended when it is asked afterwards", () => {
    const { store: held, id } = opened();
    expect(end(held, id).status).toBe("ended");
    expect(sessionOf(held, id)?.status).toBe("ended");
  });
});

describe("what the server answers", () => {
  it("serves the framed artefact at the session's own path", async () => {
    const { store: held, id } = opened();
    const reply = await answer(held, "GET", `/session/${id}`);
    expect(reply.status).toBe(200);
    expect(reply.type).toContain("text/html");
    expect(reply.body).toContain("<h1>the board</h1>");
    expect(reply.body).toContain("painter-session");
  });

  it("tells a page which revision it is looking at, so it knows when to reload", async () => {
    const { store: held, id } = opened();
    reload(held, id, "<html><body>moved on</body></html>");
    const reply = await answer(held, "GET", `/session/${id}/revision`);
    expect(JSON.parse(reply.body)).toEqual({ revision: 2, status: "open" });
  });

  it("takes a prompt from the browser and gives it to the waiting agent", async () => {
    const { store: held, id } = opened();
    const waiting = poll(held, id);
    const reply = await answer(
      held,
      "POST",
      `/session/${id}/reply`,
      JSON.stringify({ text: "from the page", tag: "whiteboard" }),
    );
    expect(reply.status).toBe(200);
    expect((await waiting).prompts[0]?.text).toBe("from the page");
  });

  it("refuses a prompt with nothing in it", async () => {
    const { store: held, id } = opened();
    expect((await answer(held, "POST", `/session/${id}/reply`, "{}")).status).toBe(400);
    expect((await answer(held, "POST", `/session/${id}/reply`, "not json")).status).toBe(400);
  });

  it("ends a session from the browser", async () => {
    const { store: held, id } = opened();
    expect((await answer(held, "POST", `/session/${id}/end`)).status).toBe(200);
    expect(sessionOf(held, id)?.status).toBe("ended");
  });

  it("shows the queue without taking it", async () => {
    const { store: held, id } = opened();
    reply(held, id, "still here");
    const reply2 = await answer(held, "GET", `/session/${id}/prompts`);
    expect(JSON.parse(reply2.body).prompts).toHaveLength(1);
    expect(prompts(held, id)).toHaveLength(1);
  });

  it("is a 404 for a session nobody opened, never a blank page", async () => {
    const reply = await answer(store(), "GET", "/session/deadbeef");
    expect(reply.status).toBe(404);
    expect(reply.body).toContain("no session deadbeef");
  });

  it("is a 404 for a path that is not a session at all", async () => {
    expect((await answer(store(), "GET", "/")).status).toBe(404);
    expect((await answer(store(), "GET", "/board")).status).toBe(404);
  });

  it("is a 404 for a verb the painter does not have", async () => {
    const { store: held, id } = opened();
    expect((await answer(held, "GET", `/session/${id}/paint`)).status).toBe(404);
    expect((await answer(held, "POST", `/session/${id}/paint`)).status).toBe(404);
  });

  it("refuses a method it does not serve", async () => {
    const { store: held, id } = opened();
    const reply = await answer(held, "DELETE", `/session/${id}`);
    expect(reply.status).toBe(405);
    expect(reply.body).toContain("GET and POST only");
  });
});

describe("the painter on a socket", () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.close();
    server = undefined;
  });

  it("carries a mark made in the browser out to a polling agent", async () => {
    const { store: held, id } = opened();
    server = await serve(held);
    const at = sessionUrl(server, id);
    expect(at).toBe(`${addressOf(server)}/session/${id}`);

    const page = await fetch(at);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>the board</h1>");

    const waiting = fetch(`${at}/poll`).then((r) => r.json());
    await fetch(`${at}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "the legend overlaps the axis" }),
    });
    expect((await waiting).prompts[0].text).toBe("the legend overlaps the axis");

    await fetch(`${at}/end`, { method: "POST" });
    expect((await (await fetch(`${at}/revision`)).json()).status).toBe("ended");
  });
});

describe("the cli's manifest", () => {
  const manifest = JSON.parse(
    readFileSync(join(fileURLToPath(new URL("../../cli/", import.meta.url)), "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };

  it("depends on the painter, because the painter is how a cli verb reaches a person", () => {
    expect(manifest.dependencies["@wecode/painter"]).toBe("workspace:*");
  });
});
