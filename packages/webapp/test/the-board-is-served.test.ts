/** The board, over a socket. Two things are being held here: that the page is the board
 *  views.yaml declares — the same boxes, in the same order, saying the same words as the
 *  cockpit — and that a browser pointed at the server actually gets it.
 *
 *  The rows are a hand-made `Board` rather than a database: what this proves is the page
 *  and the transport, and a page that could only be read with a workspace behind it would
 *  drag every one of these assertions through a migration. Where a workspace is, is
 *  `bin.ts`'s, and it is the one thing here with no test of its own. */
import type { Server } from "node:http";
import type { Board, Row } from "@wecode/core";
import { loadViews } from "@wecode/tui";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, boardAt, boardPage, serve } from "../src/index.js";

const VIEWS = loadViews();

const row = (id: number, what: string, state: string, detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

/** Every group the board has, holding nothing. A test says which groups it filled by
 *  filling them, and every other box on the page is then genuinely empty. */
const emptyBoard = (): Board => ({
  projects: [],
  stale: [],
  running: [],
  needs_human: [],
  queued: [],
  failed: [],
  dropped: [],
  unproven: [],
  open: [],
  planned: [],
  delivered: [],
  unmergeable: [],
  cooking: [],
});

const boardWith = (groups: Partial<Record<keyof Board, readonly Row[]>>): Board => ({
  ...emptyBoard(),
  ...groups,
});

/** The section ids the document came out with, in the order it wrote them. */
const sections = (body: string): readonly string[] =>
  [...body.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1] as string);

/** The markup of one box, so an assertion about a box is not an assertion about the page. */
function sectionOf(body: string, name: string): string {
  const at = body.indexOf(`<section id="${name}"`);
  expect(at, `the page has no ${name} box`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</section>", at));
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

/** A running server and what a client gets from it. The port is the operating system's
 *  choice, so two of these can run at once and neither depends on a port being free. */
async function fetched(
  board: () => Board,
  path = "/",
  init: RequestInit = {},
): Promise<Response> {
  const server = await serve({ "/": boardAt(board) });
  servers.push(server);
  return fetch(`${addressOf(server)}${path}`, init);
}

describe("the board, served", () => {
  it("answers / with an html document", async () => {
    const res = await fetched(emptyBoard);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toMatch(/^<!doctype html>/);
  });

  it("draws the boxes views.yaml declares, in the order it declares them", async () => {
    const res = await fetched(emptyBoard);
    expect(sections(await res.text())).toEqual(VIEWS.map((v) => v.name));
  });

  it("heads each box with its declared title and letter", () => {
    const body = boardPage(emptyBoard()).body;
    for (const v of VIEWS) {
      const box = sectionOf(body, v.name);
      expect(box, `${v.name}: its title`).toContain(v.title);
      if (v.key !== undefined) expect(box, `${v.name}: its letter`).toContain(`<kbd>${v.key}</kbd>`);
    }
  });

  it("says what a box says when it is empty, in the box's own words", () => {
    const body = boardPage(emptyBoard()).body;
    for (const v of VIEWS) {
      expect(sectionOf(body, v.name)).toContain(`<p class="empty">${v.empty}</p>`);
    }
  });

  it("writes a row as its code, its state and its description", () => {
    const board = boardWith({ running: [row(12, "widen the scope", "attempting", "task")] });
    const box = sectionOf(boardPage(board).body, "running");
    expect(box).toContain(`<span class="code">task #12</span>`);
    expect(box).toContain(`<span class="state">attempting</span>`);
    expect(box).toContain(`<span class="what">widen the scope</span>`);
    expect(box).not.toContain("class=\"empty\"");
  });

  it("spends a detail that is not the row's kind on the description", () => {
    const board = boardWith({ needs_human: [row(3, "pick a port", "option", "two of them")] });
    const box = sectionOf(boardPage(board).body, "needs_human");
    expect(box).toContain(`<span class="code">#3</span>`);
    expect(box).toContain(`<span class="what">pick a port · two of them</span>`);
  });

  it("shows no more rows than the box declares, and says how many it kept back", () => {
    const view = VIEWS.find((v) => v.name === "queued");
    expect(view).toBeDefined();
    const height = view?.rows ?? 0;
    const rows = Array.from({ length: height + 4 }, (_, i) => row(i + 1, `task ${i + 1}`, "ready"));
    const box = sectionOf(boardPage(boardWith({ queued: rows })).body, "queued");
    expect([...box.matchAll(/<li>/g)]).toHaveLength(height + 1);
    expect(box).toContain("and 4 more");
    expect(box).not.toContain(`task ${height + 1}<`);
  });

  it("writes a person's own words as words, not as markup", async () => {
    const what = `a <script>alert("x")</script> & an 'apostrophe'`;
    const res = await fetched(() => boardWith({ planned: [row(9, what, "planned")] }));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(body).toContain("&amp; an &#39;apostrophe&#39;");
  });

  it("reads the board again on every request", async () => {
    let reads = 0;
    const server = await serve({
      "/": boardAt(() => {
        reads += 1;
        return boardWith({ dropped: [row(reads, `read ${reads}`, "dropped")] });
      }),
    });
    servers.push(server);
    const first = await (await fetch(`${addressOf(server)}/`)).text();
    const second = await (await fetch(`${addressOf(server)}/`)).text();
    expect(reads).toBe(2);
    expect(first).toContain("read 1");
    expect(second).toContain("read 2");
  });

  it("gives a browser the headers and no body for a HEAD", async () => {
    const res = await fetched(emptyBoard, "/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
  });
});

describe("what the server will not answer", () => {
  const page = () => boardPage(emptyBoard());
  const routes = { "/": page };

  it("serves nothing but GET, and says so", async () => {
    const reply = answer(routes, "POST", "/");
    expect(reply.status).toBe(405);
    expect(reply.body).toContain("GET only");
    const res = await fetched(emptyBoard, "/", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("names the paths there are when asked for one there is not", async () => {
    const reply = answer(routes, "GET", "/elsewhere");
    expect(reply.status).toBe(404);
    expect(reply.body).toContain("/elsewhere");
    expect(reply.body).toContain("/");
    const res = await fetched(emptyBoard, "/elsewhere");
    expect(res.status).toBe(404);
  });

  it("routes on the path alone, so a query reaches the page", () => {
    expect(answer(routes, "GET", "/?workspace=wecode").status).toBe(200);
  });

  it("answers a page that threw with the reason", async () => {
    const server = await serve({
      "/": () => {
        throw new Error("no workspace behind this board");
      },
    });
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("no workspace behind this board");
  });
});
