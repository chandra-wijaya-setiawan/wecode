import type { DatabaseSync } from "node:sqlite";
import { CHORE_KIND_DEFS, performedByTheRunner, type ChoreKind } from "../chore.js";
import type { Budget, Scope } from "../entities.js";
import type { Candidate } from "../order.js";
import type { RoleConfig } from "../roles.js";
import type { Refusal } from "../types.js";
import { attemptedIds, beginsPerChore, choresWhere } from "./reads.js";
import { outOfAttempts } from "./record.js";
import { WAITING_FOR_APPROVAL } from "./view.js";

/** Which chores the allocator may hand out, and the reason for each one it may not. */

/** A chore's role is its kind's role, and its scope and budget are that role's — a chore
 *  narrows nothing, because the files a merge conflict is in are wherever the conflict is.
 *  config/roles.yaml is the one definition of both, so this reads it rather than holding a
 *  copy — the caller hands in the loaded config. */
export function choreRole(kind: ChoreKind, roles: RoleConfig): { scope: Scope; budget: Budget } | null {
  const def = roles.roles[CHORE_KIND_DEFS[kind].role];
  return def === undefined ? null : { scope: def.scope, budget: def.budget };
}

/** Chores the allocator could choose, in id order.
 *
 *  A chore is a candidate when nothing is attempting it and it is neither `done` — the
 *  condition that made it is gone — nor `running` — somebody is on it. `planned` is
 *  included on purpose: that is where a chore wecode raised sits, and leaving it out is
 *  exactly the bug where three merge chores wait for ever for a state nobody sets.
 *
 *  A kind that needs approval and has none is not a candidate, and says so in the board's
 *  words rather than vanishing.
 *
 *  `roles` is what makes chores considered at all, and asking for it is deliberate rather
 *  than a convenience: a caller that cannot say where a chore's scope comes from is a
 *  caller that has not been taught chores, and handing it one would have it create a
 *  `task` assignment pointing at a chore id. With no roles the answer is empty — not one
 *  guessed scope, and not a refusal about a chore nobody asked about.
 */
export function choreCandidates(
  db: DatabaseSync,
  roles?: RoleConfig,
): { readonly candidates: readonly Candidate[]; readonly refused: readonly Refusal[] } {
  if (roles === undefined) return { candidates: [], refused: [] };

  // `NOT IN ('done','running')` and the `NOT EXISTS` are two set differences, taken here:
  // `done` is excluded by the query, and the other two by the sets the board reads anyway.
  const attempting = attemptedIds(db);
  const begun = beginsPerChore(db);
  const rows = choresWhere(db, "done", "!=", null).filter((c) => c.state !== "running" && !attempting.has(c.id));

  const candidates: Candidate[] = [];
  const refused: Refusal[] = [];
  for (const r of rows) {
    // A kind wecode performs itself is neither offered nor refused here. Not offered,
    // because there is no worker to offer it to; not refused, because a refusal is a
    // sentence about this pass and would write over the reason the chore is actually
    // carrying — the conflict its last attempt hit. It stays on the board saying that.
    if (performedByTheRunner(r.kind)) continue;
    const attempts = begun.get(r.id) ?? 0;
    const tries = { attempts, max_retry: CHORE_KIND_DEFS[r.kind].max_retry };
    // A chore that has failed its check as often as its kind allows is not handed out
    // again. It stays on the board saying so, which is the doctor's to name.
    if (tries.attempts >= tries.max_retry) {
      refused.push({ id: r.id, why: outOfAttempts(tries) });
      continue;
    }
    if (CHORE_KIND_DEFS[r.kind].needs_approval && r.approved_at === null) {
      refused.push({ id: r.id, why: WAITING_FOR_APPROVAL });
      continue;
    }
    const role = choreRole(r.kind, roles);
    if (role === null) continue;
    candidates.push({
      id: r.id,
      objective_type: "chore",
      title: `${r.kind} ${r.target_type} #${r.target_id}`,
      role: CHORE_KIND_DEFS[r.kind].role,
      scope: role.scope,
      budget: role.budget,
      attempts,
    });
  }
  return { candidates, refused };
}
