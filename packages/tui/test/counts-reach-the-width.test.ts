/** Where a number goes when it is a number and not prose.
 *
 *  Two of them, both on the dashboard. A section's count used to sit inside its name —
 *  `── ⟐ QUEUE (1) [q] ───────` — so eight of them down the page were eight phrases, each
 *  starting in a different column, and comparing two meant reading both. It is pushed to
 *  the width instead: the names are a column down the left, the counts a column down the
 *  right, and the space between is the fill that keeps them there.
 *
 *  The fill is space and not rule. The `── ` a head opened with went the same way as the
 *  dashes out to the width — see test/a-heading-is-a-mark-and-a-name.test.ts — so a head is
 *  found by the glyph in column zero that config/design.yaml's `proposal.head` opens it
 *  with. What this file still decides is unchanged: where the number goes.
 *
 *  And the letter rides the number. `1 [q]` was a count, a bracket and a letter for the eye
 *  to put back together; `1q` is one token. So the last thing on a head is the raised
 *  letter, and the count is what stands immediately before it.
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
import { Cockpit, raised, tally } from "../src/screens.js";
import { sectionMark } from "../src/list.js";
import { loadViews } from "../src/views.js";
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

const lines = (width = 100, height = 60): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** How the design opens a head: the section's glyph in column zero, then its name in
 *  capitals. A section is the only thing on the page that draws one. */
const opening = (name: string, title: string): string => `${sectionMark(name)} ${title.toUpperCase()}`;

const OPENINGS = [
  opening("services", services.title),
  ...views.map((v) => opening(v.name, v.title)),
];

/** Every head on the page. */
const heads = (out: string[]): string[] => out.filter((l) => OPENINGS.some((o) => l.startsWith(o)));

/** The head of the section named `title`, in the capitals a head says it in. */
const head = (out: string[], title: string): string => {
  const view = views.find((v) => v.title === title);
  const opens = opening(view?.name ?? "services", title);
  const at = out.find((l) => l.startsWith(opens));
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

/** What a head's count ends in: the number, with the letter `v` opens the box by raised
 *  onto it. The seed hires nobody, so the seated box's fraction never shows here. */
const tail = (name: string): string =>
  `${held(name)}${raised(views.find((v) => v.name === name)?.key)}`;

describe("a section's count", () => {
  it("is the last thing on the head, against the right edge", () => {
    const out = lines();
    expect(head(out, "Queue").endsWith(` 1${raised("q")}`)).toBe(true);
    expect(head(out, "Needs you").endsWith(` 0${raised("n")}`)).toBe(true);
  });

  it("is out of the name: the head reads as a name, not as a phrase with a number in it", () => {
    const out = lines();
    for (const view of views) {
      const line = head(out, view.title);
      expect(line, `${view.title} still names its count`).not.toContain(
        `(${held(view.name)})`,
      );
      // The mark, the name, and then nothing but space until the number and its letter.
      expect(line).toMatch(
        new RegExp(
          `^${sectionMark(view.name)} ${view.title.toUpperCase()} +\\d+${raised(view.key)}$`,
        ),
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
      expect(head(out, view.title).trimEnd().split(" ").at(-1)).toBe(tail(view.name));
    }
    expect(head(out, "Planned").endsWith(` 3${raised("p")}`)).toBe(true);
  });

  /** The point of pushing it to the width: a count is compared with the one above it. */
  it("ends in the same column as every other, whatever the name is or how many digits", () => {
    for (let i = 0; i < 12; i += 1) {
      ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${i}`, tree.epic, `story ${i}`, "planned", T, T);
    }
    app.refresh();
    const out = lines();
    const counted = heads(out).filter((l) => /\d/.test(l));
    expect(counted).toHaveLength(views.length);
    // Two digits in Planned's count and one in the rest, and all of them end at the width.
    expect(head(out, "Planned").endsWith(` 12${raised("p")}`)).toBe(true);
    expect(new Set(counted.map((l) => l.length))).toEqual(new Set([100]));
  });

  /** The services section counts nothing: its rows are one runner, one schema, one fleet
   *  and one doctor, and a `4` on that head would be a number nobody asked a question of.
   *  `v` does not open it either, so it is the one head that ends in its own name. */
  it("is absent from the section that holds no rows", () => {
    expect(head(lines(), "Services")).toBe(opening("services", services.title));
  });

  it("keeps its place when the name no longer fits, rather than going off the edge", () => {
    for (const width of [16, 20, 28]) {
      const ruled = heads(lines(width, 40));
      expect(ruled.length, `no heads at ${width}`).toBeGreaterThan(views.length);
      for (const line of ruled) {
        // The countless head is as long as its name and no longer; a counted one is held
        // out to the width by the number standing at its right edge.
        if (/\d/.test(line)) expect(line.length, `the head overran ${width}`).toBe(width);
        else expect(line.length, `the head overran ${width}`).toBeLessThanOrEqual(width);
      }
      // The name is what gives way — every box still ends in its number and its letter.
      expect(ruled.filter((l) => /\d/.test(l)), `a count fell off at ${width}`).toHaveLength(
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
