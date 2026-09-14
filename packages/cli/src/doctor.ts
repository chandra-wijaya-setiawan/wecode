import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checkRecord, currentDatabase, now, type RecordNode, type Snapshot, type Violation } from "@wecode/core";

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
function snapshot(db: DatabaseSync): Snapshot {
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
  try {
    violations = checkRecord(snapshot(db));
    if (heal) {
      process.stdout.write(healed(healLandedMarkers(db, violations, gitIn(repoOf(db)))));
      // What is reported afterwards is what the heal could not settle, refusals included.
      violations = checkRecord(snapshot(db));
    }
  } finally {
    db.close();
  }

  // A record that holds says nothing at all. A doctor that printed "all well" would be
  // noise on every tick of the thing that runs it.
  if (violations.length === 0) return 0;

  process.stdout.write(report(violations));
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
function report(violations: readonly Violation[]): string {
  const groups = new Map<string, Violation[]>();
  for (const v of violations) groups.set(v.invariant, [...(groups.get(v.invariant) ?? []), v]);

  const lines: string[] = [];
  for (const [name, found] of groups) {
    lines.push(name);
    // A violation with no id is not a row — `role` names a role nobody fills — so it is
    // named by its slug alone rather than by a `#null` nobody could go and look at.
    for (const v of found) {
      lines.push(`  ${v.entity}${v.id === null ? "" : ` #${v.id}`} ${v.slug} — ${v.detail}`);
    }
    lines.push("");
  }
  const what = violations.length === 1 ? "1 entity" : `${violations.length} entities`;
  const how = groups.size === 1 ? "1 invariant" : `${groups.size} invariants`;
  lines.push(`${what} breaking ${how}\n`);
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
 *  A copy of `packages/runner/src/doctor.ts`, like `snapshot` above it: `@wecode/cli`
 *  depends on `@wecode/core` alone and cannot import the runner. The two are pinned
 *  identical by `packages/runner/test/backfill-landed.test.ts`, which runs both. */

/** git, read-only, as the heal is allowed to see it: argv in, stdout out. */
export type Git = (args: readonly string[]) => string;

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

export interface HealReport {
  readonly written: readonly Backfilled[];
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
  const left: LeftAlone[] = [];
  for (const v of found) {
    if (v.invariant !== "delivered_story_has_landed" || v.id === null) continue;
    const shas = landCommits(git, base, v.slug);
    const why = refusal(shas.length, base, v.slug) ?? emptyStory(db, v.id);
    if (why !== null) {
      left.push({ story: v.id, slug: v.slug, why });
      continue;
    }
    writeMarker(db, v.id, v.slug, shas[0] as string);
    written.push({ story: v.id, slug: v.slug, sha: shas[0] as string });
  }
  return { written, left };
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
