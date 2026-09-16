/** Why a candidate was passed over is the same fact as why a bulk action declined an
 *  id, so Refusal has one definition, in types. */
import type { Refusal } from "./types.js";
import type { DatabaseSync } from "node:sqlite";
import { CHORE_KIND_DEFS, choreCandidates, clearChoreRefusal, recordChoreRefusal, type ChoreKind } from "./chore.js";
import { queries, table } from "./db.js";
import type { Budget, Scope } from "./entities.js";
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

/** Ready tasks with no assignment attempting them, in id order.
 *
 *  The exclusion is a set difference rather than a `NOT EXISTS`, and the order is applied
 *  here rather than in the query: the dialect spells neither, and both are cheap on a list
 *  the allocator is about to walk one at a time anyway. */
export function readyCandidates(db: DatabaseSync): readonly Candidate[] {
  const attempted = new Set(
    openAssignments(db)
      .filter((a) => a.objective_type === "task")
      .map((a) => a.objective_id),
  );

  return queries(db)
    .selectFrom(task)
    .select(["id", "title", "role", "scope", "budget", "attempts"])
    .where("state", "=", "ready")
    .all()
    .filter((r) => !attempted.has(r.id))
    .sort((a, b) => a.id - b.id)
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
