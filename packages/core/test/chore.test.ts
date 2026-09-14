import { describe, expect, it } from "vitest";
import {
  applyChore,
  approveChore,
  board,
  CHORE_KIND_DEFS,
  CHORE_KINDS,
  CHORE_MACHINE,
  choreById,
  choreFor,
  ensureChore,
  openChores,
} from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

const mergeSpec = (project: number, story: number) =>
  ({
    project_id: project,
    kind: "merge",
    target_type: "story",
    target_id: story,
    check: "the branch merges cleanly",
  }) as const;

const sweepSpec = (project: number) =>
  ({
    project_id: project,
    kind: "sweep",
    target_type: "project",
    target_id: project,
    check: "the lessons are fewer and still say what the originals said",
  }) as const;

describe("the chore record", () => {
  it("holds a kind, a target, a check and a state", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const chore = ensureChore(db, mergeSpec(project, story));

    expect(chore).toMatchObject({
      kind: "merge",
      project_id: project,
      target_type: "story",
      target_id: story,
      check: "the branch merges cleanly",
      state: "planned",
      slug: `merge-story-${story}`,
      approved_at: null,
    });
  });

  it("a condition that is still true is the same chore, not a second one", () => {
    const db = freshDb();
    const { project, story } = seed(db);

    const first = ensureChore(db, mergeSpec(project, story));
    const again = ensureChore(db, mergeSpec(project, story));

    expect(again.id).toBe(first.id);
    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(1);
  });

  it("the same target may carry chores of different kinds", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    ensureChore(db, mergeSpec(project, story));
    ensureChore(db, sweepSpec(project));

    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(2);
  });

  it("is findable by the condition that created it", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const made = ensureChore(db, mergeSpec(project, story));

    expect(choreFor(db, "merge", "story", story)?.id).toBe(made.id);
    expect(choreFor(db, "sweep", "project", project)).toBeNull();
  });

  it("every declared kind names the role that performs it", () => {
    for (const kind of CHORE_KINDS) {
      expect(CHORE_KIND_DEFS[kind].role).toBe("system");
    }
  });
});

describe("the chore machine", () => {
  it("is planned, ready, running, done and failed", () => {
    expect(CHORE_MACHINE.states).toEqual(["planned", "ready", "running", "done", "failed"]);
    expect(CHORE_MACHINE.initial).toBe("planned");
  });

  it("runs a merge chore from planned to done, with no approval anywhere", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;

    expect(applyChore(db, id, "start", "runner").ok).toBe(true);
    expect(stateOf(db, "chore", id)).toBe("ready");
    expect(applyChore(db, id, "begin", "system-1").ok).toBe(true);
    expect(stateOf(db, "chore", id)).toBe("running");
    expect(applyChore(db, id, "finish", "system-1").ok).toBe(true);
    expect(stateOf(db, "chore", id)).toBe("done");
  });

  it("a sweep chore refuses to start without approval", () => {
    const db = freshDb();
    const { project } = seed(db);
    const id = ensureChore(db, sweepSpec(project)).id;

    const refused = applyChore(db, id, "start", "runner");

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toBe("a sweep chore needs approval before it starts");
    expect(stateOf(db, "chore", id)).toBe("planned");
  });

  it("and starts once a person has approved it", () => {
    const db = freshDb();
    const { project } = seed(db);
    const id = ensureChore(db, sweepSpec(project)).id;

    expect(approveChore(db, id, "chandra").ok).toBe(true);
    expect(choreById(db, id)?.approved_by).toBe("chandra");
    // Approving does not start it. It only removes the reason it may not be started.
    expect(stateOf(db, "chore", id)).toBe("planned");

    expect(applyChore(db, id, "start", "runner").ok).toBe(true);
    expect(stateOf(db, "chore", id)).toBe("ready");
  });

  it("refuses to approve a kind that never waits for one", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;

    const refused = approveChore(db, id, "chandra");

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toContain("does not wait for approval");
  });

  it("a failed chore may be retried; a done one is finished with", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;

    applyChore(db, id, "start", "runner");
    applyChore(db, id, "begin", "system-1");
    expect(applyChore(db, id, "fail", "system-1").ok).toBe(true);
    expect(stateOf(db, "chore", id)).toBe("failed");
    expect(applyChore(db, id, "retry", "runner").ok).toBe(true);

    applyChore(db, id, "begin", "system-1");
    applyChore(db, id, "finish", "system-1");
    const after = applyChore(db, id, "begin", "system-1");
    expect(after.ok).toBe(false);
    expect(!after.ok && after.why).toContain("terminal");
  });

  it("says what is legal instead of what is not", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;

    const refused = applyChore(db, id, "finish", "runner");

    expect(!refused.ok && refused.why).toBe("finish is not legal from planned. Legal here: start");
  });

  it("every move is on the ledger, so nothing changed state unobserved", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;
    applyChore(db, id, "start", "runner");

    const rows = db
      .prepare("SELECT verb, from_state, to_state, actor FROM ledger WHERE entity = 'chore' AND entity_id = ?")
      .all(id) as unknown as Record<string, string>[];
    expect(rows).toEqual([{ verb: "start", from_state: "planned", to_state: "ready", actor: "runner" }]);
  });
});

describe("the board", () => {
  it("lists an open chore, as itself, with its kind and its target", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;

    expect(board(db).chores).toEqual([
      { id, what: "merge story password reset", state: "planned", detail: "the branch merges cleanly" },
    ]);
  });

  it("says of a chore waiting for approval that that is what it waits for", () => {
    const db = freshDb();
    const { project } = seed(db);
    ensureChore(db, sweepSpec(project));

    expect(board(db).chores[0]?.detail).toBe("waiting for approval");
  });

  it("drops a chore off the board once it is done", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;
    for (const verb of ["start", "begin", "finish"]) applyChore(db, id, verb, "system-1");

    expect(board(db).chores).toEqual([]);
  });

  it("keeps a failed chore on it: the work is still owed", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;
    for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");

    expect(board(db).chores.map((r) => r.state)).toEqual(["failed"]);
  });

  it("narrows to one project, like every other group", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    ensureChore(db, mergeSpec(project, story));

    expect(openChores(db, project)).toHaveLength(1);
    expect(openChores(db, project + 999)).toEqual([]);
  });
});
