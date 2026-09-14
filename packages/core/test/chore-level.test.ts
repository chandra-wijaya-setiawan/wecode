import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyChore,
  board,
  CHORE_KIND_DEFS,
  choreAttempts,
  choreById,
  choreCandidates,
  choreRefusal,
  closeChore,
  ensureChore,
  reraiseChore,
} from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** docs/design/18. A chore row was being kept as a memo about the past.
 *
 *  Story 139's branch merged cleanly, chore 2 was discharged, and then story 138 landed and
 *  the branch was behind the base again — `git merge-base --is-ancestor` said so and
 *  `wecode land` refused. Chore 2 sat `done` with nothing raised, because `ensureChore`
 *  re-raised only from `failed`. Story 192 is the same bug the other way round: chore 3
 *  stayed `failed` after story 152's branch became mergeable, because the runner rightly
 *  stopped calling `ensureChore` and nothing closed a chore whose reason had gone.
 *
 *  One rule, both halves: a chore's state is a claim about the world now, and the runner
 *  re-reads the condition every tick. True again re-raises; gone closes. */

const mergeSpec = (project: number, story: number) =>
  ({
    project_id: project,
    kind: "merge",
    target_type: "story",
    target_id: story,
    check: "the branch merges cleanly",
  }) as const;

const attempt = (db: DatabaseSync, id: number, ending: "fail" | "finish"): void => {
  for (const verb of ["start", "begin", ending]) applyChore(db, id, verb, "system-1");
};

/** A chore performed and proved, the way the runner leaves one it discharged. */
const doneChore = (db: DatabaseSync, project: number, story: number): number => {
  const id = ensureChore(db, mergeSpec(project, story)).id;
  attempt(db, id, "finish");
  expect(stateOf(db, "chore", id)).toBe("done");
  return id;
};

/** A chore attempted and refused, the way the runner leaves one whose check would not prove. */
const failedChore = (db: DatabaseSync, project: number, story: number): number => {
  const id = ensureChore(db, mergeSpec(project, story)).id;
  attempt(db, id, "fail");
  expect(stateOf(db, "chore", id)).toBe("failed");
  return id;
};

const verbsFor = (db: DatabaseSync, id: number): string[] =>
  (
    db
      .prepare("SELECT verb FROM ledger WHERE entity = 'chore' AND entity_id = ? ORDER BY id")
      .all(id) as unknown as { verb: string }[]
  ).map((r) => r.verb);

const roles = {
  roles: { system: { scope: { write: ["**"], tools: ["bash"] }, budget: { tokens: 1, seconds: 1 } } },
} as never;

describe("a done chore whose condition has come back", () => {
  it("is raised again, as the same chore, back in planned", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = doneChore(db, project, story);

    // Story 138 landed; the runner re-read the condition and it is true again.
    const again = ensureChore(db, mergeSpec(project, story));

    expect(again.id).toBe(id);
    expect(again.state).toBe("planned");
  });

  it("keeps the attempts, so the board shows a second pass and not a new chore", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = doneChore(db, project, story);

    ensureChore(db, mergeSpec(project, story));

    expect(choreAttempts(db, id)?.attempts).toBe(1);
    expect(board(db).chores).toHaveLength(1);
    expect(board(db).chores[0]).toMatchObject({
      id,
      state: "planned",
      detail: `attempt 2 of ${CHORE_KIND_DEFS.merge.max_retry} · the branch merges cleanly`,
    });
  });

  it("says it came back on the ledger, from done, in the runner's name", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = doneChore(db, project, story);

    ensureChore(db, mergeSpec(project, story), "runner");

    expect(
      db
        .prepare("SELECT verb, from_state, to_state, actor FROM ledger WHERE entity = 'chore' AND entity_id = ? ORDER BY id")
        .all(id)
        .at(-1),
    ).toMatchObject({ verb: "reprove", from_state: "done", to_state: "planned", actor: "runner" });
  });

  it("is a candidate again, with the attempt it has already had", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    doneChore(db, project, story);
    ensureChore(db, mergeSpec(project, story));

    const { candidates } = choreCandidates(db, roles);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.attempts).toBe(1);
  });
});

describe("a failed chore whose condition has come back", () => {
  it("is raised again too, because it is the same rule", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);

    const again = ensureChore(db, mergeSpec(project, story));

    expect(again.id).toBe(id);
    expect(again.state).toBe("planned");
    expect(verbsFor(db, id)).toEqual(["start", "begin", "fail", "reprove"]);
  });
});

describe("a chore whose condition has gone", () => {
  it("is closed, with the reason, rather than sitting as a stale claim", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);

    // Somebody rebased the branch by hand. The condition is false, so nothing is owed.
    const out = closeChore(db, id, "reset merges into main now", "runner");

    expect(out.ok).toBe(true);
    expect(out.ok && out).toMatchObject({ from: "failed", to: "done" });
    expect(stateOf(db, "chore", id)).toBe("done");
    expect(verbsFor(db, id).at(-1)).toBe("close");
    expect(choreRefusal(db, id)?.why).toBe("reset merges into main now");
  });

  it("leaves the board and the allocator, because there is nothing to hand out", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);

    closeChore(db, id, "reset merges into main now");

    expect(board(db).chores).toEqual([]);
    expect(choreCandidates(db, roles)).toEqual({ candidates: [], refused: [] });
  });

  it("closes a chore nobody ever attempted, from planned", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;

    expect(closeChore(db, id, "reset merges into main now").ok).toBe(true);
    expect(stateOf(db, "chore", id)).toBe("done");
  });

  it("refuses to close one a worker is in a tree on: that attempt says how it ended", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;
    applyChore(db, id, "start", "runner");
    applyChore(db, id, "begin", "system-1");

    const refused = closeChore(db, id, "reset merges into main now");

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toContain("close is not legal from running");
    expect(stateOf(db, "chore", id)).toBe("running");
  });

  it("and is raised again cleanly if the condition comes back after the close", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);
    closeChore(db, id, "reset merges into main now");

    const again = ensureChore(db, mergeSpec(project, story));

    expect(again.id).toBe(id);
    expect(again.state).toBe("planned");
    // The reason it was closed was about a world that has moved on again.
    expect(choreRefusal(db, id)).toBeNull();
  });
});

describe("max_retry, which neither half may loop past", () => {
  const exhaust = (db: DatabaseSync, project: number, story: number): number => {
    const id = failedChore(db, project, story);
    while ((choreAttempts(db, id)?.attempts ?? 0) < CHORE_KIND_DEFS.merge.max_retry) {
      ensureChore(db, mergeSpec(project, story));
      attempt(db, id, "fail");
    }
    return id;
  };

  it("stops raising a chore that keeps failing its check, however true the condition is", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const max = CHORE_KIND_DEFS.merge.max_retry;
    const id = exhaust(db, project, story);

    const after = ensureChore(db, mergeSpec(project, story));

    expect(after.state).toBe("failed");
    expect(choreAttempts(db, id)?.attempts).toBe(max);
    const refused = reraiseChore(db, id);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toBe(`out of attempts · ${max} of ${max}`);
  });

  it("names the drift for the doctor: on the board, and to the allocator", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const max = CHORE_KIND_DEFS.merge.max_retry;
    const id = exhaust(db, project, story);

    const out = `out of attempts · ${max} of ${max}`;
    expect(board(db).chores[0]).toMatchObject({ state: "failed", detail: `${out} · the branch merges cleanly` });
    expect(choreCandidates(db, roles).refused).toEqual([{ id, why: out }]);
  });

  it("still closes one whose condition has gone: attempts bound retries, not whether it is owed", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = exhaust(db, project, story);

    expect(closeChore(db, id, "reset merges into main now").ok).toBe(true);
    expect(choreById(db, id)?.state).toBe("done");
    expect(board(db).chores).toEqual([]);
  });

  it("and a done chore is not re-raised past the ceiling either", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = exhaust(db, project, story);
    closeChore(db, id, "reset merges into main now");

    // The condition comes back, but this chore has spent what its kind allows.
    const again = ensureChore(db, mergeSpec(project, story));

    expect(again.state).toBe("done");
    expect(again.id).toBe(id);
  });
});
