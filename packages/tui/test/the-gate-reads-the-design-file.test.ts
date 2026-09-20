/** The expected tree the gate holds the cockpit to is built from the design files.
 *
 *  the-cockpit-matches-its-design.test.ts writes its expected tree out by hand: every box
 *  name in capitals, every letter, every y, the bar's whole line. That is a fourth copy of
 *  views.yaml and design.yaml, and it is the copy with nothing checking it — rename Queue
 *  in views.yaml and the literal does not move, so the gate goes on holding the screen to
 *  a page nobody asked for, and the only red is the one the rename itself caused.
 *
 *  `cockpitDesign` derives it instead: which boxes there are, in what order, under what
 *  title, on what letter and what they say when empty is views.yaml; that the page leads
 *  with the services, that a section costs one line of chrome, that heads are capitals,
 *  that the bar is the last line and which keys it names is design.yaml. The one thing a
 *  caller supplies is what each box is holding, because that is the workspace's rows and
 *  no config knows them.
 *
 *  What is proven here: the derived tree is a clean capture, it says what the two files
 *  say rather than what this test says, editing either file moves it, and the real cockpit
 *  passes the gate when it is pointed at the derived tree instead of the literal one.
 */
import { plain } from "./force-color.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open, SCHEMA_VERSION } from "@wecode/core";
// Through the package entry, the one door: `@wecode/ui` names the design half beside
// `check`, so the gate reaches the loader the projector reaches and a reader of this file
// does not have to know that `expected` lives in expected.js.
import { against, check, expected, type CapturedNode } from "@wecode/ui";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import {
  cockpitDesign,
  detailDesign,
  loadViews,
  outlineDesign,
  screenDesign,
  screenNames,
  ViewError,
} from "../src/views.js";
import { seed, T } from "./seed.js";

const WIDTH = 80;
const HEIGHT = 30;

const VIEWS = fileURLToPath(new URL("../config/views.yaml", import.meta.url));
const DESIGN = fileURLToPath(new URL("../config/design.yaml", import.meta.url));

/** The two files with one edit, written somewhere else. Reading the design back out of a
 *  copy is the only way to say the tree came from the file: an assertion against the real
 *  config cannot tell a reader from a literal that happens to agree with it. */
function edited(edits: { views?: [string, string]; design?: [string, string] }): {
  views: string;
  design: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "wecode-design-"));
  const write = (from: string, edit?: [string, string]): string => {
    const text = readFileSync(from, "utf8");
    if (edit !== undefined) expect(text).toContain(edit[0]);
    const to = join(dir, from.endsWith("views.yaml") ? "views.yaml" : "design.yaml");
    writeFileSync(to, edit === undefined ? text : text.replace(edit[0], edit[1]));
    return to;
  };
  return { views: write(VIEWS, edits.views), design: write(DESIGN, edits.design) };
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(T) + 2 * 60 * 60 * 1000);
});
afterAll(() => {
  vi.useRealTimers();
  cleanup();
});

let app: App;

beforeEach(() => {
  const db = open(":memory:");
  seed(db);
  app = new App(db, loadViews(), loadMachines());
});

const frame = (): string[] =>
  plain(
    render(createElement(Cockpit, { app, width: WIDTH, height: HEIGHT })).lastFrame() ?? "",
  ).split("\n");

/** The same capture the cockpit's own gate takes: a section owns the full width from its
 *  head down to the next one, the bar is the last line, and the blank the body stops short
 *  of it belongs to nobody. */
const HEAD = /^──\s(?:\S\s)?(.+?)\s(?:\[(\S)\]\s)?─/;

function capture(out: readonly string[]): CapturedNode {
  const heads = out.flatMap((line, at) => (HEAD.test(line) ? [at] : []));
  const children = heads.map((at, i): CapturedNode => {
    const [, name = "", key] = HEAD.exec(out[at] ?? "") ?? [];
    const under = out.slice(at + 1, heads[i + 1] ?? out.length);
    const blank = under.indexOf("");
    const body = blank === -1 ? under : under.slice(0, blank);
    return {
      name,
      at: { x: 0, y: at, width: WIDTH, height: body.length + 1 },
      ...(key === undefined ? {} : { key }),
      rows: body,
    };
  });
  return {
    name: "Cockpit",
    at: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    children: [
      ...children,
      {
        name: "Key bar",
        at: { x: 0, y: HEIGHT - 1, width: WIDTH, height: 1 },
        rows: [out.at(-1) ?? ""],
      },
    ],
  };
}

const SCREEN = { width: WIDTH, height: HEIGHT };

/** What the seeded workspace has each box holding. The rows and nothing else: every name,
 *  letter, height and coordinate below comes out of the two config files. */
const HOLDS = {
  services: [
    "pulse   storefront  still      0 running · 1 queued · 0 stuck · moved 2h0m ago",
    "runner  workspace   none       no runner holds this workspace · 1 queued",
    `schema  workspace   current    database ${SCHEMA_VERSION} · this build understands ${SCHEMA_VERSION}`,
    "fleet   workspace   short      no engineer for 1 ready",
    "doctor  workspace   not built  0.0.2 · healing and collection",
  ],
  queued: ["  #1  ready  send the reset mail · engineer"],
};

describe("the tree is built out of the two files", () => {
  it("is a capture the four rules read clean, like any design", () => {
    expect(check(expected(cockpitDesign(SCREEN, HOLDS)))).toEqual([]);
  });

  it("names the boxes views.yaml names, in its order, in the case design.yaml asks for", () => {
    const parts = cockpitDesign(SCREEN).parts ?? [];
    expect(parts.map((p) => p.name)).toEqual([
      "SERVICES",
      ...loadViews().map((v) => v.title.toUpperCase()),
      "Key bar",
    ]);
  });

  it("gives each box the letter views.yaml gives it, and the lead section none", () => {
    const parts = cockpitDesign(SCREEN).parts ?? [];
    expect(parts.map((p) => p.key)).toEqual([
      undefined,
      ...loadViews().map((v) => v.key),
      undefined,
    ]);
  });

  it("holds views.yaml's empty line where the caller says a box holds nothing", () => {
    const parts = cockpitDesign(SCREEN, { queued: ["  #1  ready  send it"] }).parts ?? [];
    const named = Object.fromEntries(parts.map((p) => [p.name, p.rows]));
    expect(named["QUEUE"]).toEqual(["  #1  ready  send it"]);
    expect(named["DROPPED"]).toEqual(["nothing has been dropped"]);
  });

  it("stacks the boxes by what they hold, a section costing design.yaml's one line", () => {
    const placed = expected(cockpitDesign(SCREEN, HOLDS)).children ?? [];
    expect(placed.map((box) => [box.name, box.at.y, box.at.height])).toEqual([
      ["SERVICES", 0, 6],
      ["NEEDS YOU", 6, 2],
      ["RUNNING", 8, 2],
      ["QUEUE", 10, 2],
      ["COOKING", 12, 2],
      ["PLANNED", 14, 2],
      ["DELIVERED", 16, 2],
      ["DROPPED", 18, 2],
      ["Key bar", HEIGHT - 1, 1],
    ]);
  });

  it("writes the bar design.yaml's keys, minus the ones it withholds from the dashboard", () => {
    const bar = (cockpitDesign(SCREEN).parts ?? []).at(-1);
    expect(bar?.rows).toEqual([
      "j/k move  g/G top/end  enter open  v box  v t outline  a act  r refresh  q quit",
    ]);
  });
});

describe("an edit to either file moves the tree", () => {
  it("renames a box when views.yaml renames it, with no edit here", () => {
    const paths = edited({ views: ["title: Queue", "title: Waiting"] });
    const names = (cockpitDesign(SCREEN, {}, paths).parts ?? []).map((p) => p.name);
    expect(names).toContain("WAITING");
    expect(names).not.toContain("QUEUE");
  });

  it("re-letters a box when views.yaml re-letters it", () => {
    const paths = edited({ views: ["filter: queued\n    key: q", "filter: queued\n    key: u"] });
    const box = (cockpitDesign(SCREEN, {}, paths).parts ?? []).find((p) => p.name === "QUEUE");
    expect(box?.key).toBe("u");
  });

  it("leaves the names as written when design.yaml stops asking for capitals", () => {
    const paths = edited({ design: ["case: upper", "case: written"] });
    expect((cockpitDesign(SCREEN, {}, paths).parts ?? [])[0]?.name).toBe("Services");
  });

  it("grows every box when design.yaml spends two lines of chrome on a section", () => {
    const paths = edited({ design: ["chrome_lines_per_section: 1", "chrome_lines_per_section: 2"] });
    const placed = expected(cockpitDesign(SCREEN, HOLDS, paths)).children ?? [];
    expect(placed.slice(0, 3).map((b) => [b.name, b.at.y, b.at.height])).toEqual([
      ["SERVICES", 0, 7],
      ["NEEDS YOU", 7, 3],
      ["RUNNING", 10, 3],
    ]);
  });

  it("drops a key off the bar when design.yaml withholds it from the dashboard", () => {
    const paths = edited({ design: ['{ key: "a", does: act }', '{ key: "a", does: act, only_on: [outline] }'] });
    expect((cockpitDesign(SCREEN, {}, paths).parts ?? []).at(-1)?.rows?.[0]).not.toContain("a act");
  });

  it("refuses a design that moves the bar off the last line rather than guessing", () => {
    const paths = edited({ design: ["key_bar: last", "key_bar: first"] });
    expect(() => cockpitDesign(SCREEN, {}, paths)).toThrow(ViewError);
  });

  it("refuses a lead section views.yaml does not declare", () => {
    const paths = edited({ design: ["lead: services", "lead: weather"] });
    expect(() => cockpitDesign(SCREEN, {}, paths)).toThrow(/weather/);
  });
});

/** The cockpit was the only screen with a translation, and design.yaml declares three.
 *  A screen with no translation is a screen the gate cannot hold the code to and the
 *  projector cannot draw, which is how the detail page and the outline came to be argued
 *  out in a config file nothing reads. */
describe("the other two screens the design declares", () => {
  it("writes the detail page's block out of design.yaml's fields, into its own gutter", () => {
    const rows = (detailDesign("node", SCREEN).parts ?? [])[0]?.rows ?? [];
    expect(rows).toEqual([
      "entity    —",
      "id        —",
      "title     —",
      "state     —",
      "children  —",
    ]);
  });

  it("carries the sections design.yaml declares `of` the record, and no others", () => {
    const named = (record: string): string[] =>
      (detailDesign(record, SCREEN).parts ?? []).map((p) => p.name);
    expect(named("node")).toContain("children ({count}) · {tally}");
    expect(named("node")).toContain("proof ({count}) · {tally}");
    expect(named("assignment")).not.toContain("children ({count}) · {tally}");
    expect(detailDesign("assignment", SCREEN).name).toBe("assignment #{id} · {state}");
  });

  it("foots the page with two levels, the global one on the terminal's last line", () => {
    const feet = (detailDesign("node", SCREEN).parts ?? []).slice(-2);
    expect(feet.map((f) => [f.name, f.at?.y])).toEqual([
      ["record", HEIGHT - 2],
      ["global", HEIGHT - 1],
    ]);
    // Every word beside a letter is key_bar's own, and the key it withholds is withheld.
    expect(feet[0]?.rows).toEqual(["j/k move  g/G top/end  enter open  a act"]);
    expect(feet[1]?.rows?.[0]).not.toContain("fold");
  });

  it("refuses a record design.yaml does not declare a detail page for", () => {
    expect(() => detailDesign("weather", SCREEN)).toThrow(ViewError);
    expect(() => detailDesign("weather", SCREEN)).toThrow(
      "detail.screens does not name weather — it names node, assignment",
    );
  });

  it("draws one outline row per rung design.yaml shows, indented by its depth", () => {
    const tree = (outlineDesign(SCREEN).parts ?? [])[0];
    expect(tree?.rows).toEqual([
      "- {label} · #{id} · project · {state} · {rollup}",
      "  - {label} · #{id} · release · {state} · {rollup}",
      "    - {label} · #{id} · epic · {state} · {rollup}",
      "      - {label} · #{id} · story · {state} · {rollup}",
      // The deepest rung folds nothing, so design.yaml marks it with a space and the row
      // keeps the column rather than closing up under the one above it.
      "          {label} · #{id} · task · {state} · {rollup}",
    ]);
  });

  it("gives the outline the title and letter views.yaml gives it, and room for a border", () => {
    const box = outlineDesign(SCREEN);
    expect([box.name, box.key]).toEqual(["Outline", "t"]);
    expect((box.parts ?? [])[0]?.at).toEqual({ x: 1, y: 1 });
    expect((box.parts ?? [])[0]?.width).toBe(WIDTH - 2);
  });

  it("puts the outline's own key on its bar, which the dashboard's withholds", () => {
    expect((outlineDesign(SCREEN).parts ?? []).at(-1)?.rows?.[0]).toContain("+/- fold");
    expect((cockpitDesign(SCREEN).parts ?? []).at(-1)?.rows?.[0]).not.toContain("fold");
  });

  it("re-titles the outline when views.yaml re-titles it, with no edit here", () => {
    const paths = edited({ views: ["title: Outline", "title: Everything"] });
    expect(outlineDesign(SCREEN, {}, paths).name).toBe("Everything");
  });
});

describe("one door onto all three", () => {
  it("names the screens the files declare, the page and each record it is drawn for", () => {
    expect(screenNames()).toEqual(["cockpit", "detail", "outline", "node", "assignment"]);
  });

  it("hands each name to the translation that owns it", () => {
    expect(screenDesign("cockpit", SCREEN, HOLDS)).toEqual(cockpitDesign(SCREEN, HOLDS));
    expect(screenDesign("outline", SCREEN)).toEqual(outlineDesign(SCREEN));
    expect(screenDesign("assignment", SCREEN)).toEqual(detailDesign("assignment", SCREEN));
  });

  it("reads `detail` as the first record design.yaml declares the page for", () => {
    expect(screenDesign("detail", SCREEN)).toEqual(detailDesign("node", SCREEN));
  });

  it("is a clean capture for every screen it knows, like any design", () => {
    for (const name of screenNames()) expect(check(expected(screenDesign(name, SCREEN)))).toEqual([]);
  });

  it("names them all when asked for one nobody declared", () => {
    expect(() => screenDesign("weather", SCREEN)).toThrow(
      "no such screen weather — the design declares cockpit, detail, outline, node, assignment",
    );
  });
});

describe("the real cockpit against the derived tree", () => {
  it("is the screen the two files ask for, box for box and row for row", () => {
    expect(against(cockpitDesign(SCREEN, HOLDS), capture(frame()))).toEqual([]);
  });

  it("still catches a box drawn somewhere other than where the design puts it", () => {
    const moved = capture(frame());
    const boxes = (moved.children ?? []).map((box) =>
      box.name === "QUEUE" ? { ...box, at: { ...box.at, y: box.at.y + 1 } } : box,
    );
    expect(
      against(cockpitDesign(SCREEN, HOLDS), { ...moved, children: boxes }),
    ).toEqual([
      { kind: "moved", node: "Cockpit > QUEUE", says: `was at 0,10 ${WIDTH}x2, now 0,11 ${WIDTH}x2` },
    ]);
  });
});
