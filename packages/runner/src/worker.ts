import { statSync } from "node:fs";
import type { Budget } from "@wecode/core";
import type { Observation, Work } from "./ports.js";

/** The one precondition every adapter shares: the work has somewhere to happen.
 *
 *  An assignment whose worktree is not there is not a slow attempt or a lost session — it
 *  is an attempt that cannot be started at all, and starting it anyway is how a harness
 *  ends up writing into whatever directory it happened to be standing in. So the check is
 *  here, above every adapter, rather than repeated inside each of them.
 *
 *  A file where a directory should be is refused for the same reason and named differently:
 *  the two have different causes — one is a worktree that was pruned, the other a path that
 *  was never a worktree — and a refusal that says only "not usable" sends the operator to
 *  look for the wrong thing. */

/** Why a path cannot be worked in, or null when it can. */
function faultOf(worktree: string): string | null {
  if (worktree.trim() === "") return "the assignment names no worktree at all";
  try {
    return statSync(worktree).isDirectory() ? null : `${worktree} is not a directory`;
  } catch {
    return `${worktree} does not exist`;
  }
}

/** What the refusal says. It names the assignment — its id, its objective and what it was
 *  asked to do — because the refusal is the only record of it a person reads: an attempt
 *  refused without naming the assignment leaves the board saying a run failed and nothing
 *  saying which one, and the worktree path alone is shared by every assignment on a
 *  story. */
export function worktreeRefusal(work: Work): string {
  const fault = faultOf(work.worktree);
  if (fault === null) return "";
  const said = work.instruction.trim();
  return (
    `Refused assignment ${work.id} (${work.objective_type} ${work.objective_id}): ${fault}.` +
    (said === "" ? "" : ` The work was: ${said}`)
  );
}

const zero = (): Budget => ({ tokens: 0, seconds: 0 });

/** The refusal as the foreman records observations, or null when there is nothing to refuse.
 *
 *  `lost` rather than `other`, and deliberately the same reason a vanished worktree gets on
 *  resume: both are the same fact — the attempt's place on disk is gone — and giving them
 *  two reasons would make the board's count of lost attempts depend on which tick noticed. */
export function refuseWithoutWorktree(work: Work): Observation | null {
  const said = worktreeRefusal(work);
  if (said === "") return null;
  return { phase: "failed", session: work.session, spent: zero(), reason: "lost", lesson: said };
}
