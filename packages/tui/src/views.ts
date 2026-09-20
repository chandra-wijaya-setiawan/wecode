import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Board } from "@wecode/core";
import { designDocument, DesignError, type Design } from "@wecode/ui";

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
  "projects", "running", "needs_human", "stale", "queued", "failed", "dropped",
  "unproven", "open", "planned", "delivered", "unmergeable", "cooking",
] as const satisfies readonly (keyof Board)[];

/** One of the two yaml files this module reads, as a mapping.
 *
 *  The shape check is `@wecode/ui`'s rather than this module's: the gate and the projector
 *  both answer the question "is this a design file", and two answers to it is a file one of
 *  them accepts and the other refuses. What is left here is which file was read, which the
 *  loader takes so that its refusal names it — a reader looking at `design.yaml is not a
 *  mapping` should not have to guess which of two files it was. */
const top = (path: string, called = basename(path)): Record<string, unknown> => {
  try {
    return designDocument(parse(readFileSync(path, "utf8")), called);
  } catch (err) {
    if (err instanceof DesignError) throw new ViewError(err.message);
    throw err;
  }
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

/** One box of the cockpit's design: `@wecode/ui`'s `Design` under the name this module has
 *  always called it. It was once a structural copy, kept so this module took no dependency
 *  on the gate it feeds — which it now does, because the loader above is the gate's. A copy
 *  that can be the real type is one shape declared twice. */
export type DesignBox = Design;

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

/** Reading a parsed yaml document without deciding anything about it. A missing block is
 *  an empty one and a missing word is the caller's fallback, so that a design file says
 *  what it says and this module adds nothing to it. */
const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const listOf = (v: unknown): readonly string[] => (Array.isArray(v) ? (v as string[]) : []);
const str = (v: unknown, or: string): string => (typeof v === "string" ? v : or);
const num = (v: unknown, or: number): number => (typeof v === "number" ? v : or);

/** Which renderer's half of design.yaml this module is translating for. The tree it builds
 *  is read by the ink gate and by the SVG projector, and the file states separately what
 *  each of them draws — so the one that a rule, a fill glyph and a last-line bar are true
 *  of has to be named rather than assumed. */
const RENDERER = "terminal";

/** One block of the design, from whichever half of the file declares it: a screen's own
 *  content is under `shared` and is the same for every renderer, and what only one
 *  renderer draws is under that renderer. A name in neither is an empty block, which is
 *  how every reader below keeps its own fallback. */
const blockOf = (design: Record<string, unknown>, name: string): Record<string, unknown> =>
  mapOf(mapOf(design["shared"])[name] ?? mapOf(mapOf(design["renderers"])[RENDERER])[name]);

/** The bar the design says the dashboard answers: every key that is not withheld from it,
 *  written as the design writes an entry and joined by the gap it declares. */
function keyBar(design: Record<string, unknown>, kind: string): string {
  const bar = blockOf(design, "key_bar");
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
  const head = blockOf(design, "head");
  const page = blockOf(design, "page");
  const board = blockOf(design, "dashboard");
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

  const bars = blockOf(design, "bars");
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

/** One stacked region of a framed page. */
interface Section { readonly name: string; readonly rows: readonly string[]; readonly key?: string }

/** A page with a frame around it: its sections stacked from the top inside the frame, its
 *  foot pinned to the terminal's last lines. The frame's cost is read off the file rather
 *  than spent on every page — the cockpit's chrome is a rule and pays nothing, and
 *  `border`, which design.yaml gives a screen that has the whole terminal for one thing,
 *  costs the line and the column on each side it is spent for. */
function framed(name: string, key: string | undefined, screen: Screen, chrome: unknown,
  body: readonly Section[], foot: readonly Section[]): DesignBox {
  const pad = chrome === "border" ? 1 : 0;
  let y = pad;
  const inside = body.map((s): DesignBox => ({
    name: s.name, at: { x: pad, y: (y += s.rows.length) - s.rows.length },
    width: screen.width - 2 * pad, height: s.rows.length,
    ...(s.key === undefined ? {} : { key: s.key }), rows: s.rows,
  }));
  const first = screen.height - foot.length;
  const feet = foot.map((s, i): DesignBox => ({
    name: s.name, at: { x: 0, y: first + i }, width: screen.width, height: 1, rows: s.rows,
  }));
  return {
    name, ...(key === undefined ? {} : { key }),
    width: screen.width, height: screen.height, parts: [...inside, ...feet],
  };
}

/** One line of a detail page's foot: the keys one level names, written as the footer writes
 *  an entry and joined by the gap it declares. What a key does is never restated here —
 *  design.yaml says `keys_from: key_bar`, so the word beside a letter is the bar's word and
 *  there is one copy of the vocabulary; a key the footer omits is dropped, which is how the
 *  page that cannot fold declines `+/-` without a second list of what it does answer. */
function foot(design: Record<string, unknown>, footer: Record<string, unknown>,
  level: Record<string, unknown>): string {
  const bar = blockOf(design, "key_bar")["keys"];
  const keys = Array.isArray(bar) ? (bar as Record<string, unknown>[]) : [];
  const does = new Map(keys.map((k) => [String(k["key"]), String(k["does"])]));
  const entry = str(footer["entry"], "{key} {does}");
  const omits = listOf(footer["omits"]);
  return listOf(level["keys"])
    .filter((key) => !omits.includes(key))
    .map((key) => entry.replace("{key}", key).replace("{does}", does.get(key) ?? key))
    .join(str(footer["gap"], "  "));
}

/** A record's own page as design.yaml declares it, for the record named. Same bargain as
 *  the cockpit's: every name, line and key comes out of the file, and the only thing a
 *  caller supplies is what a section is holding. Drawn for no record in particular it is
 *  the mockup — the block's fields at the empty value design.yaml declares, the children
 *  and the proof saying what they say when there are none — which is the picture that has
 *  to be signed before the screen is built. */
export function detailDesign(record: string, screen: Screen, holds: Holds = {}, paths: Paths = {}): DesignBox {
  const design = top(paths.design ?? DESIGN);
  const detail = blockOf(design, "detail");
  const records = listOf(detail["screens"]);
  if (!records.includes(record)) {
    throw new ViewError(`detail.screens does not name ${record} — it names ${records.join(", ") || "none"}`);
  }
  const block = mapOf(detail["block"]);
  const entry = str(block["entry"], "{name}  {value}");
  const fields = listOf(mapOf(detail["fields"])[record]);
  /** `gutter: longest_name` — the file states the rule, never the number. */
  const gutter = Math.max(0, ...fields.map((f) => f.length));
  const rows = fields.map((f) =>
    entry.replace("{name}", block["align"] === "left" ? f.padEnd(gutter) : f.padStart(gutter))
      .replace("{value}", (holds[f] ?? [])[0] ?? str(block["empty"], "-")));

  /** The sections that are only on the record they are declared `of`: a node is a branch
   *  and carries its children and their proof, an assignment is a leaf and carries
   *  neither. The file says which; this decides nothing. */
  const under = (of: string): readonly Section[] => {
    const s = mapOf(detail[of]);
    return s["of"] !== record ? [] : [{ name: str(s["title"], of), rows: holds[of] ?? [str(s["empty"], "")] }];
  };
  const footer = mapOf(detail["footer"]);
  if (footer["sits"] !== "last") throw new ViewError("detail.footer.sits must be last");
  const levels = Array.isArray(footer["levels"]) ? (footer["levels"] as Record<string, unknown>[]) : [];
  const feet = listOf(footer["order"]).map((name): Section => {
    const level = levels.find((l) => l["level"] === name);
    if (level === undefined) throw new ViewError(`detail.footer.order names ${name}, which no level declares`);
    return { name, rows: [foot(design, footer, level)] };
  });
  if (feet.length !== num(footer["lines"], feet.length)) {
    throw new ViewError(`detail.footer.lines says ${String(footer["lines"])}, and ${feet.length} are ordered`);
  }

  const body = [{ name: "block", rows }, ...under("children"), ...under("proof")];
  return framed(str(mapOf(detail["title"])[record], record), undefined, screen, detail["chrome"], body, feet);
}

/** Where a design of either screen may be read from, when not from the config. */
interface Paths { readonly views?: string; readonly design?: string }

/** The tree's own page, as the two files declare it between them. views.yaml says what it
 *  is called and what letter opens it; design.yaml says it is bordered, which rungs it
 *  draws, how a row is written and what depth costs. A mockup row is one rung written
 *  through the declared entry at the declared indent, and the holes nobody can fill
 *  without a workspace are left as the file writes them — which is what a wireframe of a
 *  tree is: the shape, not somebody's rows. */
export function outlineDesign(screen: Screen, holds: Holds = {}, paths: Paths = {}): DesignBox {
  const doc = top(paths.views ?? CONFIG);
  const design = top(paths.design ?? DESIGN);
  const outline = blockOf(design, "outline");
  const box = mapOf(doc["outline"]);
  if (typeof box["title"] !== "string") throw new ViewError("views.yaml gives the outline no title");
  const entry = str(mapOf(outline["row"])["entry"], "{marker} {label}");
  const marker = mapOf(outline["marker"]);
  const levels = listOf(mapOf(outline["levels"])["shows"]);
  if (levels.length === 0) throw new ViewError("outline.levels.shows must name the rungs it draws");
  const indent = num(mapOf(outline["depth"])["indent"], 2);
  const rows = holds["outline"] ?? levels.map((level, depth) =>
    " ".repeat(depth * indent) +
    entry.replace(/\{(\w+)\}/g, (_, hole: string) =>
      hole === "marker" ? str(marker[depth === levels.length - 1 ? "leaf" : "open"], " ")
        : hole === "kind" ? level : `{${hole}}`));
  if (blockOf(design, "bars")["key_bar"] !== "last") throw new ViewError("bars.key_bar must be last");
  return framed(
    box["title"], typeof box["key"] === "string" ? box["key"] : undefined,
    screen, outline["chrome"], [{ name: "tree", rows }],
    [{ name: "Key bar", rows: [keyBar(design, "outline")] }],
  );
}

/** Every screen the two files declare, in the order a reader meets them: the board, the
 *  detail page, the tree, and then each record the detail page is drawn for by name. Both
 *  ways of naming a record page work, and neither list is written here — `detail.screens`
 *  is the file's. */
export function screenNames(paths: Paths = {}): readonly string[] {
  return ["cockpit", "detail", "outline", ...listOf(blockOf(top(paths.design ?? DESIGN), "detail")["screens"])];
}

/** The translation, by the name of the screen: what these two config files say the screen
 *  is, as a tree `@wecode/ui` can read. This is the one door — the gate holds the drawn
 *  screen to it and the projector draws a picture of it, and neither has a translation of
 *  its own, because a second reading of views.yaml is a mockup that can disagree with the
 *  gate: a picture signed off on a screen nobody is held to. */
export function screenDesign(name: string, screen: Screen, holds: Holds = {}, paths: Paths = {}): DesignBox {
  if (name === "cockpit") return cockpitDesign(screen, holds, paths);
  if (name === "outline") return outlineDesign(screen, holds, paths);
  const records = listOf(blockOf(top(paths.design ?? DESIGN), "detail")["screens"]);
  const record = name === "detail" ? records[0] : name;
  if (record !== undefined && records.includes(record)) return detailDesign(record, screen, holds, paths);
  throw new ViewError(`no such screen ${name} — the design declares ${screenNames(paths).join(", ")}`);
}
