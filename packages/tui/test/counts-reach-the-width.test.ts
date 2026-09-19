/** Where a number goes when it is a number and not prose.
 *
 *  Two of them, both on the dashboard. A section's count used to sit inside its name —
 *  `── ⟐ QUEUE (1) [q] ───────` — so eight of them down the page were eight phrases, each
 *  starting in a different column, and comparing two meant reading both. It is pushed to
 *  the width instead: the names are a column down the left, the counts a column down the
 *  right, and the rule between is the fill that keeps them there.
 *
 *  And a tally's counts ride on their own words. `ready 2 · done 1` is four tokens the eye
 *  has to pair up, and the space between `ready` and `2` is the same space that separates
 *  one pair from the next. In superscript the digit belongs to the word it touches, so
 *  `ready² · done¹` is two things and not four. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit, tally } from "../src/screens.js";
import { loadViews } from "../src/views.js";
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

const lines = (width = 100, height = 60): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** Every rule on the page. A section is the only thing that draws one. */
const heads = (out: string[]): string[] => out.filter((l) => l.startsWith("──"));

/** The head of the section named `title`, in the capitals a rule says it in. */
const head = (out: string[], title: string): string => {
  const at = heads(out).find((l) => l.includes(` ${title.toUpperCase()} `));
  expect(at, `no section titled ${title}`).toBeDefined();
  return at as string;
};

/** How many rows the board holds for a box, whatever the box draws of them. */
const held = (name: string): number => {
  const view = views.find((v) => v.name === name);
  expect(view, `no view ${name}`).toBeDefined();
  const board = app.boardNow() as unknown as Record<string, readonly unknown[]>;
  return (board[view?.filter ?? ""] ?? []).length;
};

describe("a section's count", () => {
  it("is the last thing on the rule, against the right edge", () => {
    const out = lines();
    expect(head(out, "Queue")).toMatch(/─ 1$/);
    expect(head(out, "Needs you")).toMatch(/─ 0$/);
  });

  it("is out of the name: the head reads as a name, not as a phrase with a number in it", () => {
    const out = lines();
    for (const view of views) {
      const line = head(out, view.title);
      expect(line, `${view.title} still names its count`).not.toContain(
        `(${held(view.name)})`,
      );
      // The name, its letter, and then nothing but rule until the number.
      expect(line).toMatch(
        new RegExp(`^── \\S+ ${view.title.toUpperCase()} \\[${view.key ?? ""}\\] ─+ \\d+$`),
      );
    }
  });

  it("still says how many the board holds, box by box", () => {
    for (let i = 0; i < 3; i += 1) {
      ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${i}`, tree.epic, `story ${i}`, "planned", T, T);
    }
    app.refresh();
    const out = lines();
    for (const view of views) {
      expect(head(out, view.title).trimEnd().split(" ").at(-1)).toBe(String(held(view.name)));
    }
    expect(head(out, "Planned")).toMatch(/─ 3$/);
  });

  /** The point of pushing it to the width: a count is compared with the one above it. */
  it("ends in the same column as every other, whatever the name is or how many digits", () => {
    for (let i = 0; i < 12; i += 1) {
      ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${i}`, tree.epic, `story ${i}`, "planned", T, T);
    }
    app.refresh();
    const out = lines();
    const counted = heads(out).filter((l) => /\d$/.test(l));
    expect(counted).toHaveLength(views.length);
    // Two digits in Planned's count and one in the rest, and all of them end at the width.
    expect(head(out, "Planned")).toMatch(/─ 12$/);
    expect(new Set(counted.map((l) => l.length))).toEqual(new Set([100]));
  });

  /** The services section counts nothing: its rows are one runner, one schema, one fleet
   *  and one doctor, and a `4` on that rule would be a number nobody asked a question of. */
  it("is absent from the section that holds no rows", () => {
    expect(head(lines(), "Services")).toMatch(/─$/);
  });

  it("keeps its place when the name no longer fits, rather than going off the edge", () => {
    for (const width of [16, 20, 28]) {
      const ruled = heads(lines(width, 40));
      expect(ruled.length, `no rules at ${width}`).toBeGreaterThan(views.length);
      for (const line of ruled) {
        expect(line.length, `the rule overran ${width}`).toBe(width);
      }
      // The name is what gives way — every box still ends in its number.
      expect(ruled.filter((l) => /\d$/.test(l)), `a count fell off at ${width}`).toHaveLength(
        views.length,
      );
    }
  });
});

describe("a tally's counts", () => {
  it("are superscript digits on the state they count", () => {
    const row = (state: string) => ({ id: 1, what: "x", state, detail: "task" });
    expect(tally(["done", "ready", "ready", "blocked"].map(row))).toBe("ready² · blocked¹ · done¹");
  });

  it("carry a digit each once there are ten or more of a state", () => {
    const row = (state: string) => ({ id: 1, what: "x", state, detail: "task" });
    expect(tally(Array.from({ length: 12 }, () => row("ready")))).toBe("ready¹²");
  });

  it("leave no plain digit for the eye to pair with a word", () => {
    const row = (state: string) => ({ id: 1, what: "x", state, detail: "task" });
    expect(tally(["done", "ready", "ready"].map(row))).not.toMatch(/\d/);
  });

  it("are still a dash when there is nothing to count", () => {
    expect(tally([])).toBe("—");
  });

  it("read that way on the screen the block is drawn on", () => {
    app.key("v");
    app.key("t");
    const at = app.lines().findIndex((r) => r.what.endsWith("storefront"));
    expect(at).toBeGreaterThanOrEqual(0);
    app.cursor = at;
    app.key("enter");
    expect(lines(100, 20).join("\n")).toContain("children (1) · in_progress¹");
  });
});
