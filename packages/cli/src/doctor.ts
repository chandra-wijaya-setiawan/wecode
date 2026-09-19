import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  currentDatabase,
  doctorRun,
  INVARIANTS,
  keepUnlanded,
  now,
  storyBranch,
  transact,
  REACHED_INSIDE_ANOTHER_MERGE,
  type Ancestry,
  type DoctorRun,
  type RecordNode,
  type Snapshot,
  type Violation,
} from "@wecode/core";
/** Core's public surface does not carry the typed layer, so the one cli import that needs
 *  the dialect names the module it lives in. */
import { excluded, queries, table, type Dialect } from "@wecode/core/dist/db.js";
import { openCodegraph, type RepoIndex } from "@wecode/explorer";
import { checkTree, TREE_INVARIANTS } from "./unimported.js";

/** The columns the doctor reads, and only those. Declared per table rather than built by
 *  interpolating names into a query string, which put an identifier the compiler never saw
 *  into the statement. `typed-doctor.test.ts` holds each list against `PRAGMA table_info`. */
interface Named {
  id: number;
  slug: string;
  state: string;
}
const release = table<Named>("release", ["id", "slug", "state"]);

interface EpicRow extends Named {
  release_id: number;
}
const epic = table<EpicRow>("epic", ["id", "slug", "state", "release_id"]);

interface StoryRow extends Named {
  epic_id: number;
}
const story = table<StoryRow>("story", ["id", "slug", "state", "epic_id"]);

interface RequirementRow extends Named {
  story_id: number;
}
const requirement = table<RequirementRow>("requirement", ["id", "slug", "state", "story_id"]);

interface CriteriaRow extends Named {
  requirement_id: number;
}
const criteria = table<CriteriaRow>("acceptance_criteria", ["id", "slug", "state", "requirement_id"]);

interface AcceptanceTestRow extends Named {
  parent_id: number;
  red_at_base_sha: string | null;
}
const acceptanceTest = table<AcceptanceTestRow>("acceptance_test", [
  "id",
  "slug",
  "state",
  "parent_id",
  "red_at_base_sha",
]);

interface TaskRow extends Named {
  acceptance_test_id: number;
  role: string;
}
const task = table<TaskRow>("task", ["id", "slug", "state", "acceptance_test_id", "role"]);

interface TaskTestRow extends Named {
  parent_id: number;
}
const taskTest = table<TaskTestRow>("task_test", ["id", "slug", "state", "parent_id"]);

const worker = table<{ id: number; slug: string; role: string }>("worker", ["id", "slug", "role"]);
const schemaVersion = table<{ version: number }>("schema_version", ["version"]);
const project = table<{ id: number; repo: string }>("project", ["id", "repo"]);

interface LandedRow {
  task_id: number;
  branch: string;
  sha: string;
  merged_at: string;
}
const landedBranch = table<LandedRow>("landed_branch", ["task_id", "branch", "sha", "merged_at"]);

interface LedgerRow {
  entity: string;
  entity_id: number;
  verb: string;
  from_state: string;
  to_state: string;
  actor: string;
  at: string;
}
const ledger = table<LedgerRow>("ledger", ["entity", "entity_id", "verb", "from_state", "to_state", "actor", "at"]);

/** One row per pass, whatever the pass found. Shape and counting are core's. */
const doctorRuns = table<DoctorRun>("doctor_run", ["at", "duration_ms", "checks_run", "checks_failed"]);

/** sqlite's own catalogue, read like any other table. */
const master = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

/** One node per row, flattened: whatever foreign key the table carries becomes `parent_id`,
 *  the only thing the invariants know about parentage. The dialect spells no aliases, so the
 *  renaming happens here in TypeScript, and a column not in the table above cannot reach the
 *  query at all. Each entry carries the closure that reads its own table rather than a table
 *  name: `Record<entity, TableDef<Row>>` cannot be written, because `columns: (keyof Row)[]`
 *  makes `TableDef` invariant in `Row`. */
type Node = Omit<RecordNode, "entity">;

const NODES: readonly { entity: RecordNode["entity"]; rows: (q: Dialect) => readonly Node[] }[] = [
  // A release's parent is a project, which the invariants do not check: it is a root here.
  { entity: "release", rows: (q) => q.selectFrom(release).all().map((r) => ({ ...r, parent_id: null })) },
  { entity: "epic", rows: (q) => q.selectFrom(epic).all().map(({ release_id, ...r }) => ({ ...r, parent_id: release_id })) },
  { entity: "story", rows: (q) => q.selectFrom(story).all().map(({ epic_id, ...r }) => ({ ...r, parent_id: epic_id })) },
  {
    entity: "requirement",
    rows: (q) => q.selectFrom(requirement).all().map(({ story_id, ...r }) => ({ ...r, parent_id: story_id })),
  },
  {
    entity: "acceptance_criteria",
    rows: (q) => q.selectFrom(criteria).all().map(({ requirement_id, ...r }) => ({ ...r, parent_id: requirement_id })),
  },
  { entity: "acceptance_test", rows: (q) => q.selectFrom(acceptanceTest).all() },
  {
    entity: "task",
    rows: (q) => q.selectFrom(task).all().map(({ acceptance_test_id, ...r }) => ({ ...r, parent_id: acceptance_test_id })),
  },
  { entity: "task_test", rows: (q) => q.selectFrom(taskTest).all() },
];

/** A workspace that has never landed anything has no `landed_branch` table beside the
 *  record, and that is not drift — nothing has been observed against it yet. */
const hasTable = (db: DatabaseSync, name: string): boolean =>
  queries(db)
    .selectFrom(master)
    .select(["type"])
    .where("name", "=", name)
    .all()
    .some((r) => r.type === "table" || r.type === "view");

/** The story each task sits under: what was one four-table query, held as three Maps and
 *  walked in TypeScript, because the dialect composes single-table reads only. A task whose
 *  chain is broken is absent from the result, as it was from the old query. */
function storiesByTask(q: Dialect): Map<number, number> {
  const ofTest = new Map(q.selectFrom(acceptanceTest).select(["id", "parent_id"]).all().map((r) => [r.id, r.parent_id]));
  const ofCriteria = new Map(
    q.selectFrom(criteria).select(["id", "requirement_id"]).all().map((r) => [r.id, r.requirement_id]),
  );
  const ofRequirement = new Map(
    q.selectFrom(requirement).select(["id", "story_id"]).all().map((r) => [r.id, r.story_id]),
  );
  const found = new Map<number, number>();
  for (const t of q.selectFrom(task).select(["id", "acceptance_test_id"]).all()) {
    const c = ofTest.get(t.acceptance_test_id);
    const r = c === undefined ? undefined : ofCriteria.get(c);
    const s = r === undefined ? undefined : ofRequirement.get(r);
    if (s !== undefined) found.set(t.id, s);
  }
  return found;
}

/** `landed_branch` is the lander's own table, keyed by task, so a story is landed when
 *  something under it merged. That sha is what `delivered_story_has_landed` reads. */
function landedShas(db: DatabaseSync): Map<number, string> {
  if (!hasTable(db, "landed_branch")) return new Map();
  const q = queries(db);
  const of = storiesByTask(q);
  const shas = new Map<number, string>();
  for (const b of q.selectFrom(landedBranch).select(["task_id", "sha"]).all()) {
    const s = of.get(b.task_id);
    if (s !== undefined) shas.set(s, b.sha);
  }
  return shas;
}

const byId = <T extends { id: number }>(rows: readonly T[]): readonly T[] => [...rows].sort((a, b) => a.id - b.id);

/** One plain object, no live handle: everything the invariants are allowed to see. Sorted
 *  here rather than by the database — the dialect has no vocabulary for sorting — in the
 *  order the invariants report in, applied to every table alike. */
export function snapshot(db: DatabaseSync): Snapshot {
  const q = queries(db);
  const landed = landedShas(db);
  const nodes = NODES.flatMap(({ entity, rows }) =>
    // The table it came from is what the entity is; sqlite does not carry it on the row.
    byId(rows(q)).map((n) =>
      entity === "story" ? { ...n, entity, landed_sha: landed.get(n.id) ?? null } : { ...n, entity },
    ),
  );
  const workers = byId(q.selectFrom(worker).all()).map((w) => ({ slug: w.slug, role: w.role }));
  const version = hasTable(db, "schema_version") ? q.selectFrom(schemaVersion).get() : null;
  return { nodes, workers, schema_version: version?.version ?? 0 };
}

/** `wecode doctor` — one pass of the invariants, read only.
 *  `wecode doctor --heal` — the same pass, and then the safe fixes.
 *
 *  docs/design/19's two halves, kept apart: without the flag it reads and reports, and the
 *  handle it reads through is opened read-only so that is true by construction — never
 *  migrated, because a doctor that upgraded the file it was inspecting would repair the one
 *  drift it is meant to report. `recordPass` writes only the doctor's own table.
 *
 *  The pass is `runChecks`, the same one the tick runs, so the command's answer is the
 *  tick's answer: core's pure set, and then the one check that has to ask git. A workspace
 *  with no repository to hand is not an error — every other check still reports, and the
 *  output says which check went unanswered rather than passing its worst case off as a fact.
 *
 *  `wecode doctor --tree` — and also the invariants about the source, read through the
 *  repo-explorer port. That half is asked of an index, which cannot be built inside a
 *  function that returns a number: it runs alongside, prints for itself, and settles its
 *  own exit code, and a caller who needs the answer awaits `examined()`. Opt-in because
 *  indexing a repository costs seconds and the tick runs this every time.
 *
 *  Non-zero when anything is still broken, so a script can gate on it. */
export function doctor(args: readonly string[], open: (root: string) => RepoIndex = openCodegraph): number {
  const heal = args.includes("--heal");
  const path = args.find((a) => !a.startsWith("--")) ?? currentDatabase();
  if (!existsSync(path)) {
    process.stderr.write(`no workspace at ${path} — wecode init\n`);
    return 1;
  }

  const db = new DatabaseSync(path, heal ? {} : { readOnly: true });
  const at = now();
  const began = Date.now();
  let violations: readonly Violation[];
  let world: World;
  try {
    const repo = repoOf(db);
    world = worldOf(gitIn(repo));
    if (args.includes("--tree")) examine(repo, entryPoints(args), open);
    violations = runChecks(snapshot(db), world);
    if (heal) {
      process.stdout.write(healed(healLandedMarkers(db, violations, gitIn(repoOf(db)))));
      // What is reported afterwards is what the heal could not settle, refusals included.
      violations = runChecks(snapshot(db), world);
    }
  } finally {
    db.close();
  }
  recordPass(path, roll(violations, world, null), at, Date.now() - began);

  // The roll-call is opt-in for the same reason the silence below is the default: the tick
  // runs this every time and does not need a list of things that held. A person asking
  // `--checks` is asking the opposite question — not "what is broken" but "what was even
  // looked at" — so it prints every check, and marks the ones that did not run and why.
  if (args.includes("--checks")) {
    const say = (tree: readonly Violation[] | null): void => {
      process.stdout.write(rollCall(roll(violations, world, tree)));
    };
    // With `--tree` the tree half's answer is still in flight, and a roll-call printed
    // before it landed would have to guess. It waits instead; nothing else here does.
    if (args.includes("--tree")) examining = examining.then((found) => (say(found), found));
    else say(null);
  }

  // A record that holds says nothing at all. A doctor that printed "all well" would be
  // noise on every tick of the thing that runs it.
  if (violations.length === 0) return 0;

  process.stdout.write(report(violations, world.reachable ? [] : gitAnswered()));
  return 1;
}

/** The pass's own row, appended once the read handle is closed.
 *
 *  A second connection on purpose: the read handle is read-only so a doctor cannot repair
 *  the drift it reports, and that guarantee is worth more than one handle. This one is
 *  opened for this row alone, never migrates, and touches no table the pass read.
 *
 *  The ledger is left alone — a ledger line is something that happened to the *work*, and a
 *  pass that changed nothing did not. The tree half counts as not run: it settles long
 *  after this row, and guessing would be the silent worst case the report refuses.
 *  Migrations predating the table get no row rather than an error. */
function recordPass(path: string, rows: readonly Reported[], at: string, ms: number): void {
  const db = new DatabaseSync(path);
  try {
    if (!hasTable(db, "doctor_run")) return;
    const checks = rows.map((r) => ({ invariant: r.name, ran: r.skipped === null, found: r.found }));
    queries(db).insertInto(doctorRuns, doctorRun(checks, at, ms)).run();
  } finally {
    db.close();
  }
}

/** A check this pass knows about, and what became of it. `skipped` is why it did not run,
 *  null when it did: not the same fact as "found nothing", and an `ok` against a check
 *  nobody ran would be the silent worst case the report refuses elsewhere. */
export interface Reported {
  readonly name: string;
  readonly skipped: string | null;
  /** How many entities it accused. Zero when it ran and held, and zero when it did not run. */
  readonly found: number;
}

/** Why a check went unrun. Two halves can be missing: the world, and the tree's index. */
const NO_REPOSITORY = "no repository to ask";
const TREE_NOT_ASKED = "the tree half was not asked for — --tree";

/** Every check a pass knows, record half and tree half alike, in the order they are run.
 *  `tree` is the tree half's violations, or null when that half did not run — the absence of
 *  a pass, not an empty one, which is exactly the distinction being reported. */
export function roll(
  record: readonly Violation[],
  world: World,
  tree: readonly Violation[] | null,
): readonly Reported[] {
  const count = (found: readonly Violation[], name: string): number =>
    found.filter((v) => v.invariant === name).length;
  return [
    ...checksOf().map((c) => ({
      name: c.name,
      skipped: c.world && !world.reachable ? NO_REPOSITORY : null,
      found: count(record, c.name),
    })),
    ...TREE_INVARIANTS.map((i) => ({
      name: i.name,
      skipped: tree === null ? TREE_NOT_ASKED : null,
      found: tree === null ? 0 : count(tree, i.name),
    })),
  ];
}

/** The roll-call, said out loud. Every check on its own line, whatever it did — the point
 *  of the thing is that a check nobody ran is visible, and silence cannot say that. */
export function rollCall(rows: readonly Reported[]): string {
  const said = (r: Reported): string =>
    r.skipped !== null
      ? `not run — ${r.skipped}`
      : r.found === 0
        ? "held"
        : `broken by ${r.found === 1 ? "1 entity" : `${r.found} entities`}`;
  const lines = rows.map((r) => `  ${r.name} — ${said(r)}`);
  const unrun = rows.filter((r) => r.skipped !== null).length;
  const ran = rows.length - unrun;
  return [`${rows.length} checks — ${ran} run, ${unrun} not run`, ...lines, "", ""].join("\n");
}

/** The files whose exports are the repository's outward surface, as `--entry=<path>`, once
 *  per file. Named by a person rather than guessed from a filename: which modules are a
 *  package's surface is a fact about the packaging, not a pattern to infer. */
const entryPoints = (args: readonly string[]): ReadonlySet<string> =>
  new Set(args.filter((a) => a.startsWith("--entry=")).map((a) => a.slice("--entry=".length)));

/** The tree half, running beside the record half. Nothing is awaited: `run()` is not async,
 *  so the answer arrives through this promise and the pass puts its verdict on
 *  `process.exitCode`. Node stays alive while the promise is, so the report is printed. */
let examining: Promise<readonly Violation[]> = Promise.resolve([]);

function examine(repo: string, surface: ReadonlySet<string>, open: (root: string) => RepoIndex): void {
  examining = (async () => {
    const found = await checkTree({ index: open(repo), files: tracked(gitIn(repo)), surface });
    if (found.length > 0) {
      process.stdout.write(report(found, []));
      process.exitCode = 1;
    }
    return found;
  })();
}

/** What the last `wecode doctor --tree` found, once it has. Empty when none was asked. */
export const examined = (): Promise<readonly Violation[]> => examining;

/** Every file the repository tracks. Asked of git, so what is checked is what is committed
 *  — unfiltered by extension, because whether a file is a module is the index's answer. */
const tracked = (git: Git): readonly string[] =>
  git(["ls-files"])
    .split("\n")
    .filter((l) => l !== "");

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
  const rows = byId(queries(db).selectFrom(project).all());
  return rows[0]?.repo ?? process.cwd();
}

const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** The checks that cannot be answered from the record alone. */
const gitAnswered = (): readonly string[] => checksOf().filter((c) => c.world).map((c) => c.name);

/** Grouped by invariant, because the invariant is the sentence that was broken and the
 *  entities are the evidence. Ungrouped, one drift on forty rows reads as forty problems.
 *  `unanswered` is an argument rather than worked out here: the tree half runs no
 *  git-answered check, and a footnote about one would describe a pass that did not happen. */
function report(violations: readonly Violation[], unanswered: readonly string[]): string {
  const groups = new Map<string, Violation[]>();
  for (const v of violations) groups.set(v.invariant, [...(groups.get(v.invariant) ?? []), v]);
  const needsGit = new Set(gitAnswered());

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
  if (unanswered.length > 0) {
    lines.push(`no repository to ask — unanswered: ${unanswered.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** docs/design/19, the healing, and one fix of it.
 *
 *  `delivered_story_has_landed` has been broken for five stories that did land: the marker
 *  is written only on the path that merges from now on, and theirs merged before that path
 *  existed. Their land commits are in the base, one each, subject `land story/<slug>`, so
 *  the sha is read off the world rather than guessed, and copied onto the record.
 *
 *  Read-only on git, additive on the record, and a ledger line for every marker written.
 *  Ambiguity is refused rather than resolved: no such commit, or more than one, is drift to
 *  report, because an unexplained fix is worse than visible drift.
 *
 *  A copy of `packages/runner/src/doctor.ts`, like `snapshot` and `runChecks` above it —
 *  `@wecode/cli` cannot import the runner. `packages/runner/test/backfill-landed.test.ts`
 *  and `packages/cli/test/doctor-parity.test.ts` pin the two identical. */

/** git, read-only, as the heal is allowed to see it: argv in, stdout out. */
export type Git = (args: readonly string[]) => string;

/** Is the branch in the base? `rev-list branch ^base` rather than `merge-base
 *  --is-ancestor`, because this git speaks in stdout and not exit codes. A ref nobody can
 *  resolve is the story with no branch at all. */
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
 *  "which checks needed git" is one sentence both halves read rather than a shared habit. */
export const WORLD_CHECK = "delivered_story_has_landed";

/** Every check a pass runs, and which has to ask the world. Core owns the pure set; this
 *  column is the half that may read git, and `doctor-parity.test.ts` reads it. */
export const checksOf = (
  invariants: readonly Invariant[] = INVARIANTS,
): readonly { readonly name: string; readonly world: boolean }[] =>
  invariants.map((i) => ({ name: i.name, world: i.name === WORLD_CHECK }));

/** One invariant: the sentence and the function that finds who breaks it. */
export interface Invariant {
  readonly name: string;
  readonly check: (s: Snapshot) => readonly Violation[];
}

/** git as the checks may see it, and whether it was there to be asked. Separate facts: with
 *  no repository every branch answers `no-branch`, indistinguishable from a story that never
 *  had one, so the pass carries the difference rather than implying the stronger claim. */
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

/** One pass: core's pure set, each check inside its own boundary, then the one question
 *  that needs the world. The tick and `wecode doctor` run exactly this. A check that throws
 *  becomes a violation naming itself, because an invariant nobody can evaluate is as much a
 *  thing to see as one that failed. */
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

/** A marker written, and the commit it came from. */
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

/** The ledger line for a story in the base with nothing to name. Said once: a second heal
 *  would repeat the sentence, and the fact it records is git's, not the record's. */
function writeReached(db: DatabaseSync, id: number): void {
  const q = queries(db);
  const said = q
    .selectFrom(ledger)
    .select(["entity_id"])
    .where("entity", "=", "story")
    .where("entity_id", "=", id)
    .where("verb", "=", "heal")
    .where("to_state", "=", REACHED_INSIDE_ANOTHER_MERGE)
    .get();
  if (said !== null) return;
  q.insertInto(ledger, healLine(id, REACHED_INSIDE_ANOTHER_MERGE, now())).run();
}

/** The doctor's own ledger line. One shape for both heals: what it was — no marker — and
 *  what it became, whichever of the two it became. */
const healLine = (id: number, to: string, at: string): LedgerRow => ({
  entity: "story",
  entity_id: id,
  verb: "heal",
  from_state: `no landed marker`,
  to_state: to,
  actor: "doctor",
  at,
});

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

function tasksOf(db: DatabaseSync, id: number): readonly number[] {
  return [...storiesByTask(queries(db))].filter(([, s]) => s === id).map(([t]) => t);
}

/** The marker the lander writes, written the same way, plus the line saying the doctor
 *  wrote it and what it read the sha off. One transaction: a marker with no ledger line
 *  behind it is exactly the unexplained fix 19 forbids. */
function writeMarker(db: DatabaseSync, id: number, slug: string, sha: string): void {
  // The one statement left in raw SQL, and not a query: the dialect compiles selects and
  // writes and has no vocabulary for schema.
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  const at = now();
  transact(db, () => {
    const q = queries(db);
    for (const t of tasksOf(db, id)) {
      q.insertInto(landedBranch, { task_id: t, branch: storyBranch(slug), sha, merged_at: at })
        .onConflict(["task_id"], {
          branch: excluded<LandedRow>("branch"),
          sha: excluded<LandedRow>("sha"),
          merged_at: excluded<LandedRow>("merged_at"),
        })
        .run();
    }
    q.insertInto(ledger, healLine(id, `landed_sha ${sha} from 'land story/${slug}'`, at)).run();
  });
}
