/** The cockpit is drawn the way config/design.yaml says it is.
 *
 *  The look of the frame — rules and not boxes, the name in the rule, the count and the
 *  letter beside it, the bars at the foot, the keys they name — was decided in docstrings
 *  inside screens.tsx. A decision that lives only in the code that acts on it cannot be
 *  broken, because there is nothing for the drawing to disagree with. design.yaml is that
 *  something, and this file is the disagreement.
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
import { Cockpit } from "../src/screens.js";
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
  readonly head: {
    readonly glyph: string;
    readonly case: string;
    readonly section: string;
    readonly box: string;
    readonly count: string;
    readonly count_at: string;
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

/** A name in the case the design writes heads in. */
const cased = (title: string): string =>
  design.head.case === "upper" ? title.toUpperCase() : title;

/** A head as the design writes it: the template in the design's case, the rule out to the
 *  full width, and — where there is a count — that count standing at the far end of it. */
const head = (
  template: string,
  holes: Record<string, string>,
  width: number,
  count?: number,
): string => {
  expect(design.head.count_at).toBe("width");
  const tail = count === undefined ? "" : fill(design.head.count, { count: String(count) });
  const written = fill(template, { ...holes, title: cased(holes["title"] ?? "") });
  const fillTo = Math.max(width - tail.length - written.length, 0);
  return written + design.head.glyph.repeat(fillTo) + tail;
};

/** Every line the dashboard gives to chrome, in the order it draws them. */
const chrome = (out: readonly string[]): string[] =>
  out.filter((l) => l.startsWith(design.head.glyph.repeat(2)));

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
    const drawn = chrome(lines()).map((l) => /^── (.) (.+?) [([─]/.exec(l)?.slice(1, 3) ?? [l]);
    expect(drawn).toEqual(named.map(([name, title]) => [sectionMark(name), cased(title)]));
  });

  it("spends the design's one line of chrome on each section, and never a blank one", () => {
    const drawn = chrome(lines());
    const sections = views.length + 1;
    expect(drawn).toHaveLength(sections * design.dashboard.chrome_lines_per_section);
    for (const line of drawn) expect(line.trim()).not.toBe("");
  });
});

describe("a section is chromed the way the design chromes it", () => {
  it("rules the sections rather than boxing them", () => {
    expect(design.dashboard.chrome).toBe("rule");
    const out = lines();
    for (const glyph of design.dashboard.forbidden) {
      const drawn = out.filter((l) => l.includes(glyph));
      expect(drawn, `the dashboard drew ${glyph} on ${drawn.length} lines`).toEqual([]);
    }
  });

  it("writes the lead section's head as design.yaml writes it", () => {
    expect(chrome(lines())[0]).toBe(
      head(design.head.section, { title: services.title, mark: sectionMark("services") }, 100),
    );
  });

  it("writes each box's head as design.yaml writes it, count and letter and all", () => {
    const drawn = chrome(lines()).slice(1);
    const board = app.boardNow();
    expect(drawn).toEqual(
      views.map((v) =>
        head(
          design.head.box,
          { title: v.title, mark: sectionMark(v.name), key: v.key ?? "" },
          100,
          board[v.filter].length,
        ),
      ),
    );
  });

  it("stands every count at the width, on the fill rather than beside the name", () => {
    expect(design.head.count_at).toBe("width");
    const board = app.boardNow();
    const drawn = chrome(lines()).slice(1);
    drawn.forEach((line, i) => {
      const view = views[i];
      const tail = fill(design.head.count, { count: String(board[view!.filter].length) });
      expect(line).toHaveLength(100);
      expect(line.endsWith(design.head.glyph + tail), `${view!.title} head: ${line}`).toBe(true);
    });
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
