/** The cockpit changes the record only through the generated facade. These hold the two
 *  halves of that: what `a` offers is the facade's method list read for the row's state,
 *  and what `a` then does is the facade method itself — the same outcome, the same ledger
 *  line, as calling `Verbs` by hand. */
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, loadMachines, open, STATEFUL, TRANSITIONS, Verbs } from "@wecode/core";
import { App } from "../src/app.js";
import { loadViews } from "../src/views.js";
import { seed } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

const APP = fileURLToPath(new URL("../src/app.ts", import.meta.url));

const stateOf = (db: DatabaseSync, table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

const ledger = (db: DatabaseSync): { entity: string; verb: string; actor: string }[] =>
  db.prepare("SELECT entity, verb, actor FROM ledger ORDER BY id").all() as {
    entity: string;
    verb: string;
    actor: string;
  }[];

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

/** Put the cursor on a row by what it says. Ids repeat across tables, so the label is what
 *  names a row on a board whose boxes are queries over different ones. */
const cursorOn = (what: string): void => {
  const at = app.lines().findIndex((r) => r.what === what);
  expect(at, `no row ${what}`).toBeGreaterThanOrEqual(0);
  app.cursor = at;
};

describe("the verbs the cockpit offers are the facade's methods", () => {
  it("offers exactly the methods the facade has for the row's entity and state", () => {
    cursorOn("storefront"); // a project in_progress
    const expected = TRANSITIONS.filter(
      (t) => t.entity === "project" && t.method !== null && t.from.includes("in_progress"),
    ).map((t) => t.verb);

    expect(expected).toEqual(["hold", "drop"]);
    expect(app.verbs()).toEqual(expected);
  });

  /** A verb with no method is a transition nobody invokes. The offer list is read off the
   *  same table, so it cannot drift from what the facade can actually spell. */
  it("offers no verb the facade has no method for", () => {
    const methodless = new Set(
      TRANSITIONS.filter((t) => t.method === null).map((t) => `${t.entity}.${t.verb}`),
    );
    expect(methodless.size).toBeGreaterThan(0);

    // Every row the dashboard lists, whatever entity its box is a query over.
    for (let at = 0; at < app.lines().length; at++) {
      app.cursor = at;
      expect(app.verbs().length).toBeGreaterThan(0);
      for (const verb of app.verbs()) {
        for (const e of STATEFUL) expect(methodless).not.toContain(`${e}.${verb}`);
      }
    }
  });
});

describe("a verb the cockpit applies is the facade method", () => {
  it("leaves the record and the ledger as the facade method would", () => {
    cursorOn("storefront");
    app.key("a");
    app.key("h");

    expect(stateOf(db, "project", tree.project)).toBe("on_hold");

    // The same verb, by hand, on a second database seeded identically.
    const twin = open(":memory:");
    const twinTree = seed(twin);
    const out = new Verbs(new Engine(twin, machines)).holdProject(twinTree.project, "operator");

    expect(out.ok).toBe(true);
    expect(stateOf(twin, "project", twinTree.project)).toBe("on_hold");
    expect(ledger(db)).toEqual(ledger(twin));
  });

  it("reports the refusal the facade method returns, and writes nothing", () => {
    cursorOn("send the reset mail"); // a task ready: give_up is guarded by max_retry_reached
    expect(app.verbs()).toContain("give_up");

    app.key("a");
    app.key("g");

    const out = new Verbs(new Engine(db, machines)).giveUpTask(tree.task, "operator");
    expect(out.ok).toBe(false);
    expect(app.status).toBe(out.why);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });
});

/** The point of the move: there is one door into the record from here. A second
 *  `engine.apply` would be a verb the facade never saw, spelled as a string. */
describe("the cockpit has no way round the facade", () => {
  it("names no entity, verb or apply of its own", () => {
    const source = readFileSync(APP, "utf8");
    expect(source).not.toMatch(/\.apply\s*\(/);
    expect(source).toContain("new Verbs(");
  });
});
