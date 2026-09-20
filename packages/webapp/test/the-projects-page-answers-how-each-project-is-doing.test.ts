/** The projects page, over a socket. What is held here is that the page answers the two
 *  questions it exists for — how the workspace is doing, in one strip, and how each project
 *  in it is doing, one card each — and that the words it uses are views.yaml's rather than
 *  its own.
 *
 *  The board is hand-made for the reason the board page's is: what is being proved is the
 *  page and the transport, and a page that could only be read with a workspace behind it
 *  would drag every assertion here through a migration. */
import type { Server } from "node:http";
import type { Board, Row } from "@wecode/core";
import { loadOffPage, loadViews, sectionMark } from "@wecode/tui";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/server.js";
import {
  PROJECTS_PATHS,
  projectRoutes,
  projectsContents,
  projectsPage,
  since,
  type Pulse,
} from "../src/pages/projects.js";
import { document, loadShell } from "../src/pages/shell.js";

const VIEWS = loadViews();
const SHELL = loadShell();
const PROJECTS_BOX = loadOffPage().find((v) => v.filter === "projects");

const row = (id: number, what: string, state: string, detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

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

/** Some rows, so a box that is asked for a count has one to give. */
const rows = (n: number): readonly Row[] =>
  Array.from({ length: n }, (_, i) => row(i + 1, `row ${i + 1}`, "ready"));

/** The markup of one card, so an assertion about a project is not an assertion about the
 *  page. */
function cardOf(body: string, id: number): string {
  const at = body.indexOf(`<li id="project-${id}"`);
  expect(at, `the page has no card for project ${id}`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</li>", at));
}

const stripOf = (body: string): string =>
  body.slice(body.indexOf(`<ul class="strip">`), body.indexOf("</ul>"));

/** The counts the strip came out with, in the order it wrote them, by the title beside
 *  each. */
const cells = (body: string): readonly (readonly [string, string])[] =>
  [
    ...stripOf(body).matchAll(
      /<span class="count">(\d+)<\/span><span class="title">([^<]+)<\/span>/g,
    ),
  ].map((m) => [m[2] as string, m[1] as string] as const);

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

async function fetched(board: () => Board, path = "/", pulse?: () => Pulse): Promise<Response> {
  const server = await serve(projectRoutes(board, pulse));
  servers.push(server);
  return fetch(`${addressOf(server)}${path}`);
}

describe("where the projects page answers", () => {
  it("is served at / and at /projects, with the same document", async () => {
    expect([...PROJECTS_PATHS]).toEqual(["/", "/projects"]);
    const board = (): Board => boardWith({ projects: [row(1, "wecode", "active", "1/3 stories")] });
    const front = await (await fetched(board, "/")).text();
    const named = await (await fetched(board, "/projects")).text();
    expect(front).toContain("wecode");
    expect(named).toBe(front);
  });

  it("answers with an html document", async () => {
    const res = await fetched(emptyBoard);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toMatch(/^<!doctype html>/);
  });

  it("routes nothing else to it", () => {
    expect(answer(projectRoutes(emptyBoard), "GET", "/elsewhere").status).toBe(404);
  });

  it("reads the board again on every request", async () => {
    let reads = 0;
    const server = await serve(
      projectRoutes(() => {
        reads += 1;
        return boardWith({ projects: [row(1, `read ${reads}`, "active")] });
      }),
    );
    servers.push(server);
    const first = await (await fetch(`${addressOf(server)}/`)).text();
    const second = await (await fetch(`${addressOf(server)}/projects`)).text();
    expect(reads).toBe(2);
    expect(first).toContain("read 1");
    expect(second).toContain("read 2");
  });
});

describe("the summary strip", () => {
  it("is one cell per box views.yaml puts on the page, in that order", () => {
    const body = projectsPage(emptyBoard()).body;
    expect(cells(body).map(([title]) => title)).toEqual(VIEWS.map((v) => v.title));
  });

  it("carries each box's own mark", () => {
    const strip = stripOf(projectsPage(emptyBoard()).body);
    for (const v of VIEWS) {
      expect(strip, `${v.name}: its mark`).toContain(
        `<span class="mark">${sectionMark(v.name).replace(/>/g, "&gt;")}</span>`,
      );
    }
  });

  it("counts what each box is holding", () => {
    const board = boardWith({ running: rows(2), queued: rows(7), needs_human: rows(1) });
    const held = new Map(cells(projectsPage(board).body));
    for (const v of VIEWS) {
      expect(held.get(v.title), `${v.title}`).toBe(String(board[v.filter].length));
    }
    const queue = VIEWS.find((v) => v.filter === "queued");
    expect(held.get(queue?.title ?? "")).toBe("7");
  });

  it("keeps a box that is holding nothing, and dims it", () => {
    const body = projectsPage(boardWith({ running: rows(2) })).body;
    expect(cells(body)).toHaveLength(VIEWS.length);
    expect(stripOf(body)).toContain(`<li class="none">`);
    expect(stripOf(body)).toContain(`<li class="some">`);
  });
});

describe("a project card", () => {
  it("says the project's name, its number, its state and how many stories are done", () => {
    const board = boardWith({ projects: [row(4, "wecode", "active", "2/5 stories")] });
    const card = cardOf(projectsPage(board).body, 4);
    expect(card).toContain(`<span class="name">wecode</span>`);
    expect(card).toContain(`<span class="code">#4</span>`);
    expect(card).toContain(`<span class="state">active</span>`);
    expect(card).toContain(`<span class="stories">2/5 stories</span>`);
  });

  it("draws how far along it is as the row's own fraction", () => {
    const board = boardWith({ projects: [row(1, "wecode", "active", "2/5 stories")] });
    expect(cardOf(projectsPage(board).body, 1)).toContain(`style="width:40%"`);
  });

  it("draws no meter for a row whose detail is not a fraction", () => {
    const board = boardWith({ projects: [row(1, "wecode", "active", "just begun")] });
    const card = cardOf(projectsPage(board).body, 1);
    expect(card).not.toContain("meter");
    expect(card).toContain("just begun");
  });

  it("says how long the project has been quiet, when it is known", () => {
    const board = boardWith({ projects: [row(1, "a", "active"), row(2, "b", "active")] });
    const pulse: Pulse = { silence: new Map([[1, 7 * 60_000]]) };
    const body = projectsPage(board, pulse).body;
    expect(cardOf(body, 1)).toContain("quiet 7m");
    expect(cardOf(body, 2)).not.toContain("quiet");
  });

  it("reads a beat in the units a person thinks in", () => {
    expect(since(0)).toBe("0m");
    expect(since(59 * 60_000)).toBe("59m");
    expect(since(90 * 60_000)).toBe("1h");
    expect(since(50 * 3_600_000)).toBe("2d");
  });

  it("draws the throughput as a sparkline and the last hour as a rate", () => {
    const board = boardWith({ projects: [row(1, "wecode", "active")] });
    const pulse: Pulse = { throughput: new Map([[1, [0, 0, 1, 2, 4, 0, 0, 0, 1, 3]]]) };
    const card = cardOf(projectsPage(board, pulse).body, 1);
    const spark = /<span class="spark">([^<]+)<\/span>/.exec(card)?.[1] ?? "";
    expect([...spark]).toHaveLength(10);
    expect(card).toContain(`<span class="rate">3/h</span>`);
  });

  it("says nothing about a pulse it was not given", () => {
    const board = boardWith({ projects: [row(1, "wecode", "active")] });
    expect(cardOf(projectsPage(board).body, 1)).not.toContain("pulse");
  });

  it("draws a card per project, in the order the board kept them", () => {
    const board = boardWith({
      projects: [row(1, "one", "active"), row(2, "two", "active"), row(3, "three", "active")],
    });
    const body = projectsPage(board).body;
    expect([...body.matchAll(/<li id="project-(\d+)"/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
  });
});

describe("the words the page uses", () => {
  it("heads its own part of the page with the projects box's own title", () => {
    expect(PROJECTS_BOX).toBeDefined();
    const body = projectsPage(emptyBoard()).body;
    expect(body).toContain(`<h2>${PROJECTS_BOX?.title}</h2>`);
  });

  it("wears the shell the design declares, and does not spell a document of its own", () => {
    const body = projectsPage(emptyBoard()).body;
    expect(body).toContain(projectsContents(emptyBoard()));
    expect(body.startsWith(`${SHELL.doctype}\n`)).toBe(true);
    expect(body).toContain(`<title>${SHELL.title}</title>`);
    // The document's one h1 is the shell's banner; the page heads with an h2 under it.
    expect([...body.matchAll(/<h1>/g)]).toHaveLength(1);
    expect(body).toContain(`<h1>${SHELL.banner}</h1>`);
    const inside = body.slice(
      body.indexOf(`<${SHELL.body}>`),
      body.indexOf(`</${SHELL.body}>`),
    );
    expect(inside).toContain(`<ul class="strip">`);
  });

  it("moves with the design, rather than with a document written out here", () => {
    const moved = { ...SHELL, title: "elsewhere", banner: "a board" };
    const body = document(projectsContents(emptyBoard()), undefined, moved);
    expect(body).toContain("<title>elsewhere</title>");
    expect(body).toContain("<h1>a board</h1>");
  });

  it("says what the projects box says when there is no project", () => {
    const body = projectsPage(emptyBoard()).body;
    expect(body).toContain(`<p class="empty">`);
    expect(body).toContain(
      (PROJECTS_BOX?.empty ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
    );
    expect(body).not.toContain(`<ul class="cards">`);
  });

  it("writes a person's own words as words, not as markup", async () => {
    const what = `a <script>alert("x")</script> & an 'apostrophe'`;
    const res = await fetched(() => boardWith({ projects: [row(9, what, "active")] }));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(body).toContain("&amp; an &#39;apostrophe&#39;");
  });
});
