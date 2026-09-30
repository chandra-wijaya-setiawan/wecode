/** Why a candidate was passed over is the same fact as why a bulk action declined an
 *  id, so Refusal has one definition, in types. */
import type { Refusal, StatefulEntity } from "./types.js";
import type { DatabaseSync } from "node:sqlite";
import { CHORE_KIND_DEFS, choreCandidates, clearChoreRefusal, recordChoreRefusal, type ChoreKind } from "./chore.js";
import { queries, table } from "./db.js";
import { NO_DEPENDENCIES, prerequisitesOf, type Dependencies } from "./depends.js";
import type { Budget, Scope } from "./entities.js";
import { successOf } from "./invariants.js";
import { Repo } from "./repo.js";
import type { RoleConfig } from "./roles.js";

/** The columns this module reads, and only those. A narrow declaration is not a second copy
 *  of the schema: it is the ask, and `typed-order.test.ts` holds each list against
 *  `PRAGMA table_info` so a column that is renamed out from under it fails a test. */
interface TaskRow {
  id: number;
  title: string;
  role: string;
  scope: string;
  budget: string;
  attempts: number;
  state: string;
}
const task = table<TaskRow>("task", ["id", "title", "role", "scope", "budget", "attempts", "state"]);

interface AssignmentRow {
  objective_type: string;
  objective_id: number;
  worker_id: number;
  scope: string;
  phase: string;
}
const assignment = table<AssignmentRow>("assignment", ["objective_type", "objective_id", "worker_id", "scope", "phase"]);

const chore = table<{ id: number; kind: string }>("chore", ["id", "kind"]);
const worker = table<{ id: number; role: string }>("worker", ["id", "role"]);

/** An assignment nobody has finished with. The dialect spells no `IN`, so the set is held
 *  here and matched in TypeScript — which is where it belonged anyway: three phase names
 *  repeated in four SQL strings were four copies of one rule. */
const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];

const openAssignments = (db: DatabaseSync): readonly AssignmentRow[] =>
  queries(db)
    .selectFrom(assignment)
    .all()
    .filter((a) => OPEN_PHASES.includes(a.phase));

/** A row per id, for the lookups that used to be joins. Undefined for an objective whose
 *  row is gone, which is what the join did with it too: it dropped the assignment. */
const byId = <T, V>(rows: readonly T[], id: (r: T) => number, value: (r: T) => V): Map<number, V> =>
  new Map(rows.map((r) => [id(r), value(r)]));

/** What kind of thing an assignment would point at. A candidate that does not say is a
 *  task: every candidate was one before chores could be chosen, and an id alone does not
 *  say which table it is in. */
export type CandidateKind = "task" | "chore";

/** A ready task, or a chore wecode owes itself, with nothing attempting it: something the
 *  allocator could choose. */
export interface Candidate {
  readonly id: number;
  readonly title: string;
  readonly role: string;
  readonly scope: Scope;
  readonly budget: Budget;
  readonly attempts: number;
  /** Absent means `task`. */
  readonly objective_type?: CandidateKind;
}

export const kindOf = (c: Candidate): CandidateKind => c.objective_type ?? "task";

/** **A chore goes before a task.** Not a tie-break and not a preference: a chore exists
 *  because something already proved is stuck — a story that will not merge is work already
 *  delivered and not yet landed — and every task started ahead of it moves the base branch
 *  further from the branch the chore has to reconcile, so the chore gets harder the longer
 *  it waits while the task only gets started later. Ids are no help here: chore #3 and task
 *  #3 are two different things, so rank decides before id is looked at.
 *
 *  This table is the only place the two kinds are ranked against each other; `ordered` is
 *  the only thing that reads it. */
const RANK: Readonly<Record<CandidateKind, number>> = { chore: 0, task: 1 };

/** The words the board and the allocator both use for a role with nobody free in it. */
export const noWorkerFree = (role: string): string => `no worker free for role ${role || "(none)"}`;

/** The half of the budget that decides order. */
export interface Ordering {
  readonly fresh_first: boolean;
}

/** What the record says is already taken, at the moment of asking. */
export interface Load {
  /** Write globs held by assignments that are open right now. */
  readonly held: readonly string[];
  /** Open assignments per role. */
  readonly openPerRole: Readonly<Record<string, number>>;
  /** The ceiling per role, where there is one. */
  readonly capPerRole: Readonly<Record<string, number>>;
  /** Workers per role with nothing open. Absent means nobody asked — a pure caller that
   *  only cares about order and collision leaves it out, and no candidate is refused for
   *  a workforce that was never counted. */
  readonly freePerRole?: Readonly<Record<string, number>>;
}

/** Two write scopes collide when either reaches into the other. */
export function collides(a: readonly string[], b: readonly string[]): boolean {
  const stem = (g: string): string => g.replace(/\*+.*$/, "");
  return a.some((x) =>
    b.some((y) => {
      const [sx, sy] = [stem(x), stem(y)];
      return sx === "" || sy === "" || sx.startsWith(sy) || sy.startsWith(sx);
    }),
  );
}

/** **What a story is waiting on, and which of the ones that are not waiting to do first.**
 *
 *  Two facts, and they are the two halves of one question, kept in separate fields for the
 *  reason migration 017 gives: a dependency is a fact about the work — checkout genuinely
 *  cannot be written before the cart — and a priority is a preference about it. Apart, a
 *  preference cannot claim a story is blocked.
 *
 *  Both arrive as a value rather than being read here, for the reason `depends.ts` gives:
 *  the rule is the part worth having exactly once, and it is the same rule whether the edges
 *  came from a plan file, from a form, or one day from rows. It is also the only shape
 *  available to this module — `typed-order.test.ts` holds the tables declared above to the
 *  four the allocator already speaks about, so `story` and `story_depends_on` cannot be
 *  asked here directly.
 *
 *  A prerequisite's *state* is the exception, and deliberately: it is read from the record,
 *  through Repo, every time the question is asked. A caller may say what the shape of the
 *  work is; it may not hand over a claim that the thing being waited for has finished. */
export interface StoryQueue {
  /** Every prerequisite edge declared so far, in the shape `depends.ts` holds them. */
  readonly depends: Dependencies;
  /** Priority per story id, lower first, as migration 017 spells the column. A story with
   *  no entry is 0 — "nobody has ranked this" — which sorts it in among the others rather
   *  than at one end. */
  readonly priority: Readonly<Record<number, number>>;
}

/** Nothing waits on anything and nobody has ranked anything: the queue as it stood before
 *  either fact could be stated, and the default.
 *
 *  It has to be inert. `board`'s queued panel is held against `readyCandidates(db)` id for
 *  id by `queue-completeness.test.ts`, so the bare call must answer exactly what it always
 *  did — a queue is something a caller opts into, not a new opinion of its own. */
export const UNORDERED: StoryQueue = { depends: NO_DEPENDENCIES, priority: {} };

/** Finished with, either way: the two states `invariants.ts` calls settled, with the success
 *  one read back through `successOf` rather than spelled a second time.
 *
 *  `dropped` counts, and that is the whole of why the rule is *settled* and not *delivered*:
 *  a story that was dropped is never going to be delivered, so a queue that kept waiting for
 *  it would hold everything behind it for ever. */
const SETTLED: readonly string[] = ["dropped", successOf("story")];

/** The story a task hangs under, by the containment climb — task, acceptance_test,
 *  acceptance_criteria, requirement, story. Null when the chain is broken, which is the same
 *  answer this module already gives an assignment pointing at a row that is gone.
 *
 *  Memoised, because the sort asks for one task's story once per comparison and every answer
 *  is four lookups. */
function storyOf(repo: Repo, id: number, cache: Map<number, number | null>): number | null {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  let at: { entity: StatefulEntity; id: number } | null = { entity: "task", id };
  while (at !== null && at.entity !== "story") at = repo.parentOf(at.entity, at.id);
  const found = at === null ? null : at.id;
  cache.set(id, found);
  return found;
}

/** Whether anything this story declared it needs has yet to settle.
 *
 *  Direct prerequisites only, as `depends.ts` holds them: if 3 needs 2 and 2 needs 1, then 3
 *  is held up by 2 and by nothing else — 2 cannot settle before 1 does, so 1 is already
 *  accounted for by the time the question is asked again.
 *
 *  A prerequisite with no row at all counts as unsettled. It can never settle, so the only
 *  alternative is to start work on the strength of a story nobody can find, and "no such
 *  story" reads exactly like "not finished yet" — which is what it is. */
const isWaiting = (repo: Repo, declared: Dependencies, story: number): boolean =>
  prerequisitesOf(declared, story).some((p) => {
    const state = repo.stateOf("story", p);
    return state === null || !SETTLED.includes(state);
  });

/** Ready tasks with no assignment attempting them and nothing unsettled in front of them, in
 *  priority then id order.
 *
 *  The exclusion is a set difference rather than a `NOT EXISTS`, and the order is applied
 *  here rather than in the query: the dialect spells neither, and both are cheap on a list
 *  the allocator is about to walk one at a time anyway.
 *
 *  Priority decides first and id still decides after it, so two candidates never tie and the
 *  same record always yields the same first choice. Under the default queue every priority is
 *  0 and this is the plain id order it has always been.
 *
 *  A task is dropped for a waiting story, not refused with a reason. `Refusal` is an id and a
 *  sentence about a candidate, and a task held back by a dependency never became one — the
 *  allocator's pass drops it at step 3, before scope and role are looked at.
 *
 *  **What this does not reach, named rather than half-done.** `nextUp` calls this without a
 *  queue, and `ordered` re-sorts what it gets by rank, attempts and id — so a priority
 *  established here would not survive that second sort. Carrying it would need a field on
 *  `Candidate`, whose shape `typed-order.test.ts` holds to six. Nothing yet loads
 *  `story_depends_on` or `story.priority` into a `StoryQueue` either; that loader is the
 *  queue task's. Dropping a waiting task *does* carry through `nextUp` once it is given a
 *  queue, because a candidate left out of this list stays left out. */
export function readyCandidates(db: DatabaseSync, queue: StoryQueue = UNORDERED): readonly Candidate[] {
  const attempted = new Set(
    openAssignments(db)
      .filter((a) => a.objective_type === "task")
      .map((a) => a.objective_id),
  );

  // Neither half of the queue is asked of the record when the queue has nothing to say: with
  // no edges declared nothing can be waiting, and with nothing ranked every priority is 0.
  // The climb to a story is four lookups per task, and the common case pays for none of them.
  const asked = queue.depends.length > 0;
  const ranked = Object.keys(queue.priority).length > 0;
  const repo = new Repo(db);
  const climbed = new Map<number, number | null>();
  const under = (id: number): number | null => storyOf(repo, id, climbed);

  const waiting = (id: number): boolean => {
    if (!asked) return false;
    const story = under(id);
    return story !== null && isWaiting(repo, queue.depends, story);
  };
  const rank = (id: number): number => {
    if (!ranked) return 0;
    const story = under(id);
    return story === null ? 0 : queue.priority[story] ?? 0;
  };

  return queries(db)
    .selectFrom(task)
    .select(["id", "title", "role", "scope", "budget", "attempts"])
    .where("state", "=", "ready")
    .all()
    .filter((r) => !attempted.has(r.id) && !waiting(r.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id - b.id)
    .map((r) => ({
      id: r.id,
      title: r.title,
      role: r.role,
      scope: JSON.parse(r.scope) as Scope,
      budget: JSON.parse(r.budget) as Budget,
      attempts: r.attempts,
    }));
}

/** What the open assignments hold right now. */
export function currentLoad(db: DatabaseSync, capPerRole: Readonly<Record<string, number>>): Load {
  const open = openAssignments(db);
  const q = queries(db);
  const roleOf = byId(
    q.selectFrom(task).select(["id", "role"]).all(),
    (t) => t.id,
    (t) => t.role,
  );
  // A chore holds its role's slot too. The role is the kind's, not a column, so it is
  // reached through the kind and folded onto the same tally as a task's role.
  const kindOfChore = byId(
    q.selectFrom(chore).all(),
    (c) => c.id,
    (c) => c.kind as ChoreKind,
  );

  const openPerRole: Record<string, number> = {};
  const count = (role: string | undefined): void => {
    if (role !== undefined) openPerRole[role] = (openPerRole[role] ?? 0) + 1;
  };
  for (const a of open) {
    if (a.objective_type === "task") count(roleOf.get(a.objective_id));
    else if (a.objective_type === "chore") {
      const kind = kindOfChore.get(a.objective_id);
      count(kind === undefined ? undefined : CHORE_KIND_DEFS[kind].role);
    }
  }

  return {
    held: open.flatMap((a) => (JSON.parse(a.scope) as Scope).write),
    openPerRole,
    capPerRole,
    freePerRole: freeWorkers(db),
  };
}

/** Workers with nothing open, per role. One definition of *free*: holding no assignment in
 *  a phase that has not ended. A role with nobody free is absent rather than zero, as the
 *  grouped count it replaces was — every reader treats a missing role as none. */
export function freeWorkers(db: DatabaseSync): Readonly<Record<string, number>> {
  const busy = new Set(openAssignments(db).map((a) => a.worker_id));
  const free: Record<string, number> = {};
  for (const w of queries(db).selectFrom(worker).all()) {
    if (!busy.has(w.id)) free[w.role] = (free[w.role] ?? 0) + 1;
  }
  return free;
}

/** Who could run, and the reason for each one who could not. Pure: the caller supplies
 *  the load, so a view can ask the same question the allocator asks. */
export function eligible(
  cs: readonly Candidate[],
  load: Load,
): { readonly eligible: readonly Candidate[]; readonly refused: readonly Refusal[] } {
  const refused: Refusal[] = [];
  const kept = cs.filter((c) => {
    const cap = load.capPerRole[c.role];
    if (cap !== undefined && (load.openPerRole[c.role] ?? 0) >= cap) {
      refused.push({ id: c.id, why: `role ${c.role} is at ${cap}` });
      return false;
    }
    // A chore's placement is nothing but a worker: it needs no tree cut for it and no
    // task branch, so whether anybody can take it is knowable here, and a chore nobody can
    // take must say so rather than sit silent. A task is not checked here — the runner asks
    // for its placement one candidate at a time and refuses it in these same words there,
    // and one candidate must not collect two reasons for the same fact.
    if (kindOf(c) === "chore" && load.freePerRole !== undefined && (load.freePerRole[c.role] ?? 0) === 0) {
      refused.push({ id: c.id, why: noWorkerFree(c.role) });
      return false;
    }
    if (collides(c.scope.write, load.held)) {
      refused.push({ id: c.id, why: "its write scope overlaps an assignment already open" });
      return false;
    }
    return true;
  });
  return { eligible: kept, refused };
}

/** The order the allocator walks: chores before tasks, then fresh attempts first, then by
 *  id. Total, so it is stable — two candidates never tie, and the same record always yields
 *  the same first choice. Within one kind ids are unique, and rank is compared first, so a
 *  chore and a task with the same id are still ordered by the rule and not by accident. */
export function ordered(cs: readonly Candidate[], order: Ordering): readonly Candidate[] {
  return [...cs].sort((a, b) => {
    const rank = RANK[kindOf(a)] - RANK[kindOf(b)];
    if (rank !== 0) return rank;
    if (order.fresh_first && a.attempts !== b.attempts) return a.attempts - b.attempts;
    return a.id - b.id;
  });
}

/** What the allocator would choose from, in the order it would try them, and why it ruled
 *  the rest out. The one answer to *what is next* — the allocator walks this list, and a
 *  view shows it, rather than each keeping a copy of the decision. */
export function nextUp(
  db: DatabaseSync,
  config: {
    readonly max_open_per_role: Readonly<Record<string, number>>;
    readonly order: Ordering;
    /** Where a chore's scope and budget come from. Without it a chore is not offered: see
     *  choreCandidates. */
    readonly roles?: RoleConfig;
  },
): { readonly ordered: readonly Candidate[]; readonly refused: readonly Refusal[] } {
  const load = currentLoad(db, config.max_open_per_role);
  const chores = choreCandidates(db, config.roles);
  const { eligible: kept, refused } = eligible([...readyCandidates(db), ...chores.candidates], load);
  const all = [...chores.refused, ...refused];

  // A chore's reason goes on the record here, where the kind of each id is still known.
  // Downstream a Refusal is an id and a sentence, and a chore id is not a task id, so
  // anything further along would have to guess which table to write to.
  const chorish = new Set(chores.candidates.map((c) => c.id));
  const spoken = new Set<number>();
  for (const r of all) {
    if (chorish.has(r.id) || chores.refused.some((x) => x.id === r.id)) {
      recordChoreRefusal(db, r.why, r.id);
      spoken.add(r.id);
    }
  }
  // A reason must not outlive the pass it was true in: a chore that can now be taken is
  // not still showing why it could not be.
  for (const c of chores.candidates) if (!spoken.has(c.id)) clearChoreRefusal(db, c.id);

  return { ordered: ordered(kept, config.order), refused: all };
}
