/** The assignment page wraps, budgets, beats and fills the screen.
 *
 *  What each test here can only pass when the work is done: a question too long for one
 *  line is on the page in full rather than behind an ellipsis, the page says what the
 *  assignment was allowed and what it has used, it says in a word whether anything is
 *  still working it, and it is as tall as the screen it has to itself without ever drawing
 *  over the status line or the key bar. A test that only counted the fields would pass
 *  against a page that drew eight wrong ones.
 */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, Maker, open } from "@wecode/core";
import { assignmentFacts } from "@wecode/core/dist/board.js";
import { App } from "../src/app.js";
import { ALIVE_FOR_MS, Assignment, beatLine, budgetLine, Cockpit, fit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { ins, seed, T } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

/** A fixed now, so an age on the page is arithmetic this test did rather than a race with
 *  the clock. The page reads the beat at render time on purpose — see `factsNow`. */
const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

function claude(d: DatabaseSync): number {
  const make = new Maker(d);
  make.role("engineer", { write: ["src/**"], tools: ["bash"] }, "agent");
  return make.worker("claude", "engineer", "agent");
}

interface Made {
  readonly phase?: string;
  readonly budget?: { tokens: number; seconds: number };
  readonly spent?: { tokens: number; seconds: number };
  readonly lastSeen?: string | null;
  readonly question?: string | null;
}

/** An assignment against the seeded task, with the fields this page exists to draw. */
function assignment(made: Made = {}): number {
  return ins(
    db,
    "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,question,last_seen,spent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    "send-mail-1",
    "task",
    tree.task,
    claude(db),
    JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }),
    JSON.stringify(made.budget ?? { tokens: 10_000, seconds: 600 }),
    "/wt/send-mail",
    made.phase ?? "running",
    made.question === undefined ? null : "input",
    made.question ?? null,
    made.lastSeen === undefined ? at(0) : made.lastSeen,
    JSON.stringify(made.spent ?? { tokens: 2500, seconds: 300 }),
    T,
    T,
  );
}

/** On the page, with the cursor put on the assignment's own board row. */
function openAssignment(id: number): void {
  app = new App(db, views, machines);
  const row = app.lines().findIndex((r) => r.id === id);
  expect(row, `no board row for #${id}`).toBeGreaterThanOrEqual(0);
  app.cursor = row;
  app.key("enter");
}

const lines = (width = 100, height = 40): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The page's own rows, borders off. */
const inside = (out: string[]): string[] =>
  out.filter((l) => l.startsWith("│")).map((l) => l.slice(1, -1).trimEnd());

/** A field's value, continuation lines joined back on — the page indents them under the
 *  gutter, so a wrapped value is read by putting it back together. */
function field(out: string[], name: string): string {
  const rows = inside(out);
  const first = rows.findIndex((r) => r.startsWith(`${name} `));
  expect(first, `no ${name} field`).toBeGreaterThanOrEqual(0);
  const gutter = (rows[first] ?? "").length - (rows[first] ?? "").trimStart().length;
  const parts = [(rows[first] ?? "").replace(/^\S+\s+/, "")];
  for (const row of rows.slice(first + 1)) {
    if (row === "" || /^\S/.test(row)) break;
    expect(row.length - row.trimStart().length, "a continuation off the gutter").toBeGreaterThan(
      gutter,
    );
    parts.push(row.trim());
  }
  return parts.join(" ");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = open(":memory:");
  tree = seed(db);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the assignment page says whether anything is still working it", () => {
  it("calls it alive, with how long ago it last spoke, while the beats keep coming", () => {
    const id = assignment({ lastSeen: at(12_000) });
    openAssignment(id);

    expect(field(lines(), "beat")).toBe("alive · last beat 12s ago");
  });

  it("calls it silent once the beats stop, so a dead worker is not read as a busy one", () => {
    const id = assignment({ lastSeen: at(ALIVE_FOR_MS + 60_000) });
    openAssignment(id);

    expect(field(lines(), "beat")).toBe("silent · last beat 2m ago");
  });

  it("goes from alive to silent with no keystroke, because silence is not something written", () => {
    const id = assignment({ lastSeen: at(0) });
    openAssignment(id);
    expect(field(lines(), "beat")).toContain("alive");

    // Nothing is pressed and nothing is written: only the clock moves.
    vi.setSystemTime(NOW + ALIVE_FOR_MS + 1000);

    expect(field(lines(), "beat")).toBe("silent · last beat 1m ago");
  });

  it("says a dispatched assignment has not started rather than calling it silent", () => {
    const id = assignment({ phase: "pending", lastSeen: null });
    openAssignment(id);

    expect(field(lines(), "beat")).toBe("no beat yet · dispatched and not started");
  });

  it("calls a finished assignment over, because a closed record is not an alarm", () => {
    const id = assignment({ phase: "succeeded", lastSeen: at(3 * 3_600_000) });
    // A succeeded assignment is on no box, so the page is asserted through the component.
    const facts = assignmentFacts(db, id);

    expect(beatLine(facts)).toBe("over · last 180m ago");
  });
});

describe("the assignment page says what it was allowed and what it has used", () => {
  it("puts the spend beside the allowance, in both dimensions, with the share of each", () => {
    const id = assignment({
      budget: { tokens: 10_000, seconds: 600 },
      spent: { tokens: 2500, seconds: 300 },
    });
    openAssignment(id);

    expect(field(lines(), "budget")).toBe("2.5k of 10.0k tokens (25%) · 300s of 600s (50%)");
  });

  it("says so when an assignment has overrun what it was given", () => {
    const id = assignment({
      budget: { tokens: 1000, seconds: 60 },
      spent: { tokens: 3000, seconds: 90 },
    });
    openAssignment(id);

    expect(field(lines(), "budget")).toBe("3.0k of 1.0k tokens (300%) · 90s of 60s (150%)");
  });

  it("quotes no share against a budget nobody set, rather than inventing a 0% or a 100%", () => {
    const id = assignment({ budget: { tokens: 0, seconds: 0 }, spent: { tokens: 400, seconds: 5 } });
    openAssignment(id);

    expect(field(lines(), "budget")).toBe("0.4k of 0.0k tokens · 5s of 0s");
  });

  it("reads a budget nothing can parse as nothing rather than refusing to draw the page", () => {
    const id = assignment();
    db.prepare("UPDATE assignment SET budget = ?, spent = ? WHERE id = ?").run("{", "2000", id);

    expect(budgetLine(assignmentFacts(db, id))).toBe("0.0k of 0.0k tokens · 0s of 0s");
  });
});

describe("the assignment page wraps what it cannot fit on one line", () => {
  const QUESTION =
    "the reset mail changes the link expiry from twenty four hours to one hour, " +
    "which will log out every session opened yesterday — ship it to production now, " +
    "or hold it until the support queue is clear on Monday morning?";

  it("carries a long question in full rather than losing its tail to an ellipsis", () => {
    const id = assignment({ phase: "waiting", question: QUESTION });
    openAssignment(id);
    const out = lines(60, 40);

    expect(field(out, "detail")).toBe(QUESTION);
    // Nothing on the page was cut. The key bar under it still is: it is a list of keys and
    // the page is the thing being read.
    expect(inside(out).join("\n")).not.toContain("…");
  });

  it("indents the wrapped lines under the gutter, so the names stay a column", () => {
    const id = assignment({ phase: "waiting", question: QUESTION });
    openAssignment(id);
    const rows = inside(lines(60, 40));
    const first = rows.findIndex((r) => r.startsWith("detail "));

    // `field` refuses a continuation that is not indented past the name; this states the
    // column it lines up in — the same one the value itself starts in.
    const gutter = (rows[first] ?? "").indexOf("the reset mail");
    expect(gutter).toBeGreaterThan(0);
    expect(rows[first + 1]?.slice(0, gutter)).toBe(" ".repeat(gutter));
    expect(rows[first + 1]?.charAt(gutter)).not.toBe(" ");
  });

  it("never draws past the terminal, however narrow it is", () => {
    const id = assignment({ phase: "waiting", question: QUESTION });
    openAssignment(id);

    for (const width of [24, 40, 60]) {
      for (const line of lines(width, 30)) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

describe("the assignment page fills the screen and budgets it", () => {
  it("is as tall as the body, so the page does not stop a third of the way down", () => {
    const id = assignment();
    openAssignment(id);
    const out = lines(100, 40);

    expect(out).toHaveLength(40);
    expect(out[0]?.startsWith("┌")).toBe(true);
    // The status line and the key bar are the last two; the page's floor sits on them.
    expect(out.at(-3)?.startsWith("└")).toBe(true);
    expect(out.at(-2)).toContain(`assignment #${id}`);
    expect(out.at(-1)).toContain("esc back");
  });

  it("drops what will not fit and says how much, rather than drawing over the key bar", () => {
    const id = assignment({ phase: "waiting", question: "why is this taking so long" });
    openAssignment(id);
    const out = lines(60, 9);

    expect(out).toHaveLength(9);
    expect(out.at(-1)).toContain("esc back");
    expect(inside(out).at(-1)).toBe("… and 4 more");
    // Nine lines, less the status line and the key bar, less the border: five rows, and
    // the fifth is spent saying what became of the other four.
    expect(inside(out)).toHaveLength(5);
  });

  it("counts every line it dropped, including the ones a wrap added", () => {
    expect(fit(["a", "b", "c", "d"], 4, 20)).toEqual(["a", "b", "c", "d"]);
    expect(fit(["a", "b", "c", "d"], 3, 20)).toEqual(["a", "b", "… and 2 more"]);
    expect(fit(["a", "b"], 0, 20)).toEqual([]);
  });

  it("draws the page at all when the record behind it is gone", () => {
    const screen = {
      kind: "assignment",
      id: 9,
      row: { id: 9, what: "task #3", state: "running", detail: "claude · 1m" },
    } as const;

    const out = plain(
      render(createElement(Assignment, { screen, facts: null, width: 50, height: 14 })).lastFrame() ??
        "",
    ).split("\n");

    expect(out).toHaveLength(14);
    expect(field(out, "budget")).toBe("—");
    expect(field(out, "beat")).toBe("—");
  });
});
