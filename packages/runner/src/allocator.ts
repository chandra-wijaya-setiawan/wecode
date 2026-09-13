import type { DatabaseSync } from "node:sqlite";
import { Maker, openAssignments, type Budget, type Scope } from "@wecode/core";
import type { BudgetConfig } from "./budget.js";

export interface Candidate {
  readonly id: number;
  readonly title: string;
  readonly role: string;
  readonly scope: Scope;
  readonly budget: Budget;
  readonly attempts: number;
}

/** Why a candidate was passed over. Recorded so the board can answer *why is nothing
 *  running* per task — a refusal nobody sees is how a task starves silently. */
export interface Refusal {
  readonly id: number;
  readonly why: string;
}

export interface Pass {
  readonly created: number | null;
  readonly refused: readonly Refusal[];
}

/** Tasks that are ready and have nothing attempting them. */
export function candidates(db: DatabaseSync): readonly Candidate[] {
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

/** Write scopes held by assignments that are open right now. */
function heldScopes(db: DatabaseSync): readonly string[] {
  const rows = db
    .prepare(`SELECT scope FROM assignment WHERE phase IN ('pending','running','waiting')`)
    .all() as unknown as { scope: string }[];
  return rows.flatMap((r) => (JSON.parse(r.scope) as Scope).write);
}

function openPerRole(db: DatabaseSync): Readonly<Record<string, number>> {
  const rows = db
    .prepare(
      `SELECT t.role AS role, count(*) AS n
         FROM assignment a JOIN task t ON t.id = a.objective_id
        WHERE a.objective_type = 'task' AND a.phase IN ('pending','running','waiting')
        GROUP BY t.role`,
    )
    .all() as unknown as { role: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.role, r.n]));
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

/** One pass of docs/design/10. Creates at most one assignment: a pass that filled every
 *  slot at once could not react to what the first one did. */
export function allocate(
  db: DatabaseSync,
  config: BudgetConfig,
  pick: (c: Candidate) => { worker_id: number; worktree: string } | null,
): Pass {
  const refused: Refusal[] = [];
  const open = openAssignments(db);
  if (open >= config.max_open) {
    return { created: null, refused: [{ id: 0, why: `${open} of ${config.max_open} slots are open` }] };
  }

  const held = heldScopes(db);
  const perRole = openPerRole(db);

  const eligible = candidates(db).filter((c) => {
    const cap = config.max_open_per_role[c.role];
    if (cap !== undefined && (perRole[c.role] ?? 0) >= cap) {
      refused.push({ id: c.id, why: `role ${c.role} is at ${cap}` });
      return false;
    }
    if (collides(c.scope.write, held)) {
      refused.push({ id: c.id, why: "its write scope overlaps an assignment already open" });
      return false;
    }
    return true;
  });

  const ordered = [...eligible].sort((a, b) => {
    if (config.order.fresh_first && a.attempts !== b.attempts) return a.attempts - b.attempts;
    return a.id - b.id;
  });

  const next = ordered[0];
  if (next === undefined) return { created: null, refused };

  const placement = pick(next);
  if (placement === null) {
    refused.push({ id: next.id, why: `no worker free for role ${next.role}` });
    return { created: null, refused };
  }

  const id = new Maker(db).assignment({
    objective_type: "task",
    objective_id: next.id,
    worker_id: placement.worker_id,
    scope: next.scope,
    budget: next.budget,
    worktree: placement.worktree,
  });
  return { created: id, refused };
}
