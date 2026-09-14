/** Why a candidate was passed over is the same fact as why a bulk action declined an
 *  id, so Refusal has one definition, in types. */
import type { Refusal } from "./types.js";
import type { DatabaseSync } from "node:sqlite";
import type { Budget, Scope } from "./entities.js";

/** A ready task with nothing attempting it: something the allocator could choose. */
export interface Candidate {
  readonly id: number;
  readonly title: string;
  readonly role: string;
  readonly scope: Scope;
  readonly budget: Budget;
  readonly attempts: number;
}

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

/** Ready tasks with no assignment attempting them, in id order. */
export function readyCandidates(db: DatabaseSync): readonly Candidate[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.role, t.scope, t.budget, t.attempts
         FROM task t
        WHERE t.state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM assignment a
             WHERE a.objective_type = 'task' AND a.objective_id = t.id
               AND a.phase IN ('pending','running','waiting'))
        ORDER BY t.id`,
    )
    .all() as unknown as {
    id: number;
    title: string;
    role: string;
    scope: string;
    budget: string;
    attempts: number;
  }[];

  return rows.map((r) => ({
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
  const scopes = db
    .prepare(`SELECT scope FROM assignment WHERE phase IN ('pending','running','waiting')`)
    .all() as unknown as { scope: string }[];
  const roles = db
    .prepare(
      `SELECT t.role AS role, count(*) AS n
         FROM assignment a JOIN task t ON t.id = a.objective_id
        WHERE a.objective_type = 'task' AND a.phase IN ('pending','running','waiting')
        GROUP BY t.role`,
    )
    .all() as unknown as { role: string; n: number }[];

  return {
    held: scopes.flatMap((r) => (JSON.parse(r.scope) as Scope).write),
    openPerRole: Object.fromEntries(roles.map((r) => [r.role, r.n])),
    capPerRole,
  };
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
    if (collides(c.scope.write, load.held)) {
      refused.push({ id: c.id, why: "its write scope overlaps an assignment already open" });
      return false;
    }
    return true;
  });
  return { eligible: kept, refused };
}

/** The order the allocator walks: fresh attempts first, then by id. Total, so it is stable
 *  — two candidates never tie, and the same record always yields the same first choice. */
export function ordered(cs: readonly Candidate[], order: Ordering): readonly Candidate[] {
  return [...cs].sort((a, b) => {
    if (order.fresh_first && a.attempts !== b.attempts) return a.attempts - b.attempts;
    return a.id - b.id;
  });
}

/** What the allocator would choose from, in the order it would try them, and why it ruled
 *  the rest out. The one answer to *what is next* — the allocator walks this list, and a
 *  view shows it, rather than each keeping a copy of the decision. */
export function nextUp(
  db: DatabaseSync,
  config: { readonly max_open_per_role: Readonly<Record<string, number>>; readonly order: Ordering },
): { readonly ordered: readonly Candidate[]; readonly refused: readonly Refusal[] } {
  const load = currentLoad(db, config.max_open_per_role);
  const { eligible: kept, refused } = eligible(readyCandidates(db), load);
  return { ordered: ordered(kept, config.order), refused };
}
