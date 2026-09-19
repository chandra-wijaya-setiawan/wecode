import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { loadMachines, open } from "@wecode/core";
import { App, boxKeys } from "../src/app.js";
import { loadOffPage, loadViews } from "../src/views.js";

const views = loadViews();
const machines = loadMachines();

const T = "2026-09-13T00:00:00.000Z";

const ins = (db: DatabaseSync, sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** One of everything, in states that put a row in a box: a queued task and a planned story
 *  on the dashboard, and the whole chain underneath for a node screen to walk.
 *
 *  Two rows rather than one, because half of what is asked here is what the cursor does
 *  between them. The board's seven boxes are each one question, and an in_progress epic or
 *  story is on none of them — it is in flight, which the outline and Running answer. */
function seed(db: DatabaseSync) {
  const ws = ins(db, "INSERT INTO workspace (slug,name,path,created_at,updated_at) VALUES (?,?,?,?,?)", "acme", "acme", "/acme", T, T);
  const project = ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", "storefront", ws, "storefront", "/repo", "in_progress", T, T);
  const release = ins(db, "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "v1", project, "1.0.0", "in_progress", T, T);
  const epic = ins(db, "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "recovery", release, "account recovery", "in_progress", T, T);
  const story = ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "reset", epic, "password reset", "in_progress", T, T);
  const planned = ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "next", epic, "the next thing", "planned", T, T);
  const requirement = ins(db, "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "one-change", story, "one link, one change", "in_progress", T, T);
  const criteria = ins(db, "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "emailed", requirement, "a link is emailed", "in_progress", T, T);
  const acceptance = ins(db, "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mail-arrives", criteria, "the mail arrives", "script", "bash test/mail.sh", "planned", T, T);
  const dropped = ins(db, "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mail-twice", criteria, "the mail arrives twice", "script", "bash test/twice.sh", "dropped", T, T);
  const task = ins(db, "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "send-mail", acceptance, "send the reset mail", JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "ready", T, T);
  const taskTest = ins(db, "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mailer-called", task, "the mailer is called", "script", "vitest run mail", "ready", T, T);
  return { project, release, epic, story, planned, requirement, criteria, acceptance, dropped, task, taskTest };
}

const stateOf = (db: DatabaseSync, table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

const whats = (): string[] => app.lines().map((r) => r.what);

/** The outline, which is how a project is reached now that the board has no projects box:
 *  its seven are needs you, running, queue, cooking, planned, delivered and dropped. */
const fromTheOutline = (): void => {
  app.key("v");
  app.key("t");
  expect(app.screen).toEqual({ kind: "outline" });
};

/** Put the cursor on a row by what it says, wherever the screen came from. An outline row
 *  leads with the tree guide it is drawn under; a board row and a child row do not. */
const cursorOn = (what: string): void => {
  const at = app.lines().findIndex((r) => r.what === what || r.what.endsWith(` ${what}`));
  expect(at, `no row ${what}`).toBeGreaterThanOrEqual(0);
  app.cursor = at;
};

/** Down the chain to the screen listing this entity's siblings. */
const descendTo = (...steps: string[]): void => {
  for (const step of steps) {
    const at = app.lines().findIndex((r) => r.what === step || r.what.endsWith(` ${step}`));
    expect(at, `no row ${step}`).toBeGreaterThanOrEqual(0);
    app.cursor = at;
    app.key("enter");
  }
};

describe("the dashboard", () => {
  it("lists every box's rows in the order the page declares", () => {
    // needs you, running, queue, cooking, planned, delivered, dropped — seven boxes, and
    // the project is on none of them: it is reached through the outline. The ready task is
    // Queue's, which the page draws third, and the planned story is Planned's, which it
    // draws fifth. So the rows come back in the page's order, not the board's.
    expect(whats()).toEqual([
      "send the reset mail",
      "the next thing",
    ]);
    expect(app.screen).toEqual({ kind: "dashboard" });
  });

  it("starts with the cursor on the first row, nothing said and nothing quit", () => {
    expect(app.cursor).toBe(0);
    expect(app.status).toBe("");
    expect(app.quit).toBe(false);
  });
});

describe("the keys that move", () => {
  it("j and k step, and stop at the ends rather than wrapping", () => {
    app.key("j");
    expect(app.cursor).toBe(1);
    app.key("k");
    app.key("k");
    expect(app.cursor).toBe(0);
    for (let i = 0; i < 20; i++) app.key("j");
    expect(app.cursor).toBe(app.lines().length - 1);
  });

  it("g and G go to the first and last row", () => {
    app.key("G");
    expect(app.cursor).toBe(app.lines().length - 1);
    app.key("g");
    expect(app.cursor).toBe(0);
  });

  it("q quits and r re-reads the database", () => {
    expect(whats()).not.toContain("checkout");
    db.prepare(
      "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("checkout", tree.epic, "checkout", "in_progress", T, T);

    app.key("r");
    expect(app.status).toBe("refreshed");
    expect(whats()).toContain("checkout");

    app.key("q");
    expect(app.quit).toBe(true);
  });

  it("says so rather than doing something when the key means nothing", () => {
    app.key("z");
    expect(app.status).toBe("z does nothing here");
    expect(app.cursor).toBe(0);
  });
});

describe("v, then a box's letter", () => {
  it("gives every box a letter of its own", () => {
    const keys = boxKeys(views);
    expect([...keys.values()].map((v) => v.name).sort()).toEqual(views.map((v) => v.name).sort());
    expect(keys.size).toBe(views.length);
  });

  it("opens that box at full height, with only its rows", () => {
    // Queue, which is where the ready task lives now that it is a box again.
    const c = [...boxKeys(views)].find(([, v]) => v.name === "queued")?.[0] as string;

    app.key("v");
    expect(app.status).toContain("Queue");
    app.key(c);

    expect(app.screen).toMatchObject({ kind: "box" });
    expect(whats()).toEqual(["send the reset mail"]);
  });

  /** The point of cutting a box from the page was the height it took from the boxes beside
   *  it. Its letter took none of that, so the projects the dashboard no longer draws are
   *  still one keystroke away — the box is off the page, not taken away. Which letter that
   *  is comes off `boxKeys`, because with seven boxes on the page the free letters are the
   *  page's leavings and hardcoding one here would make the order of the page a fact about
   *  this test. */
  it("opens an off-page box on its letter, and offers it", () => {
    expect(whats()).not.toContain("storefront");
    const j = [...boxKeys([...views, ...loadOffPage()])].find(([, v]) => v.name === "projects")?.[0] as string;

    app.key("v");
    expect(app.status).toContain("Projects");
    app.key(j);

    expect(app.screen).toMatchObject({ kind: "box" });
    expect(whats()).toEqual(["storefront"]);
    app.key("enter");
    expect(app.screen).toMatchObject({ kind: "node", entity: "project" });
  });

  /** An off-page box may not take a letter one of the four on the page wants: the page is
   *  what an operator reads all day, and its letters are the ones spent from memory. */
  it("lets the page's boxes take their letters first", () => {
    const page = boxKeys(views);
    const all = boxKeys([...views, ...loadOffPage()]);
    for (const [k, v] of page) expect(all.get(k)?.name).toBe(v.name);
    expect(all.size).toBe(page.size + loadOffPage().length);
  });

  it("refuses a letter no box claims, and stays where it was", () => {
    app.key("v");
    app.key("2");

    expect(app.status).toBe("no box on 2");
    expect(app.screen).toEqual({ kind: "dashboard" });
  });

  it("does not treat the box letter as a key of its own", () => {
    app.key("v");
    app.key("j"); // a letter here picks a box; it must not move the cursor
    expect(app.cursor).toBe(0);
  });
});

describe("esc, and the stack it pops", () => {
  it("comes back to the row it left", () => {
    app.key("j");
    const p = [...boxKeys(views)].find(([, v]) => v.name === "queued")?.[0] as string;
    app.key("v");
    app.key(p);
    expect(app.cursor).toBe(0);

    app.key("esc");
    expect(app.screen).toEqual({ kind: "dashboard" });
    expect(app.cursor).toBe(1);
  });

  it("pops one screen at a time", () => {
    fromTheOutline();
    descendTo("storefront", "1.0.0");
    expect(app.screen).toMatchObject({ kind: "node", entity: "release" });

    app.key("esc");
    expect(app.screen).toMatchObject({ kind: "node", entity: "project" });
    // One at a time all the way out: the outline the project was opened from, then home.
    app.key("esc");
    expect(app.screen).toEqual({ kind: "outline" });
    app.key("esc");
    expect(app.screen).toEqual({ kind: "dashboard" });
  });

  it("says it is already home rather than emptying the stack", () => {
    app.key("esc");
    expect(app.screen).toEqual({ kind: "dashboard" });
    expect(app.status).toBe("this is the dashboard");
  });
});

describe("enter, and the descent", () => {
  it("goes project to release to epic to story to requirement to criteria to test to task to task test", () => {
    const chain: [string, string][] = [
      ["storefront", "release"],
      ["1.0.0", "epic"],
      ["account recovery", "story"],
      ["password reset", "requirement"],
      ["one link, one change", "acceptance_criteria"],
      ["a link is emailed", "acceptance_test"],
      ["the mail arrives", "task"],
      ["send the reset mail", "task_test"],
    ];

    fromTheOutline();
    for (const [row, child] of chain) {
      descendTo(row);
      expect(app.lines().map((r) => r.detail)).toContain(child);
    }
    expect(whats()).toEqual(["the mailer is called"]);
  });

  it("shows a child's id and state, which is what a verb is judged from", () => {
    fromTheOutline();
    descendTo("storefront");
    expect(app.lines()).toEqual([
      { id: tree.release, what: "1.0.0", state: "in_progress", detail: "release" },
    ]);
  });

  it("says there is nothing under a leaf rather than opening an empty screen", () => {
    fromTheOutline();
    descendTo("storefront", "1.0.0", "account recovery", "password reset");
    descendTo("one link, one change", "a link is emailed", "the mail arrives");
    descendTo("send the reset mail", "the mailer is called");

    expect(app.screen).toMatchObject({ kind: "node", entity: "task_test" });
    expect(app.lines()).toEqual([]);
    app.key("enter");
    expect(app.status).toBe("nothing to open");
    expect(app.screen).toMatchObject({ kind: "node", entity: "task_test" });
  });
});

describe("verbs, read off the row's state machine", () => {
  it("offers what the machine allows from the state the row is in", () => {
    fromTheOutline();
    cursorOn("storefront");
    expect(app.verbs()).toEqual(["hold", "drop"]); // a project in_progress
  });

  it("never offers a transition no actor may invoke", () => {
    fromTheOutline();
    descendTo("storefront", "1.0.0", "account recovery");
    cursorOn("password reset");

    expect(app.verbs()).toContain("hold");
    expect(app.verbs()).not.toContain("deliver"); // automatic: the cascade fires it
  });

  it("offers none on a row nothing may be done to", () => {
    fromTheOutline();
    descendTo("storefront", "1.0.0", "account recovery", "password reset");
    descendTo("one link, one change", "a link is emailed");
    app.cursor = app.lines().findIndex((r) => r.id === tree.dropped);

    expect(app.verbs()).toEqual([]);
    app.key("a");
    expect(app.status).toBe("nothing may be done to this row");
  });
});

describe("a, then a verb's initial", () => {
  it("applies the one verb that letter names", () => {
    fromTheOutline();
    cursorOn("storefront");
    app.key("a");
    expect(app.status).toContain("hold");
    app.key("h");

    expect(stateOf(db, "project", tree.project)).toBe("on_hold");
    expect(app.status).toContain("on_hold");
    expect(app.lines()[app.cursor]?.state).toBe("on_hold");
  });

  it("refuses an ambiguous letter rather than guessing", () => {
    fromTheOutline();
    descendTo("storefront", "1.0.0", "account recovery", "password reset");
    descendTo("one link, one change", "a link is emailed");
    app.cursor = app.lines().findIndex((r) => r.id === tree.acceptance);
    expect(app.verbs()).toEqual(["deliver", "drop"]);

    app.key("a");
    app.key("d");

    expect(app.status).toBe("d is ambiguous: deliver, drop");
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("planned");
  });

  it("says so when no verb starts with that letter", () => {
    fromTheOutline();
    cursorOn("storefront");
    app.key("a");
    app.key("z");

    expect(app.status).toBe("no verb on z");
    expect(stateOf(db, "project", tree.project)).toBe("in_progress");
  });

  it("reports a refusal from the machine rather than writing anything", () => {
    fromTheOutline();
    descendTo("storefront");
    app.cursor = 0; // the release, whose drop is guarded
    app.key("a");
    app.key("d");

    expect(stateOf(db, "release", tree.release)).toBe("in_progress");
    expect(app.status).not.toBe("");
  });

  it("only arms for one key", () => {
    app.key("a");
    app.key("z");
    app.key("j"); // no longer armed: this moves
    expect(app.cursor).toBe(1);
  });
});
