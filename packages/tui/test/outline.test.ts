import { coloured, GREEN, inverted, plain, RED } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { board, loadMachines, open } from "@wecode/core";
import { App, outlineOpensOn } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { OUTLINE, scopeTitle, splitTree } from "../src/outline.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
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

const frame = (width = 120, height = 40): string =>
  render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "";

const lines = (width = 120, height = 40): string[] => plain(frame(width, height)).split("\n");

/** The rows inside the outline's box, without their side borders. */
const inside = (width = 120, height = 40): string[] =>
  lines(width, height)
    .filter((l) => l.startsWith("│"))
    .map((l) => l.slice(1, -1).trimEnd())
    .filter((l) => l !== "");

/** The row naming a thing, as it is drawn. */
const row = (what: string, width = 120, height = 40): string => {
  const hit = inside(width, height).find((l) => l.includes(what));
  expect(hit, `no row for ${what}`).toBeDefined();
  return hit as string;
};

const open_ = (): void => {
  app.key("v");
  app.key(OUTLINE.key);
};

/** Put the cursor on the row naming a thing. */
const onto = (what: string): void => {
  const at = app.lines().findIndex((r) => r.what.includes(what));
  expect(at, `no row for ${what}`).toBeGreaterThanOrEqual(0);
  app.cursor = at;
};

describe("getting there", () => {
  it("opens on v then the key its config declares, from any screen", () => {
    open_();
    expect(app.screen).toMatchObject({ kind: "outline" });

    app.key("esc");
    app.key("v");
    app.key("p");
    expect(app.screen).toMatchObject({ kind: "box" });
    open_();
    expect(app.screen).toMatchObject({ kind: "outline" });
  });

  it("is named on the key bar, along with the keys that fold it", () => {
    const bar = (): string => lines(120, 20).at(-1) as string;
    expect(bar()).toContain(`v ${OUTLINE.key} outline`);
    // +/- only where they do something, and there wherever they do.
    expect(bar()).not.toContain("+/-");
    open_();
    expect(bar()).toContain("+/- fold");
    expect(bar()).toContain("esc back");
  });

  it("offers itself among the boxes v arms", () => {
    app.key("v");
    expect(app.status).toContain(`${OUTLINE.key} ${OUTLINE.title}`);
  });
});

describe("the box", () => {
  beforeEach(open_);

  it("is one bordered box titled with its scope, its count and its key", () => {
    const out = lines();
    expect(out[0]?.startsWith("┌")).toBe(true);
    expect(out[0]).toContain(
      `─ ${scopeTitle(outlineOpensOn(), app.lines().length)} [${OUTLINE.key}] ─`,
    );
    // One box, not a stack: exactly one top border and one bottom.
    expect(out.filter((l) => l.startsWith("┌"))).toHaveLength(1);
    expect(out.filter((l) => l.startsWith("└"))).toHaveLength(1);
  });

  it("lines its columns up down the whole tree", () => {
    // The id, because it is the first column past the tree: what the labels used to cost
    // the line, they now cost the prose at the end of it.
    const at = (what: string): number => row(what).indexOf("#");
    expect(at("storefront")).toBeGreaterThan(0);
    expect(at("account recovery")).toBe(at("storefront"));
    expect(at("password reset")).toBe(at("storefront"));
  });

  it("uses colour for state and for nothing else", () => {
    ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", "dead", 1, "abandoned", "/repo", "dropped", T, T);
    app.refresh();
    // A dropped project is settled work, so the scope the outline opens on has already
    // dropped it: widen to all before asking what the state colours are doing.
    app.key("f");
    app.key("a");
    const red = coloured(frame(), RED);
    expect(red).toHaveLength(1);
    expect(red[0]).toContain("abandoned");
    // The rows in states with nothing to say about themselves are drawn plain.
    expect(coloured(frame(), GREEN)).toHaveLength(0);
  });
});

describe("what it opens at", () => {
  beforeEach(open_);

  it("is folded to story depth: the story is shown and what is under it is not", () => {
    const shown = inside().join("\n");
    for (const above of ["storefront", "1.0.0", "account recovery", "password reset"]) {
      expect(shown, `${above} should be shown`).toContain(above);
    }
    // The requirement under the story, and everything under that, is folded away.
    for (const below of ["one link, one change", "a link is emailed", "send the reset mail"]) {
      expect(shown, `${below} should be folded away`).not.toContain(below);
    }
  });

  it("indents each level under its parent", () => {
    // The guide carries the whole indent now that the label is out of the tree cell, so
    // the depth is read off the connector rather than off where the label starts — and
    // off the connector alone, the marker having been pulled right against the id.
    const indent = (what: string): number =>
      (/^(?:[│ ]{2})*(?:[├└]─)?/.exec(row(what))?.[0] ?? "").trimEnd().length;
    expect(indent("1.0.0")).toBeGreaterThan(indent("storefront"));
    expect(indent("account recovery")).toBeGreaterThan(indent("1.0.0"));
    expect(indent("password reset")).toBeGreaterThan(indent("account recovery"));
  });

  it("shows every row's id and state beside it", () => {
    // A code, not a bare number — the outline draws rows through the same contract as
    // every other list, and list.tsx is the one place that decides what a code looks like.
    // The tree cell is the guide and the marker alone, so the code is the first column
    // after it and the label follows the four columns views.yaml declares.
    expect(row("storefront")).toMatch(new RegExp(`#${tree.project}\\s+proj\\s+work\\s+storefront`));
    expect(splitTree(row("storefront"))[1].trimStart()).toMatch(new RegExp(`^#${tree.project}\\b`));
    expect(row("password reset")).toMatch(/\bstor\b/);
  });
});

describe("folding", () => {
  beforeEach(open_);

  it("+ opens the node under the cursor by one level, and no further", () => {
    onto("password reset");
    app.key("+");
    const shown = inside().join("\n");
    expect(shown).toContain("one link, one change");
    // One level: the criteria under that requirement stays folded.
    expect(shown).not.toContain("a link is emailed");
  });

  it("- closes it again, taking everything under it with it", () => {
    onto("password reset");
    app.key("+");
    onto("one link, one change");
    app.key("+");
    expect(inside().join("\n")).toContain("a link is emailed");

    onto("password reset");
    app.key("-");
    const shown = inside().join("\n");
    expect(shown).toContain("password reset");
    expect(shown).not.toContain("one link, one change");
    expect(shown).not.toContain("a link is emailed");
  });

  it("keeps the screen it is on: folding pushes nothing esc has to pop", () => {
    onto("password reset");
    for (let i = 0; i < 5; i += 1) {
      app.key("+");
      onto("one link, one change");
    }
    expect(app.screen).toMatchObject({ kind: "outline" });
    // One esc, from however deep the tree has been opened.
    app.key("esc");
    expect(app.screen).toMatchObject({ kind: "dashboard" });
  });

  it("says so rather than silently doing nothing on a row with no children", () => {
    onto("password reset");
    app.key("+");
    onto("one link, one change");
    app.key("+");
    onto("a link is emailed");
    app.key("+");
    onto("the mail arrives");
    app.key("+");
    onto("send the reset mail");
    app.key("+");
    onto("the mailer is called");
    app.key("+");
    expect(app.status).toContain("nothing under it");
  });

  it("refuses to fold anywhere else, and names the way in", () => {
    app.key("esc");
    app.key("+");
    expect(app.status).toContain(`v ${OUTLINE.key}`);
    expect(app.screen).toMatchObject({ kind: "dashboard" });
  });

  it("moves the cursor with j and k over what is visible", () => {
    expect(app.cursor).toBe(0);
    app.key("j");
    app.key("j");
    expect(app.cursor).toBe(2);
    expect(inverted(frame())[0]).toContain("account recovery");
    app.key("k");
    expect(inverted(frame())[0]).toContain("1.0.0");
  });
});

describe("rollups", () => {
  beforeEach(open_);

  it("say what is behind a folded project row without opening it", () => {
    const project = row("storefront");
    expect(project).not.toContain("password reset");
    // Everything under the project, and the states it is in.
    expect(project).toMatch(/\d+ under/);
    expect(project).toContain("in_progress");
    expect(project).toContain("planned");
    expect(project).toContain("ready");
  });

  it("count every descendant, not only the children", () => {
    const count = (what: string): number =>
      Number(/(\d+) under/.exec(row(what))?.[1] ?? "-1");
    // The chain is one of each, so a level always holds more than the level below it.
    expect(count("storefront")).toBeGreaterThan(count("1.0.0"));
    expect(count("1.0.0")).toBeGreaterThan(count("account recovery"));
    expect(count("account recovery")).toBeGreaterThan(count("password reset"));
  });

  it("grow with the work: a new story is behind the project row at once", () => {
    const before = Number(/(\d+) under/.exec(row("storefront"))?.[1]);
    ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "second", tree.epic, "second story", "planned", T, T);
    app.refresh();
    expect(Number(/(\d+) under/.exec(row("storefront"))?.[1])).toBe(before + 1);
  });

  it("say nothing on a row with nothing under it, rather than zero", () => {
    onto("password reset");
    for (const step of ["one link, one change", "a link is emailed", "the mail arrives", "send the reset mail"]) {
      app.key("+");
      onto(step);
    }
    app.key("+");
    expect(row("the mailer is called")).not.toContain("under");
  });
});

describe("the task that is next to run", () => {
  /** Where the outline reads its ordering from. Nothing here re-derives it. */
  const nextByCore = (): number => board(db).queued[0]?.id as number;

  it("is marked, and it is the one core puts at the head of the queue", () => {
    open_();
    onto("password reset");
    for (const step of ["one link, one change", "a link is emailed", "the mail arrives"]) {
      app.key("+");
      onto(step);
    }
    app.key("+");
    expect(nextByCore()).toBe(tree.task);
    expect(row("send the reset mail")).toContain("next to run");
  });

  it("marks that row and no other", () => {
    open_();
    expect(inside().filter((l) => l.includes("next to run"))).toHaveLength(0);
    onto("password reset");
    for (const step of ["one link, one change", "a link is emailed", "the mail arrives"]) {
      app.key("+");
      onto(step);
    }
    app.key("+");
    expect(inside().filter((l) => l.includes("next to run"))).toHaveLength(1);
  });

  it("follows core's ordering when it changes rather than keeping its own", () => {
    // A second ready task under the same acceptance test. Core orders the queue; whichever
    // it puts first is the row that has to be marked.
    const acceptance = (db.prepare("SELECT acceptance_test_id AS id FROM task WHERE id = ?").get(tree.task) as { id: number }).id;
    const second = ins(db, "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "second-task", acceptance, "write the template",JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "ready", T, T);
    app.refresh();
    open_();
    onto("password reset");
    for (const step of ["one link, one change", "a link is emailed", "the mail arrives"]) {
      app.key("+");
      onto(step);
    }
    app.key("+");

    const marked = (): string =>
      inside().find((l) => l.includes("next to run")) as string;
    expect(nextByCore()).toBe(tree.task);
    expect(marked()).toContain("send the reset mail");

    // The head of the queue moves when the first task stops being ready.
    db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(tree.task);
    app.refresh();
    expect(nextByCore()).toBe(second);
    expect(marked()).toContain("write the template");
  });
});
