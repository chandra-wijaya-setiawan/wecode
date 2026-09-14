/** What is holding the workspace up, above the work it is holding up. Four rows, each a
 *  fact the record already carries: the runner's lease, the schema this build understands,
 *  the fleet, and the doctor.
 *
 *  Every one of them is read from the database and none from the machine. The cockpit is
 *  run wherever the operator is standing — over ssh, on a laptop, beside a runner that is
 *  on another host entirely — so a `ps` here would report on the wrong computer and a
 *  runner that is plainly alive would be drawn dead. The lease is the runner's own claim
 *  about itself, and it is the only thing both hosts can see. */
import type { DatabaseSync } from "node:sqlite";
import { Text } from "ink";
import { leaseAgeMs, leaseIsStale, now, readLease, SCHEMA_VERSION, STALE_INTERVALS } from "@wecode/core";
import { clip } from "./list.js";
import type { App } from "./app.js";

/** The box's title. It carries no count: these four rows are always the four rows. */
export const SERVICES = "Services";
export const SERVICE_ROWS = 4;

/** Red is a thing to go and do something about. Dim is a thing that does not exist yet —
 *  the doctor is not built, and drawing it green would be a lamp for a service that has
 *  never run. Nothing is coloured by being merely present. */
export type Tone = "ok" | "red" | "dim";

export interface ServiceRow {
  readonly what: string;
  readonly state: string;
  readonly detail: string;
  readonly tone: Tone;
}

/** The release the doctor is planned for — docs/design/19. Healing. */
const DOCTOR = "0.0.2";

const COLOUR: Readonly<Record<Tone, string>> = {
  ok: "green",
  red: "red",
  dim: "gray",
};

/** The database the cockpit is drawn from. App keeps it to itself because nothing on a
 *  screen decides anything from the record — every other box is a slice of the board. The
 *  services box is the one thing on the screen that is not about the work, and the App it
 *  sits on is the only thing holding the handle it needs. */
const dbOf = (app: App): DatabaseSync => (app as unknown as { db: DatabaseSync }).db;

const ms = (n: number): string => {
  const s = Math.max(0, Math.round(n / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
};

/** Ready, and nothing open is attempting it — the same question the Queue box asks, by
 *  role, because a role is what a task waits for a worker of. */
function readyByRole(db: DatabaseSync): { role: string; n: number }[] {
  return db
    .prepare(
      `SELECT t.role AS role, count(*) AS n FROM task t
        WHERE t.state = 'ready'
          AND NOT EXISTS (SELECT 1 FROM assignment a
                           WHERE a.objective_type = 'task' AND a.objective_id = t.id
                             AND a.phase IN ('pending','running','waiting'))
        GROUP BY t.role ORDER BY t.role`,
    )
    .all() as unknown as { role: string; n: number }[];
}

function workersByRole(db: DatabaseSync): { role: string; busy: number; n: number }[] {
  return db
    .prepare(
      `SELECT w.role AS role, count(*) AS n,
              sum(CASE WHEN EXISTS (SELECT 1 FROM assignment a
                                     WHERE a.worker_id = w.id
                                       AND a.phase IN ('pending','running','waiting'))
                       THEN 1 ELSE 0 END) AS busy
         FROM worker w GROUP BY w.role ORDER BY w.role`,
    )
    .all() as unknown as { role: string; busy: number; n: number }[];
}

/** A heartbeat older than three of the holder's own intervals is a runner that is gone —
 *  see lease.ts, which is where that rule lives and is not restated here.
 *
 *  A gone runner with nothing queued is idle rather than dead: the two are the same row in
 *  the record, and the difference between them is whether anything was waiting. */
function runner(db: DatabaseSync, queued: number, at: string): ServiceRow {
  const lease = readLease(db);
  if (lease === null) {
    return {
      what: "runner",
      state: queued === 0 ? "idle" : "none",
      detail: queued === 0 ? "no runner holds this workspace" : `nothing holds ${queued} queued`,
      tone: queued === 0 ? "dim" : "red",
    };
  }
  const age = leaseAgeMs(lease, at);
  const stale = leaseIsStale(lease, at);
  return {
    what: "runner",
    state: stale ? (queued === 0 ? "idle" : "dead") : "alive",
    detail:
      `${lease.holder} · beat ${ms(age)} ago · every ${ms(lease.intervalMs)}` +
      (stale ? ` · ${STALE_INTERVALS} intervals missed` : ""),
    tone: stale ? "red" : "ok",
  };
}

/** The number in the file against the number in this build. They differ in both directions
 *  and neither is safe to read past, so both are named rather than merely flagged. */
function schema(db: DatabaseSync): ServiceRow {
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  const found = row?.version ?? 0;
  const same = found === SCHEMA_VERSION;
  return {
    what: "schema",
    state: same ? "current" : found > SCHEMA_VERSION ? "ahead" : "behind",
    detail: `database ${found} · this build understands ${SCHEMA_VERSION}`,
    tone: same ? "ok" : "red",
  };
}

/** Busy and idle per role, and — louder than either — a role with work ready and no worker
 *  of that role at all. That is not a queue moving slowly; it is a queue that cannot move,
 *  and nothing else on the board says so. */
function fleet(db: DatabaseSync): ServiceRow {
  const workers = workersByRole(db);
  const ready = readyByRole(db);
  const have = new Set(workers.map((w) => w.role));
  const starved = ready.filter((r) => !have.has(r.role));
  const per = workers.map((w) => `${w.role} ${w.busy} busy ${w.n - w.busy} idle`);
  const none = starved.map((r) => `no ${r.role} for ${r.n} ready`);
  const busy = workers.reduce((n, w) => n + w.busy, 0);
  const all = workers.reduce((n, w) => n + w.n, 0);
  return {
    what: "fleet",
    state: starved.length > 0 ? "short" : all === 0 ? "none" : `${busy}/${all} busy`,
    detail: [...none, ...per].join(" · ") || "no workers, no work waiting",
    tone: starved.length > 0 ? "red" : workers.length === 0 ? "dim" : "ok",
  };
}

/** Planned, and drawn as planned. A green lamp for a service nobody has written is the one
 *  thing this box must never say. */
const doctor = (): ServiceRow => ({
  what: "doctor",
  state: "not built",
  detail: `${DOCTOR} · healing and collection`,
  tone: "dim",
});

/** The four rows, in the order a reader scans them: who is running the workspace, whether
 *  this build may read it, what it has to run work with, and what is not there yet. */
export function services(db: DatabaseSync, queued: number, at: string = now()): ServiceRow[] {
  return [runner(db, queued, at), schema(db), fleet(db), doctor()];
}

/** The rows themselves. The border round them is the dashboard's, so the services box and
 *  every work box are one kind of box. */
export function Services({
  app,
  width,
  at,
}: {
  readonly app: App;
  readonly width: number;
  readonly at?: string | undefined;
}) {
  const rows = services(dbOf(app), app.boardNow().queued.length, at ?? now());
  const gutter = Math.max(...rows.map((r) => r.what.length));
  const states = Math.max(...rows.map((r) => r.state.length));
  return (
    <>
      {rows.map((r) => (
        <Text key={r.what} color={COLOUR[r.tone]} wrap="truncate">
          {clip(`${r.what.padEnd(gutter)}  ${r.state.padEnd(states)}  ${r.detail}`, width)}
        </Text>
      ))}
    </>
  );
}
