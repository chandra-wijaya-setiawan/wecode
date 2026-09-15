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
 *  rest of the circle, against a real board and against the config. */
export const FILTERS = [
  "projects",
  "running",
  "needs_human",
  "stale",
  "queued",
  "failed",
  "open",
  "delivered",
] as const satisfies readonly (keyof Board)[];

/** Every name here has to resolve to a filter the code knows. A typo is a refusal to
 *  start, not a blank box on the one screen an operator watches all day. */
export function loadViews(path: string = CONFIG): readonly View[] {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new ViewError("views.yaml is not a mapping");
  const top = raw as Record<string, unknown>;

  const order = (top["page"] as Record<string, unknown> | undefined)?.["order"];
  if (!Array.isArray(order)) throw new ViewError("page.order must be a list");

  const views = top["views"];
  if (views === null || typeof views !== "object") throw new ViewError("no views");
  const defs = views as Record<string, Record<string, unknown>>;

  const loaded = (order as string[]).map((name) => {
    const v = defs[name];
    if (v === undefined) throw new ViewError(`page.order names ${name}, which no view declares`);
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
