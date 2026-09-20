import {
  checkRunner,
  INVARIANTS,
  keepUnlanded,
  noWorkerFree,
  now,
  readLease,
  REACHED_INSIDE_ANOTHER_MERGE,
  storyBranch,
  transact,
  type Ancestry,
  type RecordNode,
  type RunnerBuild,
  type Snapshot,
  type Violation,
} from "@wecode/core";
// The dialect is core's and deliberately not on core's barrel: `index.ts` exports the things
// a client speaks the record in, and a query layer is not one of them. Reached by the path
// core builds it to, the one specifier that resolves without widening that barrel.
import { excluded, queries, table, type Dialect } from "@wecode/core/dist/db.js";
import { fileCeilingInvariant } from "./ceiling.js";
// The examiner already reads a failing file off the runner's own failure banner and never
// off the lines it ran and passed. One reading of it, so a tally and a re-run cannot
// disagree about which file is red.
import { failingFilesOf } from "./examiner.js";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** docs/design/19, the check, on the runner's tick.
 *
 *  Core's set, run once a tick and written to one runner-owned table so a view can say what
 *  drifted without eight queries of its own. Nothing else is written: no entity is touched,
 *  no state moves, no chore is proposed. A failure never stops a tick — every invariant runs
 *  inside its own boundary and a throw becomes a line in the report rather than an exception. */

/** One invariant: the sentence and the function that finds who breaks it. */
export interface Invariant {
  readonly name: string;
  readonly check: (s: Snapshot) => readonly Violation[];
}

/** A ready task no pass can dispatch, and the refusal that explains it.
 *
 *  The allocator refuses a task it cannot place with `no worker free for role <role>` and
 *  clears that reason next tick. With nobody of the role in the workforce that sentence is
 *  true for ever: the task sits `ready` and the refusal reads like a queue rather than a
 *  stop. `system` is the live case. Pure over the snapshot, and the runner's rather than
 *  core's only because core's set is what `wecode doctor` and the tick share verbatim. */
export const READY_TASK_CHECK = "ready_task_can_be_dispatched";

export const readyTaskCanBeDispatched: Invariant = {
  name: READY_TASK_CHECK,
  check: (s: Snapshot): readonly Violation[] => {
    const staffed = new Set(s.workers.map((w) => w.role));
    return s.nodes
      .filter((n) => n.entity === "task" && n.state === "ready" && !staffed.has(n.role ?? ""))
      .map((n) => ({
        invariant: READY_TASK_CHECK,
        entity: n.entity,
        id: n.id,
        slug: n.slug,
        // The allocator's own words, so the report and the board say the same thing, and
        // then the part the allocator cannot know: nothing about the next pass is different.
        detail:
          `ready, and every pass refuses it — ${noWorkerFree(n.role ?? "")}, and no worker ` +
          `holds role ${n.role || "(none)"} at all: hire one, or give the task a role somebody holds`,
      }));
  },
};

/** A task the record calls done whose work is in no commit.
 *
 *  `task.finish` is guarded on the branch holding a commit the task wrote, but a guard only
 *  ever ran on the finishes that came after it: a task finished before it existed, or moved
 *  by a hand that wrote the state, leaves the record reporting work no commit carries. Read
 *  off `assignment.commit_sha` — the same fact `taskFinishesOnItsOwnWork` reads, so the two
 *  cannot disagree, and a refresh merge nobody attempted is never mistaken for the task's
 *  own work. Built per record rather than listed in the pure set, because the snapshot
 *  carries no attempt: like the ceiling check, it is the Doctor's own default. */
export const WORK_CHECK = "done_task_has_a_commit";

const assignment = table<{ objective_type: string; objective_id: number; commit_sha: string | null }>("assignment", [
  "objective_type",
  "objective_id",
  "commit_sha",
]);

/** Every task some attempt committed against. A blank sha is no sha: the column is text, and
 *  an attempt that wrote nothing has been seen to leave it empty rather than null. */
function committedTasks(db: DatabaseSync): ReadonlySet<number> {
  if (!hasTable(db, "assignment")) return new Set();
  const rows = queries(db)
    .selectFrom(assignment)
    .select(["objective_id", "commit_sha"])
    .where("objective_type", "=", "task")
    .all();
  return new Set(rows.filter((r) => (r.commit_sha ?? "").trim() !== "").map((r) => r.objective_id));
}

export const taskWorkIsCommitted = (db: DatabaseSync): Invariant => ({
  name: WORK_CHECK,
  check: (s: Snapshot): readonly Violation[] => {
    const committed = committedTasks(db);
    return s.nodes
      .filter((n) => n.entity === "task" && n.state === "done" && !committed.has(n.id))
      .map((n) => ({
        invariant: WORK_CHECK,
        entity: n.entity,
        id: n.id,
        slug: n.slug,
        detail:
          `done, and task/${n.slug} holds no commit of its own — no attempt on it recorded a ` +
          `sha, so the work the record reports is in no commit`,
      }));
  },
});

/** A task branch its story branch has already got, merged at every tick for ever.
 *
 *  The lander retries a done task's merge until `landed_branch` records it, and remembers a
 *  conflict only by the pair of tips it happened between — so a branch the story has taken
 *  by another route (cherry-picked, recut, landed by hand) is merged again every time either
 *  tip moves, and git refuses it every time. Nothing on the branch the story does not already
 *  hold is what superseded means, which is `ancestryOf`'s `in` read against the story branch
 *  rather than against the base of the repository. Named, so the answer is the sentence and
 *  not another merge. Like the ceiling and the dist check it reads the world, so it is the
 *  Doctor's own default and not in the pure set. */
export const SUPERSEDED_CHECK = "task_branch_is_not_superseded";

/** Every task the lander has recorded a merge for. Its own table, keyed by task. */
function landedTasks(db: DatabaseSync): ReadonlySet<number> {
  if (!hasTable(db, "landed_branch")) return new Set();
  return new Set(queries(db).selectFrom(landedBranch).select(["task_id"]).all().map((r) => r.task_id));
}

export const taskBranchIsNotSuperseded = (db: DatabaseSync, git: Git): Invariant => ({
  name: SUPERSEDED_CHECK,
  check: (s: Snapshot): readonly Violation[] => {
    // Exactly the set the lander retries: done, something committed against it, no marker.
    const landed = landedTasks(db);
    const committed = committedTasks(db);
    const owner = storyOfTask(queries(db));
    const slugOfStory = new Map(s.nodes.filter((n) => n.entity === "story").map((n) => [n.id, n.slug]));
    return s.nodes
      .filter((n) => n.entity === "task" && n.state === "done" && committed.has(n.id) && !landed.has(n.id))
      .flatMap((n) => {
        const story = slugOfStory.get(owner.get(n.id) ?? -1);
        if (story === undefined) return [];
        const base = storyBranch(story);
        const branch = `task/${n.slug}`;
        // `no-branch` is a branch that is gone, which is a different fact and not this one.
        if (ancestryOf(git, base)(branch) !== "in") return [];
        return [
          {
            invariant: SUPERSEDED_CHECK,
            entity: n.entity,
            id: n.id,
            slug: n.slug,
            detail:
              `done, and ${base} already holds every commit on ${branch} — the merge is ` +
              `retried every tick and can move nothing: the branch is superseded, not unmerged`,
          },
        ];
      });
  },
});

/** docs/design/19, applied to what the record is judged by rather than to the record.
 *
 *  Every package is run from `dist`: a bin, the tick, and every specifier that resolves
 *  through a package name read the compiled tree and never the source beside it. So a
 *  `dist` older than its `src` is a pass that judged code nobody wrote, and it is the one
 *  drift no test can find — the stale tree is the thing running the tests. Said per package
 *  and naming the source that is newer, because that is what says which build is late.
 *
 *  A package with no `dist` at all is not stale: it is unbuilt, which is a different fact
 *  and one the build says far louder than a report would. Like the ceiling, it reads a tree
 *  rather than the record, so it is the Doctor's own default and not in the pure set. */
export const DIST_CHECK = "dist_is_built_from_its_source";

/** The newest file under one tree, repository-relative, and when it was written. */
export interface Newest {
  readonly path: string;
  readonly at: number;
}

/** One package, as the two trees this check holds against each other. `null` is a tree with
 *  nothing in it, which includes a tree that is not there. */
export interface Built {
  readonly pkg: string;
  readonly source: Newest | null;
  readonly dist: Newest | null;
}

/** Source is what a person writes; `dist` is what `tsc` leaves. Declarations and maps are
 *  written by the same pass as the `.js`, so the one extension answers for the build. */
const SOURCE_EXT = [".ts", ".tsx"] as const;
const DIST_EXT = [".js"] as const;

const dirents = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The newest file of these kinds anywhere under `dir`. */
export function newestUnder(dir: string, ext: readonly string[]): Newest | null {
  let best: Newest | null = null;
  for (const e of dirents(dir)) {
    const path = join(dir, e.name);
    const found = e.isDirectory()
      ? newestUnder(path, ext)
      : ext.some((x) => e.name.endsWith(x))
        ? { path, at: statSync(path).mtimeMs }
        : null;
    if (found !== null && (best === null || found.at > best.at)) best = found;
  }
  return best;
}

/** Every package in the workspace, each with the newest of its two trees. Paths come back
 *  repository-relative with forward slashes, so a violation reads the same on every host. */
export function builtTree(root: string): readonly Built[] {
  const packages = join(root, "packages");
  const rel = (n: Newest | null): Newest | null =>
    n === null ? null : { path: relative(root, n.path).split("\\").join("/"), at: n.at };
  return dirents(packages)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((pkg) => ({
      pkg,
      source: rel(newestUnder(join(packages, pkg, "src"), SOURCE_EXT)),
      dist: rel(newestUnder(join(packages, pkg, "dist"), DIST_EXT)),
    }));
}

/** What is stale, one sentence each, in package order — a report whose lines moved between
 *  two identical passes reads as drift that is not there. */
export function staleDists(built: readonly Built[]): readonly Violation[] {
  return built
    .filter((b) => b.source !== null && b.dist !== null && b.source.at > b.dist.at)
    .map((b) => ({
      invariant: DIST_CHECK,
      entity: "package",
      // A package is not a row of the record, so there is no id to name it by. The path is.
      id: null,
      slug: `packages/${b.pkg}`,
      detail:
        `packages/${b.pkg}/dist is older than its source — ${b.source?.path} was written ` +
        `after ${b.dist?.path}, so everything that imports the package is running a build ` +
        `that predates it: run pnpm -r build`,
    }));
}

/** The check, bound to a repository. `read` is the seam the test uses: a pair of trees is
 *  handed in rather than written to disk, so the case being proven is the comparison. */
export const distIsBuiltFromSource = (
  root: string,
  read: (root: string) => readonly Built[] = builtTree,
): Invariant => ({
  name: DIST_CHECK,
  check: (): readonly Violation[] => staleDists(read(root)),
});

/** The pure set: core's, plus the checks that are the runner's own. The file-length check is
 *  not here — it reads a tree rather than the record, so it is built per repository and added
 *  to the Doctor's own default below. `runChecks` and `checksOf` still default to core's set. */
export const RUNNER_INVARIANTS: readonly Invariant[] = [...INVARIANTS, readyTaskCanBeDispatched];

/** The columns this module reads, and only those. A narrow declaration is not a second copy
 *  of the schema: it is the ask, and `typed-runner-doctor.test.ts` holds each list against
 *  `PRAGMA table_info` so a column renamed out from under it fails a test. */
const release = table<{ id: number; slug: string; state: string }>("release", ["id", "slug", "state"]);
const epic = table<{ id: number; slug: string; state: string; release_id: number }>("epic", ["id", "slug", "state", "release_id"]);
const story = table<{ id: number; slug: string; state: string; epic_id: number }>("story", ["id", "slug", "state", "epic_id"]);
const requirement = table<{ id: number; slug: string; state: string; story_id: number }>("requirement", ["id", "slug", "state", "story_id"]);
const criteria = table<{ id: number; slug: string; state: string; requirement_id: number }>("acceptance_criteria", ["id", "slug", "state", "requirement_id"]);
const acceptanceTest = table<{
  id: number;
  slug: string;
  state: string;
  parent_id: number;
  red_at_base_sha: string | null;
  script_path: string | null;
}>("acceptance_test", ["id", "slug", "state", "parent_id", "red_at_base_sha", "script_path"]);
const taskTable = table<{ id: number; slug: string; state: string; acceptance_test_id: number; role: string }>("task", ["id", "slug", "state", "acceptance_test_id", "role"]);
const taskTest = table<{ id: number; slug: string; state: string; parent_id: number }>("task_test", ["id", "slug", "state", "parent_id"]);
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
  /** Written by sqlite, so absent on the row this module hands to an insert. */
  id?: number;
  entity: string;
  entity_id: number;
  verb: string;
  from_state: string;
  to_state: string;
  actor: string;
  at: string;
}
const ledger = table<LedgerRow>("ledger", ["id", "entity", "entity_id", "verb", "from_state", "to_state", "actor", "at"]);

/** `rowid` is the order this table is read back in and a real column of it; `table_info` does
 *  not list it, so the test holding these lists against the schema names it as the exception. */
interface ViolationRow {
  rowid?: number;
  invariant: string;
  entity: string;
  entity_id: number | null;
  slug: string;
  detail: string;
  found_at: string;
}
const doctorViolation = table<ViolationRow>("doctor_violation", ["rowid", "invariant", "entity", "entity_id", "slug", "detail", "found_at"]);

/** One check a pass ran, as the pass recorded it. Rewritten whole every tick beside the
 *  violations, and in the same transaction: a report and the list of what produced it that
 *  came from two different passes would be worse than either alone. */
interface PassRow {
  rowid?: number;
  invariant: string;
  /** Whether this check had to ask git, and whether git was there to be asked. Stored as
   *  0/1 because sqlite has no boolean, and read back as one. */
  world: number;
  reachable: number;
  found: number;
  at: string;
}
const doctorPass = table<PassRow>("doctor_pass", ["rowid", "invariant", "world", "reachable", "found", "at"]);

/** One whole-suite run, as the pass recorded it. One row: "how red is the tip" is answered
 *  by the last run and no other. `files` is the failures' files newline-joined, kept in the
 *  row that counted them so the number and the names cannot come from two different runs. */
interface SuiteRow {
  tip: string;
  failed: number;
  passed: number;
  skipped: number;
  files: string;
  at: string;
}
const doctorSuite = table<SuiteRow>("doctor_suite", ["tip", "failed", "passed", "skipped", "files", "at"]);

const sqliteMaster = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

/** A name that is something to select from. `type IN (…)` has no spelling in the dialect and
 *  did not deserve one: two kinds held here is the same rule in one place. */
const SELECTABLE: readonly string[] = ["table", "view"];

const hasTable = (db: DatabaseSync, name: string): boolean =>
  queries(db)
    .selectFrom(sqliteMaster)
    .select(["type"])
    .where("name", "=", name)
    .all()
    .some((r) => SELECTABLE.includes(r.type));

/** Where each entity's rows come from, flattened to the node shape — the one place in the
 *  runner that knows the shape of the tables. Closures rather than a table name and a foreign
 *  key name, because `parent_id` is an alias and the dialect has none. */
type Node = Omit<RecordNode, "entity">;

const TABLES: readonly { entity: RecordNode["entity"]; nodes: (q: Dialect) => readonly Node[] }[] = [
  { entity: "release", nodes: (q) => q.selectFrom(release).all().map((r) => ({ ...r, parent_id: null })) },
  { entity: "epic", nodes: (q) => q.selectFrom(epic).all().map(({ release_id, ...r }) => ({ ...r, parent_id: release_id })) },
  { entity: "story", nodes: (q) => q.selectFrom(story).all().map(({ epic_id, ...r }) => ({ ...r, parent_id: epic_id })) },
  { entity: "requirement", nodes: (q) => q.selectFrom(requirement).all().map(({ story_id, ...r }) => ({ ...r, parent_id: story_id })) },
  { entity: "acceptance_criteria", nodes: (q) => q.selectFrom(criteria).all().map(({ requirement_id, ...r }) => ({ ...r, parent_id: requirement_id })) },
  { entity: "acceptance_test", nodes: (q) => q.selectFrom(acceptanceTest).all() },
  {
    entity: "task",
    nodes: (q) => q.selectFrom(taskTable).all().map(({ acceptance_test_id, ...r }) => ({ ...r, parent_id: acceptance_test_id })),
  },
  { entity: "task_test", nodes: (q) => q.selectFrom(taskTest).all() },
];

/** One step up the chain: each child against the story its parent already resolved to. A
 *  child whose parent is gone drops out, which is what the joins did with it too. */
const step = <T>(
  rows: readonly T[],
  id: (r: T) => number,
  parent: (r: T) => number,
  up: Map<number, number>,
): Map<number, number> =>
  new Map(
    rows.flatMap((r) => {
      const s = up.get(parent(r));
      return s === undefined ? [] : [[id(r), s] as [number, number]];
    }),
  );

/** Every task, against the story it proves. The dialect has no JOIN, and one walk is one copy
 *  of the chain rather than two that have to agree. */
function storyOfTask(q: Dialect): Map<number, number> {
  const byRequirement = new Map(
    q
      .selectFrom(requirement)
      .select(["id", "story_id"])
      .all()
      .map((r) => [r.id, r.story_id] as [number, number]),
  );
  const byCriteria = step(
    q.selectFrom(criteria).select(["id", "requirement_id"]).all(),
    (c) => c.id,
    (c) => c.requirement_id,
    byRequirement,
  );
  const byTest = step(
    q.selectFrom(acceptanceTest).select(["id", "parent_id"]).all(),
    (a) => a.id,
    (a) => a.parent_id,
    byCriteria,
  );
  return step(
    q.selectFrom(taskTable).select(["id", "acceptance_test_id"]).all(),
    (t) => t.id,
    (t) => t.acceptance_test_id,
    byTest,
  );
}

/** The story a task belongs to, landed: `landed_branch` is the lander's own table, keyed
 *  by task, so a story is landed when something under it is recorded as merged. */
function landedShas(db: DatabaseSync): Map<number, string> {
  if (!hasTable(db, "landed_branch")) return new Map();
  const q = queries(db);
  const owner = storyOfTask(q);
  const shas = new Map<number, string>();
  for (const b of q.selectFrom(landedBranch).select(["task_id", "sha"]).all()) {
    const s = owner.get(b.task_id);
    if (s !== undefined) shas.set(s, b.sha);
  }
  return shas;
}

/** By id, as every query here used to ask for. The dialect has no ORDER BY, and a report whose
 *  lines moved between two identical passes reads as drift that is not there. */
const byId = <T extends { id: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.id - b.id);

/** One plain object, no live handle: everything the invariants are allowed to see. */
export function snapshot(db: DatabaseSync): Snapshot {
  const q = queries(db);
  const landed = landedShas(db);
  // The table it came from is what the entity is; sqlite does not carry it on the row.
  const nodes = TABLES.flatMap(({ entity, nodes }) =>
    byId(nodes(q)).map((n) =>
      entity === "story" ? { ...n, entity, landed_sha: landed.get(n.id) ?? null } : { ...n, entity },
    ),
  );
  const workers = byId(q.selectFrom(worker).all()).map(({ slug, role }) => ({ slug, role }));
  const version = hasTable(db, "schema_version") ? q.selectFrom(schemaVersion).get() : null;
  return { nodes, workers, schema_version: version?.version ?? 0 };
}

/** The step every pass begins with, named so the report can say a pass got no further than
 *  it. Not an invariant: a snapshot that cannot be taken is the pass failing to look. */
export const SNAPSHOT_STEP = "snapshot";

/** One check a pass ran, and what came of it. `found: 0` is the sentence the story is for:
 *  this check ran, over this record, and had nothing to say. */
export interface LookedAt {
  readonly invariant: string;
  /** The check asks git. */
  readonly world: boolean;
  /** git answered — a world check whose repository was missing looked at less than it says. */
  readonly reachable: boolean;
  readonly found: number;
}

/** What the last pass looked at. `null` is nobody looked: no pass has run against this
 *  record at all, which is a different fact from a pass that found nothing. */
export interface Pass {
  readonly at: string;
  readonly looked: readonly LookedAt[];
}

/** The one check whose subject is the process rather than the record. Core owns the
 *  sentence; the runner is the half that can name the runner of record. */
export const BUILD_CHECK = "runner_build_is_current";

/** What the process holding this workspace says it is running, read off the lease — the
 *  only place a live process describes its own build. `null` is nobody to ask: no lease
 *  table, or no holder, which is not the same fact as a build that is current. */
export function runningBuild(db: DatabaseSync): RunnerBuild | null {
  const held = hasTable(db, "runner_lease") ? readLease(db) : null;
  if (held === null) return null;
  const { holder, buildSha, buildBehind } = held;
  return { holder, ...(buildSha === undefined ? {} : { buildSha }), ...(buildBehind === undefined ? {} : { behind: buildBehind }) };
}

/** The check, wired to a record. Runner-owned, like `landed_branch`: the ledger says what is
 *  true of the work, this says what this pass observed about it. Rewritten whole every tick —
 *  a violation that has been fixed is not history worth keeping. */
export class Doctor {
  constructor(
    private readonly db: DatabaseSync,
    /** The tick's set: the pure ones, plus the tree read against the repository the record
     *  names. A caller passes its own only to test the boundary itself. */
    private readonly invariants: readonly Invariant[] = [
      ...RUNNER_INVARIANTS,
      fileCeilingInvariant(repoOf(db)),
      distIsBuiltFromSource(repoOf(db)),
      taskWorkIsCommitted(db),
      taskBranchIsNotSuperseded(db, gitIn(repoOf(db))),
    ],
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
    db.exec(
      `CREATE TABLE IF NOT EXISTS doctor_pass (
         invariant TEXT    NOT NULL,
         world     INTEGER NOT NULL,
         reachable INTEGER NOT NULL,
         found     INTEGER NOT NULL,
         at        TEXT    NOT NULL
       )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS doctor_suite (
         tip     TEXT    NOT NULL,
         failed  INTEGER NOT NULL,
         passed  INTEGER NOT NULL,
         skipped INTEGER NOT NULL,
         files   TEXT    NOT NULL,
         at      TEXT    NOT NULL
       )`,
    );
  }

  /** One pass. Returns what it found and records the same, and throws for nothing. */
  check(): readonly Violation[] {
    const { found, looked } = this.run();
    try {
      this.record(found, looked);
    } catch {
      // The report is worth less than the tick. A table that could not be written is drift
      // of its own, and the next pass rewrites it whole anyway.
    }
    return found;
  }

  /** The shared pass, `runChecks`, over this tick's snapshot. A snapshot that cannot be
   *  taken is reported in the same shape as a check that threw. */
  private run(): { readonly found: readonly Violation[]; readonly looked: readonly LookedAt[] } {
    let s: Snapshot;
    try {
      s = snapshot(this.db);
    } catch (err) {
      // The pass looked at the record and got no further. Said as the one step it did
      // attempt, so the report is not an empty list that reads like nobody came.
      const found = [broken(SNAPSHOT_STEP, err)];
      return { found, looked: [{ invariant: SNAPSHOT_STEP, world: false, reachable: false, found: 1 }] };
    }
    const world = worldOf(this.git, this.base);
    const found = runChecks(s, world, this.invariants);
    // Appended rather than folded into the set: its subject is not in the snapshot, and a
    // workspace nobody holds has no runner for the pass to say it looked at.
    const runner = runningBuild(this.db);
    const build = checkRunner(runner);
    const row = { invariant: BUILD_CHECK, world: false, reachable: true, found: build.length };
    const looked = [...lookedAt(this.invariants, world, found), ...(runner === null ? [] : [row])];
    return { found: [...found, ...build], looked };
  }

  /** Replaced, not appended: the answer to "what is wrong now" is this pass and only this
   *  pass. One transaction, so a view never reads half a report. */
  private record(found: readonly Violation[], looked: readonly LookedAt[]): void {
    const at = now();
    const q = queries(this.db);
    transact(this.db, () => {
      q.deleteFrom(doctorPass).run();
      for (const l of looked)
        q.insertInto(doctorPass, {
          invariant: l.invariant,
          world: l.world ? 1 : 0,
          reachable: l.reachable ? 1 : 0,
          found: l.found,
          at,
        }).run();
      q.deleteFrom(doctorViolation).run();
      for (const v of found)
        q.insertInto(doctorViolation, {
          invariant: v.invariant,
          entity: v.entity,
          entity_id: v.id,
          slug: v.slug,
          detail: v.detail,
          found_at: at,
        }).run();
    });
  }
}

/** docs/design/19, the healing, and one fix of it.
 *
 *  `delivered_story_has_landed` broke for five stories that did land: the marker is written
 *  only on the path that merges from now on, and theirs merged before it existed. Their land
 *  commits are in the base, subject `land story/<slug>`, so the sha is read off the world
 *  rather than guessed. Read-only on git, additive on the record, a ledger line for every
 *  marker written, and the ambiguous cases — none, or more than one — refused not resolved. */

/** git, read-only, as the heal is allowed to see it: argv in, stdout out. */
export type Git = (args: readonly string[]) => string;

/** The repository the record names, as `wecode land` sees it. */
function repoOf(db: DatabaseSync): string {
  const row = byId(queries(db).selectFrom(project).all())[0];
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

/** The one check that cannot be answered from the record alone. Named once here and copied
 *  verbatim into the cli, so "which checks needed git" is a fact both halves read off the
 *  same sentence rather than a habit each of them has. */
export const WORLD_CHECK = "delivered_story_has_landed";

/** Every check a pass runs, and which of them has to ask the world. Core owns the pure set;
 *  this column is the half that may read git. A copy that gained a check the other could not
 *  see would differ here, which is what `packages/cli/test/doctor-parity.test.ts` reads. */
export const checksOf = (
  invariants: readonly Invariant[] = INVARIANTS,
): readonly { readonly name: string; readonly world: boolean }[] =>
  invariants.map((i) => ({ name: i.name, world: i.name === WORLD_CHECK }));

/** git as the checks are allowed to see it, and whether it was there to be asked at all. The
 *  two are separate facts: with no repository to hand every branch answers `no-branch`, which
 *  is indistinguishable from a story that never had one. */
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
 *  needs the world. The tick and `wecode doctor` run exactly this. A check that throws becomes
 *  a violation naming itself: an invariant nobody can evaluate needs seeing as much as one
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
    // git could not be asked, and over-accusing beats dying of a missing repository.
    return [...found, broken(WORLD_CHECK, err)];
  }
}

/** What a pass looked at, built from the set it ran and what it returned. Derived rather than
 *  collected inside `runChecks`, so the tick and `wecode doctor` cannot differ over a count. */
export function lookedAt(
  invariants: readonly Invariant[],
  world: World,
  found: readonly Violation[],
): readonly LookedAt[] {
  const counted = new Map<string, number>();
  for (const v of found) counted.set(v.invariant, (counted.get(v.invariant) ?? 0) + 1);
  return checksOf(invariants).map((c) => ({
    invariant: c.name,
    world: c.world,
    // A pure check needs nothing of the world: everything it reads was there.
    reachable: c.world ? world.reachable : true,
    found: counted.get(c.name) ?? 0,
  }));
}

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

/** The safe heal for `delivered_story_has_landed`, applied to what a check already found. Its
 *  violations are an argument, not a pass of its own, so nothing here changes what was said. */
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
    // No commit to copy, but the branch is in: it reached the base inside another merge.
    if (ancestryOf(git, base)(storyBranch(v.slug)) === "in") {
      writeReached(db, v.id);
      reached.push({ story: v.id, slug: v.slug });
      continue;
    }
    left.push({ story: v.id, slug: v.slug, why });
  }
  return { written, reached, left };
}

/** The ledger line for a story in the base with nothing to name. Said once, not every heal. */
function writeReached(db: DatabaseSync, storyId: number): void {
  const q = queries(db);
  const said = q
    .selectFrom(ledger)
    .select(["id"])
    .where("entity", "=", "story")
    .where("entity_id", "=", storyId)
    .where("verb", "=", "heal")
    .where("to_state", "=", REACHED_INSIDE_ANOTHER_MERGE)
    .get();
  if (said !== null) return;
  q.insertInto(ledger, healed(storyId, REACHED_INSIDE_ANOTHER_MERGE, now())).run();
}

/** The doctor's own ledger line: what it healed, and what it read the fix off. */
const healed = (storyId: number, to: string, at: string): LedgerRow => ({
  entity: "story",
  entity_id: storyId,
  verb: "heal",
  from_state: `no landed marker`,
  to_state: to,
  actor: "doctor",
  at,
});

/** Commits in the base with subject exactly `land story/<slug>`: `--grep` narrows, the
 *  comparison decides, because `land story/a` is a substring of `land story/ab`. */
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

/** The marker hangs off the story's tasks: one with none has nowhere to carry it, which is
 *  drift of its own shape and not this heal's to fix. */
function emptyStory(db: DatabaseSync, storyId: number): string | null {
  return tasksOf(db, storyId).length === 0 ? "no task under the story to carry the marker" : null;
}

function tasksOf(db: DatabaseSync, storyId: number): readonly number[] {
  return [...storyOfTask(queries(db))]
    .filter(([, s]) => s === storyId)
    .map(([t]) => t)
    .sort((a, b) => a - b);
}

/** The marker the lander writes, written the same way, plus the line saying the doctor wrote
 *  it and off what. One transaction: a marker with no ledger line is the fix 19 forbids. */
function writeMarker(db: DatabaseSync, storyId: number, slug: string, sha: string): void {
  // DDL, which the dialect does not spell: a table this module owns, created by it.
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  const at = now();
  const q = queries(db);
  const tasks = tasksOf(db, storyId);
  transact(db, () => {
    for (const taskId of tasks)
      q.insertInto(landedBranch, { task_id: taskId, branch: `story/${slug}`, sha, merged_at: at })
        .onConflict(["task_id"], {
          branch: excluded<LandedRow>("branch"),
          sha: excluded<LandedRow>("sha"),
          merged_at: excluded<LandedRow>("merged_at"),
        })
        .run();
    q.insertInto(ledger, healed(storyId, `landed_sha ${sha} from 'land story/${slug}'`, at)).run();
  });
}

/** A check that could not be run, said out loud in the shape of the thing it failed to be. */
const broken = (name: string, err: unknown): Violation => ({
  invariant: name,
  entity: "invariant",
  id: null,
  slug: name,
  detail: `the check itself failed: ${(err as Error).message}`,
});

/** What a view reads to tell a quiet record from an unexamined one. The last pass and every
 *  check it ran, in the order it ran them; `null` when no pass has been recorded, which is
 *  the only honest way to say nobody looked. */
export function lastPass(db: DatabaseSync): Pass | null {
  if (!hasTable(db, "doctor_pass")) return null;
  const rows = queries(db)
    .selectFrom(doctorPass)
    .select(["rowid", "invariant", "world", "reachable", "found", "at"])
    .all()
    .sort((a, b) => (a.rowid ?? 0) - (b.rowid ?? 0));
  if (rows.length === 0) return null;
  return {
    at: rows[0]!.at,
    looked: rows.map((r) => ({
      invariant: r.invariant,
      world: r.world === 1,
      reachable: r.reachable === 1,
      found: r.found,
    })),
  };
}

/** What a view reads. The last pass, in the order it was found. */
export function violations(db: DatabaseSync): readonly Violation[] {
  if (!hasTable(db, "doctor_violation")) return [];
  return queries(db)
    .selectFrom(doctorViolation)
    .select(["rowid", "invariant", "entity", "entity_id", "slug", "detail"])
    .all()
    .sort((a, b) => (a.rowid ?? 0) - (b.rowid ?? 0))
    .map((r) => ({ invariant: r.invariant, entity: r.entity, id: r.entity_id, slug: r.slug, detail: r.detail }));
}

/** A file the base has already been watched failing on. Each ready acceptance test is run
 *  once at the commit its story was cut from, and red there is what makes it proof. The
 *  record keeps that sha on the test; a scope author needs the other end of it — which
 *  file — so a gate never names one that is red before anybody has touched it. */
export interface RedFile {
  readonly file: string;
  /** The acceptance test whose run at the base was red, and the commit it was red at. */
  readonly test: string;
  readonly sha: string;
}

/** What a view reads to say which files fail at the base. The file is the one the plan
 *  spec'd — `script_path`, which migration 005 added so a scope is written against a path
 *  rather than guessed off a command line — so a red test that never said where its script
 *  lives names no file here, and is left out rather than guessed at. One row per file, by
 *  the first test that proved it: two tests over one file is one fact about the file. */
export function redAtBase(db: DatabaseSync): readonly RedFile[] {
  if (!hasTable(db, "acceptance_test")) return [];
  const found = new Map<string, RedFile>();
  for (const t of byId(queries(db).selectFrom(acceptanceTest).all())) {
    if (t.red_at_base_sha === null || t.script_path === null || found.has(t.script_path)) continue;
    found.set(t.script_path, { file: t.script_path, test: t.slug, sha: t.red_at_base_sha });
  }
  return [...found.values()];
}

/** docs/design/19, applied to the tree the pass ran against rather than to the record.
 *
 *  The watch called master green for hours off `the-cockpit-matches-its-design` alone while
 *  the whole suite was red on about a hundred tests: a run narrowed to one file answers for
 *  that file and nothing else, and no count of the record can find that out. So the suite is
 *  run whole, at the tip it ran against, and `failed` is the number the board puts beside
 *  the branch. `files` is the failures' files in the order the runner named them, empty for
 *  a green run, because a number nobody can act on gets argued with instead. */
export interface Tally {
  /** The commit the suite ran against. A tally with no tip is a number about nothing. */
  readonly tip: string;
  readonly failed: number;
  readonly passed: number;
  readonly skipped: number;
  readonly files: readonly string[];
}

/** The runner's summary, read off the line counting tests and not the one above it counting
 *  files: one red file holding a hundred red tests is a hundred, and `Test Files 1 failed
 *  (1)` would call it one. A word the summary omits is nought of that kind, which is how
 *  vitest prints a run with nothing skipped. `null` is output carrying no summary at all — a
 *  suite that died before it counted anything, which must never read as green. */
export function tallyOf(coloured: string, tip: string): Tally | null {
  // A runner that believes it is talking to a terminal writes its counts in escape codes,
  // and a pass that read only the plain spelling would call such a run uncountable.
  const output = coloured.replace(/\u001b\[[0-9;]*m/g, "");
  const line = /^[^\S\n]*Tests[^\S\n]+(.*)$/m.exec(output)?.[1];
  if (line === undefined) return null;
  const n = (word: string): number => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return { tip, failed: n("failed"), passed: n("passed"), skipped: n("skipped"), files: failingFilesOf(output) };
}

/** The suite as the pass may see it: a tree in, everything the runner printed out. Both
 *  streams, because vitest counts on stdout and names its failing files on stderr. */
export type Suite = (cwd: string) => string;

/** A red suite exits non-zero. That is the answer, not an error, so the output is taken off
 *  the failure exactly as off the success. */
export const runSuite: Suite = (cwd: string): string => {
  try {
    return execFileSync("pnpm", ["exec", "vitest", "run"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
};

/** Run the whole suite over a tree and say what it came to. The runner is a seam so a test
 *  can hand in a tree of its own; the default is the one the watch and the tick would use. */
export const suiteTally = (cwd: string, tip: string, suite: Suite = runSuite): Tally | null => tallyOf(suite(cwd), tip);

/** Written as the doctor's other rows are: replaced, never appended — two rows would leave
 *  a view to guess which of them the branch is at. A run with no tally to record writes
 *  nothing and clears nothing: the last real count is still true of the tip it names. */
export function recordSuite(db: DatabaseSync, tally: Tally | null): void {
  if (tally === null) return;
  const q = queries(db);
  transact(db, () => {
    q.deleteFrom(doctorSuite).run();
    q.insertInto(doctorSuite, { ...tally, files: tally.files.join("\n"), at: now() }).run();
  });
}

/** What the board reads to say how red the tip is. `null` is no suite has been run against
 *  this record at all, which is not the same fact as a suite that found nothing. */
export function lastSuite(db: DatabaseSync): (Tally & { readonly at: string }) | null {
  if (!hasTable(db, "doctor_suite")) return null;
  const row = queries(db).selectFrom(doctorSuite).all()[0];
  if (row === undefined) return null;
  return { ...row, files: row.files === "" ? [] : row.files.split("\n") };
}
