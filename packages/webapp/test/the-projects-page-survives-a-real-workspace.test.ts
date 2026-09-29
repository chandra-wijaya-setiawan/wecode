/** The projects page against the shapes a workspace actually comes in.
 *
 *  The sibling file holds the page's two questions. This one holds the page against the
 *  values a live ledger hands it and a hand-picked example never does: a hundred rows in a
 *  box, a project with no story under it yet, a counter that has run past its total, a beat
 *  of zero, a series of ten zeroes, a pulse that still names a project the board has
 *  already dropped, and a name a person typed with a bracket in it.
 *
 *  Every shape here is one `@wecode/core` can produce — `board()` writes `n/m stories`
 *  including `0/0`, `throughput()` gives every project ten buckets even when nothing has
 *  passed, and `silence()` leaves out a project it cannot date while clamping the rest at
 *  zero. The board is still hand-made, because what is being proved is the page's arithmetic
 *  at those values, not the query that produced them. */
import type { Board, Row } from "@wecode/core";
import { loadViews } from "@wecode/tui";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { addressOf, serve } from "../src/server.js";
import { projectRoutes, projectsPage, since, type Pulse } from "../src/pages/projects.js";

const VIEWS = loadViews();

/** How many buckets `throughput()` gives a project — ten hours, one block an hour. */
const BUCKETS = 10;

const row = (id: number, what: string, state = "active", detail = ""): Row => ({
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

const rows = (n: number, from = 1): readonly Row[] =>
  Array.from({ length: n }, (_, i) => row(from + i, `row ${from + i}`, "ready"));

/** One project's card, cut out of the page so an assertion about a project is not an
 *  assertion about its neighbours. The closing quote is part of the match: without it
 *  `project-1` finds the card of project 17. */
function cardOf(body: string, id: number): string {
  const at = body.indexOf(`<li id="project-${id}">`);
  expect(at, `the page has no card for project ${id}`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</li>", at));
}

const stripOf = (body: string): string =>
  body.slice(body.indexOf(`<ul class="strip">`), body.indexOf("</ul>"));

const cardIds = (body: string): readonly string[] =>
  [...body.matchAll(/<li id="project-(\d+)">/g)].map((m) => m[1] as string);

const counts = (body: string): readonly string[] =>
  [...stripOf(body).matchAll(/<span class="count">(\d+)<\/span>/g)].map((m) => m[1] as string);

const meterOf = (card: string): string | null =>
  /<span style="width:(\d+)%"><\/span>/.exec(card)?.[1] ?? null;

const sparkOf = (card: string): string | null =>
  /<span class="spark">([^<]*)<\/span>/.exec(card)?.[1] ?? null;

/** A workspace the size of one somebody works in: a dozen projects and every box holding a
 *  different number of rows, none of them a number a test writer would pick. */
const liveBoard = (): Board => {
  const held: Partial<Record<keyof Board, readonly Row[]>> = {
    projects: Array.from({ length: 12 }, (_, i) =>
      row(100 + i, `project ${i}`, i % 3 === 0 ? "active" : "paused", `${i}/${i * 2} stories`),
    ),
  };
  let next = 1;
  for (const [i, v] of VIEWS.entries()) {
    const n = [0, 1, 3, 17, 104, 250][i % 6] as number;
    held[v.filter] = rows(n, (next += 1000));
  }
  return boardWith(held);
};

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("a workspace the size of a real one", () => {
  it("draws a cell per box and a card per project, however many rows they hold", () => {
    const board = liveBoard();
    const body = projectsPage(board).body;
    expect(counts(body)).toEqual(VIEWS.map((v) => String(board[v.filter].length)));
    expect(cardIds(body)).toEqual(board.projects.map((p) => String(p.id)));
  });

  it("serves that workspace over a socket, whole", async () => {
    const board = liveBoard();
    const server = await serve(projectRoutes(() => board));
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(cardIds(body)).toHaveLength(board.projects.length);
    expect(body).toContain("project 11");
    expect(body.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("keeps one card per project even when two of them are named the same", () => {
    const board = boardWith({
      projects: [row(1, "wecode", "active", "1/2 stories"), row(2, "wecode", "paused", "0/4 stories")],
    });
    const body = projectsPage(board).body;
    expect(cardIds(body)).toEqual(["1", "2"]);
    expect(cardOf(body, 1)).toContain("active");
    expect(cardOf(body, 2)).toContain("paused");
  });
});

describe("the counts a project row arrives with", () => {
  it("draws no meter for a project with no story under it yet", () => {
    const card = cardOf(projectsPage(boardWith({ projects: [row(1, "new", "active", "0/0 stories")] })).body, 1);
    expect(meterOf(card)).toBeNull();
    expect(card).toContain("0/0 stories");
  });

  it("fills the meter for a project whose stories are all delivered", () => {
    const card = cardOf(projectsPage(boardWith({ projects: [row(1, "done", "active", "9/9 stories")] })).body, 1);
    expect(meterOf(card)).toBe("100");
  });

  it("never draws past full, whatever the counter says", () => {
    const card = cardOf(projectsPage(boardWith({ projects: [row(1, "odd", "active", "70/5 stories")] })).body, 1);
    expect(meterOf(card)).toBe("100");
  });

  it("holds its arithmetic at a workspace's worth of stories", () => {
    const card = cardOf(projectsPage(boardWith({ projects: [row(1, "big", "active", "1200/2400 stories")] })).body, 1);
    expect(meterOf(card)).toBe("50");
  });

  it("says a project's words even when it has none", () => {
    const card = cardOf(projectsPage(boardWith({ projects: [row(1, "", "", "")] })).body, 1);
    expect(card).toContain(`<span class="name"></span>`);
    expect(meterOf(card)).toBeNull();
  });
});

describe("the pulse a live ledger hands the page", () => {
  const one = (): Board => boardWith({ projects: [row(1, "wecode", "active", "1/3 stories")] });

  it("says a project touched a moment ago is quiet for nothing, rather than saying nothing", () => {
    const card = cardOf(projectsPage(one(), { silence: new Map([[1, 0]]) }).body, 1);
    expect(card).toContain("quiet 0m");
  });

  it("reads a beat of weeks in days", () => {
    expect(since(30 * 24 * 3_600_000)).toBe("30d");
    expect(since(23 * 3_600_000 + 59 * 60_000)).toBe("23h");
  });

  it("draws the ten zero buckets a project with no pass gets", () => {
    const pulse: Pulse = { throughput: new Map([[1, Array<number>(BUCKETS).fill(0)]]) };
    const card = cardOf(projectsPage(one(), pulse).body, 1);
    expect([...(sparkOf(card) ?? "")]).toHaveLength(BUCKETS);
    expect(card).toContain(`<span class="rate">0/h</span>`);
  });

  it("draws a busy hour without outgrowing the line", () => {
    const series = [0, 0, 2, 1, 0, 0, 5, 0, 1, 37];
    const card = cardOf(projectsPage(one(), { throughput: new Map([[1, series]]) }).body, 1);
    const spark = [...(sparkOf(card) ?? "")];
    expect(spark).toHaveLength(BUCKETS);
    expect(spark[BUCKETS - 1]).toBe("█");
    expect(card).toContain(`<span class="rate">37/h</span>`);
  });

  it("ignores a pulse for a project the board has already dropped", () => {
    const pulse: Pulse = {
      silence: new Map([
        [1, 60_000],
        [999, 60_000],
      ]),
      throughput: new Map([[999, Array<number>(BUCKETS).fill(3)]]),
    };
    const body = projectsPage(one(), pulse).body;
    expect(cardIds(body)).toEqual(["1"]);
    expect(body).not.toContain("project-999");
    expect(cardOf(body, 1)).toContain("quiet 1m");
    expect(cardOf(body, 1)).not.toContain("spark");
  });

  it("says nothing about a beat for a project neither map names", () => {
    const board = boardWith({ projects: [row(1, "a"), row(2, "b")] });
    const pulse: Pulse = { silence: new Map([[1, 60_000]]), throughput: new Map([[1, [1]]]) };
    const body = projectsPage(board, pulse).body;
    expect(cardOf(body, 2)).not.toContain("pulse");
  });
});

describe("the words a person typed", () => {
  it("writes a name, a state and a detail as words, wherever the markup would be", () => {
    const board = boardWith({
      projects: [row(1, `we<b>code</b>`, `a & "b"`, `<i>3</i>/4 stories`)],
    });
    const card = cardOf(projectsPage(board).body, 1);
    expect(card).not.toMatch(/<(b|i)>/);
    expect(card).toContain("we&lt;b&gt;code&lt;/b&gt;");
    expect(card).toContain("a &amp; &quot;b&quot;");
    expect(card).toContain("&lt;i&gt;3&lt;/i&gt;/4 stories");
  });

  it("keeps a name a person typed in their own alphabet", () => {
    const what = "proyecto — 設計 🚀";
    const board = boardWith({ projects: [row(1, what)] });
    expect(cardOf(projectsPage(board).body, 1)).toContain(what);
  });

  it("lets a name with no space in it wrap inside its card", () => {
    const what = "a".repeat(120);
    const body = projectsPage(boardWith({ projects: [row(1, what)] })).body;
    expect(cardOf(body, 1)).toContain(what);
    const style = body.slice(body.indexOf("<style>"), body.indexOf("</style>"));
    expect(style).toMatch(/ul\.cards \.name \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/ul\.cards li \{[^}]*min-width: 0/);
  });
});
