/** The board opens with a line per project, and every row in the box carries a tag.
 *
 *  Two claims, and they are one story because they are the same change: the moment the top
 *  box holds a row about a project as well as rows about the workspace, a reader scanning
 *  it down the left has to be told which is which, and the tag is what tells them.
 *
 *  A pulse is counted off the board the boxes underneath are drawn from, never derived
 *  beside it — so the tests here assert the pulse against `board()` itself rather than
 *  against numbers written out by hand, which is the only way to catch the two drifting.
 *
 *  The beat — how long since anything under the project moved — is the one field the
 *  board's groups cannot answer, and it is read off the record's own timestamps. */
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { board, loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { loadServices, services, serviceLines, SERVICE_ROWS, WORKSPACE } from "../src/services.js";
import { loadViews } from "../src/views.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();
const config = loadServices();

/** Twelve hours after everything the seed writes, so an unmoved project has an age worth
 *  reading and the arithmetic is one a person can check. */
const AT = "2026-09-13T12:00:00.000Z";

let db: DatabaseSync;
let app: App;
let tree: ReturnType<typeof seed>;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

/** The rows the box would draw right now. `queued` is the board's own count, as the
 *  dashboard passes it. */
const rows = (at: string = AT) => {
  app.refresh();
  return services(db, app.boardNow().queued.length, config, at);
};

const pulses = (at: string = AT) => rows(at).filter((r) => r.what === "pulse");

const project = (slug: string, name: string, updated = T): number =>
  ins(
    db,
    "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    slug,
    1,
    name,
    "/repo",
    "in_progress",
    T,
    updated,
  );

const worker = (slug: string): number =>
  ins(db, "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)", slug, slug, "engineer", "agent", T, T);

/** An assignment against the seed's task, which is what makes its project beat. */
const assign = (slug: string, phase: string, updated = T): number =>
  ins(
    db,
    `INSERT INTO assignment
       (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    slug,
    "task",
    tree.task,
    worker(slug),
    "{}",
    "{}",
    "/tmp/wt",
    phase,
    "{}",
    T,
    updated,
  );

describe("the board opens with a pulse line per project", () => {
  it("draws one, for every project there is, before the workspace's own rows", () => {
    project("atlas", "atlas");
    project("beacon", "beacon");

    const out = rows();
    expect(out.slice(0, 3).map((r) => r.what)).toEqual(["pulse", "pulse", "pulse"]);
    expect(out.slice(0, 3).map((r) => r.tag)).toEqual(["storefront", "atlas", "beacon"]);
    expect(out.slice(3).map((r) => r.what)).toEqual(["runner", "schema", "fleet", "doctor"]);
  });

  it("is a line per project and nothing else, however many the workspace holds", () => {
    expect(pulses()).toHaveLength(1);
    project("atlas", "atlas");
    expect(pulses()).toHaveLength(board(db).projects.length);
    expect(rows()).toHaveLength(board(db).projects.length + SERVICE_ROWS);
  });

  it("says what the boxes underneath say, because it is counted off the same board", () => {
    assign("a1", "running");
    project("atlas", "atlas");

    for (const p of board(db).projects) {
      const groups = board(db, p.id);
      const line = pulses().find((r) => r.tag === p.what);
      expect(line?.detail).toContain(`${groups.running.length} running`);
      expect(line?.detail).toContain(`${groups.queued.length} queued`);
      expect(line?.detail).toContain(`${groups.cooking.length} stuck`);
    }
  });
});

describe("what a pulse says about a project", () => {
  it("beats while something is running under it", () => {
    assign("a1", "running");
    expect(pulses()[0]?.state).toBe("beating");
    expect(pulses()[0]?.alarm).toBe(false);
  });

  it("is still, and red, when work is waiting and nothing is running it", () => {
    // The seed's own task is ready and nothing is attempting it: that is a project the
    // machine has stopped carrying, which is the one thing here worth crossing the room for.
    expect(board(db, tree.project).queued).toHaveLength(1);
    expect(pulses()[0]?.state).toBe("still");
    expect(pulses()[0]?.alarm).toBe(true);
  });

  it("is quiet, and not red, when there is nothing to do at all", () => {
    // A project with no work under it: the box's rule is red or nothing, and a lamp for a
    // project nobody has given work to would light every evening and be read by nobody.
    project("atlas", "atlas");
    const line = pulses().find((r) => r.tag === "atlas");
    expect(line?.state).toBe("quiet");
    expect(line?.alarm).toBe(false);
    expect(line?.detail).toContain("0 running · 0 queued · 0 stuck");
  });
});

describe("the beat", () => {
  it("says how long since anything under the project moved, off the record's own stamps", () => {
    // Everything the seed writes is stamped T, and AT is twelve hours later.
    expect(pulses()[0]?.detail).toContain("moved 12h0m ago");
  });

  it("is dated from the newest touch anywhere under the project, not from the project row", () => {
    // A project row nobody has updated since T, with an assignment touched a minute before
    // the reading: what moved under it is what the beat is.
    assign("a1", "running", "2026-09-13T11:59:00.000Z");
    expect(pulses()[0]?.detail).toContain("moved 1m ago");
  });

  it("says so plainly when nothing under the project has ever moved", () => {
    project("atlas", "atlas");
    expect(pulses().find((r) => r.tag === "atlas")?.detail).toContain("never moved");
  });
});

describe("every row carries a tag", () => {
  it("names the workspace on the rows that are about the workspace", () => {
    project("atlas", "atlas");
    const workspace = rows().filter((r) => r.what !== "pulse");
    expect(workspace.map((r) => r.tag)).toEqual([WORKSPACE, WORKSPACE, WORKSPACE, WORKSPACE]);
  });

  it("names the project on the row that is about a project", () => {
    project("atlas", "atlas");
    expect(pulses().map((r) => r.tag)).toEqual(["storefront", "atlas"]);
  });

  it("leaves no row untagged, whatever the workspace holds", () => {
    project("atlas", "atlas");
    assign("a1", "running");
    expect(rows().every((r) => r.tag !== "")).toBe(true);
  });

  it("draws the tag first, in a column every row lines up in", () => {
    project("a-much-longer-project-name", "a-much-longer-project-name");
    const drawn = serviceLines(rows(), 200);
    const tag = "a-much-longer-project-name".length;
    expect(drawn.every((l) => l.slice(0, tag + 2).endsWith("  "))).toBe(true);
    expect(drawn.some((l) => l.startsWith(`${WORKSPACE.padEnd(tag)}  runner`))).toBe(true);
    expect(drawn.some((l) => l.startsWith("a-much-longer-project-name  pulse"))).toBe(true);
  });

  it("still loses a long row's tail to an ellipsis rather than wrapping", () => {
    const drawn = serviceLines(rows(), 40);
    expect(drawn.every((l) => l.length <= 40)).toBe(true);
  });
});
