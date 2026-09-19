/** What is holding the workspace up, drawn above the work it is holding up.
 *
 *  A pulse line per project and four service rows, every one of them read from the record.
 *  Nothing here asks the machine the cockpit runs on: no `ps`, no pid probe, no socket. The cockpit is
 *  opened wherever the operator is standing — over ssh, on a laptop, beside a runner that
 *  is on another host entirely — so a process this host cannot see is not a process that is
 *  not running. The lease is the runner's own claim about itself, written where both hosts
 *  can read it, and that claim is the only evidence a remote cockpit is entitled to.
 *
 *  Colour is red or nothing, which is the box grammar of docs/design/16 applied honestly:
 *  green there means a state that finished well, and a runner that is merely alive has not
 *  finished anything. A lamp per service would also have to light for the doctor, which
 *  does not exist. So this box is quiet until there is something to go and do. */
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Text } from "ink";
import { parse } from "yaml";
import {
  board,
  leaseAgeMs,
  leaseIsStale,
  now,
  A_RESTART_IS_OWED,
  checkRunner,
  readLease,
  type Lease,
  SCHEMA_VERSION,
  STALE_INTERVALS,
} from "@wecode/core";
// Through the module, because index.ts publishes the composed board and not board.ts's
// own exports — the same reach `app.ts` makes for `assignmentFacts`.
import { silence } from "@wecode/core/dist/board.js";
import type { App } from "./app.js";
import { clip } from "./list.js";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));

export class ServiceConfigError extends Error {}

/** The words the box says that are not facts about this workspace — see views.yaml. */
export interface ServicesConfig {
  readonly title: string;
  /** The phases that hold a worker. `waiting` is one of them: a worker waiting on a person
   *  is not available to anything else, which is the whole point of counting them. */
  readonly busyPhases: readonly string[];
  readonly doctor: { readonly version: string; readonly state: string; readonly detail: string };
}

/** The four service rows are always the four service rows. The box is taller than that by
 *  one pulse line per project, so `services()` returns `SERVICE_ROWS` plus one row per
 *  project.
 *
 *  Which means this constant is no longer the box's height, and whatever draws the panel
 *  has to size it from the rows it is given — `screens.tsx` still writes
 *  `height={SERVICE_ROWS + BORDER}`, and a panel shorter than its rows does not clip them,
 *  it draws them over one another. That one line is the whole of what is left. */
export const SERVICE_ROWS = 4;

/** What this workspace has, rather than what one project has. */
export const WORKSPACE = "workspace";

export interface ServiceRow {
  /** What the row is about: `workspace`, or the project a pulse line beats for. The box
   *  holds two kinds of row now, and a reader scanning it has to be able to tell which
   *  without reading the rest of the line. */
  readonly tag: string;
  readonly what: string;
  readonly state: string;
  readonly detail: string;
  /** True when this row is the reason to stop reading the board and go and do something. */
  readonly alarm: boolean;
}

export function loadServices(path: string = CONFIG): ServicesConfig {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  const top = (raw ?? {}) as Record<string, unknown>;
  const s = top["services"];
  if (s === null || typeof s !== "object") throw new ServiceConfigError("views.yaml has no services");
  const cfg = s as Record<string, unknown>;

  const doctor = (cfg["doctor"] ?? {}) as Record<string, unknown>;
  for (const key of ["version", "state", "detail"]) {
    if (typeof doctor[key] !== "string") throw new ServiceConfigError(`services.doctor.${key} must be a string`);
  }
  const phases = cfg["busy_phases"];
  if (!Array.isArray(phases) || phases.some((p) => typeof p !== "string")) {
    throw new ServiceConfigError("services.busy_phases must be a list of strings");
  }
  return {
    title: typeof cfg["title"] === "string" ? cfg["title"] : "Services",
    busyPhases: phases as string[],
    doctor: {
      version: doctor["version"] as string,
      state: doctor["state"] as string,
      detail: doctor["detail"] as string,
    },
  };
}

/** A duration a person reads at a glance. Seconds under a minute, because the difference
 *  between one missed tick and three is seconds. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** `?` per phase, so the phases that hold a worker stay in views.yaml rather than being
 *  spelled into the SQL twice. */
const holds = (phases: readonly string[]): string =>
  `a.phase IN (${phases.map(() => "?").join(",")})`;

/** Ready, and nothing open is attempting it — the Queue box's question, asked per role,
 *  because a role is what a task waits for a worker of. */
function readyByRole(db: DatabaseSync, busy: readonly string[]): { role: string; n: number }[] {
  return db
    .prepare(
      `SELECT t.role AS role, count(*) AS n FROM task t
        WHERE t.state = 'ready'
          AND NOT EXISTS (SELECT 1 FROM assignment a
                           WHERE a.objective_type = 'task' AND a.objective_id = t.id
                             AND ${holds(busy)})
        GROUP BY t.role ORDER BY t.role`,
    )
    .all(...busy) as unknown as { role: string; n: number }[];
}

function workersByRole(
  db: DatabaseSync,
  busy: readonly string[],
): { role: string; busy: number; all: number }[] {
  return db
    .prepare(
      `SELECT w.role AS role, count(*) AS all_,
              sum(CASE WHEN EXISTS (SELECT 1 FROM assignment a
                                     WHERE a.worker_id = w.id AND ${holds(busy)})
                       THEN 1 ELSE 0 END) AS busy
         FROM worker w GROUP BY w.role ORDER BY w.role`,
    )
    .all(...busy)
    .map((r) => {
      const row = r as unknown as { role: string; all_: number; busy: number };
      return { role: row.role, busy: row.busy, all: row.all_ };
    });
}

/** Who holds the workspace, and how long since they last said so. The staleness rule is
 *  lease.ts's — three of the holder's own intervals — and is asked rather than restated.
 *
 *  A stale lease over an empty queue is `idle`, not `dead`, and is not an alarm. The record
 *  cannot tell those two apart on its own: they are the same missing heartbeat, and the
 *  only thing that distinguishes a runner that has crashed from one that has nothing to do
 *  is whether anything was waiting for it. A quiet log is not a hung runner, and a red row
 *  every quiet evening is a row nobody reads by Friday. */

/** What the holder is running, appended to whatever else its row says.
 *
 *  Read from the lease, like everything else in this box: the holder measured it against a
 *  repository this host may not even have. Whether that is drift is `runner_build_is_current`'s
 *  to say and not this file's, so the row asks the invariant and prints what it answers — a
 *  cockpit that disagreed with the doctor about a stale runner would be worse than either.
 *  A build that cannot say and a build that is current both read `build <sha>` and nothing
 *  more; and nothing here restarts anything, because the thing to do is never automatic. */
function buildOf(lease: Lease): { readonly say: string; readonly owed: boolean } {
  if (lease.buildSha === undefined) return { say: "", owed: false };
  const sha = `build ${lease.buildSha.slice(0, 12)}`;
  const drift = checkRunner({
    holder: lease.holder,
    buildSha: lease.buildSha,
    ...(lease.buildBehind === undefined ? {} : { behind: lease.buildBehind }),
  });
  const behind = lease.buildBehind ?? 0;
  return drift.length === 0
    ? { say: sha, owed: false }
    : { say: `${sha} · ${behind} behind the base — ${A_RESTART_IS_OWED}`, owed: true };
}

const withBuild = (detail: string, build: { readonly say: string }): string =>
  build.say === "" ? detail : `${detail} · ${build.say}`;

function runner(db: DatabaseSync, queued: number, at: string): ServiceRow {
  const waiting = queued === 0 ? "nothing queued" : `${queued} queued`;
  const lease = readLease(db);
  if (lease === null) {
    return {
      tag: WORKSPACE,
      what: "runner",
      state: queued === 0 ? "idle" : "none",
      detail: `no runner holds this workspace · ${waiting}`,
      alarm: queued > 0,
    };
  }
  const stale = leaseIsStale(lease, at);
  const beat = `beat ${ago(leaseAgeMs(lease, at))} ago · every ${ago(lease.intervalMs)}`;
  const build = buildOf(lease);
  // A runner behind its base is an alarm while it is alive: it is taking work and doing it
  // with code the operator has already replaced. Dead, the restart is owed anyway.
  if (!stale) {
    return {
      tag: WORKSPACE,
      what: "runner",
      state: build.owed ? "stale build" : "alive",
      detail: withBuild(`${lease.holder} · ${beat}`, build),
      alarm: build.owed,
    };
  }
  return {
    tag: WORKSPACE,
    what: "runner",
    state: queued === 0 ? "idle" : "dead",
    detail: withBuild(`${lease.holder} · ${beat} · ${STALE_INTERVALS} intervals missed · ${waiting}`, build),
    alarm: queued > 0,
  };
}

/** The number in the file against the number this build was compiled with. Red in either
 *  direction: a database ahead is one this build must not read, and a database behind is
 *  one nothing has migrated. Both numbers are named, because "mismatch" is not something a
 *  person can act on and "database 5, build 4" is. */
function schema(db: DatabaseSync): ServiceRow {
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  const found = row?.version ?? 0;
  const same = found === SCHEMA_VERSION;
  return {
    tag: WORKSPACE,
    what: "schema",
    state: same ? "current" : found > SCHEMA_VERSION ? "ahead" : "behind",
    detail: `database ${found} · this build understands ${SCHEMA_VERSION}`,
    alarm: !same,
  };
}

/** Busy and idle per role, and — first, and louder — any role with work ready and no worker
 *  of that role at all. That is not a queue moving slowly, it is a queue that cannot move,
 *  and every other box on the board draws it as an ordinary waiting task. */
function fleet(db: DatabaseSync, busyPhases: readonly string[]): ServiceRow {
  const workers = workersByRole(db, busyPhases);
  const have = new Set(workers.map((w) => w.role));
  const starved = readyByRole(db, busyPhases).filter((r) => !have.has(r.role));
  const per = workers.map((w) => `${w.role} ${w.busy} busy ${w.all - w.busy} idle`);
  const none = starved.map((r) => `no ${r.role} for ${r.n} ready`);
  const busy = workers.reduce((n, w) => n + w.busy, 0);
  const all = workers.reduce((n, w) => n + w.all, 0);
  return {
    tag: WORKSPACE,
    what: "fleet",
    state: starved.length > 0 ? "short" : all === 0 ? "none" : `${busy}/${all} busy`,
    detail: [...none, ...per].join(" · ") || "no workers",
    alarm: starved.length > 0,
  };
}

/** Planned, and drawn as planned. There is no service to ask, so the row says the release
 *  it is planned for and the word `not built`. A lamp here — of any colour — would be this
 *  box asserting something about a program nobody has written. */
const doctor = (cfg: ServicesConfig): ServiceRow => ({
  tag: WORKSPACE,
  what: "doctor",
  state: cfg.doctor.state,
  detail: `${cfg.doctor.version} · ${cfg.doctor.detail}`,
  alarm: false,
});

/** A line per project, saying whether it is beating.
 *
 *  Here rather than in a box of its own because it is the same question this box already
 *  asks: a runner that is alive over a project nothing has moved in two hours is only an
 *  answer when the two are read together. Counted off the composed board — the one the
 *  boxes underneath are drawn from — so a pulse and the box below it cannot disagree.
 *
 *  Red when nothing is running and something is waiting: that is a project the machine has
 *  stopped carrying, and it is the one state here worth crossing the room for. A project
 *  with no work is quiet, not red, by the same rule that keeps an idle runner plain. */
function pulses(db: DatabaseSync, at: string): ServiceRow[] {
  const then = Date.parse(at);
  const silent = silence(db, Number.isNaN(then) ? Date.now() : then);
  return board(db).projects.map((p) => {
    const groups = board(db, p.id);
    const running = groups.running.length;
    const waiting = groups.queued.length + groups.cooking.length;
    const beat = silent.get(p.id);
    return {
      tag: p.what,
      what: "pulse",
      state: running > 0 ? "beating" : waiting > 0 ? "still" : "quiet",
      detail:
        `${running} running · ${groups.queued.length} queued · ${groups.cooking.length} stuck · ` +
        (beat === undefined ? "never moved" : `moved ${ago(beat)} ago`),
      alarm: running === 0 && waiting > 0,
    };
  });
}

/** The pulse lines, then the four service rows in the order a reader scans them: what each
 *  project is doing, then who is running this workspace, whether this build may read it at
 *  all, what it has to run work with, and what is not there yet.
 *
 *  The projects come first because they are what the board is about; the four rows under
 *  them are why a project's line might be wrong.
 *
 *  `queued` is passed in rather than counted here: it is the Queue box's number, and the
 *  runner row saying `idle` while the Queue box shows three would be the box disagreeing
 *  with the board directly underneath it.
 */
export function services(
  db: DatabaseSync,
  queued: number,
  cfg: ServicesConfig,
  at: string = now(),
): ServiceRow[] {
  return [...pulses(db, at), runner(db, queued, at), schema(db), fleet(db, cfg.busyPhases), doctor(cfg)];
}

/** The rows as text, columns padded to line up the way every list on the screen does.
 *
 *  What the row is about leads, and the tag is the column beside it: the leftmost column of
 *  this box has always been the name of the thing — `runner`, `schema` — and the board's
 *  other boxes are read down that same edge. A tag column in front of it would move every
 *  service row sideways to say `workspace` four times, which is the least informative word
 *  on the line. Second, the tag still separates the two kinds of row at a glance, and it is
 *  the column that varies where the first one repeats. */
export function serviceLines(rows: readonly ServiceRow[], width: number): string[] {
  const tag = Math.max(...rows.map((r) => r.tag.length));
  const what = Math.max(...rows.map((r) => r.what.length));
  const state = Math.max(...rows.map((r) => r.state.length));
  return rows.map((r) =>
    clip(`${r.what.padEnd(what)}  ${r.tag.padEnd(tag)}  ${r.state.padEnd(state)}  ${r.detail}`, width),
  );
}

/** The database the cockpit was opened on. App keeps it private because no screen has ever
 *  needed it: every other box is a slice of the board App already read. This box is the one
 *  thing on the dashboard that is not about the work, and App is the only holder of the
 *  handle — so the reach is here, named, and once. */
const dbOf = (app: App): DatabaseSync => (app as unknown as { db: DatabaseSync }).db;

/** The rows themselves. The border round them is the dashboard's, so the services box and
 *  every box of work are one kind of box. */
export function Services({
  app,
  width,
  config,
  at,
}: {
  readonly app: App;
  readonly width: number;
  readonly config: ServicesConfig;
  readonly at?: string | undefined;
}) {
  const rows = services(dbOf(app), app.boardNow().queued.length, config, at ?? now());
  return (
    <>
      {serviceLines(rows, width).map((line, i) => (
        <Text key={`${rows[i]?.tag ?? ""}/${rows[i]?.what ?? i}`} wrap="truncate" color={rows[i]?.alarm === true ? "red" : ""}>
          {line}
        </Text>
      ))}
    </>
  );
}
