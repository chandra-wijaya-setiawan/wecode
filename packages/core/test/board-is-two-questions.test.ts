/** The board asks two questions, and only one of them is a person's: what waits on you, and
 *  what is cooking. `needs_human` is the first; the four machine-side panels fold into the
 *  second — one list, oldest first, every row carrying how long it has been sitting.
 *
 *  `running` is on neither side of it. The fold ranks by age, which is the question to ask
 *  of a row nobody is holding; a running row is held, and what it is asked is who has it
 *  and how much they have spent. So it keeps a box of its own and the fold leaves it alone.
 *
 *  `projects` and `open` are on neither side of that either: they are the tree the dashboard
 *  is navigated by rather than a report on the machine, so they keep boxes of their own and
 *  the fold leaves them alone.
 *
 *  What is held here is the fold itself: that it covers every machine-side panel and nothing
 *  else, that it is ordered by age rather than by id, and that the age on a row is read off
 *  that row's own record rather than guessed. */
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
// From the module rather than the facade: `index.ts` publishes the composed board, and the
// fold is board.ts's own, so this is where its contract is.
import { MACHINE_SIDE, board, cooking, recordRefusal } from "../src/board.js";
import { freshDb, seed } from "./helpers.js";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

const T = "2026-09-13T00:00:00.000Z";

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** Minutes ago, as the record writes a timestamp. */
const ago = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const storyIn = (epic: number, slug: string, state = "in_progress", updated = T): number =>
  ins(
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    epic,
    slug,
    state,
    T,
    updated,
  );

const worker = (name: string): number =>
  ins(
    "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    name,
    name,
    "engineer",
    "agent",
    T,
    T,
  );

const assign = (
  slug: string,
  a: { phase?: string; spent?: string; created_at?: string; updated_at?: string; worker_id?: number } = {},
): number =>
  ins(
    `INSERT INTO assignment
       (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    slug,
    "task",
    tree.task,
    a.worker_id ?? worker(slug),
    "{}",
    "{}",
    "/tmp/wt",
    a.phase ?? "running",
    a.spent ?? "{}",
    a.created_at ?? T,
    a.updated_at ?? T,
  );

/** A task refused a pass for the same reason three times running, which is what puts it in
 *  `stale` — and `since` is when the first of those passes was, so it is the age too. */
const refusedSince = (why: string, since: string): void => {
  db.prepare("UPDATE task SET state = 'ready' WHERE id = ?").run(tree.task);
  for (let i = 0; i < 3; i++) recordRefusal(db, why, tree.task);
  db.prepare("UPDATE refusal SET since = ? WHERE task_id = ?").run(since, tree.task);
};

/** The age a cooking row leads with, as a number of minutes. */
const age = (detail: string): number => Number(/^(\d+)m(?: · |$)/.exec(detail)?.[1] ?? Number.NaN);

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("the fold covers the machine side and nothing else", () => {
  it("names the four panels that are the machine's business, and not the one that is yours", () => {
    expect([...MACHINE_SIDE]).toEqual(["stale", "queued", "failed", "delivered"]);
    expect([...MACHINE_SIDE]).not.toContain("needs_human");
  });

  it("leaves running out of the fold, and keeps its rows whole on its own panel", () => {
    // A worker has it: the question is who and how much, not how long it has sat, and a
    // row ranked by age lands at the far end of the list from where it is looked for.
    expect([...MACHINE_SIDE]).not.toContain("running");

    const a = assign("a1", { created_at: ago(7), spent: JSON.stringify({ tokens: 2500 }), worker_id: worker("claude-1") });

    expect(board(db).running.map((r) => r.id)).toEqual([a]);
    expect(cooking(db).some((r) => r.what === "send the reset mail")).toBe(false);
  });

  it("leaves the two boxes that are the tree out of the fold", () => {
    // Not an omission: a folded row is off five tables and can no longer say which entity
    // it is, and these two are the rows `enter` descends from. Folding them would leave
    // the dashboard with nothing to open.
    expect([...MACHINE_SIDE]).not.toContain("projects");
    expect([...MACHINE_SIDE]).not.toContain("open");
    const b = board(db);
    expect(b.projects.length).toBeGreaterThan(0);
    expect(b.open.length).toBeGreaterThan(0);
    for (const row of [...b.projects, ...b.open]) {
      expect(cooking(db).some((f) => f.id === row.id && f.what === row.what)).toBe(false);
    }
  });

  it("keeps every row of every machine-side panel, and exactly as many rows as they hold", () => {
    // Six rows off three of the four panels — stale, queued and delivered — so the count
    // cannot be one panel's.
    refusedSince("no worker free", ago(200));
    storyIn(tree.epic, "shipped", "delivered", ago(30));
    storyIn(tree.epic, "also-shipped", "delivered", ago(31));
    storyIn(tree.epic, "shipped-too", "delivered", ago(32));
    storyIn(tree.epic, "and-shipped", "delivered", ago(33));

    const b = board(db);
    const folded = cooking(db);

    expect(folded.length).toBe(MACHINE_SIDE.reduce((n, panel) => n + b[panel].length, 0));
    expect(folded.length).toBeGreaterThan(4);
    for (const panel of MACHINE_SIDE) {
      for (const row of b[panel]) {
        expect(folded.some((f) => f.id === row.id && f.what === row.what), `${panel} #${row.id}`).toBe(true);
      }
    }
  });

  it("leaves out a row that only needs_human holds", () => {
    // Younger than the staleness threshold, so it is on no machine-side panel at all: the
    // one question the fold does not answer is the one a person is being asked.
    const a = assign("a1", { phase: "waiting", updated_at: ago(5) });

    expect(board(db).needs_human.map((r) => r.id)).toEqual([a]);
    // By what rather than by id: an assignment, a story and a project all number from 1, and
    // the fold is a list of rows off six tables, so an id in it is not an identity.
    expect(cooking(db).some((r) => r.what === "send the reset mail")).toBe(false);
  });

  it("narrows with the project, the way the panels it folds do", () => {
    const other = ins(
      "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      "loyalty",
      tree.ws,
      "loyalty",
      "/loyalty",
      "in_progress",
      T,
      T,
    );
    const release = ins(
      "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "loyalty-v1",
      other,
      "1.0",
      "in_progress",
      T,
      T,
    );
    const epic = ins(
      "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "loyalty-epic",
      release,
      "loyalty epic",
      "in_progress",
      T,
      T,
    );
    const elsewhere = storyIn(epic, "points");

    expect(cooking(db).some((r) => r.what === "points")).toBe(true);
    expect(cooking(db, tree.project).some((r) => r.id === elsewhere && r.what === "points")).toBe(false);
  });
});

describe("oldest first", () => {
  /** The fold, kept to the rows a case put in it, named the way a person reads them. */
  const order = (...whats: readonly string[]): string[] =>
    cooking(db)
      .map((r) => r.what)
      .filter((what) => whats.includes(what));

  it("orders the whole fold by age, whatever panel a row came from", () => {
    // Four rows off three panels — delivered, queued, stale and delivered again — so the
    // order cannot be the panels' order and cannot be an id order either. The refused task
    // is two rows, because queued and stale say different things about it.
    storyIn(tree.epic, "newest", "delivered", ago(5));
    refusedSince("no worker free", ago(40));
    storyIn(tree.epic, "oldest", "delivered", ago(600));

    expect(order("newest", "oldest", "send the reset mail")).toEqual([
      "oldest",
      "send the reset mail",
      "send the reset mail",
      "newest",
    ]);
  });

  it("puts the older row first even when the younger one has the smaller id", () => {
    const early = storyIn(tree.epic, "early-id", "delivered", ago(1));
    const late = storyIn(tree.epic, "late-id", "delivered", ago(999));
    expect(early).toBeLessThan(late);

    expect(order("early-id", "late-id")).toEqual(["late-id", "early-id"]);
  });

  it("falls back to the id when two rows have sat since the same instant", () => {
    const same = ago(50);
    const first = storyIn(tree.epic, "tie-a", "delivered", same);
    const second = storyIn(tree.epic, "tie-b", "delivered", same);
    expect(first).toBeLessThan(second);

    expect(order("tie-a", "tie-b")).toEqual(["tie-a", "tie-b"]);
  });

  it("sorts a row nothing can date last rather than first", () => {
    storyIn(tree.epic, "no-date", "delivered", "whenever");
    storyIn(tree.epic, "ancient", "delivered", ago(10_000));

    const folded = cooking(db);
    expect(folded[0]?.what).toBe("ancient");
    expect(folded.at(-1)?.what).toBe("no-date");
  });
});

describe("every cooking row says its age", () => {
  it("leads the detail with the minutes, on every row there is", () => {
    refusedSince("no worker free", ago(7));
    storyIn(tree.epic, "shipped", "delivered", ago(30));

    for (const row of cooking(db)) {
      expect(row.detail, `#${row.id} ${row.what}`).toMatch(/^\d+m(?: · |$)/);
    }
  });

  it("reads the age off the row's own record", () => {
    // A task refused the same way three times is two panels' business: queued says it has
    // no slot and stale says it has stopped moving. A fold is not a dedupe — the two rows
    // say different things — and both are dated from the refusal rather than from the
    // task's last touch, which the seed left at 2026-09-13.
    refusedSince("no worker free", ago(90));
    const details = cooking(db)
      .filter((r) => r.what === "send the reset mail")
      .map((r) => r.detail);
    expect(details.sort()).toEqual(["90m · no worker free", "90m · no worker free · 3 passes"]);
  });

  it("keeps the panel's own detail behind the age", () => {
    const story = storyIn(tree.epic, "shipped", "delivered", ago(30));
    expect(cooking(db).find((r) => r.id === story)?.detail).toBe("30m · story");
  });

  it("dates a queued task from the pass that refused it, not from the record's last touch", () => {
    refusedSince("no worker free", ago(120));
    const queued = board(db).queued.find((r) => r.id === tree.task);
    expect(queued?.detail).toBe("no worker free");
    expect(age(cooking(db).find((r) => r.detail.endsWith("no worker free"))?.detail ?? "")).toBe(120);
  });

  it("says the same minutes once, where the panel already said them", () => {
    refusedSince("no worker free", ago(45));

    expect(board(db).stale.some((r) => r.detail === "no worker free · 3 passes · 45m")).toBe(true);
    expect(cooking(db).some((r) => r.detail === "45m · no worker free · 3 passes")).toBe(true);
  });
});

describe("the panels the fold reads are left as they were", () => {
  it("hands the cockpit the same rows it always did, with no age on them", () => {
    assign("a1", { created_at: ago(7), spent: JSON.stringify({ tokens: 2500 }), worker_id: worker("claude-1") });
    const story = storyIn(tree.epic, "shipped", "delivered", ago(30));

    expect(board(db).running).toEqual([
      { id: 1, what: "send the reset mail", state: "running", detail: "claude-1 · 7m · 2k" },
    ]);
    expect(board(db).delivered).toEqual([{ id: story, what: "shipped", state: "delivered", detail: "story" }]);
  });
});
