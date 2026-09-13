import { describe, expect, it } from "vitest";
import type { Board } from "@wecode/core";
import { loadViews, render } from "../src/index.js";

const empty: Board = { running: [], needs_human: [], queued: [], failed: [], roadmap: [] };
const views = loadViews();
const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const row = (id: number) => ({ id, what: `task ${id}`, state: "ready", detail: "engineer" });

describe("header", () => {
  it("is the first line, above every box", () => {
    const lines = strip(render(empty, views, 100)).split("\n");
    expect(lines[0]).toBe("wecode  0 running, 0 needs you");
    expect(lines.indexOf("wecode  0 running, 0 needs you")).toBeLessThan(
      lines.findIndex((l) => l.startsWith("Running")),
    );
  });

  it("counts the running and the needs-you rows, not the other boxes", () => {
    const board: Board = {
      ...empty,
      running: [row(1), row(2), row(3)],
      needs_human: [row(4)],
      queued: [row(5), row(6)],
    };
    expect(strip(render(board, views, 100)).split("\n")[0]).toBe("wecode  3 running, 1 needs you");
  });

  it("counts every row, including the ones a box trims away", () => {
    const board: Board = { ...empty, running: Array.from({ length: 9 }, (_, i) => row(i + 1)) };
    const out = strip(render(board, views, 100));
    expect(out.split("\n")[0]).toBe("wecode  9 running, 0 needs you");
    expect(out).toContain("and 4 more");
  });
});
