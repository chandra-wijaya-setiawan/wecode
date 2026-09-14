import {
  INVARIANTS,
  keepUnlanded,
  now,
  REACHED_INSIDE_ANOTHER_MERGE,
  storyBranch,
  type Ancestry,
  type RecordNode,
  type Snapshot,
  type Violation,
} from "@wecode/core";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

/** docs/design/19, the check, on the runner's tick.
 *
 *  The invariant set is core's and is run here once a tick. What comes back is written to
 *  one runner-owned table so a view can say what drifted without running eight queries of
 *  its own. Nothing else is written: no entity is touched, no state moves, no chore is
 *  proposed. Healing is the next slice, and this one is allowed to be wrong in public.
 *
 *  A doctor failure never stops a tick. The work of the tick is the point; a check that
 *  could take the runner down with it would be a worse problem than the drift it looks
 *  for, so every invariant runs inside its own boundary and a throw becomes a line in the
 *  report rather than an exception in the caller. */

/** One invariant: the sentence and the function that finds who breaks it. */
export interface Invariant {
  readonly name: string;
  readonly check: (s: Snapshot) => readonly Violation[];
}

/** Where each entity's row lives and what its parent key is called. The one place in the
 *  runner that knows the shape of the tables; the invariants see only flattened nodes. */
const TABLES: readonly { entity: RecordNode["entity"]; fk: string; extra?: string }[] = [
  { entity: "release", fk: "NULL" },
  { entity: "epic", fk: "release_id" },
  { entity: "story", fk: "epic_id" },
  { entity: "requirement", fk: "story_id" },
  { entity: "acceptance_criteria", fk: "requirement_id" },
  { entity: "acceptance_test", fk: "parent_id", extra: ", red_at_base_sha" },
  { entity: "task", fk: "acceptance_test_id", extra: ", role" },
  { entity: "task_test", fk: "parent_id" },
];

const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !== undefined;

/** The story a task belongs to, landed: `landed_branch` is the lander's own table, keyed
 *  by task, so a story is landed when something under it is recorded as merged. */
function landedShas(db: DatabaseSync): Map<number, string> {
  if (!hasTable(db, "landed_branch")) return new Map();
  const rows = db
    .prepare(
      `SELECT q.story_id AS story_id, b.sha AS sha
         FROM landed_branch b
         JOIN task t ON t.id = b.task_id
         JOIN acceptance_test a ON a.id = t.acceptance_test_id
         JOIN acceptance_criteria c ON c.id = a.parent_id
         JOIN requirement q ON q.id = c.requirement_id`,
    )
    .all() as unknown as { story_id: number; sha: string }[];
  return new Map(rows.map((r) => [r.story_id, r.sha]));
}

/** One plain object, no live handle: everything the invariants are allowed to see. */
export function snapshot(db: DatabaseSync): Snapshot {
  const landed = landedShas(db);
  const nodes = TABLES.flatMap(({ entity, fk, extra }) => {
    const rows = db
      .prepare(`SELECT id, slug, state, ${fk} AS parent_id${extra ?? ""} FROM ${entity} ORDER BY id`)
      .all() as unknown as Omit<RecordNode, "entity">[];
    // The table it came from is what the entity is; sqlite does not carry it on the row.
    return rows.map((n) =>
      entity === "story" ? { ...n, entity, landed_sha: landed.get(n.id) ?? null } : { ...n, entity },
    );
  });
  const workers = db.prepare("SELECT slug, role FROM worker ORDER BY id").all() as unknown as {
    slug: string;
    role: string;
  }[];
  const version = hasTable(db, "schema_version")
    ? (db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)
    : undefined;
  return { nodes, workers, schema_version: version?.version ?? 0 };
}

/** The check, wired to a record.
 *
 *  Runner-owned, like `landed_branch`: the ledger says what is true of the work, this says
 *  what this pass observed about it. Rewritten whole every tick, because a violation that
 *  has been fixed is not history worth keeping — the record is. */
export class Doctor {
  constructor(
    private readonly db: DatabaseSync,
    /** Defaults to core's set. A caller passes its own only to test the boundary itself:
     *  the point being proven is that one bad check cannot take the tick with it. */
    private readonly invariants: readonly Invariant[] = INVARIANTS,
    /** How the ancestry question gets asked. The runner is the half that may read the
     *  world, so `delivered_story_has_landed` is only ever reported here after git has
     *  been asked whether the branch is in the base. */
    private readonly git: Git = gitIn(repoOf(db)),
    private readonly base = "HEAD",
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS doctor_violation (
         invariant TEXT    NOT NULL,
         entity    TEXT    NOT NULL,
         entity_id INTEGER,
         slug      TEXT    NOT NULL,
         detail    TEXT    NOT NULL,
         found_at  TEXT    NOT NULL
       )`,
    );
  }

  /** One pass. Returns what it found and records the same, and throws for nothing. */
  check(): readonly Violation[] {
    const found = this.run();
    try {
      this.record(found);
    } catch {
      // The report is worth less than the tick. A table that could not be written is drift
      // of its own, and the next pass rewrites it whole anyway.
    }
    return found;
  }

  /** Each invariant inside its own boundary. A check that throws is not silently dropped:
   *  it becomes a violation naming itself, because an invariant nobody can evaluate is a
   *  thing a person needs to see as much as one that failed. */
  private run(): readonly Violation[] {
    let s: Snapshot;
    try {
      s = snapshot(this.db);
    } catch (err) {
      return [broken("snapshot", err)];
    }
    const found = this.invariants.flatMap((i) => {
      try {
        return i.check(s);
      } catch (err) {
        return [broken(i.name, err)];
      }
    });
    try {
      return keepUnlanded(found, ancestryOf(this.git, this.base));
    } catch (err) {
      // git could not be asked. The worst case is what core already said, and a report
      // that over-accuses is better than a tick that dies of a missing repository.
      return [...found, broken("delivered_story_has_landed", err)];
    }
  }

  /** Replaced, not appended: the answer to "what is wrong now" is this pass and only this
   *  pass. One transaction, so a view never reads half a report. */
  private record(found: readonly Violation[]): void {
    const at = now();
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM doctor_violation");
      const insert = this.db.prepare(
        `INSERT INTO doctor_violation (invariant, entity, entity_id, slug, detail, found_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const v of found) insert.run(v.invariant, v.entity, v.id, v.slug, v.detail, at);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** docs/design/19, the healing, and one fix of it.
 *
 *  `delivered_story_has_landed` has been broken for five stories that did land: the marker
 *  is written only on the path that merges from now on, and theirs merged before that path
 *  existed. Their land commits are in the base, one each, subject `land story/<slug>`, so
 *  the sha is not guessed — it is read off the world and copied onto the record.
 *
 *  Read-only on git, additive on the record, and a ledger line for every marker written.
 *  The ambiguous cases are refused rather than resolved: no such commit, or more than one,
 *  is drift to report. A heal that picked one of two commits would be inventing the answer,
 *  and an unexplained fix is worse than visible drift. */

/** git, read-only, as the heal is allowed to see it: argv in, stdout out. */
export type Git = (args: readonly string[]) => string;

/** The repository the record names, as `wecode land` sees it. */
function repoOf(db: DatabaseSync): string {
  const row = db.prepare("SELECT repo FROM project ORDER BY id").get() as { repo: string } | undefined;
  return row?.repo ?? process.cwd();
}

const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Is the branch in the base? Asked as `rev-list branch ^base` rather than as
 *  `merge-base --is-ancestor`, because this git speaks in stdout and not in exit codes:
 *  nothing on the branch that the base does not already have is what being in means.
 *  A ref nobody can resolve is the story with no branch at all. */
export const ancestryOf =
  (git: Git, base: string) =>
  (branch: string): Ancestry => {
    try {
      return git(["rev-list", "--count", branch, `^${base}`]).trim() === "0" ? "in" : "out";
    } catch {
      return "no-branch";
    }
  };

/** A marker written, and the commit it was read from. */
export interface Backfilled {
  readonly story: number;
  readonly slug: string;
  readonly sha: string;
}

/** A drift the heal would not touch, and the sentence saying why. */
export interface LeftAlone {
  readonly story: number;
  readonly slug: string;
  readonly why: string;
}

/** A story that is in the base with no commit of its own to name. */
export interface Reached {
  readonly story: number;
  readonly slug: string;
}

export interface HealReport {
  readonly written: readonly Backfilled[];
  /** In the base inside another story's merge: no marker to write, and no drift either. */
  readonly reached: readonly Reached[];
  readonly left: readonly LeftAlone[];
}

/** The safe heal for `delivered_story_has_landed`, applied to what a check already found.
 *
 *  The check is the other half and stays the other half: this takes its violations as an
 *  argument rather than running a pass of its own, so nothing here can change what was
 *  reported. */
export function healLandedMarkers(
  db: DatabaseSync,
  found: readonly Violation[],
  git: Git,
  base = "HEAD",
): HealReport {
  const written: Backfilled[] = [];
  const reached: Reached[] = [];
  const left: LeftAlone[] = [];
  for (const v of found) {
    if (v.invariant !== "delivered_story_has_landed" || v.id === null) continue;
    const shas = landCommits(git, base, v.slug);
    const why = refusal(shas.length, base, v.slug) ?? emptyStory(db, v.id);
    if (why === null) {
      writeMarker(db, v.id, v.slug, shas[0] as string);
      written.push({ story: v.id, slug: v.slug, sha: shas[0] as string });
      continue;
    }
    // No commit to copy, but the branch is in: the story did reach the base, inside
    // somebody else's merge. There is no sha that is the answer, so the ledger carries
    // what is true and the marker stays empty.
    if (ancestryOf(git, base)(storyBranch(v.slug)) === "in") {
      writeReached(db, v.id);
      reached.push({ story: v.id, slug: v.slug });
      continue;
    }
    left.push({ story: v.id, slug: v.slug, why });
  }
  return { written, reached, left };
}

/** The ledger line for a story that is in the base with nothing to name. Said once: a
 *  second heal of the same story would be the same sentence again, and the fact it records
 *  is git's, not the record's. */
function writeReached(db: DatabaseSync, story: number): void {
  const said = db
    .prepare("SELECT 1 FROM ledger WHERE entity = 'story' AND entity_id = ? AND verb = 'heal' AND to_state = ?")
    .get(story, REACHED_INSIDE_ANOTHER_MERGE);
  if (said !== undefined) return;
  db.prepare(
    `INSERT INTO ledger (entity, entity_id, verb, from_state, to_state, actor, at)
     VALUES ('story', ?, 'heal', ?, ?, 'doctor', ?)`,
  ).run(story, `no landed marker`, REACHED_INSIDE_ANOTHER_MERGE, now());
}

/** Commits in the base whose subject is exactly `land story/<slug>`. `--grep` narrows, the
 *  comparison decides: a grep is a substring match, and `land story/a` is a substring of
 *  `land story/ab`. */
function landCommits(git: Git, base: string, slug: string): readonly string[] {
  const subject = `land story/${slug}`;
  const out = git(["log", "--format=%H%x1f%s", "--fixed-strings", `--grep=${subject}`, base]);
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\x1f"))
    .filter(([, s]) => s === subject)
    .map(([h]) => h as string);
}

/** Nothing to copy, or two things to choose between. Both are drift a person settles. */
const refusal = (n: number, base: string, slug: string): string | null =>
  n === 1 ? null : `${n === 0 ? "no commit" : `${n} commits`} in ${base} with subject 'land story/${slug}'`;

/** The marker hangs off the story's tasks, so a story with none has nowhere to carry it.
 *  That is drift of its own shape, and not this heal's to fix. */
function emptyStory(db: DatabaseSync, story: number): string | null {
  return tasksOf(db, story).length === 0 ? "no task under the story to carry the marker" : null;
}

function tasksOf(db: DatabaseSync, story: number): readonly number[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id FROM task t
         JOIN acceptance_test a ON a.id = t.acceptance_test_id
         JOIN acceptance_criteria c ON c.id = a.parent_id
         JOIN requirement q ON q.id = c.requirement_id
        WHERE q.story_id = ?`,
    )
    .all(story) as unknown as { id: number }[];
  return rows.map((r) => r.id);
}

/** The marker the lander writes, written the same way, plus the line that says it was the
 *  doctor who wrote it and what it read the sha off. One transaction: a marker with no
 *  ledger line behind it is exactly the unexplained fix 19 forbids. */
function writeMarker(db: DatabaseSync, story: number, slug: string, sha: string): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  const at = now();
  db.exec("BEGIN");
  try {
    const insert = db.prepare(
      `INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET branch = excluded.branch, sha = excluded.sha,
                                             merged_at = excluded.merged_at`,
    );
    for (const task of tasksOf(db, story)) insert.run(task, `story/${slug}`, sha, at);
    db.prepare(
      `INSERT INTO ledger (entity, entity_id, verb, from_state, to_state, actor, at)
       VALUES ('story', ?, 'heal', ?, ?, 'doctor', ?)`,
    ).run(story, `no landed marker`, `landed_sha ${sha} from 'land story/${slug}'`, at);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** A check that could not be run, said out loud in the shape of the thing it failed to be. */
const broken = (name: string, err: unknown): Violation => ({
  invariant: name,
  entity: "invariant",
  id: null,
  slug: name,
  detail: `the check itself failed: ${(err as Error).message}`,
});

/** What a view reads. The last pass, in the order it was found. */
export function violations(db: DatabaseSync): readonly Violation[] {
  if (!hasTable(db, "doctor_violation")) return [];
  const rows = db
    .prepare("SELECT invariant, entity, entity_id, slug, detail FROM doctor_violation ORDER BY rowid")
    .all() as unknown as { invariant: string; entity: string; entity_id: number | null; slug: string; detail: string }[];
  return rows.map((r) => ({ invariant: r.invariant, entity: r.entity, id: r.entity_id, slug: r.slug, detail: r.detail }));
}
