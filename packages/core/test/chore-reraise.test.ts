import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyChore,
  board,
  CHORE_KIND_DEFS,
  choreAttempts,
  choreById,
  choreCandidates,
  ensureChore,
  reraiseChore,
} from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

/** docs/design/18. A failed chore was a dead end: `ensureChore` is keyed on the condition,
 *  so the runner that saw the condition again found the failed row and returned it. Chore 3
 *  for story 152 sat that way — the base had moved mid-flight, the branch was still behind
 *  it, and no chore came back. The way back is `reprove`, and the condition being true is
 *  what applies it: the runner only calls `ensureChore` when it has just re-read it. */

const mergeSpec = (project: number, story: number) =>
  ({
    project_id: project,
    kind: "merge",
    target_type: "story",
    target_id: story,
    check: "the branch merges cleanly",
  }) as const;

/** A chore that has been attempted and failed, the way the runner leaves one. */
const failedChore = (db: DatabaseSync, project: number, story: number): number => {
  const id = ensureChore(db, mergeSpec(project, story)).id;
  for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");
  expect(stateOf(db, "chore", id)).toBe("failed");
  return id;
};

const ledgerFor = (db: DatabaseSync, id: number) =>
  db
    .prepare("SELECT verb, from_state, to_state, actor FROM ledger WHERE entity = 'chore' AND entity_id = ? ORDER BY id")
    .all(id) as unknown as { verb: string; from_state: string; to_state: string; actor: string }[];

describe("a failed chore whose condition still holds", () => {
  it("is raised again, as the same chore, back in planned", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);

    // The runner has re-read the condition and it is still true. That is what this call is.
    const again = ensureChore(db, mergeSpec(project, story));

    expect(again.id).toBe(id);
    expect(again.state).toBe("planned");
  });

  it("says why it is back, on the ledger, in the runner's name", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);

    ensureChore(db, mergeSpec(project, story), "runner");

    expect(ledgerFor(db, id).at(-1)).toMatchObject({
      verb: "reprove",
      from_state: "failed",
      to_state: "planned",
      actor: "runner",
    });
  });

  it("is a candidate again, and the allocator sees the attempt it has already had", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    failedChore(db, project, story);
    ensureChore(db, mergeSpec(project, story));

    const roles = { roles: { system: { scope: { write: ["**"], tools: ["bash"] }, budget: { tokens: 1, seconds: 1 } } } };
    const { candidates } = choreCandidates(db, roles as never);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.attempts).toBe(1);
  });
});

describe("a failed chore whose condition has gone", () => {
  it("is left alone: nothing raises it, because nothing asked for it", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);

    // No `ensureChore`: the merge went in by hand, so the runner never re-reads a condition
    // that is no longer true. The chore stays exactly where the failure left it.
    expect(stateOf(db, "chore", id)).toBe("failed");
    expect(ledgerFor(db, id).map((r) => r.verb)).toEqual(["start", "begin", "fail"]);
  });

  it("and reraise refuses on its own, for a chore that is not failed", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = ensureChore(db, mergeSpec(project, story)).id;

    const refused = reraiseChore(db, id, "runner");

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toBe("a planned chore is not waiting to be raised again");
    expect(stateOf(db, "chore", id)).toBe("planned");
  });
});

describe("the number of attempts is on the record", () => {
  it("counts one per attempt begun, against the kind's ceiling", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);

    expect(choreAttempts(db, id)).toEqual({ attempts: 1, max_retry: CHORE_KIND_DEFS.merge.max_retry });

    ensureChore(db, mergeSpec(project, story));
    for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");

    expect(choreAttempts(db, id)?.attempts).toBe(2);
  });

  it("shows on the board as a chore on its second attempt, not a fresh one", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    failedChore(db, project, story);
    ensureChore(db, mergeSpec(project, story));

    expect(board(db).chores[0]).toMatchObject({
      state: "planned",
      detail: `attempt 2 of ${CHORE_KIND_DEFS.merge.max_retry} · the branch merges cleanly`,
    });
  });

  it("says nothing about attempts on the first one", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    ensureChore(db, mergeSpec(project, story));

    expect(board(db).chores[0]?.detail).toBe("the branch merges cleanly");
  });
});

describe("max_retry, the way a task respects it", () => {
  it("stops raising a chore that has failed its check its kind's number of times", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);
    const max = CHORE_KIND_DEFS.merge.max_retry;

    // Round and round until the attempts are used. The condition is true every time.
    while ((choreAttempts(db, id)?.attempts ?? 0) < max) {
      expect(ensureChore(db, mergeSpec(project, story)).state).toBe("planned");
      for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");
    }

    // The condition is still true, and the answer is no. Not an infinite loop — a record.
    const after = ensureChore(db, mergeSpec(project, story));

    expect(after.state).toBe("failed");
    expect(choreById(db, id)?.state).toBe("failed");
    expect(choreAttempts(db, id)?.attempts).toBe(max);
    expect(!reraiseChore(db, id).ok).toBe(true);
  });

  it("names the drift rather than hiding it: on the board, and to the allocator", () => {
    const db = freshDb();
    const { project, story } = seed(db);
    const id = failedChore(db, project, story);
    const max = CHORE_KIND_DEFS.merge.max_retry;
    while ((choreAttempts(db, id)?.attempts ?? 0) < max) {
      ensureChore(db, mergeSpec(project, story));
      for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");
    }

    const out = `out of attempts · ${max} of ${max}`;
    expect(board(db).chores[0]).toMatchObject({ state: "failed", detail: `${out} · the branch merges cleanly` });

    const roles = { roles: { system: { scope: { write: ["**"], tools: ["bash"] }, budget: { tokens: 1, seconds: 1 } } } };
    const { candidates, refused } = choreCandidates(db, roles as never);

    expect(candidates).toEqual([]);
    expect(refused).toEqual([{ id, why: out }]);
  });
});
