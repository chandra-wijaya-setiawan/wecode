import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { draw } from "../src/screens.js";
import { loadViews, ViewError } from "../src/views.js";

const views = loadViews();
const machines = loadMachines();

const T = "2026-09-13T00:00:00.000Z";

const ins = (db: DatabaseSync, sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** The same one-of-everything the App's own tests use: a project and a queued task on the
 *  dashboard, and the chain underneath for a node screen to walk. */
function seed(db: DatabaseSync) {
  const ws = ins(db, "INSERT INTO workspace (slug,name,path,created_at,updated_at) VALUES (?,?,?,?,?)", "acme", "acme", "/acme", T, T);
  const project = ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", "storefront", ws, "storefront", "/repo", "in_progress", T, T);
  const release = ins(db, "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "v1", project, "1.0.0", "in_progress", T, T);
  const epic = ins(db, "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "recovery", release, "account recovery", "in_progress", T, T);
  const story = ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "reset", epic, "password reset", "in_progress", T, T);
  const requirement = ins(db, "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "one-change", story, "one link, one change", "in_progress", T, T);
  const criteria = ins(db, "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "emailed", requirement, "a link is emailed", "in_progress", T, T);
  const acceptance = ins(db, "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mail-arrives", criteria, "the mail arrives", "script", "bash test/mail.sh", "planned", T, T);
  const task = ins(db, "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "send-mail", acceptance, "send the reset mail", JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "ready", T, T);
  ins(db, "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mailer-called", task, "the mailer is called", "script", "vitest run mail", "ready", T, T);
  return { project, epic, story, task };
}

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

const lines = (width = 100, height = 60): string[] => draw(app, width, height).split("\n");

/** Down the chain, the way the App's tests do it. */
const descendTo = (...steps: string[]): void => {
  for (const step of steps) {
    const at = app.lines().findIndex((r) => r.what === step);
    expect(at, `no row ${step}`).toBeGreaterThanOrEqual(0);
    app.cursor = at;
    app.key("enter");
  }
};

describe("the frame", () => {
  it("is exactly as tall as the terminal, whatever the screen", () => {
    for (const height of [3, 10, 24, 60]) expect(lines(100, height)).toHaveLength(height);
    descendTo("storefront");
    for (const height of [3, 10, 24, 60]) expect(lines(100, height)).toHaveLength(height);
  });

  it("never draws a line wider than the terminal", () => {
    for (const line of lines(28, 40)) expect(line.length).toBeLessThanOrEqual(28);
  });
});

describe("the dashboard", () => {
  it("draws every box in config order", () => {
    const out = lines();
    const titles = views.map((v) => out.findIndex((l) => l.startsWith(`${v.title} (`)));
    expect(titles.every((i) => i >= 0)).toBe(true);
    expect([...titles].sort((a, b) => a - b)).toEqual(titles);
  });

  it("says what an empty box is empty of, in that box's own words", () => {
    const out = lines().join("\n");
    expect(out).toContain("Running (0)");
    expect(out).toContain("nothing is running");
  });

  it("trims a box to the rows it declares and says how many it dropped", () => {
    for (let i = 0; i < 12; i += 1) {
      ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", `p${i}`, 1, `project ${i}`, "/repo", "in_progress", T, T);
    }
    app.refresh();
    const out = lines();
    const at = out.findIndex((l) => l.startsWith("Projects ("));
    const declared = views.find((v) => v.name === "projects")?.rows ?? 0;
    expect(out[at]).toBe("Projects (13)");
    // The declared rows, the last of which is the tally of what did not fit.
    expect(out.slice(at + 1, at + 1 + declared).at(-1)).toContain(`… and ${13 - (declared - 1)} more`);
    expect(out[at + 1 + declared]).toBe("Running (0)");
  });

  it("marks the cursor in the box that holds it and in no other", () => {
    app.cursor = app.lines().findIndex((r) => r.what === "send the reset mail");
    const marked = lines().filter((l) => l.startsWith("> "));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("send the reset mail");
  });
});

describe("a box screen", () => {
  it("draws one filter, at full height, with the cursor", () => {
    for (let i = 0; i < 20; i += 1) {
      ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", `p${i}`, 1, `project ${i}`, "/repo", "in_progress", T, T);
    }
    app.refresh();
    app.key("v");
    app.key("p");
    expect(app.screen).toMatchObject({ kind: "box" });

    const out = lines(100, 12);
    expect(out[0]).toBe("Projects (21)");
    // Eleven lines for the box, one for the key bar — more than the six it gets on the
    // dashboard, and no other box on the screen.
    expect(out.filter((l) => l.startsWith("Running ("))).toHaveLength(0);
    expect(out.filter((l) => /^[>\s]\s*\d/.test(l)).length).toBeGreaterThan(6);
    expect(out.filter((l) => l.startsWith("> "))).toHaveLength(1);
  });

  it("says the box is empty rather than drawing nothing", () => {
    app.key("v");
    app.key("r");
    expect(app.screen).toMatchObject({ kind: "box" });
    const out = lines(100, 10).join("\n");
    expect(out).toContain("Running (0)");
    expect(out).toContain("nothing is running");
  });
});

describe("a node screen", () => {
  beforeEach(() => descendTo("storefront"));

  it("draws the record's fields, then its children as a list", () => {
    const out = lines(100, 20);
    expect(out[0]).toBe("entity    project");
    expect(out[1]).toBe(`id        #${tree.project}`);
    expect(out[2]).toBe("children  1");

    const at = out.findIndex((l) => l.startsWith("children ("));
    expect(at).toBeGreaterThan(2);
    expect(out[at]).toBe("children (1)");
    expect(out[at + 1]).toContain("1.0.0");
    expect(out[at + 1]).toContain("release");
    expect(out[at + 1]).toMatch(/^> /);
  });

  it("follows the chain down, so each node draws the entity it is on", () => {
    descendTo("1.0.0", "account recovery", "password reset");
    const out = lines(100, 20);
    expect(out[0]).toBe("entity    story");
    expect(out.join("\n")).toContain("one link, one change");
  });

  it("says so when a node has no children rather than leaving the list blank", () => {
    descendTo("1.0.0", "account recovery", "password reset", "one link, one change", "a link is emailed", "the mail arrives", "send the reset mail", "the mailer is called");
    const out = lines(100, 20);
    expect(out[0]).toBe("entity    task_test");
    expect(out.join("\n")).toContain("nothing under it");
  });
});

describe("the key bar", () => {
  const bar = (height = 20): string => lines(100, height).at(-1) as string;

  it("is the last line of the frame", () => {
    expect(bar()).toContain("q quit");
    expect(bar(4)).toContain("q quit");
  });

  it("names every key the dashboard answers, and esc is not one of them", () => {
    for (const k of ["j/k", "g/G", "enter", "v", "a", "r", "q"]) expect(bar()).toContain(k);
    expect(bar()).not.toContain("esc");
  });

  it("names esc once a screen has something to go back to", () => {
    descendTo("storefront");
    expect(bar()).toContain("esc back");
    app.key("esc");
    expect(bar()).not.toContain("esc");
  });

  it("drops no key App answers, on any screen", () => {
    // Every key App.key branches on. Whatever the bar omits is a way in with no sign.
    const answered = ["j", "k", "g", "G", "enter", "q", "r", "v", "a"];
    const named = (s: string): string[] => s.split("  ").flatMap((p) => (p.split(" ")[0] ?? "").split("/"));
    for (const screen of [() => {}, () => descendTo("storefront")]) {
      screen();
      const keys = named(bar());
      for (const k of answered) expect(keys, `${k} is not on the bar`).toContain(k);
    }
    expect(named(bar())).toContain("esc");
  });

  it("is clipped to the width like every other line", () => {
    expect((lines(20, 10).at(-1) as string).length).toBeLessThanOrEqual(20);
  });
});

/** views.yaml is what the screens are built out of, so what it refuses is part of what a
 *  screen is. These moved here when render.ts went. */
describe("views", () => {
  it("loads every box the page orders", () => {
    expect(views.map((v) => v.name)).toEqual([
      "projects",
      "running",
      "needs_human",
      "stale",
      "queued",
      "failed",
      "roadmap",
      "delivered",
    ]);
  });

  it("refuses a filter the code does not know", () => {
    const p = join(mkdtempSync(join(tmpdir(), "wecode-views-")), "views.yaml");
    writeFileSync(p, "page:\n  order: [a]\nviews:\n  a:\n    filter: nonsense\n");
    expect(() => loadViews(p)).toThrow(ViewError);
  });

  it("refuses a box the page orders but nothing declares", () => {
    const p = join(mkdtempSync(join(tmpdir(), "wecode-views-")), "views.yaml");
    writeFileSync(p, "page:\n  order: [ghost]\nviews:\n  a:\n    filter: running\n");
    expect(() => loadViews(p)).toThrow(/ghost/);
  });
});

/** bin.ts, driven as a process. Everything here is about the terminal rather than the
 *  frame: the keys reaching App, the frame coming back, and the terminal being left usable
 *  however the process ends. stdin is a pipe, so raw mode itself is not observable — what
 *  is observable is that a keystroke is acted on and the cursor comes back. */
describe("the terminal", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  const SHOW = "\u001b[?25h";
  const HIDE = "\u001b[?25l";

  let path: string;
  let child: ChildProcess | null = null;
  let out = "";

  beforeAll(() => {
    execFileSync("npx", ["tsc", "-b"], { cwd: root, stdio: "pipe" });
  }, 180_000);

  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "wecode-tui-")), "wecode.db");
    const file = open(path);
    seed(file);
    file.close();
    out = "";
    child = null;
  });

  const start = (): ChildProcess => {
    const c = spawn(process.execPath, [bin, "--db", path], { stdio: ["pipe", "pipe", "pipe"] });
    c.stdout?.setEncoding("utf8");
    c.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child = c;
    return c;
  };

  const until = async (want: string, ms = 8000): Promise<void> => {
    const started = Date.now();
    while (!out.includes(want)) {
      if (Date.now() - started > ms) throw new Error(`never saw ${JSON.stringify(want)} in:\n${out}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const exited = (c: ChildProcess): Promise<number> =>
    new Promise((res) => c.on("exit", (code) => res(code ?? -1)));

  it("draws the cockpit on start, cursor hidden", async () => {
    start();
    await until("q quit");
    expect(out).toContain(HIDE);
    expect(out).toContain("Projects (1)");
    expect(out).toContain("storefront");
    expect(out).toContain("workspace ");
  });

  it("feeds every keystroke to the app and redraws after each one", async () => {
    const c = start();
    await until("q quit");
    c.stdin?.write("v");
    await until("box?");
    c.stdin?.write("p");
    // The box screen: one filter, and esc on the bar because there is now something to pop.
    await until("esc back");
    expect(out).not.toContain("no box on");
  });

  it("redraws on a timer, without a keystroke", async () => {
    start();
    await until("Projects (1)");
    const file = open(path);
    file
      .prepare("INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("second", 1, "second", "/repo", "in_progress", T, T);
    file.close();
    await until("Projects (2)");
  }, 20_000);

  it("leaves the terminal clean on q", async () => {
    const c = start();
    await until("q quit");
    c.stdin?.write("q");
    expect(await exited(c)).toBe(0);
    expect(out.endsWith(SHOW + "\u001b[2J\u001b[H")).toBe(true);
  });

  it("leaves the terminal clean on ctrl-c", async () => {
    const c = start();
    await until("q quit");
    c.stdin?.write("\u0003");
    expect(await exited(c)).toBe(0);
    expect(out).toContain(SHOW);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    it(`leaves the terminal clean on ${sig}`, async () => {
      const c = start();
      await until("q quit");
      c.kill(sig);
      expect(await exited(c)).toBe(0);
      expect(out).toContain(SHOW);
    });
  }

  it("refuses to start on a database that does not exist rather than making one", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "wecode-tui-")), "nothing.db");
    const c = spawn(process.execPath, [bin, "--db", missing], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    c.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child = c;
    expect(await exited(c)).toBe(1);
    expect(err).toContain("no wecode workspace at");
  });

  afterEach(() => {
    child?.kill("SIGKILL");
  });
});
