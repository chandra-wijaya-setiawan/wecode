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
 *  workspace is, is `bin.ts`'s.
 *
 *  How deep a row sits is drawn as the nested list's own indent, and that rule — like every
 *  other rule of this surface — is the shell's: one stylesheet, selected on the markup this
 *  file writes. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  isTerminal,
  loadMachines,
  type Machine,
  type MachineSet,
  type Node,
  type Rollup,
  type StatefulEntity,
} from "@wecode/core";
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

/** The query of a reader who asked for nothing in particular. Only a base is needed: what
 *  is read off it is the search, and where the surface is deployed is nobody's here. */
const NOWHERE = new URL("http://localhost/tree");

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
  `<li id="${escape(node.entity)}-${node.id}" data-ui="${NODE}">${row(node)}${
    node.children.length === 0 ? "" : `<ul>${node.children.map(branch).join("")}</ul>`
  }</li>`;

/** What the page says: the tree, and nothing around it. The frame is the shell's. */
export function treeBranches(nodes: readonly Node[], levels?: Levels): string {
  const roots = shown(nodes, levels);
  if (roots.length === 0) return `<p class="empty">${NOTHING_YET}</p>`;
  return `<ul class="tree">${roots.map(branch).join("")}</ul>`;
}

/** The names `packages/webapp/config/ui.yaml` declares this page's parts by, carried into
 *  the markup as `data-ui` so the drawing and the declaration are checkable against each
 *  other by name rather than by eye. Nothing here is this file's to invent: an id the
 *  declaration does not hold is a part nobody signed. */
const SECTION = "tree";
const FILTER = "tree.filter";
const NODE = "tree.node";

/** What the section and the filter row say, in the declaration's own words. */
const SAYS_SECTION = "Tree";
const SAYS_FILTER = "filter:";

/** What the page says when a filter is on and nothing is left under it. Distinct from
 *  `NOTHING_YET`: a record with nothing in it and a record narrowed to nothing are two
 *  different things to have done, and one sentence for both sends the reader to the wrong
 *  place. */
const NOTHING_MATCHES = "nothing in the record matches this filter";

/** The three chips that narrow by state, by the query parameter each one sets and what it
 *  keeps. `open` is the machines' own answer — a row whose state is not terminal — so the
 *  word means here exactly what it means everywhere else in wecode. The other two are read
 *  off the state names `packages/core/config/machines.yaml` declares: `in_progress` is work
 *  under way, and `on_hold`/`failed` is work that has stopped and that only a person
 *  restarts, which is what "needs me" asks for. */
const KEEPS: Readonly<Record<string, (node: Node) => boolean>> = {
  open: (node) => !finished(node),
  "in-progress": (node) => node.state === "in_progress",
  "needs-me": (node) => node.state === "on_hold" || node.state === "failed",
};

/** The machines, read once and only when a filter needs them: a page that nobody narrowed
 *  should not fail because a config file it never consulted is unreadable. */
let machines: MachineSet | undefined;
function finished(node: Node): boolean {
  machines ??= loadMachines();
  const m = machines[node.entity as StatefulEntity] as Machine | undefined;
  return m !== undefined && isTerminal(m, node.state);
}

/** One chip of the filter row: the name the declaration gives it, the word it says, and the
 *  query it puts the reader on. */
export interface Chip {
  readonly id: string;
  readonly says: string;
  readonly param: string;
  readonly value: string;
}

/** The filter row, in the declared order: `open`, then one chip per project — that one is a
 *  `repeats`, so its word is the project's own and not the surface's — then the two the
 *  mockup writes with a `+`, because they are read as added to whatever is already on. */
export function chips(nodes: readonly Node[]): readonly Chip[] {
  const projects = nodes
    .filter((n) => n.entity === "project")
    .map((n) => ({
      id: "tree.filter.project",
      says: n.label,
      param: "project",
      value: String(n.id),
    }));
  return [
    { id: "tree.filter.open", says: "open", param: "open", value: "1" },
    ...projects,
    { id: "tree.filter.in-progress", says: "+ in progress", param: "in-progress", value: "1" },
    { id: "tree.filter.needs-me", says: "+ needs me", param: "needs-me", value: "1" },
  ];
}

/** Where a chip sends the reader: the query it is on now, with this chip's own parameter
 *  put on, or taken off again if it is already on. Everything else in the query survives —
 *  that is what makes the chips add up rather than replace one another. */
export function chipHref(url: URL, chip: Chip): string {
  const query = new URLSearchParams(url.searchParams);
  if (query.get(chip.param) === chip.value) query.delete(chip.param);
  else query.set(chip.param, chip.value);
  const said = query.toString();
  return said === "" ? "?" : `?${said}`;
}

const isOn = (url: URL, chip: Chip): boolean => url.searchParams.get(chip.param) === chip.value;

/** The record as the query asks for it. A project narrows to that project's own tree. A
 *  state chip keeps a row that matches every chip that is on — and keeps a row that matches
 *  none of them but has a kept row under it, because a row shown without the rows it hangs
 *  under is a row nobody can place. */
export function narrowed(nodes: readonly Node[], url: URL): readonly Node[] {
  const project = url.searchParams.get("project");
  const roots =
    project === null
      ? nodes
      : nodes.filter((n) => n.entity === "project" && String(n.id) === project);
  const asked = Object.keys(KEEPS).filter((param) => url.searchParams.has(param));
  if (asked.length === 0) return roots;
  const kept = (node: Node): Node | null => {
    const children = node.children.map(kept).filter((k): k is Node => k !== null);
    const matches = asked.every((param) => (KEEPS[param] as (n: Node) => boolean)(node));
    return matches || children.length > 0 ? { ...node, children } : null;
  };
  return roots.map(kept).filter((n): n is Node => n !== null);
}

/** The filter row: the word the declaration gives it, then its chips, each one a link. The
 *  chips are links and never controls — every verb that changes wecode is the cli's, and
 *  narrowing a reading changes nothing. */
function filterRow(nodes: readonly Node[], url: URL): string {
  const drawn = chips(nodes)
    .map(
      (chip) =>
        `<a class="tag${isOn(url, chip) ? " on" : ""}" data-ui="${chip.id}"` +
        ` href="${escape(chipHref(url, chip))}">${escape(chip.says)}</a>`,
    )
    .join("");
  return `<div class="filter" data-ui="${FILTER}">${SAYS_FILTER}${drawn}</div>`;
}

/** The whole page: the section the declaration names, the filter row, and the tree under
 *  whatever the query left of the record. There is no fold here and there is none in a row
 *  — see the note at the top of this file. */
export function treeSection(nodes: readonly Node[], url: URL, levels?: Levels): string {
  const roots = narrowed(nodes, url);
  const body =
    roots.length === 0 && nodes.length > 0
      ? `<p class="empty">${NOTHING_MATCHES}</p>`
      : treeBranches(roots, levels);
  return (
    `<section class="tree" data-ui="${SECTION}"><h2>${SAYS_SECTION}</h2>` +
    `${filterRow(nodes, url)}${body}</section>`
  );
}

/** The whole document: the tree page, in the shell design.yaml declares. */
export function treePage(nodes: readonly Node[], url: URL = NOWHERE, levels?: Levels): Reply {
  return html(document(treeSection(nodes, url, levels)));
}

/** This page declares no `READS`: the record is what a page reads unless it says otherwise,
 *  and the record is exactly what a tree is. See `discover.ts`.
 *
 *  The page, bound to a way of reading the record now. Read fresh on every request, for the
 *  reason the board is: work moves without anybody reloading. */
export const treeAt = (nodes: () => readonly Node[], levels?: Levels): Page =>
  shelled((url) => treeSection(nodes(), url, levels));
