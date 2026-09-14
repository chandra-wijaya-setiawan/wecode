import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./store.js";

/** One entity that breaks an invariant.
 *
 *  `entity` and `id` name the row so a person can go and look at it; `detail` is what was
 *  found, in the row's own words. Nothing here says what to do about it — docs/design/19:
 *  the check reads and reports, and changes nothing. */
export interface Violation {
  readonly entity: string;
  readonly id: number;
  readonly detail: string;
}

/** A sentence a person could check by hand.
 *
 *  `says` is that sentence. The bar from docs/design/19 is that it fits on one line: if it
 *  cannot be explained in one line it is not an invariant, it is an opinion. */
export interface Invariant {
  readonly name: string;
  readonly says: string;
  readonly check: (db: DatabaseSync) => readonly Violation[];
}

export interface Broken {
  readonly invariant: Invariant;
  readonly violations: readonly Violation[];
}

/** A workspace that has never run a runner or a lander has no table beside the record, and
 *  that is not an error — it is a record with nothing observed against it. Every invariant
 *  that reads one of those tables asks first. */
const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !== undefined;

const rows = (db: DatabaseSync, sql: string): Violation[] =>
  db.prepare(sql).all() as unknown as Violation[];

/** The parents that have a success state, and what a child of theirs is called.
 *
 *  Data rather than six copies of one query: the cascade guards are built the same way in
 *  checks.ts, and a copy of this table that drifted would let one parent through. */
const PARENTS: readonly { parent: string; success: string; child: string; fk: string }[] = [
  { parent: "release", success: "released", child: "epic", fk: "release_id" },
  { parent: "epic", success: "delivered", child: "story", fk: "epic_id" },
  { parent: "story", success: "delivered", child: "requirement", fk: "story_id" },
  { parent: "requirement", success: "met", child: "acceptance_criteria", fk: "requirement_id" },
  { parent: "acceptance_criteria", success: "accepted", child: "acceptance_test", fk: "parent_id" },
  { parent: "task", success: "done", child: "task_test", fk: "parent_id" },
];

/** A criteria's tests, and a story's tasks: the walk down the tree, written once. */
const UNDER_STORY_TASK = `task t
  JOIN acceptance_test a ON a.id = t.acceptance_test_id
  JOIN acceptance_criteria c ON c.id = a.parent_id
  JOIN requirement q ON q.id = c.requirement_id`;

/** The invariant set. Pure functions over the record: each opens nothing, runs nothing and
 *  writes nothing, so the same pass is honest from a cli, a runner tick or a test. */
export const INVARIANTS: readonly Invariant[] = [
  {
    name: "schema_version_is_understood",
    says: "the database's schema_version is the one this build understands",
    check: (db) => {
      const row = hasTable(db, "schema_version")
        ? (db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)
        : undefined;
      const found = row?.version ?? 0;
      return found === SCHEMA_VERSION
        ? []
        : [{
            entity: "schema_version",
            id: found,
            detail: `the database is at ${found} and this build understands ${SCHEMA_VERSION}`,
          }];
    },
  },
  {
    name: "delivered_story_has_a_landed_marker",
    says: "a delivered story has a landed marker",
    check: (db) => {
      // `landed_branch` is the lander's own table, keyed by task. A story is landed when
      // something under it is recorded as merged; with no table at all, nothing is.
      const marker = hasTable(db, "landed_branch")
        ? `EXISTS (SELECT 1 FROM landed_branch b
                     JOIN ${UNDER_STORY_TASK}
                    WHERE b.task_id = t.id AND q.story_id = s.id)`
        : "0";
      return rows(
        db,
        `SELECT 'story' AS entity, s.id AS id,
                s.slug || ' is delivered, and nothing recorded it landing' AS detail
           FROM story s
          WHERE s.state = 'delivered' AND NOT ${marker}
          ORDER BY s.id`,
      );
    },
  },
  {
    name: "failing_criteria_has_an_open_task",
    says: "a criteria with a failing acceptance_test has an open task under that test",
    check: (db) =>
      rows(
        db,
        `SELECT 'acceptance_criteria' AS entity, c.id AS id,
                c.slug || ': acceptance_test ' || a.slug || ' #' || a.id
                       || ' is failed and no task under it is open' AS detail
           FROM acceptance_criteria c
           JOIN acceptance_test a ON a.parent_id = c.id
          WHERE a.state = 'failed'
            AND NOT EXISTS (SELECT 1 FROM task t
                             WHERE t.acceptance_test_id = a.id
                               AND t.state IN ('planned', 'ready', 'failed'))
          ORDER BY c.id, a.id`,
      ),
  },
  {
    name: "ready_task_role_has_a_worker",
    says: "a ready task's role has at least one worker",
    check: (db) =>
      rows(
        db,
        `SELECT 'task' AS entity, t.id AS id,
                t.slug || ' is ready under role ' || t.role || ', which has no worker' AS detail
           FROM task t
          WHERE t.state = 'ready'
            AND NOT EXISTS (SELECT 1 FROM worker w WHERE w.role = t.role)
          ORDER BY t.id`,
      ),
  },
  {
    name: "all_children_dropped_is_not_a_success",
    says: "a parent whose every child is dropped is not in a success state",
    check: (db) =>
      PARENTS.flatMap(({ parent, success, child, fk }) =>
        rows(
          db,
          `SELECT '${parent}' AS entity, p.id AS id,
                  p.slug || ' is ${success}, and every one of its ${child} rows is dropped' AS detail
             FROM ${parent} p
            WHERE p.state = '${success}'
              AND EXISTS (SELECT 1 FROM ${child} k WHERE k.${fk} = p.id)
              AND NOT EXISTS (SELECT 1 FROM ${child} k WHERE k.${fk} = p.id AND k.state <> 'dropped')
            ORDER BY p.id`,
        ),
      ),
  },
  {
    name: "in_progress_story_has_work",
    says: "a story in_progress has work under it",
    check: (db) =>
      rows(
        db,
        `SELECT 'story' AS entity, s.id AS id,
                s.slug || ' is in_progress with no task under it' AS detail
           FROM story s
          WHERE s.state = 'in_progress'
            AND NOT EXISTS (SELECT 1 FROM ${UNDER_STORY_TASK} WHERE q.story_id = s.id)
          ORDER BY s.id`,
      ),
  },
];

/** One pass. Reads and reports; changes nothing.
 *
 *  Only the broken ones come back, in the order the set declares them, so a caller that
 *  prints this prints nothing at all for a record that holds. */
export function inspect(db: DatabaseSync): readonly Broken[] {
  return INVARIANTS.map((invariant) => ({ invariant, violations: invariant.check(db) }))
    .filter((b) => b.violations.length > 0);
}
