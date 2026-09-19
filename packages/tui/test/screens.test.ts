import { inverted, plain } from "./force-color.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { tmp } from "../../core/test/tmpdir.js";
import { Cockpit } from "../src/screens.js";
import { loadOffPage, loadViews, ViewError } from "../src/views.js";
import { loadServices } from "../src/services.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const services = loadServices();
const machines = loadMachines();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

/** The frame as written — box-drawing characters, colour and all. */
const frame = (width = 100, height = 60): string =>
  render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "";

const lines = (width = 100, height = 60): string[] => plain(frame(width, height)).split("\n");

/** A box's top border, which is where its title is. */
const titled = (out: string[], title: string): number =>
  out.findIndex((l) => l.includes(`─ ${title}`));

/** The rows inside the box that starts at `at`, without their side borders. */
function inside(out: string[], at: number): string[] {
  const rows: string[] = [];
  for (const line of out.slice(at + 1)) {
    if (!line.startsWith("│")) break;
    rows.push(line.slice(1, -1).trimEnd());
  }
  return rows;
}

/** Rows a project is reached from. The dashboard has no projects box any more — the
 *  outline is the way out to the whole workspace — so a walk that starts at a project
 *  opens the outline first and descends from the row there. */
const fromTheOutline = (): void => {
  app.key("v");
  app.key("t");
  expect(app.screen).toEqual({ kind: "outline" });
};

/** Down the chain, the way the App's tests do it. */
const descendTo = (...steps: string[]): void => {
  for (const step of steps) {
    // `endsWith` because an outline row leads with the tree guide it is drawn under; on a
    // board row and a node's children list the label is the whole of `what`.
    const at = app.lines().findIndex((r) => r.what === step || r.what.endsWith(` ${step}`));
    expect(at, `no row ${step}`).toBeGreaterThanOrEqual(0);
    app.cursor = at;
    app.key("enter");
  }
};

describe("the frame", () => {
  it("is exactly as tall as the terminal, whatever the screen", () => {
    for (const height of [3, 10, 24, 60]) expect(lines(100, height)).toHaveLength(height);
    fromTheOutline();
    descendTo("storefront");
    for (const height of [3, 10, 24, 60]) expect(lines(100, height)).toHaveLength(height);
  });

  it("never draws a line wider than the terminal", () => {
    for (const line of lines(28, 40)) expect(line.length).toBeLessThanOrEqual(28);
  });

  /** Every box the dashboard is supposed to draw, named. A tally against views.length said
   *  the same thing only for as long as views.yaml was the whole dashboard: the services
   *  box is not a filter over the board and is in no view, so the count broke the moment it
   *  arrived while every box on the screen was still perfectly well bordered. What is
   *  wanted is that each box that should be there is, and is a box — so each is asked for
   *  by name, and the tops and bottoms are only checked to pair up. */
  it("is laid out, not printed: every box on it is bordered", () => {
    const out = lines();
    for (const title of [services.title, ...views.map((v) => `${v.title} (`)]) {
      const at = titled(out, title);
      expect(at, `no box titled ${title}`).toBeGreaterThanOrEqual(0);
      expect(out[at]?.startsWith("┌"), `${title} has no top border`).toBe(true);
      const bottom = at + inside(out, at).length + 1;
      expect(out[bottom]?.startsWith("└"), `${title} has no bottom border`).toBe(true);
    }
    expect(out.filter((l) => l.startsWith("┌")).length).toBe(
      out.filter((l) => l.startsWith("└")).length,
    );
    for (const line of out.filter((l) => l.startsWith("│"))) {
      expect(line.endsWith("│")).toBe(true);
    }
  });
});

describe("the dashboard", () => {
  it("draws the services box first, above every box of work", () => {
    const out = lines();
    expect(titled(out, "Services")).toBe(0);
    expect(inside(out, 0).map((l) => l.split(/ {2,}/)[0])).toEqual([
      "runner",
      "schema",
      "fleet",
      "doctor",
    ]);
    // And it is above the first box views.yaml orders.
    expect(titled(out, `${views[0]?.title} (`)).toBeGreaterThan(0);
  });

  it("keeps the services box off a box page and a node screen", () => {
    app.key("v");
    app.key("n");
    expect(titled(lines(100, 12), "Services")).toBe(-1);
    app.key("esc");
    fromTheOutline();
    descendTo("storefront");
    expect(titled(lines(100, 20), "Services")).toBe(-1);
  });

  it("draws every box in config order", () => {
    const out = lines();
    const titles = views.map((v) => titled(out, `${v.title} (`));
    expect(titles.every((i) => i >= 0)).toBe(true);
    expect([...titles].sort((a, b) => a - b)).toEqual(titles);
  });

  it("carries each box's count and the letter that opens it in its title", () => {
    const out = lines().join("\n");
    // Every one of the seven, with the letter views.yaml declares for it. The seed puts a
    // row in exactly one of them — the ready task is Queue's — and the other six say zero,
    // which is the point of carrying the count: an empty box is an answer.
    expect(out).toContain("─ Needs you (0) [n] ─");
    expect(out).toContain("─ Running (0) [r] ─");
    expect(out).toContain("─ Queue (1) [q] ─");
    expect(out).toContain("─ Cooking (0) [c] ─");
    expect(out).toContain("─ Planned (0) [p] ─");
    expect(out).toContain("─ Delivered (0) [d] ─");
    expect(out).toContain("─ Dropped (0) [x] ─");
  });

  it("says what an empty box is empty of, in that box's own words", () => {
    const out = lines();
    const at = titled(out, "Needs you (0)");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(inside(out, at)).toEqual(["nothing waits on you"]);
  });

  it("trims a box to the rows it declares and says how many it dropped", () => {
    for (let i = 0; i < 12; i += 1) {
      ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${i}`, tree.epic, `story ${i}`, "planned", T, T);
    }
    app.refresh();
    const out = lines();
    const at = titled(out, "Planned (12)");
    const declared = views.find((v) => v.name === "planned")?.rows ?? 0;
    const rows = inside(out, at);

    expect(rows).toHaveLength(declared);
    // The declared rows, the last of which is the tally of what did not fit.
    expect(rows.at(-1)).toContain(`… and ${12 - (declared - 1)} more`);
    // And the next box begins directly under this one's bottom border.
    expect(out[at + declared + 1]?.startsWith("└")).toBe(true);
    expect(titled(out, "Delivered (0)")).toBe(at + declared + 2);
  });

  it("marks the cursor in the box that holds it and in no other", () => {
    app.cursor = app.lines().findIndex((r) => r.what === "send the reset mail");
    const marked = inverted(frame());
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("send the reset mail");
  });
});

describe("a box screen", () => {
  it("draws one filter, at full height, with the cursor", () => {
    for (let i = 0; i < 20; i += 1) {
      ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${i}`, tree.epic, `story ${i}`, "planned", T, T);
    }
    app.refresh();
    app.key("v");
    app.key("p");
    expect(app.screen).toMatchObject({ kind: "box" });

    const out = lines(100, 12);
    expect(titled(out, "Planned (20) [p]")).toBe(0);
    // Ten lines of rows inside the box — more than the eight it gets on the dashboard —
    // and no other box on the screen.
    expect(titled(out, "Cooking (")).toBe(-1);
    // A row begins with its code — a number said as one — behind the kind of thing it is,
    // because Planned holds epics and stories together: "story #12".
    expect(inside(out, 0).filter((l) => /^story #\d/.test(l)).length).toBeGreaterThan(6);
    expect(inverted(frame(100, 12))).toHaveLength(1);
  });

  it("lines its columns up with the same box on the dashboard", () => {
    const onDashboard = inside(lines(), titled(lines(), "Queue (1)"))[0];
    app.key("v");
    app.key("q");
    expect(app.screen).toMatchObject({ kind: "box" });
    expect(inside(lines(), 0)[0]).toBe(onDashboard);
  });

  it("says the box is empty rather than drawing nothing", () => {
    app.key("v");
    app.key("n");
    expect(app.screen).toMatchObject({ kind: "box" });
    const out = lines(100, 10);
    expect(titled(out, "Needs you (0) [n]")).toBe(0);
    expect(inside(out, 0)[0]).toBe("nothing waits on you");
  });
});

describe("a node screen", () => {
  beforeEach(() => {
    fromTheOutline();
    descendTo("storefront");
  });

  it("draws the record's fields, then its children as a list", () => {
    const out = lines(100, 20);
    expect(titled(out, "storefront · in_progress")).toBe(0);
    expect(inside(out, 0)).toEqual([
      "entity    project",
      `id        #${tree.project}`,
      "title     storefront",
      "state     in_progress",
      "children  1",
    ]);

    const at = titled(out, "children (1)");
    expect(at).toBeGreaterThan(5);
    const rows = inside(out, at);
    expect(rows[0]).toContain("1.0.0");
    expect(rows[0]).toContain("release");
    expect(inverted(frame(100, 20))[0]).toContain("1.0.0");
  });

  it("follows the chain down, so each node draws the entity it is on", () => {
    descendTo("1.0.0", "account recovery", "password reset");
    const out = lines(100, 20);
    expect(inside(out, 0)[0]).toBe("entity    story");
    expect(out.join("\n")).toContain("one link, one change");
  });

  it("says so when a node has no children rather than leaving the list blank", () => {
    descendTo("1.0.0", "account recovery", "password reset", "one link, one change", "a link is emailed", "the mail arrives", "send the reset mail", "the mailer is called");
    const out = lines(100, 20);
    expect(inside(out, 0)[0]).toBe("entity    task_test");
    const rows = inside(out, titled(out, "children (0)"));
    expect(rows[0]).toBe("nothing under it");
    expect(rows.slice(1).every((l) => l === "")).toBe(true);
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
    fromTheOutline();
    descendTo("storefront");
    expect(bar()).toContain("esc back");
    // Two screens deep now that a project is reached through the outline: the first esc
    // lands back on it, and only the second is home.
    app.key("esc");
    expect(bar()).toContain("esc back");
    app.key("esc");
    expect(bar()).not.toContain("esc");
  });

  it("drops no key App answers, on any screen", () => {
    // Every key App.key branches on. Whatever the bar omits is a way in with no sign.
    const answered = ["j", "k", "g", "G", "enter", "q", "r", "v", "a"];
    const named = (s: string): string[] => s.split("  ").flatMap((p) => (p.split(" ")[0] ?? "").split("/"));
    for (const screen of [() => {}, () => { fromTheOutline(); descendTo("storefront"); }]) {
      screen();
      const keys = named(bar());
      for (const k of answered) expect(keys, `${k} is not on the bar`).toContain(k);
    }
    expect(named(bar())).toContain("esc");
  });

  it("is clipped to the width like every other line", () => {
    expect((lines(20, 10).at(-1) as string).length).toBeLessThanOrEqual(20);
  });

  it("has the App's one line to speak on directly above it", () => {
    app.key("z");
    const out = lines(100, 20);
    expect(out.at(-2)).toBe("z does nothing here");
  });

  it("keeps its line, and the App's, clear of a box that did not fit", () => {
    // Eight boxes want more than twenty lines. The one that runs off the bottom is cut,
    // not drawn through the two lines that always have to be readable.
    app.key("z");
    for (const line of lines(100, 20).slice(-2)) {
      expect(line).not.toMatch(/[─│┌┐└┘]/);
    }
  });
});

/** views.yaml is what the screens are built out of, so what it refuses is part of what a
 *  screen is. These moved here when render.ts went. */
describe("views", () => {
  it("loads every box the page orders", () => {
    // Seven, in the page's order: what wants you, what is moving, what waits its turn,
    // what is stuck, what is not begun, what is finished but not landed, and what was put
    // down. `projects` is off the page — the outline is the way back out to the workspace.
    expect(views.map((v) => v.name)).toEqual([
      "needs_human",
      "running",
      "queued",
      "cooking",
      "planned",
      "delivered",
      "dropped",
    ]);
  });

  /** Off the page is not gone. `projects` was cut from the dashboard for the height it
   *  took, and the height is the whole of what it cost — a letter costs the boxes that
   *  stayed nothing, so it keeps one. */
  /** Two boxes are off the page now: `projects`, and `open` since `planned` took its place
   *  among the seven. Both are asserted by name, because "off the page" is the one state a
   *  box can be in that nothing on the dashboard would show. */
  it("keeps the projects and open boxes off the page and still declared", () => {
    for (const name of ["projects", "open"]) {
      expect(views.map((v) => v.name)).not.toContain(name);
      expect(loadOffPage().find((v) => v.name === name)?.filter).toBe(name);
    }
    expect(loadOffPage().map((v) => v.name).sort()).toEqual(["open", "projects"]);
  });

  it("refuses an off-page box whose filter the code does not know", () => {
    const p = join(tmp("wecode-views-"), "views.yaml");
    writeFileSync(p, "page:\n  order: []\nviews: {}\noff_page:\n  a:\n    filter: nonsense\n");
    expect(() => loadOffPage(p)).toThrow(/unknown filter nonsense/);
  });

  it("reads no off-page boxes from a file that declares none", () => {
    const p = join(tmp("wecode-views-"), "views.yaml");
    writeFileSync(p, "page:\n  order: [a]\nviews:\n  a:\n    filter: running\n");
    expect(loadOffPage(p)).toEqual([]);
  });

  /** The rename has to reach the whitelist too: a box named `planned` whose filter the code
   *  does not know is a refusal to start, so this is what loadViews accepting it proves. */
  it("resolves the planned box to the planned filter", () => {
    expect(views.find((v) => v.name === "planned")?.filter).toBe("planned");
  });

  /** The letters are the file's. Seven names do not have seven distinct first letters, so
   *  which box answers to which key stopped being something the page's order could decide. */
  it("gives every box on the page the letter views.yaml declares for it", () => {
    expect(views.map((v) => `${v.name}:${v.key ?? ""}`)).toEqual([
      "needs_human:n",
      "running:r",
      "queued:q",
      "cooking:c",
      "planned:p",
      "delivered:d",
      "dropped:x",
    ]);
  });

  it("refuses a declared letter that is not one letter", () => {
    const p = join(tmp("wecode-views-"), "views.yaml");
    writeFileSync(p, "page:\n  order: [a]\nviews:\n  a:\n    filter: running\n    key: rr\n");
    expect(() => loadViews(p)).toThrow(/key must be one letter/);
  });

  it("refuses a filter the code does not know", () => {
    const p = join(tmp("wecode-views-"), "views.yaml");
    writeFileSync(p, "page:\n  order: [a]\nviews:\n  a:\n    filter: nonsense\n");
    expect(() => loadViews(p)).toThrow(ViewError);
  });

  it("refuses a box the page orders but nothing declares", () => {
    const p = join(tmp("wecode-views-"), "views.yaml");
    writeFileSync(p, "page:\n  order: [ghost]\nviews:\n  a:\n    filter: running\n");
    expect(() => loadViews(p)).toThrow(/ghost/);
  });
});

/** bin.tsx, driven as a process. Everything here is about the terminal rather than the
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
    path = join(tmp("wecode-tui-"), "wecode.db");
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
    expect(out).toContain("Queue (1)");
    expect(out).toContain("send the reset mail");
    expect(out).toContain("workspace ");
  });

  /** The acceptance test greps the running binary for a box-drawing character, because a
   *  cockpit of plain lines passes every other test in this file's first half. */
  it("draws boxes, not lines, when it is watched through a pipe", async () => {
    start();
    await until("q quit");
    for (const corner of ["┌", "┐", "└", "┘", "│", "─"]) expect(out).toContain(corner);
  });

  it("feeds every keystroke to the app and redraws after each one", async () => {
    const c = start();
    await until("q quit");
    c.stdin?.write("v");
    await until("box?");
    c.stdin?.write("q");
    // The box screen: one filter, and esc on the bar because there is now something to pop.
    await until("esc back");
    expect(out).not.toContain("no box on");
  });

  it("redraws on a timer, without a keystroke", async () => {
    start();
    await until("Planned (0)");
    const file = open(path);
    file
      .prepare("INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("second", 1, "second story", "planned", T, T);
    file.close();
    await until("Planned (1)");
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
    const missing = join(tmp("wecode-tui-"), "nothing.db");
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
