import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  currentDatabase,
  INVARIANTS,
  keepUnlanded,
  now,
  storyBranch,
  REACHED_INSIDE_ANOTHER_MERGE,
  type Ancestry,
  type RecordNode,
  type Snapshot,
  type Violation,
} from "@wecode/core";

/** Where each entity's row lives and what its parent key is called. The one place in the
 *  doctor that knows the shape of the tables; the invariants themselves see only the
 *  flattened nodes. */
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

/** A workspace that has never landed anything has no `landed_branch` table beside the
 *  record, and that is not drift — it is a record with nothing observed against it. */
const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !== undefined;

/** The story a task belongs to, landed: `landed_branch` is the lander's own table, keyed by
 *  task, so a story is landed when something under it is recorded as merged. That sha is
 *  what `delivered_story_has_landed` reads off the story node. */
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

/** `wecode doctor` — one pass of the invariants, read only.
 *  `wecode doctor --heal` — the same pass, and then the safe fixes.
 *
 *  docs/design/19's two halves, kept apart: without the flag it reads and reports, and the
 *  database is opened read-only so that is true by construction rather than by care — in
 *  particular it is never migrated, because a doctor that upgraded the file it was
 *  inspecting would repair the one drift it is meant to report.
 *
 *  The pass is `runChecks`, the same one the tick runs, so the command's answer is the
 *  tick's answer: core's pure set, and then the one check that has to ask git. A workspace
 *  with no repository to hand is not an error — every other check still reports, and the
 *  output says which check went unanswered rather than passing its worst case off as a fact.
 *
 *  Non-zero when anything is still broken, so a script can gate on it. */
export function doctor(args: readonly string[]): number {
  const heal = args.includes("--heal");
  const path = args.find((a) => !a.startsWith("--")) ?? currentDatabase();
  if (!existsSync(path)) {
    process.stderr.write(`no workspace at ${path} — wecode init\n`);
    return 1;
  }

  const db = new DatabaseSync(path, heal ? {} : { readOnly: true });
  let violations: readonly Violation[];
  let world: World;
  try {
    world = worldOf(gitIn(repoOf(db)));
    violations = runChecks(snapshot(db), world);
    if (heal) {
      process.stdout.write(healed(healLandedMarkers(db, violations, gitIn(repoOf(db)))));
      // What is reported afterwards is what the heal could not settle, refusals included.
      violations = runChecks(snapshot(db), world);
    }
  } finally {
    db.close();
  }

  // A record that holds says nothing at all. A doctor that printed "all well" would be
  // noise on every tick of the thing that runs it.
  if (violations.length === 0) return 0;

  process.stdout.write(report(violations, world));
  return 1;
}

/** What was written, said out loud. The ledger has the same lines; this is for the person
 *  standing at the terminal, who should not have to query to find out what just changed. */
function healed(h: HealReport): string {
  if (h.written.length === 0) return "";
  const lines = h.written.map(
    (w) => `  story #${w.story} ${w.slug} — landed_sha ${w.sha.slice(0, 12)} from 'land story/${w.slug}'`,
  );
  return `healed delivered_story_has_landed\n${lines.join("\n")}\n\n`;
}

/** The repository the record names. `wecode land` merges into the branch you have checked
 *  out, so the commit a heal is looking for is on this repository's HEAD. */
function repoOf(db: DatabaseSync): string {
  const row = db.prepare("SELECT repo FROM project ORDER BY id").get() as { repo: string } | undefined;
  return row?.repo ?? process.cwd();
}

const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Grouped by invariant, because the invariant is the sentence that was broken and the
 *  entities are the evidence for it. Ungrouped, the same drift on forty rows reads as
 *  forty problems. */
function report(violations: readonly Violation[], world: World): string {
  const groups = new Map<string, Violation[]>();
  for (const v of violations) groups.set(v.invariant, [...(groups.get(v.invariant) ?? []), v]);
  const needsGit = new Set(checksOf().filter((c) => c.world).map((c) => c.name));

  const lines: string[] = [];
  for (const [name, found] of groups) {
    // Which checks had to ask the world, said on the line that names them: the reader is
    // owed the difference between "the record says so" and "git was asked and agreed".
    lines.push(needsGit.has(name) ? `${name} (asked git)` : name);
    // A violation with no id is not a row — `role` names a role nobody fills — so it is
    // named by its slug alone rather than by a `#null` nobody could go and look at.
    for (const v of found) {
      lines.push(`  ${v.entity}${v.id === null ? "" : ` #${v.id}`} ${v.slug} — ${v.detail}`);
    }
    lines.push("");
  }
  const what = violations.length === 1 ? "1 entity" : `${violations.length} entities`;
  const how = groups.size === 1 ? "1 invariant" : `${groups.size} invariants`;
  lines.push(`${what} breaking ${how}`);
  // No repository to hand is not an error — the rest of the pass is above. It is only the
  // git-answered checks that are unproven here, and saying so is cheaper than a reader
  // believing an accusation nothing confirmed.
  if (!world.reachable) {
    lines.push(`no repository to ask — unanswered: ${[...needsGit].join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
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
 *  and an unexplained fix is worse than visible drift.
 *
 *  A copy of `packages/runner/src/doctor.ts`, like `snapshot` and `runChecks` above it:
 *  `@wecode/cli` depends on `@wecode/core` alone and cannot import the runner. The two are
 *  pinned identical by `packages/runner/test/backfill-landed.test.ts`, which runs both
 *  heals, and by `packages/cli/test/doctor-parity.test.ts`, which runs both passes over one
 *  database and compares the checks each of them declares. */

/** git, read-only, as the heal is allowed to see it: argv in, stdout out. */
export type Git = (args: readonly string[]) => string;

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

/** The one check that cannot be answered from the record alone. Named once in each copy, so
 *  "which checks needed git" is a fact both halves read off the same sentence rather than a
 *  habit each of them has. */
export const WORLD_CHECK = "delivered_story_has_landed";

/** Every check a pass runs, and which of them has to ask the world. Core owns the pure set;
 *  this column is the half that may read git. A copy that gained a check the other could not
 *  see would differ here, which is what `packages/cli/test/doctor-parity.test.ts` reads. */
export const checksOf = (
  invariants: readonly Invariant[] = INVARIANTS,
): readonly { readonly name: string; readonly world: boolean }[] =>
  invariants.map((i) => ({ name: i.name, world: i.name === WORLD_CHECK }));

/** One invariant: the sentence and the function that finds who breaks it. */
export interface Invariant {
  readonly name: string;
  readonly check: (s: Snapshot) => readonly Violation[];
}

/** git as the checks are allowed to see it, and whether it was there to be asked at all.
 *  The two are separate facts: with no repository to hand every branch answers `no-branch`,
 *  which is indistinguishable from a story that never had one, so the pass carries the
 *  difference instead of letting the report imply the stronger claim. */
export interface World {
  readonly ancestry: (branch: string) => Ancestry;
  readonly reachable: boolean;
}

export function worldOf(git: Git, base = "HEAD"): World {
  let reachable = true;
  try {
    git(["rev-parse", "--verify", base]);
  } catch {
    reachable = false;
  }
  return { ancestry: ancestryOf(git, base), reachable };
}

/** One pass: core's pure set, each check inside its own boundary, then the one question that
 *  needs the world. The tick and `wecode doctor` run exactly this, which is the whole of the
 *  answer the two are supposed to share.
 *
 *  A check that throws is not silently dropped: it becomes a violation naming itself,
 *  because an invariant nobody can evaluate is a thing a person needs to see as much as one
 *  that failed. */
export function runChecks(
  s: Snapshot,
  world: World,
  invariants: readonly Invariant[] = INVARIANTS,
): readonly Violation[] {
  const found = invariants.flatMap((i) => {
    try {
      return i.check(s);
    } catch (err) {
      return [broken(i.name, err)];
    }
  });
  try {
    return keepUnlanded(found, world.ancestry);
  } catch (err) {
    // git could not be asked. The worst case is what core already said, and a report that
    // over-accuses is better than a pass that dies of a missing repository.
    return [...found, broken(WORLD_CHECK, err)];
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
    if (v.invariant !== WORLD_CHECK || v.id === null) continue;
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
