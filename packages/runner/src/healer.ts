import {
  APPROVAL_KIND,
  attributedTo,
  choreFor,
  Engine,
  ensureChore,
  now,
  raiseApproval,
  setTaskScope,
  storyBranch,
  Verbs,
  withinCeiling,
  type ChoreKind,
  type ObjectiveType,
  type RoleConfig,
  type Scope,
  type Violation,
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

/** docs/design/19, the healing, for a violation the check left open.
 *
 *  `healTasks` above is this rule applied to one failed task. This is the same rule applied
 *  to the drift itself: a check reports and changes nothing, and what a pass may then do
 *  about what it reported divides in exactly two places.
 *
 *  A violation whose fix is deterministic — nothing to judge, nothing to invent, nothing a
 *  person would want a say in — becomes a chore, which is work wecode raises for itself and
 *  a system worker performs. Every other violation becomes an approval: a question on the
 *  board, asked of a person, against the work it is about. Neither is a fix. A chore is work
 *  owed and an approval is a question owed, and the violation stands until one of them is
 *  discharged and the next pass stops reporting it.
 *
 *  Nothing here heals in silence and nothing here decides what should be built. */

/** What a violation's fix is. `safe` is the whole judgement, and it is data rather than a
 *  branch: whether a machine may make this fix is a property of the invariant, and it is
 *  written down once, in one table, where a person can read the column and disagree. */
export type Remedy =
  | { readonly safe: true; readonly chore: ChoreKind; readonly check: string }
  | { readonly safe: false; readonly why: string };

/** Said of an invariant this table has never heard of — a check added since, or one that
 *  threw and reported itself. Unknown is not safe: a fix nobody has reasoned about is the
 *  one most worth asking about. */
export const NOT_REASONED_ABOUT: Remedy = {
  safe: false,
  why: "no remedy has been reasoned about for this check, so nobody has said a machine may make it",
};

/** Every invariant, and the fix it gets. A data definition, and it belongs in config beside
 *  the checks themselves — `config/invariants.yaml`, the file core's `PARENTS` is already
 *  waiting on. It is a literal here for the same reason that one is: this slice may not add
 *  a config file, and one copy with one consumer is better than two that must agree.
 *
 *  Only one row is safe today, and that is the point of the column rather than a gap in it.
 *  `delivered_story_has_landed` is a merge the gate already permitted — the story was
 *  delivered, which is the decision — so the branch reaching the base is a `land` chore and
 *  asking would be asking a person to approve what they approved by delivering it. Every
 *  other sentence here is broken by something only a person can settle: what a story in
 *  progress with no requirement under it should have, whether an all-dropped tree was
 *  abandoned or mis-stated, whether a red test is re-run or withdrawn. A machine that picked
 *  one would be inventing work, which 19 forbids outright. */
export const REMEDIES: Readonly<Record<string, Remedy>> = {
  delivered_story_has_landed: {
    safe: true,
    chore: "land",
    check: "the story branch is an ancestor of the base",
  },
  story_in_progress_has_a_requirement: {
    safe: false,
    why: "what this story should have under it is work nobody has written down, and inventing it is not a fix",
  },
  all_children_dropped_is_not_success: {
    safe: false,
    why: "either the children were abandoned or the parent is over-claiming, and only a person knows which",
  },
  ready_acceptance_test_was_red_at_base: {
    safe: false,
    why: "the missing fact is a run at the base, and a machine recording one it did not make would be a lie",
  },
  ready_task_has_a_ready_task_test: {
    safe: false,
    why: "how a task proves itself is the task's own statement, and a machine may not write it",
  },
  failing_criteria_has_an_open_task: {
    safe: false,
    why: "whether this criteria is still pursued, and by what work, is the decision itself",
  },
  role_with_ready_work_has_a_worker: {
    safe: false,
    why: "a worker is a person's to bring, and work waiting on a role nobody fills is theirs to see",
  },
  schema_version_is_understood: {
    safe: false,
    why: "the record is being read by the wrong rules, and migrating it is not something to do unasked",
  },
  verdict_provenance_is_current: {
    safe: false,
    why: "the only remedy is proving it again, which changes a verdict, and 19 says healing never does",
  },
  runner_build_is_current: {
    safe: false,
    why: "a restart is owed, and a process that decides to replace itself mid-attempt is the worse problem",
  },
};

/** A violation turned into work. */
export interface Chored {
  readonly invariant: string;
  readonly slug: string;
  readonly chore: number;
  readonly kind: ChoreKind;
}

/** A violation turned into a question. */
export interface Asked {
  readonly invariant: string;
  readonly slug: string;
  readonly approval: number;
  readonly question: string;
}

/** A violation this pass turned into neither, and why. It is still reported by the check;
 *  all that is missing is somewhere to put it. */
export interface Standing {
  readonly invariant: string;
  readonly slug: string;
  readonly why: string;
}

export interface ViolationHealReport {
  readonly chored: readonly Chored[];
  readonly asked: readonly Asked[];
  readonly standing: readonly Standing[];
}

export interface HealViolationsOptions {
  /** The person the questions are asked of. Defaults to the first human worker on the
   *  record — with none, nothing is asked, because an approval with nobody to answer it is
   *  a row on the board that waits for ever. */
  readonly operator?: number;
  /** Who the ledger says raised the chores. */
  readonly actor?: string;
}

/** The three objective kinds an approval may hang on. Core's list, not a copy of a policy:
 *  `raiseApproval` refuses anything else, because a question is answered against the work it
 *  is about and `story #4` is not work anybody can read a statement off. This heal does not
 *  widen it and does not step around it — a violation on a story is left standing, saying so,
 *  rather than being hung on some task underneath that the person was not asked about. */
const OBJECTIVES: readonly string[] = ["task", "acceptance_test", "task_test"];

const anyAssignment = table<{
  id: number;
  objective_type: string;
  objective_id: number;
  kind: string | null;
  question: string | null;
}>("assignment", ["id", "objective_type", "objective_id", "kind", "question"]);

const workerRow = table<{ id: number; kind: string }>("worker", ["id", "kind"]);

/** The remedy for this invariant, never undefined. */
export const remedyFor = (invariant: string): Remedy => REMEDIES[invariant] ?? NOT_REASONED_ABOUT;

/** What the person is asked. Derived from the violation alone, which is what makes asking
 *  twice detectable: the same drift phrases the same question, and a record that has moved
 *  phrases a different one. */
export const questionFor = (v: Violation, remedy: Remedy): string =>
  `${v.invariant}: ${v.detail}. ` +
  (remedy.safe ? "" : `${remedy.why}. `) +
  `What should be done about ${v.entity} ${v.slug}${v.id === null ? "" : ` #${v.id}`}?`;

/** Every open violation, turned into the one thing a machine may do about it.
 *
 *  Takes what a check already found rather than running a pass of its own, for the same
 *  reason `healTasks` does: the half that reports and the half that acts stay apart, and
 *  nothing that writes can change what was found. */
export function healViolations(
  db: DatabaseSync,
  found: readonly Violation[],
  opts: HealViolationsOptions = {},
): ViolationHealReport {
  const actor = opts.actor ?? "doctor";
  const chored: Chored[] = [];
  const asked: Asked[] = [];
  const standing: Standing[] = [];

  for (const v of found) {
    const remedy = remedyFor(v.invariant);
    const out = remedy.safe ? raise(db, v, remedy, actor) : ask(db, v, remedy, opts.operator);
    if (typeof out === "string") {
      standing.push({ invariant: v.invariant, slug: v.slug, why: out });
      continue;
    }
    if ("chore" in out) chored.push(out);
    else asked.push(out);
  }
  return { chored, asked, standing };
}

/** The chore this violation is owed, or the sentence saying why none was raised.
 *
 *  `ensureChore` is idempotent on (kind, target), which is the condition itself: a check that
 *  reports the same drift every tick raises one chore, not one chore a tick. */
function raise(
  db: DatabaseSync,
  v: Violation,
  remedy: Remedy & { safe: true },
  actor: string,
): Chored | string {
  if (v.id === null) return `${v.invariant} names no row, and a chore is raised against one`;
  // A chore's target is a story or a project, and the safe remedies are all about a story.
  // A row that is neither is drift about this table rather than about the record.
  if (v.entity !== "story") return `a ${remedy.chore} chore is raised on a story, and this names a ${v.entity}`;
  const project = projectOfStory(db, v.id);
  if (project === 0) return `story #${v.id} belongs to no project, so there is nowhere to raise the chore`;
  try {
    const made = ensureChore(
      db,
      { project_id: project, kind: remedy.chore, target_type: "story", target_id: v.id, check: remedy.check },
      actor,
    );
    return { invariant: v.invariant, slug: v.slug, chore: made.id, kind: remedy.chore };
  } catch (err) {
    return `the ${remedy.chore} chore could not be raised: ${(err as Error).message}`;
  }
}

/** The question this violation is owed, or the sentence saying why none was asked. */
function ask(db: DatabaseSync, v: Violation, remedy: Remedy, operator: number | undefined): Asked | string {
  if (v.id === null || !OBJECTIVES.includes(v.entity)) {
    return `an approval is asked against ${OBJECTIVES.join(", ")}, and this names ${v.entity}`;
  }
  const person = operator ?? firstHuman(db);
  if (person === null) return `there is no human worker on the record to ask`;

  const question = questionFor(v, remedy);
  // Asked once, ever, for this question on this objective — including one already answered.
  // A person who has settled a question is not asked it again on the next tick, and a record
  // that has moved under it phrases a different question and is asked that one.
  const said = alreadyAsked(db, v.entity, v.id, question);
  if (said !== null) return { invariant: v.invariant, slug: v.slug, approval: said, question };

  try {
    const raised = raiseApproval(db, {
      objective_type: v.entity as ObjectiveType,
      objective_id: v.id,
      worker_id: person,
      question,
    });
    return { invariant: v.invariant, slug: v.slug, approval: raised.id, question };
  } catch (err) {
    return `the approval could not be raised: ${(err as Error).message}`;
  }
}

/** The id of an approval already carrying this question about this objective, or null. */
function alreadyAsked(db: DatabaseSync, type: string, id: number, question: string): number | null {
  const row = queries(db)
    .selectFrom(anyAssignment)
    .where("objective_type", "=", type)
    .where("objective_id", "=", id)
    .where("kind", "=", APPROVAL_KIND)
    .where("question", "=", question)
    .all()
    .sort((a, b) => a.id - b.id)[0];
  return row?.id ?? null;
}

/** Who wecode asks when the caller did not say. The first person on the record, by id. */
function firstHuman(db: DatabaseSync): number | null {
  const rows = queries(db)
    .selectFrom(workerRow)
    .all()
    .filter((w) => w.kind === "human")
    .sort((a, b) => a.id - b.id);
  return rows[0]?.id ?? null;
}

/** The project a story serves, walked up the chain. Zero when any step is missing, which is
 *  a story nothing can be raised against rather than a throw. */
function projectOfStory(db: DatabaseSync, storyId: number): number {
  const q = queries(db);
  const s = q.selectFrom(story).where("id", "=", storyId).get();
  if (s === null) return 0;
  const e = q.selectFrom(epic).where("id", "=", s.epic_id).get();
  if (e === null) return 0;
  return q.selectFrom(release).where("id", "=", e.release_id).get()?.project_id ?? 0;
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
