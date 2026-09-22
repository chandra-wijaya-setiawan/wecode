/** The seeing verbs: the six commands that answer a question and change nothing.
 *
 *  `standup`, `board`, `doctor`, `delivered`, `explore` and `design` all read something
 *  back — the situation, the workspace, the installation, what has shipped, the repository,
 *  a screen — and none of them writes to the ledger. `verbs/run-and-see.ts` keeps the verbs
 *  that act; this file is the half that only looks, so run.ts's dispatch reaches a reading
 *  verb without opening the file where landing and onboarding live.
 *
 *  Four of them already have a module of their own, so what this file adds for them is the
 *  one name run.ts reaches them by. `board` and `standup` have their bodies here.
 *
 *  The context is `See`, still declared in `verbs/run-and-see.ts` because the acting verbs
 *  take it too and two copies of it would be two things that must agree. */
import { parseArgs } from "node:util";
// Renamed on the way in: `board` here is the verb, and core's `board` is the query it reads.
// `delivered` is renamed for the same reason — this file re-exports the cli's own below.
import {
  board as boardOf,
  delivered as deliveredOf,
  leaseAgeMs,
  leaseIsStale,
  readLease,
  type Lease,
  type Row,
} from "@wecode/core";
// Neither the catalogue question nor the typed query layer is on core's index, so each is
// reached by the module it lives in — the way run.ts already reaches `queries`.
import { hasTable } from "@wecode/core/dist/board.js";
import { queries, table } from "@wecode/core/dist/db.js";
// The walk up the tree, so a red acceptance test can be placed under the project asked for.
import { projectOf } from "./entity.js";
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

// ─── the standup ─────────────────────────────────────────────────────────────────────────
//
// An orchestrating agent starts a session knowing nothing, and assembled its picture out of
// `board`, `doctor`, `delivered` and a look at the runner — four commands whose answers
// overlap, contradict each other about what is stuck, and say nothing about which to read
// first. The order was the operator's, supplied out loud every few minutes. So the order is
// what this writes down: the runner first, because nothing moves without one; then the work
// in the order it flows; then what is waiting on a person; then the tests that are red and
// whether anyone watched them fail at the base; then the drift the doctor holds open.
//
// It reads and it reports. No verb is applied, no chore is raised, nothing is healed: an
// orientation that changed the thing it describes would be a worse first move than none.

/** The `doctor_violation` row this reads, and only the columns it reads. The doctor owns
 *  the table; nothing here writes to it. */
interface ViolationRow {
  invariant: string;
  slug: string;
  detail: string;
  first_seen: string | null;
  cleared_at: string | null;
}
const doctorViolation = table<ViolationRow>("doctor_violation", [
  "invariant",
  "slug",
  "detail",
  "first_seen",
  "cleared_at",
]);

/** A red acceptance test, with the file it is proved by and what the base said about it. */
interface Red {
  readonly id: number;
  readonly statement: string;
  readonly file: string;
  /** The commit the test was seen to fail at, or null when nobody has watched it fail. */
  readonly sha: string | null;
  /** Why a run at base proved nothing, when the runner recorded a reason. */
  readonly why: string | null;
}

/** What the last line names: the command, and the one sentence that argues for it. */
interface Next {
  readonly run: string;
  readonly why: string;
}

/** Everything the ladder below decides from, gathered once. Passing the situation rather
 *  than the database keeps the decision a pure function of what was printed — the next step
 *  can never name something the digest above it did not show. */
interface Situation {
  readonly lease: Lease | null;
  readonly stale: boolean;
  readonly behind: number;
  readonly running: readonly Row[];
  readonly ready: readonly Row[];
  readonly failed: readonly Row[];
  readonly unlanded: readonly Row[];
  readonly needsYou: readonly Row[];
  readonly red: readonly Red[];
  readonly open: number;
}

const clip = (what: string, width: number): string =>
  what.length > width ? `${what.slice(0, width - 1)}…` : what.padEnd(width);

/** One row of a group, in the board's columns and narrower — this page carries eight
 *  groups where the board carries six. */
const line = (r: Row): string => `  #${String(r.id).padStart(4)}  ${clip(r.what, 44)}  ${r.state.padEnd(10)} ${r.detail}`;

/** The runner of record, in two sentences: whether anything holds the lease, and whether
 *  what holds it is running the code that is on the base.
 *
 *  Drift that has not been measured is said as that, not as nothing behind. Only the holder
 *  may write the number, so its absence means no tick has measured it yet — which is a
 *  different thing from a build that is current, and reading them alike is how a runner
 *  three days stale goes on looking healthy. */
function runnerSays(lease: Lease | null, stale: boolean): readonly string[] {
  if (lease === null) return ["  nobody holds the lease — no runner is dispatching work here"];
  const age = Math.max(0, Math.round(leaseAgeMs(lease) / 1000));
  const held = stale
    ? `  ${lease.holder} holds the lease, last alive ${age}s ago — stale, so nothing is ticking`
    : `  ${lease.holder} holds the lease · last alive ${age}s ago`;
  const behind = lease.buildBehind;
  const build =
    behind === undefined
      ? "  its build drift has not been measured"
      : behind === 0
        ? "  its build is current with the base"
        : `  its build is ${behind} commit${behind === 1 ? "" : "s"} behind the base`;
  return [held, build];
}

/** Every acceptance test that is failing, with the file its artefact runs and whether that
 *  file was ever seen red at the commit the story was cut from.
 *
 *  Both halves are the answer to one question. A red test with a red-at-base sha is work in
 *  flight: somebody watched it fail, and making it pass will mean something. A red test with
 *  no sha is a test that proves nothing yet, and `test_has_been_red` will refuse its pass —
 *  so the same line has to carry both or a reader draws the wrong conclusion twice. */
function redTests(at: See, db: ReturnType<See["conn"]>, project: number | null): readonly Red[] {
  const here = { ...at, conn: () => db };
  return queries(db)
    .selectFrom(at.tables.acceptanceTest)
    .all()
    .filter((t) => t.state === "failed")
    .filter((t) => project === null || projectOf(here, "acceptance_test", t.id)?.id === project)
    .sort((a, b) => a.id - b.id)
    .map((t) => ({
      id: t.id,
      statement: t.statement,
      file: t.script_path ?? t.artefact ?? "no artefact",
      sha: t.red_at_base_sha,
      why: t.red_at_base_reason,
    }));
}

/** The file before the verdict: the file is what a reader goes and opens, and the verdict
 *  is the sentence about it. Unpadded at the end, so a long reason runs on rather than
 *  leaving a column of blank between two things that belong together. */
const redLine = (t: Red): string => {
  const base = t.sha === null ? `NOT red at base — ${t.why ?? "nobody has watched it fail"}` : `red at base ${t.sha.slice(0, 7)}`;
  return `  #${String(t.id).padStart(4)}  ${clip(t.statement, 44)}  ${clip(t.file, 34)}  ${base}`;
};

/** The invariants the doctor has open, one line per invariant with how many rows stand
 *  under it. Workspace-wide and said as such: a violation carries the entity it accuses,
 *  not a project, so narrowing it here would be inventing a fact.
 *
 *  A workspace whose migrations predate the report has no table, which is nothing recorded
 *  rather than nothing wrong — the same way every other optional table is read. */
function openInvariants(db: ReturnType<See["conn"]>): readonly { name: string; count: number; first: string }[] {
  if (!hasTable(db, "doctor_violation")) return [];
  const per = new Map<string, { name: string; count: number; first: string }>();
  for (const v of queries(db).selectFrom(doctorViolation).all().filter((v) => v.cleared_at === null)) {
    const held = per.get(v.invariant);
    if (held === undefined) per.set(v.invariant, { name: v.invariant, count: 1, first: v.detail });
    else per.set(v.invariant, { ...held, count: held.count + 1 });
  }
  return [...per.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The one move to make, from what the digest just showed.
 *
 *  A ladder rather than a list of suggestions: the point of the last line is that somebody
 *  else has already done the ranking. A dead runner outranks everything, because nothing
 *  below it will move until one is up. A person being waited on outranks the rest of the
 *  work, because that is the only rung the machine cannot climb by itself. Landing outranks
 *  retrying — a delivered story off the base blocks every story cut after it. Drift comes
 *  last of the faults: it is real, and it is never the thing stopping this hour's work. */
function nextStep(s: Situation): Next {
  if (s.lease === null) return { run: "wecode-runner", why: "nothing holds the lease, so no work will be dispatched" };
  if (s.stale) return { run: "wecode-runner", why: `the lease is stale — ${s.lease.holder} stopped beating` };
  const asked = s.needsYou[0];
  if (asked !== undefined) {
    return { run: `wecode answer ${asked.id} "<your answer>"`, why: `${asked.state}: ${asked.detail || asked.what}` };
  }
  const waiting = s.unlanded[0];
  if (waiting !== undefined) return { run: `wecode land ${waiting.id}`, why: `"${waiting.what}" is delivered and not on the base` };
  const stopped = s.failed[0];
  if (stopped !== undefined) {
    return { run: `wecode task retry ${stopped.id} --reason "<what will go differently>"`, why: `"${stopped.what}" has stopped` };
  }
  if (s.behind > 0) return { run: "wecode-runner", why: `the runner's build is ${s.behind} behind the base — restart it` };
  if (s.open > 0) return { run: "wecode doctor", why: `${s.open} invariant${s.open === 1 ? " is" : "s are"} open` };
  const moving = s.running[0];
  if (moving !== undefined) return { run: `wecode wait assignment ${moving.id}`, why: `"${moving.what}" is running` };
  const queued = s.ready[0];
  if (queued !== undefined) return { run: `wecode wait task ${queued.id}`, why: `"${queued.what}" is ready and waiting on a slot` };
  return { run: "wecode board --all", why: "nothing here is running, waiting or owed" };
}

/** `wecode standup [--all] [--project <id>]` — the whole situation in one ordered read,
 *  ending in the one thing to do next.
 *
 *  Narrowed to the project this repository is unless you say otherwise, the same way the
 *  board is: standing in one repository you are asking about one project. */
export function standup(at: See): number {
  const { values } = parseArgs({
    args: [...at.args],
    options: { all: { type: "boolean" }, project: { type: "string" } },
  });
  const asked = values.project === undefined ? at.hereProject()?.id ?? null : Number(values.project);
  const chosen = values.all === true ? null : asked;
  if (chosen !== null && !Number.isInteger(chosen)) return at.fail("wecode standup --project <id>");

  const db = at.conn();
  const b = boardOf(db, chosen);
  const mine = b.projects.find((p) => p.id === chosen);
  if (chosen !== null && mine === undefined) return at.fail(`no project #${chosen}`);

  const lease = readLease(db);
  const open = openInvariants(db);
  const situation = {
    lease,
    stale: lease !== null && leaseIsStale(lease),
    behind: lease?.buildBehind ?? 0,
    running: b.running,
    ready: b.queued,
    failed: b.failed,
    // Delivered is the record's word and landed is the repository's, and they disagree for
    // a day at a time. `delivered()` is the one read that knows both, so the group is built
    // from it rather than from the board's `delivered` panel, which knows only the state.
    unlanded: deliveredOf(db, chosen)
      .filter((s) => !s.landed)
      .map((s) => ({
        id: s.id,
        what: s.title,
        state: s.reach,
        detail: s.owed === null ? (s.why ?? "nothing is owed it") : `owed a ${s.owed} chore${s.why === null ? "" : ` · ${s.why}`}`,
      })),
    needsYou: b.needs_human,
    red: redTests(at, db, chosen),
    open: open.reduce((n, i) => n + i.count, 0),
  } satisfies Situation;

  const said: string[] = [
    "",
    mine === undefined
      ? `STANDUP  all ${b.projects.length} projects in this workspace`
      : `STANDUP  #${mine.id} ${mine.what} · wecode standup --all for the whole workspace`,
    "",
    "1 RUNNER",
    ...runnerSays(lease, situation.stale),
  ];
  const group = (n: number, title: string, rows: readonly string[]): void => {
    said.push("", `${n} ${title} (${rows.length})`, ...(rows.length === 0 ? ["  —"] : rows));
  };
  group(2, "RUNNING", situation.running.map(line));
  group(3, "READY", situation.ready.map(line));
  group(4, "FAILED", situation.failed.map(line));
  group(5, "DELIVERED, NOT LANDED", situation.unlanded.map(line));
  group(6, "WAITING ON A PERSON", situation.needsYou.map(line));
  group(7, "RED ACCEPTANCE TESTS", situation.red.map(redLine));
  group(
    8,
    "DOCTOR, OPEN ACROSS THE WORKSPACE",
    open.map((i) => `  ${i.name.padEnd(38)} ${String(i.count).padStart(3)}  ${i.first}`),
  );

  // The last line, and deliberately the last thing written: a digest that ends in a list is
  // a digest somebody still has to decide from, and deciding was the part being done by hand.
  const step = nextStep(situation);
  said.push("", `NEXT  ${step.run}  —  ${step.why}`);
  process.stdout.write(`${said.join("\n")}\n`);
  return 0;
}
