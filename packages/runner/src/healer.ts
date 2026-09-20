import {
  answerApproval,
  attributedTo,
  choreFor,
  Engine,
  ensureChore,
  now,
  raiseApproval,
  setTaskScope,
  storyBranch,
  Verbs,
  waitingApprovals,
  withinCeiling,
  type RoleConfig,
  type Scope,
} from "@wecode/core";
// The dialect is core's and is deliberately not on core's barrel, so it is reached by the
// path core builds it to — the same specifier `doctor.ts` uses for the same reason.
import { queries, table } from "@wecode/core/dist/db.js";
import type { DatabaseSync } from "node:sqlite";

/** docs/design/19, the healing, for a task that stopped.
 *
 *  A task reaches `failed` only through `give_up`, whose guard is `max_retry_reached`: a
 *  failed task is an exhausted one, and nothing in the runner brings it back, because a
 *  fourth attempt is a judgement about why the first three did not work. This is the half
 *  of that judgement a machine may make — the causes that are *not* about the code, where
 *  the fix is reversible and loses nothing:
 *
 *  | cause | the safe fix |
 *  |---|---|
 *  | the story tree is behind the base | a `refresh` chore, and the retry once it proves |
 *  | the failing test is outside the write scope | that one file added to the scope, and the retry |
 *
 *  Everything else is left alone and said out loud. 19 forbids inventing work and forbids
 *  an unexplained fix, so every retry here carries the finding as its reason: it rides on
 *  the ledger's actor, which is the one column that survives beside the transition it
 *  explains, and it is what the next attempt reads to know why it is getting a fourth go. */

/** The story tree is not the tree the base is at. Read off git, never off the record. */
export const BEHIND_THE_BASE = "behind_the_base";

/** The task could not write the file its own test lives in. Read off the record alone. */
export const TEST_OUTSIDE_SCOPE = "test_outside_scope";

export type Cause = typeof BEHIND_THE_BASE | typeof TEST_OUTSIDE_SCOPE;

/** What the branch is, as the heal is allowed to see it: is the base in it? Injected for the
 *  same reason `doctor.ts` injects git — the runner is the half that may read the world, and
 *  a diagnosis is worth nothing if the test for it can only be written against a repository. */
export type Behind = (branch: string) => boolean;

/** One failed task, and what a pass made of it. `cause` is null when nothing safe is known,
 *  and then `finding` is the sentence saying so. */
export interface Diagnosis {
  readonly task: number;
  readonly slug: string;
  readonly story: number;
  readonly story_slug: string;
  readonly cause: Cause | null;
  readonly finding: string;
  /** The file the fix would add to the scope. Only ever set for `test_outside_scope`. */
  readonly file: string | null;
}

/** A task put back in the queue, and the sentence the next attempt reads. */
export interface Repaired {
  readonly task: number;
  readonly slug: string;
  readonly cause: Cause;
  readonly reason: string;
  /** The file added to the write scope, when that was the fix. */
  readonly widened: string | null;
}

/** Work raised for a cause whose fix is somebody's attempt rather than a row. The task stays
 *  failed: it is retried on the pass after the chore proves, and not before. */
export interface Waiting {
  readonly task: number;
  readonly slug: string;
  readonly chore: number;
  readonly finding: string;
}

/** A failed task this pass would not touch, and why. */
export interface LeftAlone {
  readonly task: number;
  readonly slug: string;
  readonly why: string;
}

export interface TaskHealReport {
  readonly repaired: readonly Repaired[];
  readonly waiting: readonly Waiting[];
  readonly left: readonly LeftAlone[];
}

export interface HealTasksOptions {
  /** How the world is asked. A pass with no answer heals only what the record can prove. */
  readonly behind?: Behind;
  /** The ceiling a widened scope is held to. Null skips the check, as `setTaskScope` does. */
  readonly roles?: RoleConfig | null;
  /** Who the ledger says did it. */
  readonly actor?: string;
  /** The base, as it is named in a finding. */
  readonly base?: string;
}

const taskTable = table<{
  id: number;
  slug: string;
  state: string;
  acceptance_test_id: number;
  scope: string;
  attempts: number;
  updated_at: string;
}>("task", ["id", "slug", "state", "acceptance_test_id", "scope", "attempts", "updated_at"]);

const taskTest = table<{ id: number; parent_id: number; state: string; artefact: string | null }>("task_test", [
  "id",
  "parent_id",
  "state",
  "artefact",
]);

const acceptanceTest = table<{ id: number; parent_id: number; artefact: string | null }>("acceptance_test", [
  "id",
  "parent_id",
  "artefact",
]);

const criteria = table<{ id: number; requirement_id: number }>("acceptance_criteria", ["id", "requirement_id"]);
const requirement = table<{ id: number; story_id: number }>("requirement", ["id", "story_id"]);
const story = table<{ id: number; slug: string; epic_id: number }>("story", ["id", "slug", "epic_id"]);
const epic = table<{ id: number; release_id: number }>("epic", ["id", "release_id"]);
const release = table<{ id: number; project_id: number }>("release", ["id", "project_id"]);

const ledger = table<{ entity: string; entity_id: number; to_state: string; at: string }>("ledger", [
  "entity",
  "entity_id",
  "to_state",
  "at",
]);

/** The story a task proves for, walked once. The dialect has no JOIN, and one walk is one
 *  copy of the chain rather than four queries that have to agree. */
interface Owner {
  readonly story: number;
  readonly slug: string;
  readonly project: number;
}

function owners(db: DatabaseSync): Map<number, Owner> {
  const q = queries(db);
  const projectOfRelease = new Map(q.selectFrom(release).all().map((r) => [r.id, r.project_id]));
  const projectOfEpic = new Map(
    q.selectFrom(epic).all().flatMap((e) => {
      const p = projectOfRelease.get(e.release_id);
      return p === undefined ? [] : [[e.id, p] as [number, number]];
    }),
  );
  const byStory = new Map(
    q.selectFrom(story).all().map((s) => [s.id, { story: s.id, slug: s.slug, project: projectOfEpic.get(s.epic_id) ?? 0 }]),
  );
  const byRequirement = new Map(
    q.selectFrom(requirement).all().flatMap((r) => {
      const s = byStory.get(r.story_id);
      return s === undefined ? [] : [[r.id, s] as [number, Owner]];
    }),
  );
  const byCriteria = new Map(
    q.selectFrom(criteria).all().flatMap((c) => {
      const s = byRequirement.get(c.requirement_id);
      return s === undefined ? [] : [[c.id, s] as [number, Owner]];
    }),
  );
  const byTest = new Map(
    q.selectFrom(acceptanceTest).all().flatMap((a) => {
      const s = byCriteria.get(a.parent_id);
      return s === undefined ? [] : [[a.id, s] as [number, Owner]];
    }),
  );
  return new Map(
    q.selectFrom(taskTable).all().flatMap((t) => {
      const s = byTest.get(t.acceptance_test_id);
      return s === undefined ? [] : [[t.id, s] as [number, Owner]];
    }),
  );
}

/** A scope as it was written down. A row nobody can read is an empty scope, not a throw:
 *  the heal declining to act is a better answer than a pass that dies on one bad row. */
function scopeOf(row: string): Scope {
  try {
    const parsed: unknown = JSON.parse(row);
    const s = parsed as Partial<Scope>;
    return {
      write: Array.isArray(s.write) ? s.write.filter((w): w is string => typeof w === "string") : [],
      tools: Array.isArray(s.tools) ? s.tools.filter((w): w is string => typeof w === "string") : [],
    };
  } catch {
    return { write: [], tools: [] };
  }
}

/** Every file an artefact names. A test's artefact is a command line, and the thing in it
 *  that a scope can be compared with is a path: a token with a directory and an extension.
 *  Anything else in the line — the runner, its flags — is not a file and is not looked at. */
const PATH = /(?:^|[\s'"=])((?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z]\w*)/g;

export function filesIn(artefact: string | null): readonly string[] {
  if (artefact === null) return [];
  return [...artefact.matchAll(PATH)].map((m) => m[1] as string);
}

/** Does the scope let the task write this file? Asked of `withinCeiling`, because a path is
 *  a glob that matches itself — the same reasoning `forgetCoveredRefusals` is built on, and
 *  a second matcher that had to agree with it would be the defect. */
const covered = (scope: Scope, file: string): boolean => withinCeiling(scope, { write: [file], tools: [] }).ok;

/** The one file the task's own tests live in that it may not write. The task's tests first,
 *  because those are what it is judged by; the acceptance test after, because a task that
 *  cannot reach the test its story is proved by is the same drift one step up. */
function unreachable(db: DatabaseSync, taskId: number, parentId: number, scope: Scope): string | null {
  const q = queries(db);
  const mine = q.selectFrom(taskTest).where("parent_id", "=", taskId).all();
  const parent = q.selectFrom(acceptanceTest).where("id", "=", parentId).get();
  const files = [...mine.flatMap((t) => filesIn(t.artefact)), ...filesIn(parent?.artefact ?? null)];
  return files.find((f) => !covered(scope, f)) ?? null;
}

/** When the record last said this entity reached this state. */
function lastReached(db: DatabaseSync, entity: string, id: number, state: string): string | null {
  const rows = queries(db)
    .selectFrom(ledger)
    .select(["at"])
    .where("entity", "=", entity)
    .where("entity_id", "=", id)
    .where("to_state", "=", state)
    .all()
    .map((r) => r.at)
    .sort();
  return rows[rows.length - 1] ?? null;
}

/** One pass over the tasks that stopped, and what is known about each.
 *
 *  Reads and decides; writes nothing. `healTasks` below is the half that acts, and it takes
 *  this as an argument rather than running a pass of its own, so nothing that writes can
 *  change what was found. */
export function diagnose(db: DatabaseSync, opts: HealTasksOptions = {}): readonly Diagnosis[] {
  const behind = opts.behind ?? ((): boolean => false);
  const base = opts.base ?? "the base";
  const by = owners(db);
  const found: Diagnosis[] = [];

  for (const row of queries(db).selectFrom(taskTable).where("state", "=", "failed").all().sort((a, b) => a.id - b.id)) {
    const owner = by.get(row.id);
    if (owner === undefined) continue;
    const seen = { task: row.id, slug: row.slug, story: owner.story, story_slug: owner.slug };
    const branch = storyBranch(owner.slug);
    const chore = choreFor(db, "refresh", "story", owner.story);

    // The world first: a tree that is behind now is behind whatever else is also true, and
    // an attempt made in it proves nothing about the code.
    if (safely(() => behind(branch), false)) {
      found.push({
        ...seen,
        cause: BEHIND_THE_BASE,
        finding: `${branch} does not contain ${base}, so it failed in a tree nobody has now`,
        file: null,
      });
      continue;
    }

    // The refresh is owed and undischarged: the tree it failed in is still the tree, and a
    // retry now would spend an attempt on the same wrong sources.
    if (chore !== null && chore.state !== "done") {
      found.push({
        ...seen,
        cause: BEHIND_THE_BASE,
        finding: `waiting on its refresh: chore #${chore.id} is ${chore.state}`,
        file: null,
      });
      continue;
    }

    // The refresh proved, and this task failed before it did. The sources it was judged
    // against are not the sources it would be judged against now, which is a reason a
    // fourth attempt goes differently — the one thing a retry has to be able to say.
    const proved = chore === null ? null : lastReached(db, "chore", chore.id, "done");
    const stopped = lastReached(db, "task", row.id, "failed") ?? row.updated_at;
    if (chore !== null && chore.state === "done" && proved !== null && stopped < proved) {
      found.push({
        ...seen,
        cause: BEHIND_THE_BASE,
        finding: `it failed in a tree behind ${base}, and refresh chore #${chore.id} has since proved`,
        file: null,
      });
      continue;
    }

    const file = unreachable(db, row.id, row.acceptance_test_id, scopeOf(row.scope));
    if (file !== null) {
      found.push({
        ...seen,
        cause: TEST_OUTSIDE_SCOPE,
        finding: `its test is ${file}, which its write scope does not cover`,
        file,
      });
      continue;
    }

    found.push({
      ...seen,
      cause: null,
      finding: `exhausted, and no cause with a safe fix — a person decides whether a further attempt is owed`,
      file: null,
    });
  }
  return found;
}

/** The safe heals for a task that stopped, applied to what `diagnose` already found.
 *
 *  Additive on the record and reversible: a chore raised, a file added to a scope, a task
 *  back in the queue with the finding on the ledger beside it. Nothing here drops a row,
 *  changes a verdict, or decides what should be built. */
export function healTasks(db: DatabaseSync, found: readonly Diagnosis[], opts: HealTasksOptions = {}): TaskHealReport {
  const actor = opts.actor ?? "doctor";
  const repaired: Repaired[] = [];
  const waiting: Waiting[] = [];
  const left: LeftAlone[] = [];

  for (const d of found) {
    if (d.cause === null) {
      left.push({ task: d.task, slug: d.slug, why: d.finding });
      continue;
    }

    if (d.cause === BEHIND_THE_BASE) {
      const owed = raiseRefresh(db, d);
      if (owed !== null) {
        waiting.push({ task: d.task, slug: d.slug, chore: owed, finding: d.finding });
        continue;
      }
      if (retry(db, d, actor)) repaired.push({ task: d.task, slug: d.slug, cause: d.cause, reason: d.finding, widened: null });
      else left.push({ task: d.task, slug: d.slug, why: `the retry was refused` });
      continue;
    }

    const widened = widen(db, d, opts.roles ?? null);
    if (widened !== null) {
      left.push({ task: d.task, slug: d.slug, why: widened });
      continue;
    }
    if (retry(db, d, actor)) {
      repaired.push({ task: d.task, slug: d.slug, cause: d.cause, reason: d.finding, widened: d.file });
    } else {
      left.push({ task: d.task, slug: d.slug, why: `the retry was refused` });
    }
  }
  return { repaired, waiting, left };
}

/** The chore this cause is owed, when it is owed one. Returns the chore to wait on, or null
 *  when the refresh has already proved and the retry is what is left.
 *
 *  `ensureChore` is idempotent on (kind, target), which is the condition itself: a pass a
 *  minute over one stale tree is one row, not one row a minute. */
function raiseRefresh(db: DatabaseSync, d: Diagnosis): number | null {
  const existing = choreFor(db, "refresh", "story", d.story);
  if (existing !== null && existing.state === "done") return null;
  const project = owners(db).get(d.task)?.project ?? 0;
  const raised = ensureChore(db, {
    project_id: project,
    kind: "refresh",
    target_type: "story",
    target_id: d.story,
    check: "the base is an ancestor of the branch",
  });
  return raised.id;
}

/** The file added to the write scope, or the sentence saying why it was not. A widening the
 *  role's ceiling forbids is not this heal's to make: the ceiling is a person's decision and
 *  the drift stays on the board rather than being quietly stepped over. */
function widen(db: DatabaseSync, d: Diagnosis, roles: RoleConfig | null): string | null {
  if (d.file === null) return `no file to add`;
  const row = queries(db).selectFrom(taskTable).select(["scope"]).where("id", "=", d.task).get();
  if (row === null) return `no task #${d.task}`;
  const scope = scopeOf(row.scope);
  const wider: Scope = { write: [...scope.write, d.file], tools: scope.tools };
  try {
    setTaskScope(db, d.task, wider, roles);
    return null;
  } catch (err) {
    return `${d.file} is outside the role's ceiling: ${(err as Error).message}`;
  }
}

/** failed → ready, with the finding riding on the actor, and the counter back to zero.
 *
 *  Both halves or neither: a retry whose counter is left at the limit fails `max_retry` on
 *  the next tick and the task is given up again without a further attempt ever being made,
 *  which is the dangle this heal exists to clear. The same two statements `wecode task
 *  retry` makes, because this is that verb with the machine supplying the reason. */
function retry(db: DatabaseSync, d: Diagnosis, actor: string): boolean {
  const out = new Verbs(new Engine(db)).retryTask(d.task, attributedTo(actor, d.finding));
  if (!out.ok) return false;
  queries(db).update(taskTable).set({ attempts: 0, updated_at: now() }).where("id", "=", d.task).run();
  return true;
}

/** A port that threw is a port that answered nothing. A heal that could not ask the world
 *  reports on what the record says and leaves the rest standing. */
function safely<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** docs/design/16, applied to a design rather than to a task.
 *
 *  A design is drafted before it is drawn, and a drafted design that crosses a port — a
 *  seam where the machine stops and a person starts, the screen being the one everybody
 *  means — is not wecode's to accept. Until now nothing raised it: the design sat in
 *  `drafted`, `needs you` never showed it, and the board said nothing waited on the
 *  operator while a design did. A question nobody can see is a question nobody answers.
 *
 *  So the same route the rest of 16 uses: an approval, which is an assignment whose worker
 *  is a person, raised into `waiting` where the board already draws it. The row names the
 *  screen and carries the path of the projected mockup, because a person signing a design
 *  signs a picture and not a number, and it closes the moment the design is accepted or
 *  dropped — the answer is the operator's own act, read back off the world. */

/** What the world says a design is. Injected for the same reason `Behind` is: a design
 *  lives in a file, reading a file is reading the world, and a diagnosis worth nothing if
 *  the test for it can only be written against a checkout is a diagnosis worth nothing. */
export interface Design {
  /** The screen it designs, as the approval will name it. */
  readonly screen: string;
  /** `drafted` until a person says otherwise, then `accepted` or `dropped`. */
  readonly state: string;
  /** The ports it crosses. A design that crosses none is wecode's to judge alone. */
  readonly crosses: readonly string[];
  /** Where the projected mockup was written. */
  readonly mockup: string;
  /** The task that drafted it: what the question hangs on, so the approval is read against
   *  the work and not against a filename. */
  readonly task: number;
}

/** The one state that is nobody's answer yet. */
export const DRAFTED = "drafted";

/** The two answers that close the question, and the only ones the approval offers. */
export const ACCEPTED = "accepted";
export const DROPPED = "dropped";

/** A design put in front of a person. */
export interface Asked {
  readonly screen: string;
  readonly approval: number;
  readonly mockup: string;
}

/** A design a person answered, and the assignment that answer closed. */
export interface Signed {
  readonly screen: string;
  readonly approval: number;
  readonly answer: string;
}

export interface DesignHealReport {
  readonly asked: readonly Asked[];
  readonly closed: readonly Signed[];
  readonly left: readonly LeftAlone[];
}

export interface HealDesignsOptions {
  /** The person asked. Defaults to the one human worker, when there is exactly one. */
  readonly operator?: string;
}

const workerRow = table<{ id: number; name: string; kind: string }>("worker", ["id", "name", "kind"]);

/** The question, which is also the key. It carries the screen and the mockup path because
 *  those are what is being signed; it is matched on the screen alone, so a design whose
 *  ports change is the same question asked once and not a second row. */
const asks = (d: Design): string =>
  `the design of the ${d.screen} screen is drafted and crosses ${d.crosses.join(", ")}: ` +
  `accept it or drop it. Its projected mockup is ${d.mockup}`;

const about = (screen: string): string => `the design of the ${screen} screen`;

/** The approval already standing for this screen, if one is. */
const standing = (db: DatabaseSync, screen: string) =>
  waitingApprovals(db).find((a) => (a.question ?? "").startsWith(about(screen))) ?? null;

/** Who is asked. A name given is a name honoured or nothing; with no name, the sole human
 *  worker — because a workspace with two people has no obvious one to burden, and picking
 *  for them would be wecode deciding whose signature a design needs. */
function operatorOf(db: DatabaseSync, named: string | undefined): { id: number; name: string } | null {
  const people = queries(db).selectFrom(workerRow).all().filter((w) => w.kind === "human");
  const found = named === undefined ? (people.length === 1 ? people[0] : undefined) : people.find((w) => w.name === named);
  return found === undefined ? null : { id: found.id, name: found.name };
}

/** One pass over the designs the world has, raising what a person owes an answer on and
 *  closing what they have since answered.
 *
 *  Additive and reversible, like every other heal here: a question raised, a question
 *  closed. Nothing accepts a design, because accepting one is the whole of what is being
 *  asked. */
export function healDesigns(
  db: DatabaseSync,
  designs: readonly Design[],
  opts: HealDesignsOptions = {},
): DesignHealReport {
  const asked: Asked[] = [];
  const closed: Signed[] = [];
  const left: LeftAlone[] = [];
  const who = operatorOf(db, opts.operator);

  for (const d of designs) {
    const seen = { task: d.task, slug: d.screen };
    const open = standing(db, d.screen);

    if (d.state !== DRAFTED) {
      if (open === null) continue;
      const answer = d.state === ACCEPTED ? ACCEPTED : DROPPED;
      if (who === null) {
        left.push({ ...seen, why: `${about(d.screen)} is ${d.state} and there is no operator to close it in the name of` });
        continue;
      }
      answerApproval(db, open.id, answer, who.name);
      closed.push({ screen: d.screen, approval: open.id, answer });
      continue;
    }

    if (d.crosses.length === 0) {
      left.push({ ...seen, why: `${about(d.screen)} crosses no port, so nobody has to sign it` });
      continue;
    }
    if (open !== null) {
      left.push({ ...seen, why: `${about(d.screen)} is already waiting on approval #${open.id}` });
      continue;
    }
    if (who === null) {
      left.push({ ...seen, why: `${about(d.screen)} needs a signature and no human worker is there to give it` });
      continue;
    }

    const raised = raiseApproval(db, {
      objective_type: "task",
      objective_id: d.task,
      worker_id: who.id,
      question: asks(d),
      options: [ACCEPTED, DROPPED],
    });
    asked.push({ screen: d.screen, approval: raised.id, mockup: d.mockup });
  }
  return { asked, closed, left };
}
