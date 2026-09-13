import { describe, expect, it } from "vitest";
import type { Board } from "@wecode/core";
import { loadViews, render, ViewError } from "../src/index.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const empty: Board = { running: [], needs_human: [], queued: [], failed: [], roadmap: [] };
const views = loadViews();
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("views", () => {
  it("loads every box the page orders", () => {
    expect(views.map((v) => v.name)).toEqual(["running", "needs_human", "queued", "failed", "roadmap"]);
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

describe("render", () => {
  it("says what an empty box means rather than leaving it blank", () => {
    expect(strip(render(empty, views, 100))).toContain("nothing waits on you");
  });

  it("counts what did not fit", () => {
    const many: Board = {
      ...empty,
      queued: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, what: `task ${i}`, state: "ready", detail: "engineer" })),
    };
    const out = strip(render(many, views, 100));
    expect(out).toContain("Queue (9)");
    expect(out).toContain("and 4 more");
  });
});
