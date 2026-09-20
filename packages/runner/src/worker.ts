import { statSync } from "node:fs";
import { hostname } from "node:os";
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

/** The second precondition: the seat still has a process holding it.
 *
 *  A seat reads as alive because something wrote `last_seen`, and for as long as anything
 *  other than the agent's own process can write it — a poller beside the agent, a runner
 *  ticking over a machine that was suspended — the beat says only that the *writer* was
 *  alive. That is how a dead agent leaves a seat looking busy: the last beat is real and
 *  the work behind it stopped hours ago.
 *
 *  So the beat names its own process, `host/pid`, exactly as `runnerId` names a runner's,
 *  and the check here is whether that process still answers. A beat nobody can be found
 *  behind is not evidence of work; it is evidence of a writer.
 *
 *  Two things it deliberately will not do. It will not judge a seat held on another host —
 *  a pid means nothing off the machine it was taken on, and the one honest answer from here
 *  is silence rather than a guess that reads as a fact. And it accepts that a reused pid
 *  reads as alive: that mistake leaves a stopped seat running for one more tick, where the
 *  opposite mistake kills a working agent. */

/** The process a beat named, or null when the holder cannot be read as one. */
export function holderOf(holder: string | null): { host: string; pid: number } | null {
  const cut = (holder ?? "").trim().lastIndexOf("/");
  if (cut <= 0) return null;
  const host = (holder as string).trim().slice(0, cut);
  const pid = Number((holder as string).trim().slice(cut + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { host, pid };
}

/** Whether a pid on this machine still answers. `EPERM` is somebody else's process, which
 *  is a process: it exists, and existing is the whole question. */
function answers(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Why the seat has no process behind its beat, or null when it has one — or when this host
 *  is not the one that could tell. */
export function processFault(holder: string | null, here: string = hostname()): string | null {
  const said = (holder ?? "").trim();
  if (said === "") return "its beat names no process";
  const held = holderOf(said);
  if (held === null) return `its beat names no process it could find (${said})`;
  if (held.host !== here) return null;
  return answers(held.pid) ? null : `the process that held it is gone (pid ${held.pid})`;
}

/** What the seat's stop says. It names the assignment for the same reason the worktree
 *  refusal does, and the pid because that is the thing a person goes looking for. */
export function processRefusal(work: Work, holder: string | null, here?: string): string {
  const fault = processFault(holder, here);
  if (fault === null) return "";
  return `Stopped assignment ${work.id} (${work.objective_type} ${work.objective_id}): ${fault}.`;
}

/** The seat as the foreman records observations, or null while a process still holds it.
 *
 *  `lost` for the same reason the vanished worktree gets it: the attempt's hold on this
 *  machine is gone, and one reason keeps the board's count of lost attempts from depending
 *  on which half of the fact a tick noticed first. */
export function stopWithoutProcess(
  work: Work,
  holder: string | null,
  here?: string,
): Observation | null {
  const said = processRefusal(work, holder, here);
  if (said === "") return null;
  return { phase: "failed", session: work.session, spent: zero(), reason: "lost", lesson: said };
}
