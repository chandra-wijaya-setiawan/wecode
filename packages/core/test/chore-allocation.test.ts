import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyChore,
  choreCandidates,
  choreRefusal,
  ensureChore,
  kindOf,
  loadRoles,
  nextUp,
  ordered,
  type Candidate,
  type RoleConfig,
} from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** The project's own roles file: a chore's scope is the system role's scope, and this test
 *  reads it from the same place the runner does rather than restating it. */
const roles: RoleConfig = loadRoles(
  fileURLToPath(new URL("../../../config/roles.yaml", import.meta.url)),
);

const config = { max_open_per_role: {}, order: { fresh_first: true }, roles };

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

/** The condition the runner raises: a story that will not merge. `merge` needs no
 *  approval, so the chore is a candidate from `planned` — which is where it sits. */
const mergeChore = (): number =>
  ensureChore(db, {
    project_id: tree.project,
    kind: "merge",
    target_type: "story",
    target_id: tree.story,
    check: "git merge --no-ff story/reset",
  }).id;

const systemWorker = (): number => {
  db.prepare("INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
    "sys-1",
    "sys-1",
    "system",
    "agent",
    "2026-09-15T00:00:00.000Z",
    "2026-09-15T00:00:00.000Z",
  );
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("a chore is something the allocator can choose", () => {
  it("offers an open chore when a worker holds the system role", () => {
    const chore = mergeChore();
    systemWorker();

    const up = nextUp(db, config);
    const mine = up.ordered.filter((c) => kindOf(c) === "chore");
    expect(mine.map((c) => c.id)).toEqual([chore]);
    expect(mine[0]).toMatchObject({
      role: "system",
      scope: roles.roles["system"]?.scope,
      budget: roles.roles["system"]?.budget,
    });
    expect(up.refused).toEqual([]);
  });

  it("offers it while it is still planned: that is where a chore wecode raised sits", () => {
    mergeChore();
    systemWorker();
    expect(db.prepare("SELECT state FROM chore").get()).toEqual({ state: "planned" });
    expect(choreCandidates(db, roles).candidates).toHaveLength(1);
  });

  it("does not offer one an assignment is already attempting", () => {
    const chore = mergeChore();
    const worker = systemWorker();
    db.prepare(
      `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `chore-${chore}-1`,
      "chore",
      chore,
      worker,
      JSON.stringify({ write: ["**"], tools: [] }),
      JSON.stringify({ tokens: 1, seconds: 1 }),
      "/tmp/wt",
      "running",
      JSON.stringify({ tokens: 0, seconds: 0 }),
      "2026-09-15T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
    );

    expect(choreCandidates(db, roles).candidates).toEqual([]);
  });

  it("offers no chore at all to a caller that cannot say where a scope comes from", () => {
    mergeChore();
    systemWorker();
    expect(choreCandidates(db)).toEqual({ candidates: [], refused: [] });
    expect(nextUp(db, { max_open_per_role: {}, order: { fresh_first: true } }).ordered).toEqual([]);
  });
});

describe("a chore nobody can take says so", () => {
  it("is refused with the board's own words, and the reason is on the record", () => {
    const chore = mergeChore();

    const up = nextUp(db, config);
    expect(up.ordered.filter((c) => kindOf(c) === "chore")).toEqual([]);
    expect(up.refused).toContainEqual({ id: chore, why: "no worker free for role system" });
    expect(choreRefusal(db, chore)).toMatchObject({ why: "no worker free for role system", passes: 1 });
  });

  it("holds its `since` and counts the passes while the reason does not change", () => {
    const chore = mergeChore();
    nextUp(db, config);
    const first = choreRefusal(db, chore);
    nextUp(db, config);
    const held = choreRefusal(db, chore);
    expect(held?.passes).toBe(2);
    // `since` is when this reason started, and it is not rewritten by a pass that says the
    // same thing again: a chore refused for the same reason all morning is a different
    // problem from one refused for a new reason a minute ago.
    expect(held?.since).toBe(first?.since);
  });

  it("stops saying it once a worker is free", () => {
    const chore = mergeChore();
    nextUp(db, config);
    expect(choreRefusal(db, chore)).not.toBeNull();

    systemWorker();
    nextUp(db, config);
    expect(choreRefusal(db, chore)).toBeNull();
  });

  it("refuses a kind that waits for approval in the board's words for that", () => {
    const chore = ensureChore(db, {
      project_id: tree.project,
      kind: "sweep",
      target_type: "project",
      target_id: tree.project,
      check: "wecode sweep",
    }).id;
    systemWorker();

    const up = nextUp(db, config);
    expect(up.ordered.filter((c) => kindOf(c) === "chore")).toEqual([]);
    expect(up.refused).toContainEqual({ id: chore, why: "waiting for approval" });
    expect(choreRefusal(db, chore)?.why).toBe("waiting for approval");
  });
});

describe("a chore that is done is over", () => {
  it("is never a candidate again", () => {
    const chore = mergeChore();
    systemWorker();
    for (const verb of ["start", "begin", "finish"]) {
      expect(applyChore(db, chore, verb, "runner")).toMatchObject({ ok: true });
    }
    expect(db.prepare("SELECT state FROM chore WHERE id = ?").get(chore)).toEqual({ state: "done" });

    expect(choreCandidates(db, roles).candidates).toEqual([]);
    expect(nextUp(db, config).ordered.filter((c) => kindOf(c) === "chore")).toEqual([]);
  });

  it("is not a candidate while it is running either", () => {
    const chore = mergeChore();
    systemWorker();
    applyChore(db, chore, "start", "runner");
    applyChore(db, chore, "begin", "runner");
    expect(choreCandidates(db, roles).candidates).toEqual([]);
  });

  it("is a candidate again after it failed: the branch it fought with can move", () => {
    const chore = mergeChore();
    systemWorker();
    for (const verb of ["start", "begin", "fail"]) applyChore(db, chore, verb, "runner");
    expect(choreCandidates(db, roles).candidates.map((c) => c.id)).toEqual([chore]);
  });
});

describe("a chore and a task are not ordered against each other by accident", () => {
  const cand = (id: number, objective_type: "task" | "chore", attempts = 0): Candidate => ({
    id,
    objective_type,
    title: `${objective_type} ${id}`,
    role: objective_type === "chore" ? "system" : "engineer",
    scope: { write: [`src/${id}/**`], tools: [] },
    budget: { tokens: 1, seconds: 1 },
    attempts,
  });

  it("puts the chore first, whatever the ids and the attempts say", () => {
    const order = { fresh_first: true };
    const got = ordered([cand(1, "task"), cand(9, "chore", 3)], order);
    expect(got.map((c) => [kindOf(c), c.id])).toEqual([
      ["chore", 9],
      ["task", 1],
    ]);
  });

  it("does not tie a chore and a task that share an id", () => {
    const got = ordered([cand(3, "task"), cand(3, "chore")], { fresh_first: true });
    expect(got.map(kindOf)).toEqual(["chore", "task"]);
  });

  it("still orders chores among themselves by id, and tasks by attempts", () => {
    const got = ordered(
      [cand(2, "task", 1), cand(1, "task", 4), cand(7, "chore"), cand(5, "chore")],
      { fresh_first: true },
    );
    expect(got.map((c) => `${kindOf(c)}#${c.id}`)).toEqual(["chore#5", "chore#7", "task#2", "task#1"]);
  });
});
