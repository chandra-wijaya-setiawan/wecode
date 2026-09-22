/** The tree page: the record as nested lists, every level of it, the proof folded shut.
 *
 *  The nodes are hand-made rather than read out of a workspace, for the reason the board's
 *  rows are: what is held here is the page, and that the tree is the record's shape is
 *  `@wecode/core`'s `tree()`, tested where that function lives.
 *
 *  Three things beyond the tree. The depth is the design's — five levels of work and four of
 *  proof, read off `shared.outline.levels`, and the four are shown rather than dropped:
 *  under the story they prove, folded shut so the page still lands at story level. The
 *  filter is one dropdown of two answers whose words, default and excluded states are
 *  `packages/webapp/config/ui.yaml`'s, and how much of a record's own text a row spends is
 *  that file's too, the rest of a long one behind a fold. None of the three is written out
 *  here: each is read back out of an edited copy of the file that declares it, and the
 *  parts drawn around the tree are named by the `data-ui` each one carries. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/index.js";
import { discovered, mounted, pathOf } from "../src/pages/discover.js";
import { chosen, linesOf, loadLevels, loadUi, narrowed, type Option, optionHref, shown, spent,
  treeAt, treeBranches, treePage, treeSection, TreeDesignError, TreeUiError } from "../src/pages/tree.js";

const at = (query = ""): URL => new URL(`http://localhost/tree${query}`);
function drawn(body: string, name: string): string {
  const found = [...body.matchAll(new RegExp(`<[a-z0-9]+([^>]*\\bdata-ui="${name}"[^>]*)>`, "g"))];
  expect(found.length, `the page draws ${found.length} of ${name}, not one`).toBe(1);
  return (found[0] as RegExpMatchArray)[1] as string;
}
/** What the element with this `data-ui` name says — its own text, not its children's. */
function saysOf(body: string, name: string): string {
  const open = body.search(new RegExp(`<[a-z0-9]+[^>]*\\bdata-ui="${name}"[^>]*>`));
  expect(open, `the page draws no ${name}`).toBeGreaterThan(-1);
  const rest = body.slice(body.indexOf(">", open) + 1);
  return rest.slice(0, rest.search(/<|$/));
}
/** A config file with one edit, written elsewhere: reading a declaration back out of a copy
 *  is the only way to tell a reader from a literal that happens to agree with it. */
function edits(path: string): (from: string, to: string) => string {
  const text = readFileSync(path, "utf8");
  return (from, to) => {
    expect(text, from).toContain(from);
    const said = join(mkdtempSync(join(tmpdir(), "wecode-tree-")), "edited.yaml");
    writeFileSync(said, text.replace(from, to));
    return said;
  };
}
const design = edits(fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url)));
const ui = edits(fileURLToPath(new URL("../config/ui.yaml", import.meta.url)));
const LEVELS = loadLevels();
const DECLARED = loadUi();
const PROOF = ["requirement", "acceptance_criteria", "acceptance_test", "task_test"];
const SHOWS = "      shows: [project, release, epic, story, task]";
const FOLDS = `        folds: [${PROOF.join(", ")}]`;
const EXCLUDES = "        excludes: [released, done, delivered, dropped]";
const NONE: Rollup = { done: 0, open: 0, failed: 0 };

const node = (entity: string, id: number, over: Partial<Node> = {}): Node => ({
  entity, id, label: `${entity} ${id}`, state: "planned",
  children: [], rollup: NONE, folded: false, ...over,
});
/** The record's own nine levels, the four of proof in between, as the ledger keeps them. */
const under = (parent: Node, child: Node): Node => ({ ...parent, children: [child] });
const CHAIN = [
  ["project", 1], ["release", 2], ["epic", 3], ["story", 4], ["requirement", 5],
  ["acceptance_criteria", 6], ["acceptance_test", 7],
] as const;
const deepTask = (task: Node = node("task", 8)): Node =>
  CHAIN.reduceRight<Node>((kid, [e, id]) => under(node(e, id), kid), task);
const WHOLE = deepTask(node("task", 8, { children: [node("task_test", 9)] }));
/** The `<li>` of one node, without its descendants' rows. */
function rowOf(body: string, entity: string, id: number): string {
  const found = body.indexOf(`<li id="${entity}-${id}" `);
  expect(found, `the page has no row for ${entity} #${id}`).toBeGreaterThan(-1);
  const rest = body.slice(found);
  const ends = rest.indexOf("<ul>");
  return ends === -1 ? rest.slice(0, rest.indexOf("</li>")) : rest.slice(0, ends);
}
/** How deep a node's row sits in nested lists, counted in `<ul>`s open above it. */
function nesting(body: string, entity: string, id: number): number {
  const before = body.slice(0, body.indexOf(`<li id="${entity}-${id}" `));
  return [...before.matchAll(/<ul/g)].length - [...before.matchAll(/<\/ul>/g)].length;
}
/** Every id in a narrowing, parents before the rows under them. */
const ids = (nodes: readonly Node[]): readonly number[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children)]);

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("how deep the tree goes is the design's", () => {
  it("reads the five levels of work, the four the terminal omits, and the four this folds", () => {
    expect(LEVELS.shows).toEqual(["project", "release", "epic", "story", "task"]);
    expect(LEVELS.omits).toEqual(PROOF);
    expect(LEVELS.folds).toEqual(PROOF);
  });
  it("moves when the design moves", () => {
    const moved = loadLevels(design(SHOWS, "      shows: [project, epic, story, task]"));
    expect(moved.shows).toEqual(["project", "epic", "story", "task"]);
    // A level named by no list is still drawn: a row nobody decided about is kept.
    expect(treeBranches([deepTask()], moved)).toContain(`<li id="release-2" `);
  });
  /** `folds` is what overrides `omits` for this renderer: take a level out of it and the
   *  level is omitted again, its children rising to the nearest ancestor still drawn. */
  it("drops a level it stops folding, and hangs its children on whoever was above it", () => {
    const fewer = loadLevels(design(FOLDS, "        folds: [acceptance_criteria, task_test]"));
    expect(fewer.folds).toEqual(["acceptance_criteria", "task_test"]);
    const body = treeBranches([WHOLE], fewer);
    for (const g of ["requirement-5", "acceptance_test-7"]) expect(body, g).not.toContain(`id="${g}"`);
    expect(body.slice(body.indexOf(`<li id="story-4" `)))
      .toContain(`<ul><li id="acceptance_criteria-6" `);
  });
  it("refuses a design that declares no levels, and names what is missing", () => {
    for (const [from, missing] of [[SHOWS, /no shows/], [FOLDS, /no web\.folds/]] as const) {
      expect(() => loadLevels(design(from, "")), from).toThrow(TreeDesignError);
      expect(() => loadLevels(design(from, "")), from).toThrow(missing);
    }
  });
});

/** The proof is drawn in the record's own order, and nothing is lifted past it. */
describe("the proof of a story is drawn under the story, and the tree is nested lists", () => {
  const body = treeBranches([WHOLE]);
  it("keeps every level of the record, at the depth the record put it", () => {
    expect(shown([WHOLE])[0]?.children[0]?.children[0]?.children[0]?.children.map((c) => c.entity))
      .toEqual(["requirement"]);
    expect(body).toContain(`<ul class="tree">`);
    expect([...body.matchAll(/<ul/g)]).toHaveLength(9);
    expect(([...CHAIN, ["task", 8], ["task_test", 9]] as const).map(([e, i]) => nesting(body, e, i)))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const proof of LEVELS.folds) expect(body, proof).toContain(`<li id="${proof}-`);
    expect([...body.matchAll(/<li id="/g)]).toHaveLength(9);
    // Nothing is lifted past a proof level: the task hangs under the test that accepts it.
    expect(body.slice(body.indexOf(`<li id="acceptance_test-7" `))).toContain(`<ul><li id="task-8" `);
  });
  /** The levels above the proof are open on arrival and the proof is not, so the page lands
   *  at story level: a reader scrolling for what is moving sees what they saw before. */
  it("arrives with the work open and the proof shut, and folds the proof like the rest", () => {
    expect([...body.matchAll(/<details open>/g)]).toHaveLength(3);
    expect([...body.matchAll(/<details>/g)]).toHaveLength(5);
    for (const [e, id] of [["project", 1], ["release", 2], ["epic", 3]] as const) {
      expect(rowOf(body, e, id), e).toContain(`<details open><summary>`);
    }
    // Each proof row is a disclosure of its own, so the reader opens one level at a time.
    for (const [e, id] of [["requirement", 5], ["acceptance_criteria", 6]] as const) {
      expect(rowOf(body, e, id), e).toContain(`<details><summary>`);
    }
    expect(rowOf(body, "task_test", 9)).not.toMatch(/<(details|summary)/);
    for (const v of ["onclick", "aria-expanded"]) expect(body, v).not.toContain(v);
  });
  it("closes the story around its proof, so a page that landed is showing none of it", () => {
    const open = `<li id="story-4" data-ui="tree.node">`;
    expect(body).toContain(`${open}<details><summary><span class="label">`);
    expect(body.slice(body.indexOf(open))).toContain(`</summary><ul><li id="requirement-5" `);
    // The story's is the first shut disclosure on the page and every proof row is after it,
    // so nothing of the proof is outside it.
    const shut = body.indexOf("<details><summary>");
    expect(shut).toBe(body.indexOf(open) + open.length);
    for (const p of LEVELS.folds) expect(body.indexOf(`<li id="${p}-`), p).toBeGreaterThan(shut);
  });
  it("closes what it opens, draws sibling roots as separate trees, and says so when empty", () => {
    for (const tag of ["ul", "li", "details", "summary"]) {
      const shut = [...body.matchAll(new RegExp(`</${tag}>`, "g"))].length;
      expect([...body.matchAll(new RegExp(`<${tag}[ >]`, "g"))], tag).toHaveLength(shut);
    }
    const two = treeBranches([node("project", 1), node("project", 2)]);
    expect(nesting(two, "project", 1)).toBe(1);
    expect(nesting(two, "project", 2)).toBe(1);
    expect([...two.matchAll(/<ul/g)]).toHaveLength(1);
    expect(treeBranches([])).toBe(`<p class="empty">nothing in the record yet</p>`);
  });
});

describe("a row is a sentence", () => {
  it("leads with the label, then the id, the kind, the state and what hangs under it", () => {
    // The parts in the design's order, the rollup only where there is one, and no markup.
    const body = treeBranches([node("story", 4, { label: "ship the tree page" })]);
    expect(rowOf(body, "story", 4)).toContain(
      `<span class="label">ship the tree page</span> · <span class="id">#4</span> · ` +
        `<span class="kind">story</span> · <span class="state">planned</span>`,
    );
    const full = treeBranches([node("epic", 3, { rollup: { done: 3, open: 1, failed: 0 } })]);
    expect(rowOf(full, "epic", 3)).toContain(`<span class="rollup">3 done, 1 open</span>`);
    // Never a bucket at nothing, and nothing at all when every bucket is at nothing.
    expect(rowOf(full, "epic", 3)).not.toContain("failed");
    const bare = treeBranches([node("task", 8)]);
    expect(rowOf(bare, "task", 8).endsWith(`<span class="state">planned</span>`)).toBe(true);
    // And a person's own words reach the document as words and never as markup.
    const said = treeBranches([node("story", 4, { label: `a <script> & "quotes"` })]);
    expect(said).not.toContain("<script>");
    expect(rowOf(said, "story", 4)).toContain("a &lt;script&gt; &amp; &quot;quotes&quot;");
  });
});

/** The words, the default, the states left out and the line budget are all `ui.yaml`'s. A
 *  page holding any of them as a literal is a page nobody can restate without an edit. */
describe("what the reader is offered is the declaration's", () => {
  const { filter, text } = DECLARED;
  it("reads the filter's word, parameter, default, answers, excluded states and budget", () => {
    expect([filter.says, filter.param, filter.default]).toEqual(["filter:", "show", "open"]);
    expect(filter.options.map((o) => o.value)).toEqual(["open", "all"]);
    expect(filter.options.map((o) => o.says)).toEqual(["open only", "all"]);
    expect(filter.options.map((o) => o.id)).toEqual(["tree.filter.open", "tree.filter.all"]);
    expect(filter.options[0]?.excludes).toEqual(["released", "done", "delivered", "dropped"]);
    expect(filter.options[1]?.excludes).toEqual([]);
    // And how many lines of a record's own text a row spends, with the fold for the rest.
    expect([text.budget, text.more, text.moreId]).toEqual([3, "more", "tree.node.more"]);
  });
  it("refuses a declaration that is missing a word, a count or a list, and names it", () => {
    for (const [from, to, said] of [
      [`    says: "filter:"`, "", /tree\.filter\.says says nothing/],
      ["    budget: 3", "", /tree\.text\.budget is no count/],
      [EXCLUDES, "", /excludes\b.*names no states/],
      ["      - id: tree.filter.open", "      - id:", /options\[0\]\.id says nothing/],
    ] as const) {
      expect(() => loadUi(ui(from, to)), from).toThrow(TreeUiError);
      expect(() => loadUi(ui(from, to)), from).toThrow(said);
    }
  });
});

/** The page is more than its tree: a section, one dropdown holding two answers, and the row
 *  of a record, each declared by a dotted name and carried into the markup as `data-ui` — an
 *  assertion on a class proves only that two files were written the same afternoon. */
describe("the filter is one dropdown and not a row of chips", () => {
  const body = treeSection([WHOLE], at());
  it("draws the section, the one filter under it, and exactly the two declared answers", () => {
    expect(body).toContain(`<section class="tree" data-ui="tree"><h2>Tree</h2>`);
    expect(saysOf(body, "tree.filter")).toBe("filter:");
    expect(body.indexOf(`data-ui="tree.filter"`)).toBeGreaterThan(body.indexOf(`data-ui="tree"`));
    expect(drawn(body, "tree.filter")).toBe(` class="filter" data-ui="tree.filter"`);
    expect([...body.matchAll(/data-ui="(tree\.filter\.[a-z-]+)"/g)].map((m) => m[1]))
      .toEqual(["tree.filter.open", "tree.filter.all"]);
    expect(saysOf(body, "tree.filter.open")).toBe("open only");
    expect(saysOf(body, "tree.filter.all")).toBe("all");
    // The chips the row used to be are gone, the project's own among them.
    for (const c of ["in-progress", "needs-me", "project"]) expect(body, c).not.toContain(`filter.${c}`);
  });
  it("is one disclosure whose summary is the answer held, marking it, and offers only links", () => {
    expect(body).toContain(`<details class="pick"><summary>open only</summary>`);
    expect(drawn(body, "tree.filter.open")).toContain(`class="tag on"`);
    expect(drawn(body, "tree.filter.all")).toContain(`class="tag"`);
    expect(treeSection([WHOLE], at("?show=all"))).toContain(`<summary>all</summary>`);
    // Each answer is a link, because narrowing a reading changes nothing in wecode.
    for (const v of ["<form", "<button", "<input", "<select", "onclick"]) expect(body, v).not.toContain(v);
    // Every row is the declaration's node, and never the disclosure inside it.
    expect([...body.matchAll(/data-ui="tree\.node"/g)]).toHaveLength(9);
    expect(body).toContain(`<li id="task_test-9" data-ui="tree.node">`);
    expect(body).toContain(`<li id="story-4" data-ui="tree.node"><details>`);
    expect(body).not.toMatch(/<details( open)? data-ui="tree\.node"/);
  });
});

describe("the choice travels in the query string", () => {
  const { filter } = DECLARED;
  const option = (value: string) => filter.options.find((o) => o.value === value) as Option;
  it("puts a chosen answer on the query, drops it for the arriving one, and keeps the rest", () => {
    expect(optionHref(at(), filter, option("all"))).toBe("?show=all");
    expect(optionHref(at("?show=all"), filter, option("open"))).toBe("?");
    expect(optionHref(at("?task=8"), filter, option("all"))).toBe("?task=8&show=all");
    expect(optionHref(at("?task=8&show=all"), filter, option("open"))).toBe("?task=8");
    // An absent answer and an answer nothing offers are both the default, so a query
    // somebody mistyped draws the arriving page rather than an empty one.
    for (const q of ["", "?show=open", "?show=sideways"]) expect(chosen(at(q), filter).value, q).toBe("open");
    expect(chosen(at("?show=all"), filter).value).toBe("all");
  });
});

/** What the arriving answer leaves out is the declaration's four states and no others —
 *  `failed` is terminal to the machines and is exactly what a reader owed work needs. */
describe("open only leaves out the released, done, delivered and dropped", () => {
  const record = [
    node("project", 1, { state: "in_progress", children: [
      node("story", 2, { state: "delivered" }), node("story", 3, { state: "on_hold" }),
      node("story", 10, { state: "failed" }),
      node("story", 4, { state: "released", children: [node("task", 5, { state: "done" })] }),
    ] }),
    node("project", 6, { label: "wemail", state: "dropped" }),
  ];
  it("keeps only work still owed when nobody asked, and gives the record back for the other", () => {
    expect(ids(narrowed(record, at()))).toEqual([1, 3, 10]);
    expect(ids(narrowed(record, at("?show=open")))).toEqual([1, 3, 10]);
    expect(ids(narrowed(record, at("?show=all")))).toEqual([1, 2, 3, 10, 4, 5, 6]);
    // A left-out row is kept when a kept row hangs under it: a row shown without the rows
    // it hangs under is a row nobody can place.
    const kid = node("story", 2, { state: "in_progress" });
    expect(ids(narrowed([node("project", 11, { state: "released", children: [kid] })], at())))
      .toEqual([11, 2]);
    // The states are the file's: take one out of the list and the rows in it come back.
    expect(ids(narrowed(record, at(), loadUi(ui(EXCLUDES, "        excludes: [dropped]")))))
      .toEqual([1, 2, 3, 10, 4, 5]);
  });
  it("says the filter emptied the page rather than that the record is empty", () => {
    const body = treeSection([node("project", 6, { state: "dropped" })], at());
    expect(body).toContain("nothing in the record matches this filter");
    expect(body).not.toContain("nothing in the record yet");
    // The dropdown survives it: a filter that narrowed to nothing is the one you must undo.
    expect(body).toContain(`<summary>open only</summary>`);
    expect(treeSection([], at())).toContain("nothing in the record yet");
  });
  it("narrows the served page by the query an answer links to", async () => {
    const two = [node("project", 1, { label: "wecode", state: "done" }), node("project", 2)];
    const server = await serve({ "/tree": treeAt(() => two) });
    servers.push(server);
    const body = await (await fetch(`${addressOf(server)}/tree?show=all`)).text();
    expect(body).toContain(`<li id="project-1" data-ui="tree.node">`);
    expect(await (await fetch(`${addressOf(server)}/tree`)).text()).not.toContain(`<li id="project-1"`);
    expect(body).toBe(treePage(two, at("?show=all")).body);
  });
});

/** A record's text is the record's own and no length was ever agreed for it, so the row
 *  spends the declared budget of lines on it and the rest goes behind a fold. */
describe("a long record is cut to the declared budget", () => {
  const { budget, columns } = DECLARED.text;
  const long = [1, 2, 3, 4, 5].map((n) => `line ${n} ${"w".repeat(columns - 10)}`).join(" ");
  const body = treeBranches([node("requirement", 5, { label: long })]);
  it("counts a record's text in lines of its own and of the declared width, and cuts there", () => {
    expect(linesOf("one\ntwo", columns)).toEqual(["one", "two"]);
    expect(linesOf(long, columns)).toHaveLength(5);
    // A word longer than the whole width is broken rather than left to run on.
    expect(linesOf("z".repeat(columns * 2), columns)).toHaveLength(2);
    const [said, rest] = spent(long, budget, columns);
    expect(linesOf(said, columns)).toHaveLength(budget);
    expect([said.startsWith("line 1 "), said.includes("line 4")]).toEqual([true, false]);
    expect([rest.includes("line 4"), rest.includes("line 5")]).toEqual([true, true]);
  });
  it("draws the budget in the row, hides the rest behind the fold, and folds nothing short", () => {
    const said = rowOf(body, "requirement", 5);
    expect(said).toContain(`<span class="label">line 1 `);
    expect(said.slice(0, said.indexOf("<details"))).not.toContain("line 4");
    expect(said).toContain(`<details class="more" data-ui="tree.node.more">`);
    expect(said).toContain(`<summary>more</summary><span class="rest">`);
    expect(said.slice(said.indexOf(`class="rest"`))).toContain("line 5");
    // A fold over nothing is a control that does nothing, so a short record gets none.
    const short = treeBranches([node("requirement", 5, { label: "it holds" })]);
    expect(short).toContain(`<span class="label">it holds</span>`);
    expect(short).not.toContain("tree.node.more");
    expect(spent("it holds", budget, columns)).toEqual(["it holds", ""]);
  });
  /** The fold sits after the row and never inside a `<summary>`: a disclosure nested in one
   *  is a disclosure the reader cannot press without pressing the other. */
  it("puts the fold beside the row's own, keeps it out of the summary, and closes again", () => {
    const parent = treeBranches([node("story", 4, { label: long, children: [node("task", 8)] })]);
    expect(parent).toContain(`</span></summary><details class="more"`);
    expect(parent.slice(parent.indexOf("<summary>"), parent.indexOf("</summary>")))
      .not.toContain("<details");
    // It closes because it is a disclosure, arriving shut, with no handler of its own on it.
    expect(parent).not.toContain(`<details class="more" open`);
    expect(parent).not.toContain("onclick");
  });
  /** The budget is the file's, not this page's: restate it and the cut moves with it. */
  it("moves the cut when the declaration moves it", () => {
    const one = loadUi(ui("    budget: 3", "    budget: 1"));
    const said = rowOf(treeBranches([node("requirement", 5, { label: long })], undefined, one), "requirement", 5);
    expect(said.slice(0, said.indexOf("<details"))).not.toContain("line 2");
    expect(said.slice(said.indexOf(`class="rest"`))).toContain("line 2");
  });
});

/** The frame is the shell's and the wiring is the file: under `pages/`, at `/tree`, with
 *  `bin.ts` naming none of it. */
describe("the page is served in the shell, and the surface routes it", () => {
  const BIN = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");
  const PAGES = fileURLToPath(new URL("../src/pages", import.meta.url));
  it("answers /tree with an html document in the shell, reading the record every time", async () => {
    let nodes: readonly Node[] = [WHOLE];
    const server = await serve({ "/tree": treeAt(() => nodes) });
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/tree`);
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("<title>wecode</title>");
    // Its tree is inside the shell's one element, not beside it.
    expect(body.slice(body.indexOf("<main>"), body.indexOf("</main>"))).toContain(`<li id="task-8" `);
    expect(body).toBe(treePage([WHOLE]).body);
    // Work moves without anybody reloading, so the record is read again on every request.
    nodes = [];
    expect(await (await fetch(`${addressOf(server)}/tree`)).text()).toContain("nothing in the record yet");
  });
  it("binds /tree to the page, and is named in bin.ts no more than the board is", async () => {
    expect(discovered(readdirSync(PAGES))).toContain("tree");
    expect(pathOf("tree")).toBe("/tree");
    const record = node("project", 1, { label: "the whole record" });
    const module = (await import("../src/pages/tree.js")) as Record<string, unknown>;
    const routes = { [pathOf("tree")]: mounted("tree", module, { record: () => [record] }) };
    const reply = answer(routes, "GET", "/tree");
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("the whole record");
    expect(pathOf("board")).toBe("/");
    expect(BIN).not.toContain("treeAt");
    expect(BIN).not.toContain("pages/tree");
  });
});
