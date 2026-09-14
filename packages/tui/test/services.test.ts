import { coloured, GREEN, plain, RED } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open, SCHEMA_VERSION, STALE_INTERVALS } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { services } from "../src/services.js";
import { loadViews } from "../src/views.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

/** The lease's tick, and a clock far enough past it to have missed three of them. */
const TICK = 2000;
const later = (ms: number): string => new Date(Date.parse(T) + ms).toISOString();
const FRESH = later(TICK);
const STALE = later((STALE_INTERVALS + 1) * TICK + 1);

let db: DatabaseSync;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

const lease = (heartbeat: string, holder = "runner-host/4242"): void => {
  ins(
    db,
    "INSERT INTO runner_lease (id,holder,interval_ms,taken_at,heartbeat) VALUES (1,?,?,?,?)",
    holder,
    TICK,
    T,
    heartbeat,
  );
};

const worker = (slug: string, role: string): number =>
  ins(
    db,
    "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    slug,
    role,
    "agent",
    T,
    T,
  );

/** An open assignment is what makes a worker busy; the objective is beside the point here,
 *  so it is the seed's own task. */
const busy = (workerId: number, slug: string): void => {
  ins(
    db,
    "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    slug,
    "task",
    1,
    workerId,
    "{}",
    "{}",
    "/w",
    "running",
    "{}",
    T,
    T,
  );
};

/** The seed's one ready task, taken out of the queue, so "the queue is empty" can be told
 *  from "nothing is running it". */
const drainQueue = (): void => {
  db.prepare("UPDATE task SET state = 'done'").run();
  app.refresh();
};

const rows = (at: string) => services(db, app.boardNow().queued.length, at);
const row = (at: string, what: string) => rows(at).find((r) => r.what === what);

/** The frame, so the rows are asserted where an operator reads them. */
const frame = (): string =>
  render(createElement(Cockpit, { app, width: 100, height: 60 })).lastFrame() ?? "";

describe("the runner row", () => {
  it("names the holder and how long ago it last beat", () => {
    lease(FRESH);
    expect(row(later(TICK * 2), "runner")).toMatchObject({
      state: "alive",
      tone: "ok",
    });
    expect(row(later(TICK * 2), "runner")?.detail).toContain("runner-host/4242");
    expect(row(later(TICK * 2), "runner")?.detail).toContain("beat 2s ago");
  });

  it("goes red on a heartbeat older than three of the holder's own intervals", () => {
    lease(T);
    // One missed tick is a slow disk; the row is still alive.
    expect(row(later(TICK + 1), "runner")).toMatchObject({ state: "alive", tone: "ok" });
    expect(row(STALE, "runner")).toMatchObject({ state: "dead", tone: "red" });
    expect(row(STALE, "runner")?.detail).toContain(`${STALE_INTERVALS} intervals missed`);
  });

  it("says idle rather than dead when nothing is queued", () => {
    lease(T);
    drainQueue();
    expect(app.boardNow().queued).toHaveLength(0);
    expect(row(STALE, "runner")).toMatchObject({ state: "idle" });
  });

  it("reports no runner at all against what is waiting for one", () => {
    expect(row(FRESH, "runner")).toMatchObject({ state: "none", tone: "red" });
    expect(row(FRESH, "runner")?.detail).toContain("1 queued");
    drainQueue();
    expect(row(FRESH, "runner")).toMatchObject({ state: "idle", tone: "dim" });
  });
});

describe("the schema row", () => {
  const setVersion = (n: number): void => {
    db.prepare("UPDATE schema_version SET version = ?").run(n);
  };

  it("is current when the file is at the version this build understands", () => {
    expect(row(FRESH, "schema")).toMatchObject({ state: "current", tone: "ok" });
    expect(row(FRESH, "schema")?.detail).toContain(`understands ${SCHEMA_VERSION}`);
  });

  it("goes red and names both numbers when the database is ahead of this build", () => {
    setVersion(SCHEMA_VERSION + 1);
    const r = row(FRESH, "schema");
    expect(r).toMatchObject({ state: "ahead", tone: "red" });
    expect(r?.detail).toContain(`database ${SCHEMA_VERSION + 1}`);
    expect(r?.detail).toContain(`understands ${SCHEMA_VERSION}`);
  });

  it("goes red when the database is behind this build", () => {
    setVersion(SCHEMA_VERSION - 1);
    expect(row(FRESH, "schema")).toMatchObject({ state: "behind", tone: "red" });
  });
});

describe("the fleet row", () => {
  it("counts workers busy and idle, per role", () => {
    busy(worker("e1", "engineer"), "a1");
    worker("e2", "engineer");
    worker("r1", "reviewer");
    const r = row(FRESH, "fleet");
    expect(r).toMatchObject({ state: "1/3 busy", tone: "ok" });
    expect(r?.detail).toContain("engineer 1 busy 1 idle");
    expect(r?.detail).toContain("reviewer 0 busy 1 idle");
  });

  it("calls out a role with work ready and no worker of that role at all", () => {
    // The seed's ready task is an engineer's, and the only worker is a reviewer.
    worker("r1", "reviewer");
    const r = row(FRESH, "fleet");
    expect(r).toMatchObject({ state: "short", tone: "red" });
    expect(r?.detail).toContain("no engineer for 1 ready");
    // Said first: a role nothing can run is louder than the tallies beside it.
    expect(r?.detail.indexOf("no engineer")).toBeLessThan(r?.detail.indexOf("reviewer") ?? -1);
  });

  it("does not call a role short when it has a worker, however busy", () => {
    busy(worker("e1", "engineer"), "a1");
    expect(row(FRESH, "fleet")).toMatchObject({ tone: "ok" });
  });

  it("is not red for no workers when no work is waiting either", () => {
    drainQueue();
    expect(row(FRESH, "fleet")).toMatchObject({ state: "none", tone: "dim" });
  });
});

describe("the doctor row", () => {
  it("is shown as the release it is planned for, and never as a green lamp", () => {
    const r = row(FRESH, "doctor");
    expect(r).toMatchObject({ state: "not built", tone: "dim" });
    expect(r?.detail).toContain("0.0.2");
    expect(coloured(frame(), GREEN).join("\n")).not.toContain("doctor");
  });
});

describe("the box on the dashboard", () => {
  it("draws the four rows, and colours what is wrong red", () => {
    lease(T);
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
    const out = frame();
    for (const what of ["runner", "schema", "fleet", "doctor"]) {
      expect(plain(out)).toContain(what);
    }
    const red = coloured(out, RED).join("\n");
    expect(red).toContain("schema");
    expect(red).toContain("fleet");
    expect(red).not.toContain("doctor");
  });

  it("is drawn from the record, so a cockpit on another host still reports the runner", () => {
    // Nothing here is running a runner: the row comes from what the lease says.
    lease(FRESH, "some-other-host/99");
    expect(plain(frame())).toContain("some-other-host/99");
  });
});
