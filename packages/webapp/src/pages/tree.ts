/** The record as a tree: five nested levels of work, one nested list each.
 *
 *  The cockpit's outline and this page answer the same question — where a row sits in the
 *  work — so they are drawn from the same design. `shared.outline` in
 *  `packages/tui/config/design.yaml` says which levels a tree shows, which it omits and
 *  what a row of it says; none of that is decided here, and a second opinion about how deep
 *  a tree goes is two trees.
 *
 *  The ledger is nine levels deep and the design shows five of them. The other four — a
 *  requirement, its criteria, the tests that accept it and the tests a task is proven by —
 *  are the proof that a story was done rather than work being done, and drawn as rows they
 *  outnumber the work. So they are not folded away, they are gone: a task hangs under the
 *  story it is work on, through however many levels of proof the record put in between.
 *
 *  There is no fold marker. The design gives a parent one because a terminal row is either
 *  open or closed and the mark says which; a nested list is open, and a mark saying so on
 *  every parent would say only "this row has children", which the list already says.
 *
 *  The nodes arrive as nodes, not as a database, for the reason the board's do: where a
 *  workspace is, is `bin.ts`'s. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Node, Rollup } from "@wecode/core";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { document, shelled } from "./shell.js";

/** Where the design is and what reads it — resolved through `@wecode/tui`, which owns both
 *  the file and the `yaml` dependency that parses it. `shell.ts` does the same thing for
 *  the same reason; see the note there about `import.meta.resolve`. */
const here = createRequire(fileURLToPath(import.meta.url));
const DESIGN = here.resolve("@wecode/tui/config/design.yaml");
const { parse } = createRequire(here.resolve("@wecode/tui"))("yaml") as {
  parse: (text: string) => unknown;
};

export class TreeDesignError extends Error {}

/** How far down the tree goes, as the design says it. */
export interface Levels {
  /** The entities drawn, outermost first. */
  readonly shows: readonly string[];
  /** The entities passed through — their children rise to the nearest shown ancestor. */
  readonly omits: readonly string[];
}

const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const namesOf = (v: unknown, what: string, path: string): readonly string[] => {
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string") || v.length === 0) {
    throw new TreeDesignError(`${path}: outline.levels declares no ${what}`);
  }
  return v as readonly string[];
};

/** The levels `shared.outline.levels` declares. A design that does not say is a refusal and
 *  never a default: a tree cut to a depth nothing declared is a tree nothing gates. */
export function loadLevels(path: string = DESIGN): Levels {
  const outline = mapOf(mapOf(mapOf(parse(readFileSync(path, "utf8")))["shared"])["outline"]);
  const levels = mapOf(outline["levels"]);
  return {
    shows: namesOf(levels["shows"], "shows", path),
    omits: namesOf(levels["omits"], "omits", path),
  };
}

/** What the page says when the record is empty. A page that came back blank reads as a page
 *  that failed. */
const NOTHING_YET = "nothing in the record yet";

/** This page's own presentation. Indent is the nesting, drawn as the list's own padding
 *  rather than as spaces in the text, and a root is flush as the design says. The
 *  document's margins, type and banner are the shell's and none of them is here. */
const STYLE = `
  ul.tree { list-style: none; margin: 0; padding: 0 }
  ul.tree ul { list-style: none; margin: 0; padding-left: 1.25rem;
               border-left: 1px solid #333 }
  li { padding: .1rem 0; min-width: 0; overflow-wrap: anywhere }
  li .label { color: #ddd }
  li .id, li .kind, li .rollup { color: #888 }
  li .state { color: #6cf }
  p.empty { margin: 0; color: #666 }
`;

/** The parts of a row, in the order the design writes them, joined by the separator the
 *  rest of the surface's prose already uses. The label leads because the label is what the
 *  row is; a part with nothing to say is dropped with its separator. */
const JOIN = ` · `;

/** How much hangs under a row, in the three buckets the rollup counts. A bucket at nothing
 *  is not written as a zero — a row says what is under it, not what is not. */
function rollup(counts: Rollup): string {
  const said = (["done", "open", "failed"] as const)
    .filter((b) => counts[b] > 0)
    .map((b) => `${counts[b]} ${b}`);
  return said.length === 0 ? "" : said.join(", ");
}

/** One row, as a sentence. Everything in it is a person's own words, so nothing reaches the
 *  document without coming through `escape`. */
function row(node: Node): string {
  const counts = rollup(node.rollup);
  return (
    `<span class="label">${escape(node.label)}</span>${JOIN}` +
    `<span class="id">#${node.id}</span>${JOIN}` +
    `<span class="kind">${escape(node.entity)}</span>${JOIN}` +
    `<span class="state">${escape(node.state)}</span>` +
    (counts === "" ? "" : `${JOIN}<span class="rollup">${escape(counts)}</span>`)
  );
}

/** The tree the design draws, out of the tree the record keeps: a node of a shown level
 *  keeps its place, and a node of any other level gives its children to whoever was above
 *  it. A level the design names in neither list is a level nothing decided about, so it is
 *  kept — a row silently dropped is worse than a row nobody meant to draw. */
export function shown(nodes: readonly Node[], levels: Levels = loadLevels()): readonly Node[] {
  return nodes.flatMap((n) => {
    const kids = shown(n.children, levels);
    if (levels.omits.includes(n.entity) && !levels.shows.includes(n.entity)) return kids;
    return [{ ...n, children: kids }];
  });
}

const branch = (node: Node): string =>
  `<li id="${escape(node.entity)}-${node.id}">${row(node)}${
    node.children.length === 0 ? "" : `<ul>${node.children.map(branch).join("")}</ul>`
  }</li>`;

/** What the page says: the tree, and nothing around it. The frame is the shell's. */
export function treeBranches(nodes: readonly Node[], levels?: Levels): string {
  const roots = shown(nodes, levels);
  if (roots.length === 0) return `<p class="empty">${NOTHING_YET}</p>`;
  return `<ul class="tree">${roots.map(branch).join("")}</ul>`;
}

/** The whole document: the tree, in the shell design.yaml declares. */
export function treePage(nodes: readonly Node[], levels?: Levels): Reply {
  return html(document(treeBranches(nodes, levels), STYLE));
}

/** This page declares no `READS`: the record is what a page reads unless it says otherwise,
 *  and the record is exactly what a tree is. See `discover.ts`.
 *
 *  The page, bound to a way of reading the record now. Read fresh on every request, for the
 *  reason the board is: work moves without anybody reloading. */
export const treeAt = (nodes: () => readonly Node[], levels?: Levels): Page =>
  shelled(() => treeBranches(nodes(), levels), STYLE);
