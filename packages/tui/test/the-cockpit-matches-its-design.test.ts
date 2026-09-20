/** The cockpit is drawn the way config/design.yaml says it is.
 *
 *  The look of the frame — heads and not boxes, the mark in column zero, the count and the
 *  letter at the right edge, the bars at the foot, the keys they name — was decided in
 *  docstrings inside screens.tsx. A decision that lives only in the code that acts on it
 *  cannot be broken, because there is nothing for the drawing to disagree with.
 *  design.yaml is that something, and this file is the disagreement.
 *
 *  It used to be the wrong one. A head was gated against design.yaml's `head:`, which was
 *  itself written by reading screens.tsx, so the gate compared the drawing to itself and
 *  went red the moment the board moved to the screen the operator actually signed. `head:`
 *  is gone and every claim below reads `proposal.head`.
 *
 *  Every claim is asserted against the rendered frame. Asking the components, or
 *  App.lines(), or the config alone, answers about a screen nobody is looking at.
 */
import { plain } from "./force-color.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, Maker, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit, raised } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { mark as rowMark, sectionMark } from "../src/list.js";
import { loadServices } from "../src/services.js";
import { seed, T, ins } from "./seed.js";

interface Key {
  readonly key: string;
  readonly does: string;
  readonly only_on?: readonly string[];
  readonly except_on?: readonly string[];
}

interface Design {
  readonly page: { readonly lead: string; readonly boxes: string };
  readonly dashboard: {
    readonly chrome: string;
    readonly chrome_lines_per_section: number;
    readonly rows_begin_at_column: number;
    readonly row_leads_with: string;
    readonly forbidden: readonly string[];
  };
  readonly proposal: {
    readonly head: {
      readonly opens_with: string;
      readonly begins_at_column: number;
      readonly dashes: string;
      readonly case: string;
      readonly line: string;
      readonly count: string;
      readonly count_at: string;
      readonly key_as: string;
      readonly countless: readonly string[];
      readonly seated: { readonly box: string; readonly of: string; readonly count: string };
    };
  };
  readonly pages: { readonly chrome: string; readonly bordered: readonly string[] };
  readonly bars: { readonly key_bar: string; readonly status: string };
  readonly key_bar: { readonly gap: string; readonly entry: string; readonly keys: readonly Key[] };
}

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Design;

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

/** Tall enough that nothing is clipped: a section missing because the terminal ran out of
 *  rows is a different fault from one drawn against the design. */
const lines = (width = 100, height = 90): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** A template with its holes filled — the one place this file knows what `{title}` means. */
const fill = (template: string, holes: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => holes[name] ?? `{${name}}`);

/** The one head declaration the file has left. `head:` used to sit beside it, written by
 *  reading screens.tsx, and this gate held the drawing to that transcript — so the board
 *  could not move to the screen the operator signed without turning its own gate red. */
const HEAD = design.proposal.head;

/** A name in the case the design writes heads in. */
const cased = (title: string): string =>
  HEAD.case === "upper" ? title.toUpperCase() : title;

/** How the design opens a head: the section's mark in column zero, then its name. */
const opening = (name: string, title: string): string =>
  fill(HEAD.line, { mark: sectionMark(name), title: cased(title) });

/** A head as the design writes it: the opening, blank out to the width — no dashes — and,
 *  where there is one, the count at the right edge with the box's letter raised onto it. */
const head = (
  name: string,
  title: string,
  width: number,
  count?: string,
  key?: string,
): string => {
  expect(HEAD.count_at).toBe("right");
  expect(HEAD.dashes).toBe("none");
  expect(HEAD.key_as).toBe("superscript");
  const tail =
    count === undefined ? "" : fill(HEAD.count, { count, key: raised(key) });
  return opening(name, title).padEnd(Math.max(width - tail.length, 0), " ") + tail;
};

/** What a box's `{count}` says: the plain number of rows it holds, except the seated box,
 *  whose rows each hold one of the fleet's seats and so reads `held/seats` — a workspace
 *  with no workers has no seats to be short of and falls back to the plain number. */
const counted = (view: (typeof views)[number]): string => {
  const rows = app.boardNow()[view.filter].length;
  const seats = app.seats();
  if (view.name !== HEAD.seated.box || seats === 0) return String(rows);
  return fill(HEAD.seated.count, { held: String(rows), seats: String(seats) });
};

/** Every line the dashboard gives to chrome, in the order it draws them. A head is known
 *  by the opening the design writes, because there is no rule left to know it by. */
const chrome = (out: readonly string[]): string[] => {
  const openings = [
    opening("services", services.title),
    ...views.map((v) => opening(v.name, v.title)),
  ];
  return out.filter((l) => openings.some((o) => l.startsWith(o)));
};

/** An assignment an agent is working, so the running box has a row to open. */
function assignment(): void {
  const make = new Maker(db);
  make.role("engineer", { write: ["src/**"], tools: ["bash"] }, "agent");
  const worker = make.worker("claude", "engineer", "agent");
  ins(
    db,
    "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "send-mail-1",
    "task",
    tree.task,
    worker,
    JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }),
    JSON.stringify({ tokens: 1000, seconds: 60 }),
    "/wt/send-mail",
    "running",
    2000,
    T,
    T,
  );
  app.refresh();
}

/** The screen of each kind the design names, reached the way an operator reaches it. */
const reach: Record<string, () => void> = {
  dashboard: () => undefined,
  box: () => {
    app.key("v");
    app.key("q");
  },
  outline: () => {
    app.key("v");
    app.key("t");
  },
  node: () => {
    app.cursor = app.lines().findIndex((r) => r.what === "send the reset mail");
    app.key("enter");
  },
  assignment: () => {
    assignment();
    app.cursor = app.lines().findIndex((r) => r.state === "running");
    app.key("enter");
  },
};

describe("the page is ordered the way the design orders it", () => {
  it("heads the lead section first and the boxes after it, and heads nothing else", () => {
    expect(design.page.lead).toBe("services");
    // The order is views.yaml's, and this file says so rather than keeping a second copy.
    expect(design.page.boxes).toBe("views.yaml#page.order");
    // The mark and the name, read back off the head the way the design writes them.
    const named = [
      ["services", services.title] as const,
      ...views.map((v) => [v.name, v.title] as const),
    ];
    expect(HEAD.opens_with).toBe("mark");
    expect(HEAD.begins_at_column).toBe(0);
    const want = named.map(([name, title]) => opening(name, title));
    expect(chrome(lines()).map((l, i) => l.slice(0, want[i]?.length))).toEqual(want);
  });

  it("spends the design's one line of chrome on each section, and never a blank one", () => {
    const drawn = chrome(lines());
    const sections = views.length + 1;
    expect(drawn).toHaveLength(sections * design.dashboard.chrome_lines_per_section);
    for (const line of drawn) expect(line.trim()).not.toBe("");
  });
});

describe("a section is chromed the way the design chromes it", () => {
  it("heads the sections rather than boxing them", () => {
    expect(design.dashboard.chrome).toBe("rule");
    const out = lines();
    for (const glyph of design.dashboard.forbidden) {
      const drawn = out.filter((l) => l.includes(glyph));
      expect(drawn, `the dashboard drew ${glyph} on ${drawn.length} lines`).toEqual([]);
    }
  });

  it("writes the lead section's head as design.yaml writes it, and gives it no count", () => {
    expect(HEAD.countless).toContain("services");
    expect(chrome(lines())[0]?.trimEnd()).toBe(
      head("services", services.title, 100).trimEnd(),
    );
  });

  it("writes each box's head as design.yaml writes it, count and raised letter and all", () => {
    const drawn = chrome(lines()).slice(1);
    expect(drawn).toEqual(
      views.map((v) => head(v.name, v.title, 100, counted(v), v.key)),
    );
  });

  it("stands every count at the right edge, with the letter raised onto it", () => {
    expect(HEAD.count_at).toBe("right");
    const drawn = chrome(lines()).slice(1);
    drawn.forEach((line, i) => {
      const view = views[i];
      const tail = fill(HEAD.count, { count: counted(view!), key: raised(view!.key) });
      expect(line).toHaveLength(100);
      expect(line.endsWith(tail), `${view!.title} head: ${line}`).toBe(true);
      // The letter is on the count and nowhere else: no bracket to pair back up.
      expect(line).not.toContain(`[${view!.key ?? ""}]`);
    });
  });

  it("spends no dashes on a head, so the rule that held the count is gone", () => {
    expect(HEAD.dashes).toBe("none");
    for (const line of chrome(lines())) expect(line).not.toContain("──");
  });

  it("begins a row at the column the design gives it, with none spent on chrome", () => {
    const out = lines();
    const at = out.findIndex((l) => l.includes(cased("Queue")));
    const row = out[at + 1] ?? "";
    expect(row).toContain("send the reset mail");
    // The row starts where the rule starts; its first two columns are its own mark.
    expect(design.dashboard.row_leads_with).toBe("mark");
    const line = app.lines().find((r) => r.what === "send the reset mail");
    expect(row.indexOf(`${rowMark(line!)} `)).toBe(design.dashboard.rows_begin_at_column);
  });
});

describe("a page that is one thing is chromed the way the design chromes it", () => {
  it("borders every kind design.yaml calls bordered", () => {
    expect(design.pages.chrome).toBe("border");
    for (const kind of design.pages.bordered) {
      db = open(":memory:");
      tree = seed(db);
      app = new App(db, views, machines);
      reach[kind]?.();
      expect(app.screen.kind, `nothing reached the ${kind} screen`).toBe(kind);
      const out = lines(100, 14);
      expect(out[0]?.startsWith("┌"), `${kind} drew no top border`).toBe(true);
      expect(out.some((l) => l.startsWith("└")), `${kind} drew no bottom border`).toBe(true);
    }
  });

  it("leaves the dashboard off that list, because it is not one thing", () => {
    expect(design.pages.bordered).not.toContain("dashboard");
  });
});

describe("the bars sit where the design puts them", () => {
  /** The bar is the design's `key_bar` for this screen: the keys it answers, written as
   *  the design writes an entry and joined by the gap it declares. */
  const bar = (kind: string): string =>
    design.key_bar.keys
      .filter(
        (k) =>
          (k.only_on === undefined || k.only_on.includes(kind)) &&
          (k.except_on === undefined || !k.except_on.includes(kind)),
      )
      .map((k) => fill(design.key_bar.entry, { key: k.key, does: k.does }))
      .join(design.key_bar.gap);

  it("names every key the design names, on every screen and in its order", () => {
    expect(design.bars.key_bar).toBe("last");
    for (const kind of ["dashboard", ...design.pages.bordered]) {
      db = open(":memory:");
      tree = seed(db);
      app = new App(db, views, machines);
      reach[kind]?.();
      const out = lines(120, 40);
      expect(out.at(-1)?.trimEnd(), `the ${kind} bar`).toBe(bar(kind));
    }
  });

  it("drops fold off the dashboard bar and esc with it, and keeps both on the outline", () => {
    expect(lines().at(-1)).not.toContain("fold");
    expect(lines().at(-1)).not.toContain("esc");
    app.key("v");
    app.key("t");
    expect(lines().at(-1)).toContain("+/- fold");
    expect(lines().at(-1)).toContain("esc back");
  });

  it("puts what the App has to say directly above the bar, and nothing there when silent", () => {
    expect(design.bars.status).toBe("above_key_bar");
    const quiet = lines();
    expect(quiet.at(-2)).not.toContain("refreshed");
    app.key("r");
    const said = lines();
    expect(app.status).not.toBe("");
    expect(said.at(-2)?.trimEnd()).toBe(app.status);
    expect(said.at(-1)?.trimEnd()).toBe(bar("dashboard"));
  });
});
