/** The seeing verbs: the five commands that answer a question and change nothing.
 *
 *  `board`, `doctor`, `delivered`, `explore` and `design` all read something back — the
 *  workspace, the installation, what has shipped, the repository, a screen — and none of
 *  them writes to the ledger. `verbs/run-and-see.ts` keeps the verbs that act; this file is
 *  the half that only looks, so run.ts's dispatch reaches a reading verb without opening the
 *  file where landing and onboarding live.
 *
 *  Four of them already have a module of their own, so what this file adds for them is the
 *  one name run.ts reaches them by. `board` has its body here.
 *
 *  The context is `See`, still declared in `verbs/run-and-see.ts` because the acting verbs
 *  take it too and two copies of it would be two things that must agree. */
import { parseArgs } from "node:util";
// Renamed on the way in: `board` here is the verb, and core's `board` is the query it reads.
import { board as boardOf } from "@wecode/core";
import type { See } from "./run-and-see.js";
export { doctor } from "../doctor.js";
export { delivered } from "../delivered.js";
export { explore } from "../explore.js";
export { design } from "../ui.js";

/** `wecode board [--all] [--project <id>]` — every piece of work in the workspace, grouped
 *  by what it is waiting for. Narrowed to the project this repository is unless you say
 *  otherwise, because standing in one repository you are asking about one project. */
export function board(at: See): number {
  const { values } = parseArgs({
    args: [...at.args],
    options: { all: { type: "boolean" }, project: { type: "string" } },
  });
  // Outside every project's repo there is no "here" to narrow to, so the board is the
  // workspace's — which is what it always was.
  const asked = values.project === undefined ? at.hereProject()?.id ?? null : Number(values.project);
  const chosen = values.all === true ? null : asked;
  if (chosen !== null && !Number.isInteger(chosen)) return at.fail("wecode board --project <id>");

  const b = boardOf(at.conn(), chosen);
  const mine = b.projects.find((p) => p.id === chosen);
  if (chosen !== null && mine === undefined) return at.fail(`no project #${chosen}`);
  process.stdout.write(
    mine === undefined
      ? `\nall ${b.projects.length} projects in this workspace\n`
      : `\n#${mine.id} ${mine.what} · wecode board --all for the whole workspace\n`,
  );
  const groups: [string, readonly { id: number; what: string; state: string; detail: string }[]][] = [
    ["RUNNING", b.running],
    ["NEEDS YOU", b.needs_human],
    ["STALE", b.stale],
    ["QUEUE", b.queued],
    ["FAILED", b.failed],
    ["OPEN", b.open],
  ];
  for (const [title, rows] of groups) {
    process.stdout.write(`\n${title} (${rows.length})\n`);
    if (rows.length === 0) {
      process.stdout.write("  —\n");
      continue;
    }
    for (const r of rows) {
      // A title longer than the column pushed every other column off the line.
      const what = r.what.length > 52 ? `${r.what.slice(0, 51)}…` : r.what.padEnd(52);
      process.stdout.write(`  #${String(r.id).padStart(4)}  ${what}  ${r.state.padEnd(12)} ${r.detail}\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}
