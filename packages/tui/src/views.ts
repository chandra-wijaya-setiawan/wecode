import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Board } from "@wecode/core";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));

export class ViewError extends Error {}

export interface View {
  readonly name: string;
  readonly title: string;
  readonly filter: keyof Board;
  readonly rows: number;
  readonly empty: string;
}

/** The filters a box may name. This is a fourth copy of words that already exist as the
 *  `Board` interface, as the object `board()` returns, and twice in views.yaml — so it is
 *  written as `keyof Board` and nothing else: `satisfies` makes a typo here a build error
 *  rather than a box that silently keeps no rows. test/filter-names.test.ts closes the
 *  rest of the circle, against a real board and against the config.
 *
 *  Every group the board computes is nameable, not just the ones the page draws today: the
 *  page is four boxes and views.yaml decides which four. Cutting a box, or putting one
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
  return {
    name,
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
