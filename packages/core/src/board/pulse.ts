import { instant } from "./row.js";
import type { Ledger } from "./rows.js";
import { Walk } from "./walk.js";

/** How many blocks the pulse's sparkline draws, and how wide one of them is — design.yaml. */
export const BUCKETS = 10;
const HOUR = 3_600_000;

/** How long since anything under each project was touched, in milliseconds per project id.
 *
 *  A project's beat, and the one part of its pulse the board's groups cannot answer: three
 *  empty boxes say both *nothing to do* and *nobody has looked since Tuesday*, and this is
 *  what tells them apart. Nothing below a project carries a project_id, so what moved under
 *  it is knowable only by the same walk up that places every row.
 *
 *  A project nothing can date is absent rather than zero — an unreadable timestamp is no
 *  evidence of a beat, the way it is no evidence of age in the fold. */
export function silence(ledger: Ledger, asOf: number): ReadonlyMap<number, number> {
  const walk = new Walk(ledger);
  const beat = new Map<number, string>();
  const felt = (project: number | null, at: string): void => {
    if (project === null) return;
    const held = beat.get(project);
    if (held === undefined || held < at) beat.set(project, at);
  };
  for (const e of ledger.epics) felt(walk.ofEpic(e.id), e.updated_at);
  for (const s of ledger.stories) felt(walk.ofStory(s.id), s.updated_at);
  for (const t of ledger.tasks) felt(walk.ofTask(t.id), t.updated_at);
  for (const a of ledger.assignments) felt(walk.ofAssignment(a), a.updated_at);
  const since = ([project, at]: [number, string]): [number, number][] => {
    const then = instant(at);
    return Number.isNaN(then) ? [] : [[project, Math.max(0, asOf - then)]];
  };
  return new Map([...beat].flatMap(since));
}

/** Each project's throughput as ten hourly counts of passes, oldest bucket first.
 *
 *  A pass is the only unit of progress the ledger timestamps: `last_run_at` on a test row
 *  that reached `passed`. Both kinds count — an acceptance test and a task test are each a
 *  thing that was red and is now green — and each is placed under its project by the same
 *  walk up that places every row of the board.
 *
 *  Every project has a series, all zeroes when nothing passed. That is the opposite of
 *  `silence`, which leaves out a project it cannot date, and for the opposite reason: no
 *  pass in ten hours is a fact about the project, where an unreadable beat is no evidence
 *  either way. A run older than the window, one stamped in the future, and one nothing can
 *  parse are all equally no evidence of a pass, and none of them reaches a bucket.
 *
 *  Ten hours rather than ten of anything else because the rate beside the sparkline is per
 *  hour: one block is one hour, so the last block and the rate are the same number. */
export function throughput(ledger: Ledger, asOf: number): ReadonlyMap<number, readonly number[]> {
  const walk = new Walk(ledger);
  const series = new Map<number, number[]>();
  for (const p of ledger.projects) series.set(p.id, Array<number>(BUCKETS).fill(0));
  const count = (project: number | null, state: string, ranAt: string | null): void => {
    if (project === null || state !== "passed" || ranAt === null) return;
    const ago = asOf - instant(ranAt);
    if (Number.isNaN(ago)) return;
    const bucket = BUCKETS - 1 - Math.floor(ago / HOUR);
    const row = bucket < 0 || bucket >= BUCKETS ? undefined : series.get(project);
    if (row !== undefined) row[bucket] = (row[bucket] ?? 0) + 1;
  };
  for (const t of ledger.tests) count(walk.ofTest(t.id), t.state, t.last_run_at);
  for (const t of ledger.taskTests) count(walk.ofTaskTest(t.id), t.state, t.last_run_at);
  return series;
}
