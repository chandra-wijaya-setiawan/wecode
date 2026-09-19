import {
  INVARIANTS,
  keepUnlanded,
  noWorkerFree,
  now,
  REACHED_INSIDE_ANOTHER_MERGE,
  storyBranch,
  transact,
  type Ancestry,
  type RecordNode,
  type Snapshot,
  type Violation,
} from "@wecode/core";
// The dialect is core's and is deliberately not on core's barrel: `index.ts` exports the
// things a client speaks the record in, and a query layer is not one of them. Reached by the
// path core builds it to, which is the one specifier that resolves without widening that
// barrel for every consumer.
import { excluded, queries, table, type Dialect } from "@wecode/core/dist/db.js";
import { fileCeilingInvariant } from "./ceiling.js";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

/** docs/design/19, the check, on the runner's tick.
 *
 *  The invariant set is core's and is run here once a tick. What comes back is written to
 *  one runner-owned table so a view can say what drifted without running eight queries of
 *  its own. Nothing else is written: no entity is touched, no state moves, no chore is
 *  proposed.
 *
 *  A doctor failure never stops a tick: a check that could take the runner down with it
 *  would be a worse problem than the drift it looks for, so every invariant runs inside its
 *  own boundary and a throw becomes a line in the report rather than an exception. */

/** One invariant: the sentence and the function that finds who breaks it. */
export interface Invariant {
  readonly name: string;
  readonly check: (s: Snapshot) => readonly Violation[];
}

/** A ready task no pass can dispatch, and the refusal that explains it.
 *
 *  The allocator refuses a task it cannot place with `no worker free for role <role>`, and
 *  clears that reason on the next tick. When the workforce holds nobody of the role at all
 *  the sentence is true every pass and for ever: the task sits `ready` for ever, and the
 *  refusal reads like a queue rather than a stop. `system` is the live case.
 *
 *  Pure over the snapshot — the record says both the task's role and every worker's — so
 *  this is an invariant like any other. It is the runner's rather than core's only because
 *  core's set is what `wecode doctor` and the tick are held to sharing verbatim. */
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

/** The pure set: core's, plus the checks that are the runner's own. The file-length check is
 *  not here — it reads a tree rather than the record, so it is built per repository and added
 *  to the Doctor's own default below. `runChecks` and `checksOf` still default to core's set,
 *  the one the command and the tick are held to agreeing on. */
export const RUNNER_INVARIANTS: readonly Invariant[] = [...INVARIANTS, readyTaskCanBeDispatched];

/** The columns this module reads, and only those. A narrow declaration is not a second copy
 *  of the schema: it is the ask, and `typed-runner-doctor.test.ts` holds each list against
 *  `PRAGMA table_info` so a column renamed out from under it fails a test. */
const release = table<{ id: number; slug: string; state: string }>("release", ["id", "slug", "state"]);
const epic = table<{ id: number; slug: string; state: string; release_id: number }>("epic", [
  "id",
  "slug",
  "state",
  "release_id",
]);
const story = table<{ id: number; slug: string; state: string; epic_id: number }>("story", [
  "id",
  "slug",
  "state",
  "epic_id",
]);
const requirement = table<{ id: number; slug: string; state: string; story_id: number }>("requirement", [
  "id",
  "slug",
  "state",
  "story_id",
]);
const criteria = table<{ id: number; slug: string; state: string; requirement_id: number }>("acceptance_criteria", [
  "id",
  "slug",
  "state",
  "requirement_id",
]);
const acceptanceTest = table<{
  id: number;
  slug: string;
  state: string;
  parent_id: number;
  red_at_base_sha: string | null;
  script_path: string | null;
}>("acceptance_test", ["id", "slug", "state", "parent_id", "red_at_base_sha", "script_path"]);
const taskTable = table<{
  id: number;
  slug: string;
  state: string;
  acceptance_test_id: number;
  role: string;
}>("task", ["id", "slug", "state", "acceptance_test_id", "role"]);
const taskTest = table<{ id: number; slug: string; state: string; parent_id: number }>("task_test", [
  "id",
  "slug",
  "state",
  "parent_id",
]);
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

/** `rowid` is the order this table is read back in and is a real column of it; `table_info`
 *  does not list it, which is why the test that holds these lists against the schema names
 *  it as the one exception. */
interface ViolationRow {
  rowid?: number;
  invariant: string;
  entity: string;
  entity_id: number | null;
  slug: string;
  detail: string;
  found_at: string;
}
const doctorViolation = table<ViolationRow>("doctor_violation", [
  "rowid",
  "invariant",
  "entity",
  "entity_id",
  "slug",
  "detail",
  "found_at",
]);

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

/** Where each entity's rows come from, flattened to the node shape. The one place in the
 *  runner that knows the shape of the tables. Closures rather than a table name and a foreign
 *  key name, because `parent_id` is an alias and the dialect has none: each entity says which
 *  of its own columns is the parent, where it can be checked against the column declared. */
type Node = Omit<RecordNode, "entity">;

const TABLES: readonly { entity: RecordNode["entity"]; nodes: (q: Dialect) => readonly Node[] }[] = [
  { entity: "release", nodes: (q) => q.selectFrom(release).all().map((r) => ({ ...r, parent_id: null })) },
  {
    entity: "epic",
    nodes: (q) => q.selectFrom(epic).all().map(({ release_id, ...r }) => ({ ...r, parent_id: release_id })),
  },
  {
    entity: "story",
    nodes: (q) => q.selectFrom(story).all().map(({ epic_id, ...r }) => ({ ...r, parent_id: epic_id })),
  },
  {
    entity: "requirement",
    nodes: (q) => q.selectFrom(requirement).all().map(({ story_id, ...r }) => ({ ...r, parent_id: story_id })),
  },
  {
    entity: "acceptance_criteria",
    nodes: (q) => q.selectFrom(criteria).all().map(({ requirement_id, ...r }) => ({ ...r, parent_id: requirement_id })),
  },
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

/** Every task, against the story it proves. The four joins the two queries below used to each
 *  spell, walked once here: the dialect has no JOIN, and one walk is one copy of the chain
 *  rather than two that have to agree. */
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

/** The check, wired to a record. Runner-owned, like `landed_branch`: the ledger says what is
 *  true of the work, this says what this pass observed about it. Rewritten whole every tick —
 *  a violation that has been fixed is not history worth keeping. */
export class Doctor {
  constructor(
    private readonly db: DatabaseSync,
    /** The tick's set: the pure ones, plus the tree read against the repository the record
     *  names. A caller passes its own only to test the boundary itself. */
    private readonly invariants: readonly Invariant[] = [...RUNNER_INVARIANTS, fileCeilingInvariant(repoOf(db))],
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
    return { found, looked: lookedAt(this.invariants, world, found) };
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
 *  `delivered_story_has_landed` has been broken for five stories that did land: the marker
 *  is written only on the path that merges from now on, and theirs merged before that path
 *  existed. Their land commits are in the base, one each, subject `land story/<slug>`, so
 *  the sha is read off the world and copied onto the record rather than guessed.
 *
 *  Read-only on git, additive on the record, a ledger line for every marker written, and
 *  the ambiguous cases — no such commit, or more than one — refused rather than resolved:
 *  an unexplained fix is worse than visible drift. */

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
 *  needs the world. The tick and `wecode doctor` run exactly this. A check that throws is not
 *  silently dropped — it becomes a violation naming itself, because an invariant nobody can
 *  evaluate needs seeing as much as one that failed. */
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

/** What a pass looked at, built from the set it ran and what that pass returned. Derived
 *  rather than collected inside `runChecks`, so the two halves that share that function —
 *  the tick and `wecode doctor` — cannot come apart over a count. */
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
    // A pure check needs nothing of the world, so it is reachable in the only sense that
    // applies to it: everything it reads was there.
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

/** The safe heal for `delivered_story_has_landed`, applied to what a check already found.
 *  This takes its violations as an argument rather than running a pass of its own, so
 *  nothing here can change what was reported. */
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
    // No commit to copy, but the branch is in: the story reached the base inside somebody
    // else's merge. No sha is the answer, so the ledger carries what is true instead.
    if (ancestryOf(git, base)(storyBranch(v.slug)) === "in") {
      writeReached(db, v.id);
      reached.push({ story: v.id, slug: v.slug });
      continue;
    }
    left.push({ story: v.id, slug: v.slug, why });
  }
  return { written, reached, left };
}

/** The ledger line for a story that is in the base with nothing to name. Said once: a second
 *  heal of the same story would be the same sentence again. */
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

/** Commits in the base whose subject is exactly `land story/<slug>`. `--grep` narrows, the
 *  comparison decides: `land story/a` is a substring of `land story/ab`. */
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
 *  it and what it read the sha off. One transaction: a marker with no ledger line behind it
 *  is exactly the unexplained fix 19 forbids. */
function writeMarker(db: DatabaseSync, storyId: number, slug: string, sha: string): void {
  // DDL, which the dialect does not spell and should not: a table this module owns is
  // created by this module, and there is no column name here for a typecheck to catch.
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
