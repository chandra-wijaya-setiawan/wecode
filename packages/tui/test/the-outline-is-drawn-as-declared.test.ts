/** The outline is drawn the way config/design.yaml says it is.
 *
 *  the-outline-is-declared.test.ts holds the declaration; this holds the drawing against
 *  it. Without this pair the design gates nothing: a file saying the id leads the row and a
 *  screen putting it behind however long the description ran would both be green, and the
 *  design would be a note rather than a contract.
 *
 *  Everything asserted here is read out of design.yaml rather than written down twice.
 *  Changing what a row looks like is an edit there, and a red test here until outline.tsx
 *  follows. */
import { plain } from "./force-color.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import type { Row } from "../src/list.js";
import {
  describedAt,
  OUTLINE,
  outlineEntity,
  outlineId,
  outlineLines,
  outlineRow,
  OUTLINE_ROW,
  outlineWidths,
} from "../src/outline.js";
import { seed, T, ins } from "./seed.js";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const declared = design.outline as Record<string, any>;
const row_ = declared.row as Record<string, any>;
const depth = declared.depth as Record<string, any>;

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  seed(db);
  app = new App(db, views, machines);
  app.key("v");
  app.key(OUTLINE.key);
  // The declaration is about every row of the tree, so the tree is opened all the way
  // down and widened to all work before it is read.
  app.key("f");
  app.key("a");
  for (let i = 0; i < 9; i += 1) app.key("+");
});

afterEach(cleanup);

const frame = (width = 120, height = 40): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The rows inside the box, without the border columns and without the blank ones. */
const inside = (width = 120, height = 40): string[] =>
  frame(width, height)
    .filter((l) => l.startsWith("│"))
    .map((l) => l.slice(1, -1).trimEnd())
    .filter((l) => l !== "");

const rowFor = (what: string): string => {
  const hit = inside().find((l) => l.includes(what));
  expect(hit, `no row for ${what}`).toBeDefined();
  return hit as string;
};

/** A row of the shared contract, for the drawing functions asked without a screen. */
const make = (over: Partial<Row> = {}): Row =>
  ({ id: 7, what: "- storefront", state: "in_progress", detail: "project", ...over }) as Row;

describe("the frame design.yaml gives the page", () => {
  it("borders it, because a whole-terminal page is what a border is affordable on", () => {
    expect(declared.chrome).toBe("border");
    expect(frame()[0]?.startsWith("┌")).toBe(true);
    expect(frame().filter((l) => l.startsWith("└"))).toHaveLength(1);
  });
});

describe("the columns design.yaml orders the row in", () => {
  it("writes the row in the declared order, and only in that order", () => {
    expect(row_.order).toEqual([...OUTLINE_ROW]);
    expect(row_.leads_with).toBe("id");
    const line = rowFor("password reset");
    const at = (s: string): number => line.indexOf(s);
    // The id leads; the kind and the state follow it; the description is behind all three.
    expect(at("#")).toBe(0);
    expect(at("story")).toBeGreaterThan(at("#"));
    expect(at("in_progress")).toBeGreaterThan(at("story"));
    expect(at("password reset")).toBeGreaterThan(at("in_progress"));
  });

  it("writes it with the separator the declared entry writes it with", () => {
    // `{id}  {entity}  {state}  {description}` — two columns between each pair, and
    // nothing else between them.
    expect(row_.entry).toBe("{id}  {entity}  {state}  {description}");
    const rows = app.lines();
    const widths = outlineWidths(rows);
    const parts = row_.entry.split(/\{[a-z]+\}/).filter((s: string) => s !== "");
    for (const gap of parts) expect(gap).toBe("  ");
    expect(describedAt(widths)).toBe(widths.reduce((n, w) => n + w + 2, 0));
  });

  it("holds each of the three lead columns to its own longest value, and no wider", () => {
    const rows = app.lines();
    const [id, entity, state] = outlineWidths(rows);
    expect(id).toBe(Math.max(...rows.map((r) => outlineId(r).length)));
    expect(entity).toBe(Math.max(...rows.map((r) => outlineEntity(r).length)));
    expect(state).toBe(Math.max(...rows.map((r) => r.state.length)));
    for (const name of ["id", "entity", "state"]) {
      expect(row_.columns[name].width, `${name} is held to the longest`).toBe("longest");
    }
  });

  it("aligns the id right and the kind and the state left, as declared", () => {
    expect(row_.columns.id.align).toBe("right");
    expect(row_.columns.entity.align).toBe("left");
    expect(row_.columns.state.align).toBe("left");
    const widths = [4, 7, 11] as const;
    const wide = outlineRow(make({ id: 123 }), widths, 80)[0] as string;
    const thin = outlineRow(make({ id: 4 }), widths, 80)[0] as string;
    // Right-aligned: both ids end in the same column, whatever they are worth.
    expect(wide.indexOf("#123") + 4).toBe(thin.indexOf("#4") + 2);
    // Left-aligned: the kind and the state start in the same column on every row.
    for (const cell of ["project", "in_progress"]) {
      expect(wide.indexOf(cell)).toBe(thin.indexOf(cell));
    }
  });

  it("gives the description whatever is left of the line, and starts every one at it", () => {
    expect(row_.columns.description.width).toBe("rest");
    const at = describedAt(outlineWidths(app.lines()));
    for (const line of inside()) {
      if (line.startsWith("…")) continue;
      expect(line.slice(0, at).trimEnd(), line).not.toBe("");
      expect(line.length, line).toBeGreaterThan(at);
    }
  });
});

describe("the depth design.yaml draws rather than counts", () => {
  it("draws it as a connector inside the description, on every row", () => {
    expect(depth.as).toBe("connector");
    expect(depth.in).toBe("description");
    expect(depth.every_row).toBe(true);
    const at = describedAt(outlineWidths(app.lines()));
    const child = rowFor("1.0.0");
    // The connector is in the description's own columns, never in the three before it.
    expect(child.slice(at)).toContain(depth.elbow);
    expect(child.slice(0, at)).not.toMatch(/[│├└]/);
  });

  it("hangs a row off its parent by a tee, or by an elbow when it is the last", () => {
    expect(depth.tee).toBe("├─");
    expect(depth.elbow).toBe("└─");
    const shown = inside().join("\n");
    expect(shown).toContain(depth.elbow);
    // The seed's tree is a single spine, so every non-root row is the last of its
    // siblings: a second child makes the tee the one that is drawn.
    ins(
      db,
      "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "v2",
      1,
      "2.0.0",
      "in_progress",
      T,
      T,
    );
    app.refresh();
    expect(inside()).toContainEqual(expect.stringContaining(depth.tee));
  });

  it("carries a rail at every level the branch above is still going, and clears it where it is not", () => {
    expect(depth.rail).toBe("│ ");
    expect(depth.clear).toBe("  ");
    expect(depth.indent).toBe(2);
    expect(depth.rail.length).toBe(depth.indent);
    expect(depth.clear.length).toBe(depth.indent);
    ins(
      db,
      "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "returns",
      1,
      "returns",
      "in_progress",
      T,
      T,
    );
    app.refresh();
    for (let i = 0; i < 9; i += 1) app.key("+");
    const at = describedAt(outlineWidths(app.lines()));
    // Under an epic with a sibling still to come, the level above keeps its rail.
    const deeper = rowFor("password reset").slice(at);
    expect(deeper).toContain(depth.rail);
  });

  it("draws a root flush: nothing hangs off a tree that has no parent", () => {
    expect(depth.root).toBe("flush");
    const at = describedAt(outlineWidths(app.lines()));
    expect(rowFor("storefront").slice(at)).not.toMatch(/[│├└]/);
  });
});

describe("the overflow design.yaml refuses to cut", () => {
  const long = "a release name that runs on for a good deal longer than the line it is on";

  it("wraps a description rather than truncating it", () => {
    expect(row_.overflow).toBe("wrap");
    expect(row_.truncate).toBe(false);
    const drawn = outlineRow(make({ what: `└─- ${long}` }), [3, 7, 11], 60);
    expect(drawn.length).toBeGreaterThan(1);
    // Nothing is cut: every word of it is still on the screen, and no ellipsis is.
    const said = drawn.join(" ").replace(/\s+/g, " ");
    for (const word of long.split(" ")) expect(said, word).toContain(word);
    for (const line of drawn) expect(line, line).not.toContain("…");
  });

  it("continues under where the description began, never under the columns", () => {
    expect(row_.wrap_under).toBe("description");
    const widths = [3, 7, 11] as const;
    const at = describedAt(widths);
    const [first, ...rest] = outlineRow(make({ what: `└─- ${long}` }), widths, 60);
    expect(rest.length).toBeGreaterThan(0);
    for (const line of rest) {
      expect(line.slice(0, at), line).toBe(" ".repeat(at));
      expect(line.slice(at).startsWith(" "), line).toBe(false);
    }
    expect((first as string).slice(0, 2)).toBe(" #");
  });

  it("keeps no line past the width it was given", () => {
    for (const width of [40, 60, 80, 120]) {
      for (const line of outlineRow(make({ what: `└─- ${long}` }), [3, 7, 11], width)) {
        expect(line.length, `${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("counts a wrapped row against the height as the lines it really costs", () => {
    const rows = [make({ what: `- ${long}` }), make({ id: 8, what: "- short" })];
    const lines = outlineLines(rows, 3, null, 40);
    expect(lines.length).toBeLessThanOrEqual(3);
    // The first row alone outruns the height, so the second is reported rather than drawn
    // past the border.
    expect(lines.at(-1)?.text).toBe("… and 1 more");
  });

  it("colours and marks every line of a wrapped row as the one row it is", () => {
    const lines = outlineLines([make({ what: `- ${long}`, state: "planned" })], 10, 0, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.state).toBe("planned");
      expect(line.cursor).toBe(true);
    }
  });
});
