/** The services box, asserted twice over: as the four rows it decides, and as the box the
 *  dashboard draws them in.
 *
 *  Each of the three things this box exists to catch gets a test that can only pass when it
 *  is caught — a heartbeat three intervals old, a database this build cannot read, and a
 *  role with work ready and nobody to do it. A test that asserts the box is present would
 *  pass against four blank lines. */
import { coloured, plain, RED } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open, SCHEMA_VERSION, STALE_INTERVALS } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadServices, services, serviceLines, SERVICE_ROWS } from "../src/services.js";
import { loadViews } from "../src/views.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();
const config = loadServices();

/** A tick a person would recognise: ten seconds, so three of them is half a minute. */
const TICK = 10_000;
const AT = "2026-09-13T12:00:00.000Z";
const minus = (ms: number): string => new Date(Date.parse(AT) - ms).toISOString();

let db: DatabaseSync;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

/** The rows the box would draw right now, by name. `queued` is the board's own count. */
const rows = (at: string = AT) => {
  app.refresh();
  const out = services(db, app.boardNow().queued.length, config, at);
  return Object.fromEntries(out.map((r) => [r.what, r]));
};

const lease = (holder: string, beat: string, intervalMs = TICK): void => {
  db.prepare(
    "INSERT INTO runner_lease (id,holder,interval_ms,taken_at,heartbeat) VALUES (1,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET holder=excluded.holder, interval_ms=excluded.interval_ms, " +
      "taken_at=excluded.taken_at, heartbeat=excluded.heartbeat",
  ).run(holder, intervalMs, beat, beat);
};

const worker = (slug: string, role: string): number =>
  ins(db, "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)", slug, slug, role, "agent", T, T);

/** An open assignment, which is what makes a worker busy. */
const assign = (slug: string, workerId: number, phase = "running"): number =>
  ins(
    db,
    "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    slug, "task", 1, workerId, "{}", "{}", `/tmp/${slug}`, phase, "{}", T, T,
  );

/** A second ready task, so a role other than the seed's `engineer` has work waiting. */
const readyTask = (slug: string, role: string): number =>
  ins(
    db,
    "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,(SELECT id FROM acceptance_test LIMIT 1),?,?,?,?,?,?,?)",
    slug, slug, JSON.stringify({ write: [], tools: [] }), role, JSON.stringify({ tokens: 1, seconds: 1 }), "ready", T, T,
  );

/** The whole frame, as the operator sees it. */
const frame = (width = 120, height = 60): string =>
  render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "";

const lines = (width = 120, height = 60): string[] => plain(frame(width, height)).split("\n");

describe("the runner row", () => {
  it("names the holder and how long since it last said anything", () => {
    lease("runner-host/4021", minus(4_000));
    expect(rows()["runner"]).toMatchObject({ state: "alive", alarm: false });
    expect(rows()["runner"]?.detail).toContain("runner-host/4021");
    expect(rows()["runner"]?.detail).toContain("beat 4s ago");
  });

  it("goes red when the heartbeat is older than three of the holder's own intervals", () => {
    // The seed leaves one task ready, so there is work this silence is costing.
    lease("runner-host/4021", minus(STALE_INTERVALS * TICK + 1_000));
    const row = rows()["runner"];
    expect(row?.state).toBe("dead");
    expect(row?.alarm).toBe(true);
    expect(row?.detail).toContain("1 queued");

    // And the interval is the holder's, not a number this box picked: a runner on a slow
    // tick is not called dead by a reader that assumed a fast one.
    lease("slow-host/9", minus(STALE_INTERVALS * TICK + 1_000), TICK * 10);
    expect(rows()["runner"]).toMatchObject({ state: "alive", alarm: false });
  });

  it("is two intervals behind and still alive", () => {
    lease("runner-host/4021", minus(2 * TICK));
    expect(rows()["runner"]).toMatchObject({ state: "alive", alarm: false });
  });

  it("says idle rather than dead when nothing is queued, and does not go red", () => {
    db.prepare("UPDATE task SET state = 'done'").run();
    lease("runner-host/4021", minus(STALE_INTERVALS * TICK + 60_000));
    const row = rows()["runner"];
    expect(row?.state).toBe("idle");
    expect(row?.detail).toContain("nothing queued");
    // A quiet log is not a hung runner.
    expect(row?.alarm).toBe(false);
  });

  it("says so when no runner holds the workspace at all", () => {
    expect(rows()["runner"]).toMatchObject({ state: "none", alarm: true });
    db.prepare("UPDATE task SET state = 'done'").run();
    expect(rows()["runner"]).toMatchObject({ state: "idle", alarm: false });
  });
});

describe("the schema row", () => {
  it("is quiet when the database is the version this build understands", () => {
    const row = rows()["schema"];
    expect(row).toMatchObject({ state: "current", alarm: false });
    expect(row?.detail).toBe(`database ${SCHEMA_VERSION} · this build understands ${SCHEMA_VERSION}`);
  });

  it("goes red, and names both numbers, when the database is ahead of this build", () => {
    // Exactly what locked the CLI out: the record migrated, this binary did not.
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
    const row = rows()["schema"];
    expect(row?.state).toBe("ahead");
    expect(row?.alarm).toBe(true);
    expect(row?.detail).toContain(`database ${SCHEMA_VERSION + 1}`);
    expect(row?.detail).toContain(`this build understands ${SCHEMA_VERSION}`);
  });

  it("goes red when the database is behind, too", () => {
    db.prepare("UPDATE schema_version SET version = 1").run();
    expect(rows()["schema"]).toMatchObject({ state: "behind", alarm: true });
  });
});

describe("the fleet row", () => {
  it("counts workers busy and idle, per role", () => {
    const busy = worker("eng-1", "engineer");
    worker("eng-2", "engineer");
    worker("rev-1", "reviewer");
    assign("a1", busy);
    const row = rows()["fleet"];
    expect(row?.state).toBe("1/3 busy");
    expect(row?.detail).toBe("engineer 1 busy 1 idle · reviewer 0 busy 1 idle");
    expect(row?.alarm).toBe(false);
  });

  it("goes red for a role with work ready and no worker of that role at all", () => {
    worker("eng-1", "engineer");
    readyTask("prove-it", "acceptance-tester");
    readyTask("prove-it-too", "acceptance-tester");
    const row = rows()["fleet"];
    expect(row?.state).toBe("short");
    expect(row?.alarm).toBe(true);
    // Named first: it is the thing that cannot move, not the thing moving slowly.
    expect(row?.detail).toBe("no acceptance-tester for 2 ready · engineer 0 busy 1 idle");
  });

  it("is not short when the role has a worker, however busy that worker is", () => {
    const only = worker("at-1", "acceptance-tester");
    readyTask("prove-it", "acceptance-tester");
    assign("a1", only);
    expect(rows()["fleet"]).toMatchObject({ state: "1/1 busy", alarm: false });
  });
});

describe("the doctor row", () => {
  it("is the release it is planned for and the word not built — never a lamp", () => {
    const row = rows()["doctor"];
    expect(row?.state).toBe("not built");
    expect(row?.detail).toContain("0.0.2");
    expect(row?.alarm).toBe(false);
  });

  it("says what views.yaml says, so shipping it is an edit to the config", () => {
    expect(rows()["doctor"]).toMatchObject({
      state: config.doctor.state,
      detail: `${config.doctor.version} · ${config.doctor.detail}`,
    });
  });
});

describe("the box", () => {
  it("is drawn from the record and never from this host", () => {
    // Nothing the box says depends on a process on this machine: the holder is a string
    // the record carries, and it names a host the cockpit has never heard of.
    lease("some-other-host/1", minus(1_000));
    expect(rows()["runner"]?.detail).toContain("some-other-host/1");
    expect(rows()["runner"]?.state).toBe("alive");
  });

  it("is bordered, titled, and above every box of work", () => {
    const out = lines();
    const at = out.findIndex((l) => l.includes(`─ ${config.title}`));
    expect(at).toBe(0);
    expect(out[at]?.startsWith("┌")).toBe(true);

    const inside = out.slice(at + 1, at + 1 + SERVICE_ROWS);
    expect(inside.every((l) => l.startsWith("│") && l.endsWith("│"))).toBe(true);
    expect(inside.map((l) => l.slice(1).trimStart().split(" ")[0])).toEqual([
      "runner",
      "schema",
      "fleet",
      "doctor",
    ]);
    expect(out[at + SERVICE_ROWS + 1]?.startsWith("└")).toBe(true);

    const first = out.findIndex((l) => l.includes(`─ ${views[0]?.title} (`));
    expect(first).toBeGreaterThan(at + SERVICE_ROWS);
  });

  it("colours an alarming row red and leaves every quiet row plain", () => {
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
    app.refresh();
    const red = coloured(frame(), RED);
    expect(red.some((t) => t.includes("ahead"))).toBe(true);
    // The doctor is not built, and an unbuilt service is not coloured at all.
    expect(red.some((t) => t.includes("not built"))).toBe(false);
  });

  it("does not follow you onto a box page or a node screen", () => {
    app.key("v");
    app.key("p");
    expect(lines(120, 20).some((l) => l.includes(`─ ${config.title}`))).toBe(false);
  });

  it("loses a long row's tail to an ellipsis rather than wrapping", () => {
    lease("a-very-long-hostname-indeed.example.internal/123456", minus(1_000));
    app.refresh();
    const drawn = serviceLines(services(db, 1, config, AT), 40);
    expect(drawn.every((l) => l.length <= 40)).toBe(true);
    expect(drawn[0]?.endsWith("…")).toBe(true);
    for (const line of lines(40, 60)) expect(line.length).toBeLessThanOrEqual(40);
  });
});
