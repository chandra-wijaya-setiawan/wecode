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

const FILTERS = [
  "projects",
  "running",
  "needs_human",
  "stale",
  "queued",
  "failed",
  "roadmap",
  "delivered",
] as const;

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

  return (order as string[]).map((name) => {
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
}
