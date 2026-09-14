/** What is holding the workspace up, drawn above the work it is holding up.
 *
 *  Four rows, and every one of them is read from the record. Nothing here asks the machine
 *  the cockpit happens to be running on: no `ps`, no pid probe, no socket. The cockpit is
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
  leaseAgeMs,
  leaseIsStale,
  now,
  readLease,
  SCHEMA_VERSION,
  STALE_INTERVALS,
} from "@wecode/core";
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

/** These four rows are always the four rows, so the box's height is not negotiable and its
 *  title carries no count. */
export const SERVICE_ROWS = 4;

export interface ServiceRow {
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
function runner(db: DatabaseSync, queued: number, at: string): ServiceRow {
  const waiting = queued === 0 ? "nothing queued" : `${queued} queued`;
  const lease = readLease(db);
  if (lease === null) {
    return {
      what: "runner",
      state: queued === 0 ? "idle" : "none",
      detail: `no runner holds this workspace · ${waiting}`,
      alarm: queued > 0,
    };
  }
  const stale = leaseIsStale(lease, at);
  const beat = `beat ${ago(leaseAgeMs(lease, at))} ago · every ${ago(lease.intervalMs)}`;
  if (!stale) return { what: "runner", state: "alive", detail: `${lease.holder} · ${beat}`, alarm: false };
  return {
    what: "runner",
    state: queued === 0 ? "idle" : "dead",
    detail: `${lease.holder} · ${beat} · ${STALE_INTERVALS} intervals missed · ${waiting}`,
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
  what: "doctor",
  state: cfg.doctor.state,
  detail: `${cfg.doctor.version} · ${cfg.doctor.detail}`,
  alarm: false,
});

/** The four rows, in the order a reader scans them: who is running this workspace, whether
 *  this build may read it at all, what it has to run work with, and what is not there yet.
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
  return [runner(db, queued, at), schema(db), fleet(db, cfg.busyPhases), doctor(cfg)];
}

/** The rows as text, columns padded to line up the way every list on the screen does. */
export function serviceLines(rows: readonly ServiceRow[], width: number): string[] {
  const what = Math.max(...rows.map((r) => r.what.length));
  const state = Math.max(...rows.map((r) => r.state.length));
  return rows.map((r) =>
    clip(`${r.what.padEnd(what)}  ${r.state.padEnd(state)}  ${r.detail}`, width),
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
        <Text key={rows[i]?.what ?? i} wrap="truncate" color={rows[i]?.alarm === true ? "red" : ""}>
          {line}
        </Text>
      ))}
    </>
  );
}
