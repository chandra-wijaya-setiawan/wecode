import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Board } from "@wecode/core";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));
const DESIGN = fileURLToPath(new URL("../config/design.yaml", import.meta.url));

export class ViewError extends Error {}

export interface View {
  readonly name: string;
  readonly title: string;
  readonly filter: keyof Board;
  readonly rows: number;
  readonly empty: string;
  /** The letter `v` opens it on, when the first free letter of its name is not the one an
   *  operator would reach for. Seven boxes is more names than there are distinct first
   *  letters, and which letter a box answers to is a thing a person memorises — so it is
   *  declared beside the title rather than fallen out of the order the page happens to be
   *  in. A box that declares none still takes the first letter nothing has claimed. */
  readonly key?: string;
}

/** The filters a box may name. This is a fourth copy of words that already exist as the
 *  `Board` interface, as the object `board()` returns, and twice in views.yaml — so it is
 *  written as `keyof Board` and nothing else: `satisfies` makes a typo here a build error
 *  rather than a box that silently keeps no rows. test/filter-names.test.ts closes the
 *  rest of the circle, against a real board and against the config.
 *
 *  Every group the board computes is nameable, not just the ones the page draws today: the
 *  page is seven boxes and views.yaml decides which seven. Cutting a box, or putting one
 *  back, is an edit to that file and to nothing here. */
export const FILTERS = [
  "projects",
  "running",
  "needs_human",
  "stale",
  "queued",
  "failed",
  "dropped",
  "unproven",
  "open",
  "planned",
  "delivered",
  "unmergeable",
  "cooking",
] as const satisfies readonly (keyof Board)[];

const top = (path: string): Record<string, unknown> => {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new ViewError("views.yaml is not a mapping");
  return raw as Record<string, unknown>;
};

const read = (name: string, v: Record<string, unknown>): View => {
  const filter = v["filter"];
  if (typeof filter !== "string" || !(FILTERS as readonly string[]).includes(filter)) {
    throw new ViewError(`${name}: unknown filter ${String(filter)}`);
  }
  const key = v["key"];
  if (key !== undefined && (typeof key !== "string" || key.length !== 1)) {
    throw new ViewError(`${name}: key must be one letter, not ${String(key)}`);
  }
  return {
    name,
    ...(key === undefined ? {} : { key: key as string }),
    title: typeof v["title"] === "string" ? v["title"] : name,
    filter: filter as keyof Board,
    rows: typeof v["rows"] === "number" ? v["rows"] : 5,
    empty: typeof v["empty"] === "string" ? v["empty"] : "-",
  };
};

/** The boxes the dashboard draws, in the order it draws them. A box that is declared and
 *  never ordered is the error below; one that is meant to be off the page says so in
 *  `off_page`, and `loadOffPage` reads it. */
export function loadViews(path: string = CONFIG): readonly View[] {
  const doc = top(path);

  const order = (doc["page"] as Record<string, unknown> | undefined)?.["order"];
  if (!Array.isArray(order)) throw new ViewError("page.order must be a list");

  const views = doc["views"];
  if (views === null || typeof views !== "object") throw new ViewError("no views");
  const defs = views as Record<string, Record<string, unknown>>;

  const loaded = (order as string[]).map((name) => {
    const v = defs[name];
    if (v === undefined) throw new ViewError(`page.order names ${name}, which no view declares`);
    return read(name, v);
  });

  /** The other direction, once every ordered name has been answered for: a box declared and
   *  never ordered draws nothing, and nothing says so. Both lists are the same names or the
   *  file is wrong. */
  for (const name of Object.keys(defs)) {
    if (!(order as string[]).includes(name)) {
      throw new ViewError(`views declares ${name}, which page.order does not name`);
    }
  }

  return loaded;
}

/** The boxes `v` opens that the page does not draw. They are a separate mapping rather than
 *  an unordered entry under `views`, because "declared and never ordered" has to stay the
 *  mistake it is: a box nothing draws and nothing reaches is the typo this file refuses. An
 *  off-page box is neither — it is reached by its letter and by nothing else. */
export function loadOffPage(path: string = CONFIG): readonly View[] {
  const off = top(path)["off_page"];
  if (off === undefined || off === null) return [];
  if (typeof off !== "object") throw new ViewError("off_page must be a mapping");
  return Object.entries(off as Record<string, Record<string, unknown>>).map(([name, v]) =>
    read(name, v),
  );
}

/** One box of the cockpit's design, shaped as `@wecode/ui`'s `Design` — structurally, so
 *  that this module stays a reader of two yaml files and does not take a runtime
 *  dependency on the gate it feeds. test/the-gate-reads-the-design-file.test.ts hands what
 *  comes back straight to `expected` and `against`, which is what proves the two shapes
 *  are the one shape. */
export interface DesignBox {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly at?: { readonly x?: number; readonly y?: number };
  readonly key?: string;
  readonly rows?: readonly string[];
  readonly parts?: readonly DesignBox[];
}

/** The terminal a design is a design of. */
export interface Screen {
  readonly width: number;
  readonly height: number;
}

/** What each box is holding, by the name views.yaml gives it — `services` for the lead
 *  section. A box nobody names holds the one line views.yaml says it holds when empty,
 *  which is the whole of what the config can know about content. */
export type Holds = Readonly<Record<string, readonly string[]>>;

const cased = (title: string, how: unknown): string =>
  how === "upper" ? title.toUpperCase() : title;

/** The bar the design says the dashboard answers: every key that is not withheld from it,
 *  written as the design writes an entry and joined by the gap it declares. */
function keyBar(design: Record<string, unknown>, kind: string): string {
  const bar = (design["key_bar"] ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(bar["keys"]) ? (bar["keys"] as Record<string, unknown>[]) : [];
  const entry = typeof bar["entry"] === "string" ? bar["entry"] : "{key} {does}";
  const gap = typeof bar["gap"] === "string" ? bar["gap"] : "  ";
  const on = (list: unknown): string[] => (Array.isArray(list) ? (list as string[]) : []);
  return keys
    .filter((k) => k["only_on"] === undefined || on(k["only_on"]).includes(kind))
    .filter((k) => k["except_on"] === undefined || !on(k["except_on"]).includes(kind))
    .map((k) =>
      entry.replace(/\{(\w+)\}/g, (_, hole: string) => String(k[hole] ?? `{${hole}}`)),
    )
    .join(gap);
}

/** The cockpit as design.yaml and views.yaml declare it, as a tree `@wecode/ui` can read.
 *
 *  Every box on this page is already written down: views.yaml says which boxes there are,
 *  in what order, under what title, on what letter and what they say when empty; design.yaml
 *  says the page leads with the services, that a section costs one line of chrome, that
 *  heads are written in capitals, that the bar is the last line and which keys it names.
 *  A hand-written expected tree is a fourth copy of all of that — one that goes stale
 *  silently, because renaming a box in views.yaml does not touch it, and the literal then
 *  gates the screen against a page nobody asked for any more.
 *
 *  So the tree is derived. The only thing a caller supplies is what each box is holding,
 *  which is the one thing no config can know: it is the workspace's own rows. */
export function cockpitDesign(
  screen: Screen,
  holds: Holds = {},
  paths: { readonly views?: string; readonly design?: string } = {},
): DesignBox {
  const doc = top(paths.views ?? CONFIG);
  const design = top(paths.design ?? DESIGN);
  const head = (design["head"] ?? {}) as Record<string, unknown>;
  const page = (design["page"] ?? {}) as Record<string, unknown>;
  const board = (design["dashboard"] ?? {}) as Record<string, unknown>;
  const chrome = typeof board["chrome_lines_per_section"] === "number"
    ? board["chrome_lines_per_section"]
    : 1;

  const lead = page["lead"];
  if (typeof lead !== "string") throw new ViewError("page.lead must name a section");
  const section = (doc[lead] ?? {}) as Record<string, unknown>;
  if (typeof section["title"] !== "string") {
    throw new ViewError(`page.lead names ${lead}, which views.yaml gives no title`);
  }

  const sections: readonly { name: string; title: string; empty: string; key?: string }[] = [
    { name: lead, title: section["title"], empty: "" },
    ...loadViews(paths.views ?? CONFIG).map((v) => ({
      name: v.name,
      title: v.title,
      empty: v.empty,
      ...(v.key === undefined ? {} : { key: v.key }),
    })),
  ];

  let y = 0;
  const parts = sections.map((box): DesignBox => {
    const rows = holds[box.name] ?? [box.empty];
    const at = { y };
    y += chrome + rows.length;
    return {
      name: cased(box.title, head["case"]),
      at,
      width: screen.width,
      height: chrome + rows.length,
      ...(box.key === undefined ? {} : { key: box.key }),
      rows,
    };
  });

  const bars = (design["bars"] ?? {}) as Record<string, unknown>;
  if (bars["key_bar"] !== "last") throw new ViewError("bars.key_bar must be last");

  return {
    name: "Cockpit",
    width: screen.width,
    height: screen.height,
    parts: [
      ...parts,
      {
        name: "Key bar",
        at: { y: screen.height - 1 },
        width: screen.width,
        height: 1,
        rows: [keyBar(design, "dashboard")],
      },
    ],
  };
}
