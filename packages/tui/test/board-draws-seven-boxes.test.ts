/** The board is seven boxes, and each row is in exactly one of them.
 *
 *  It was four, and the fold was doing too much: `cooking` was stale, queued, failed and
 *  delivered together, so a story waiting to land sat in the same list as a task that had
 *  given up, and the box opened to ask *what has gone wrong* answered mostly with things
 *  that had gone right. `open` was doing too much the other way — epics and stories nobody
 *  had started, mixed in with the ones in flight.
 *
 *  So: needs you, running, queue, cooking, planned, delivered, dropped. The fold keeps only
 *  what is stuck. Asserted against the rendered lines rather than against `loadViews()` or
 *  `board()`, because a test over the functions that feed the screen passes on a screen
 *  that draws nothing: the box a person can see is the border with the title in it.
 *
 *  Unlike the four-panel test this replaces, the titles *are* written out here. Which boxes
 *  the page spends its height on is the decision this test exists to hold — a test that
 *  read the order back off views.yaml would pass whatever that file said. The wording of a
 *  title is still the file's, so each is matched on the word that names the question and
 *  not on the whole string. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
// Off the module rather than off the package: `cooking` and the list of what it folds are
// board.ts's own, and the three have to be read from one place or they answer from two.
import { MACHINE_SIDE, board, cooking } from "../../core/src/board.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadOffPage, loadViews } from "../src/views.js";
import { loadServices } from "../src/services.js";
import { ins, seed, T } from "./seed.js";

/** The seven questions, top to bottom, and the word each box's title is known by. */
const ORDER = [
  { filter: "needs_human", word: "Needs you" },
  { filter: "running", word: "Running" },
  { filter: "queued", word: "Queue" },
  { filter: "cooking", word: "Cooking" },
  { filter: "planned", word: "Planned" },
  { filter: "delivered", word: "Delivered" },
  { filter: "dropped", word: "Dropped" },
] as const;

const views = loadViews();
const services = loadServices();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;
let tree: ReturnType<typeof seed>;
/** One row of each kind, by the words it is drawn under. */
let rows: Record<string, string>;

/** Minutes ago, as the record writes a timestamp. */
const ago = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const worker = (name: string): number =>
  ins(db, "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)", name, name, "engineer", "agent", T, T);

/** A second task under the same acceptance test, so each box gets a row of its own rather
 *  than four boxes arguing over the seed's one task. */
const task = (slug: string, title: string, state: string): number => {
  const parent = (
    db.prepare("SELECT acceptance_test_id AS at FROM task WHERE id = ?").get(tree.task) as { at: number }
  ).at;
  return ins(
    db,
    "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    slug, parent, title, "{}", "engineer", "{}", state, T, T,
  );
};

const assign = (slug: string, onTask: number, phase: string, updated: string): number =>
  ins(
    db,
    `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    slug, "task", onTask, worker(slug), "{}", "{}", "/tmp/wt", phase, "{}", T, updated,
  );

const story = (slug: string, title: string, state: string): number =>
  ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", slug, tree.epic, title, state, T, ago(30));

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);

  // One of each kind, and no kind twice. The waiting assignment is fresh on purpose: one
  // that has sat longer than the staleness threshold is genuinely two rows — it waits on a
  // person *and* it has stopped moving — and this case is about the boxes, not about that.
  const held = task("ship-it", "ship it", "in_progress");
  const asked = task("ask-me", "ask me", "in_progress");
  const waiting = assign("a-waits", asked, "waiting", ago(1));
  assign("a-runs", held, "running", T);
  task("gave-up", "gave up", "failed");
  task("put-down", "put it down", "dropped");
  story("next", "the next thing", "planned");
  story("shipped", "shipped last week", "delivered");

  rows = {
    needs_human: `task #${asked}`,
    running: "ship it",
    // The seed's own task: ready, with nothing attempting it, which is the queue.
    queued: "send the reset mail",
    cooking: "gave up",
    planned: "the next thing",
    delivered: "shipped last week",
    dropped: "put it down",
  };
  expect(waiting).toBeGreaterThan(0);

  app = new App(db, views, machines);
});

afterEach(cleanup);

/** Tall enough that nothing the dashboard draws is clipped: a box missing because the
 *  terminal ran out of rows is a different fault from a box that was never declared. */
const lines = (width = 100, height = 90): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** Every region the frame draws, titled, top to bottom. A region is a rule with its title
 *  sat in it — `── Cooking (1) [c] ─────` — and the count and the letter come off. The
 *  borders these titles used to sit in are gone; see test/no-section-is-boxed.test.ts. */
const drawn = (out: readonly string[]): string[] =>
  out
    .filter((l) => l.startsWith("──"))
    .map((l) => /─ (.*?) ─/.exec(l)?.[1] ?? "")
    .map((t) => t.replace(/ \(\d+\)/, "").replace(/ \[.\]$/, "").trim());

/** The services box sits on the dashboard and is not a box of the board: it is no filter,
 *  `v` does not open it, and it holds no row the cursor can reach. */
const boxes = (out: readonly string[]): string[] =>
  drawn(out).filter((t) => t !== services.title);

/** The lines under the rule titled `title`, down to the next rule or the end of the page. */
function inside(out: readonly string[], title: string): string {
  const at = out.findIndex((l) => l.startsWith(`── ${title} (`));
  expect(at, `no box titled ${title}`).toBeGreaterThanOrEqual(0);
  const rest = out.slice(at + 1);
  const end = rest.findIndex((l) => l.startsWith("──") || l.trim() === "");
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const titleOf = (filter: string): string => {
  const view = views.find((v) => v.filter === filter);
  expect(view, `no box filters on ${filter}`).toBeDefined();
  return view?.title ?? "";
};

describe("the board draws seven boxes, in order", () => {
  it("draws seven and no more", () => {
    const titles = boxes(lines());
    expect(titles.length, `the board drew ${titles.join(", ")}`).toBe(ORDER.length);
  });

  /** The decision itself: which seven, and in which order. Held against the rendered frame
   *  and against views.yaml at once, so neither a file that declares the wrong order nor a
   *  screen that draws something other than the file can pass. */
  it("draws needs you, running, queue, cooking, planned, delivered and dropped, in that order", () => {
    expect(views.map((v) => v.filter)).toEqual(ORDER.map((o) => o.filter));
    expect(boxes(lines())).toEqual(views.map((v) => v.title));
    expect(views.map((v) => v.title)).toEqual(ORDER.map((o) => o.word));
  });

  /** `open` lost its place on the page to `planned`, which is the half of it that asks a
   *  question. It did not lose its letter: what a box was cut for is the height it took
   *  from the boxes beside it, and off the page it takes none of that. So it is asserted
   *  twice over — absent from the seven the dashboard draws, and still one `v o` away. */
  it("puts open off the page rather than taking its door off", () => {
    const off = loadOffPage();
    const box = off.find((v) => v.filter === "open");
    expect(box, `off_page holds ${off.map((v) => v.name).join(", ")}`).toBeDefined();
    expect(box?.key).toBe("o");
    expect(views.map((v) => v.filter)).not.toContain("open");
    expect(boxes(lines())).not.toContain(box?.title);

    app.key("v");
    expect(app.status).toContain(box?.title as string);
    app.key("o");
    expect(app.screen).toMatchObject({ kind: "box", view: { name: "open" } });
  });

  /** Each is ruled off rather than boxed in, and the rule carries everything the border
   *  carried: the title, the count, and the letter `v` opens it by. */
  it("rules each of them off, titled, with its count and its key", () => {
    const out = lines();
    for (const view of views) {
      const at = out.findIndex((l) => l.startsWith(`── ${view.title} (`));
      expect(at, `no box titled ${view.title}`).toBeGreaterThanOrEqual(0);
      expect(out[at]).toMatch(new RegExp(`^── ${view.title} \\(\\d+\\) \\[.\\] ─+$`));
      expect((out[at] as string).length).toBe(100);
      // And the rows under it are rows, not the sides of a box the rule replaced.
      expect(inside(out, view.title)).not.toMatch(/[│┌┐└┘]/);
    }
  });

  /** A board holding one row of every kind, and every one of them lands in its own box. */
  it("puts each kind of row in the box that asks about it", () => {
    const out = lines();
    for (const [filter, what] of Object.entries(rows)) {
      expect(inside(out, titleOf(filter)), `${what} is not in ${filter}`).toContain(what);
    }
  });

  it("draws each row once, on one box and no other", () => {
    const body = lines().filter((l) => !l.startsWith("──") && l.trim() !== "");
    for (const what of Object.values(rows)) {
      const holding = body.filter((l) => l.includes(what));
      expect(holding.length, `${what} is drawn on ${holding.length} boxes`).toBe(1);
    }
  });

  /** The row a box is read for, not just the box. The running box says who is holding it —
   *  that is the whole of what it is opened for — and the queue says why there is no slot. */
  it("draws the worker on the running row and the reason on the queued one", () => {
    const out = lines();
    expect(inside(out, titleOf("running"))).toContain("a-runs");
    expect(inside(out, titleOf("queued"))).toContain("engineer");
  });
});

describe("the fold is only what is stuck", () => {
  /** The cut is the point of the story: queued and delivered are out of the fold, so the
   *  box a person opens to ask what has gone wrong holds nothing that has gone right. */
  it("folds stale and failed, and nothing that is merely waiting its turn", () => {
    expect([...MACHINE_SIDE]).toEqual(["stale", "failed"]);
    const folded = cooking(db);
    expect(folded.some((r) => r.what === rows["queued"])).toBe(false);
    expect(folded.some((r) => r.what === rows["delivered"])).toBe(false);
    expect(folded.some((r) => r.what === rows["cooking"])).toBe(true);
  });

  it("keeps every row of every panel it does fold, and exactly as many as they hold", () => {
    const b = board(db);
    expect(b.cooking.length).toBe(MACHINE_SIDE.reduce((n, p) => n + b[p].length, 0));
    expect(b.cooking).toEqual(cooking(db));
  });

  it("draws none of the panels it folds beside the fold", () => {
    for (const filter of views.map((v) => v.filter)) {
      expect(MACHINE_SIDE as readonly string[], `${filter} is drawn and folded`).not.toContain(filter);
    }
  });

  /** A box is only a box if the cursor can go through it. The fold holds two panels' rows
   *  and so more than one kind of entity, which is what app.ts has to answer for. */
  it("opens a folded row as the entity the panel it came from names", () => {
    const at = app.lines().findIndex((r) => r.what === "gave up");
    expect(at, `the fold drew ${app.lines().map((r) => r.what).join(", ")}`).toBeGreaterThanOrEqual(0);

    app.cursor = at;
    app.key("enter");

    expect(app.screen).toMatchObject({ kind: "node", entity: "task" });
  });

  it("leaves no row on any box that says nothing to open", () => {
    for (let at = 0; at < app.lines().length; at++) {
      const row = app.lines()[at];
      app.cursor = at;
      app.key("enter");
      expect(app.status, `${row?.what} is a dead row`).not.toBe("nothing to open");
      if (app.screen.kind === "node") app.key("esc");
    }
  });
});
