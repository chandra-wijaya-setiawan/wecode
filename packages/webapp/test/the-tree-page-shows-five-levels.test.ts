/** The tree page: the record as nested lists, every level of it, the proof folded shut.
 *
 *  The nodes are hand-made, for the reason the board's rows are: what is held here is the page,
 *  and that the tree is the record's shape is `@wecode/core`'s `tree()`, tested where it lives.
 *
 *  Four things beyond the tree, none written out here. The depth is the design's; the filter's
 *  words, default and excluded states are `config/ui.yaml`'s, as is what a row spends on a
 *  record's own text — each read back out of an edited copy of the file that declares it, what is
 *  drawn named by the `data-ui` it carries, because an assertion on a class proves only that two
 *  files were written the same afternoon. What open only leaves out is checked against the machines
 *  that decide what terminal means. And the fourth is that the filter needs no browser: the form is
 *  read off the page, submitted the way a `get` form is, and the address it names fetched. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMachines, type Node, type Rollup, type StatefulEntity } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/index.js";
import { discovered, mounted, pathOf } from "../src/pages/discover.js";
import { chosen, linesOf, loadLevels, loadUi, narrowed, shown, spent,
  treeAt, treeBranches, treePage, treeSection, TreeDesignError, TreeUiError } from "../src/pages/tree.js";

const at = (query = ""): URL => new URL(`http://localhost/tree${query}`);
/** The attributes of the one element with this `data-ui` name, which must be exactly one. */
function drawn(body: string, name: string): string {
  const found = [...body.matchAll(new RegExp(`<[a-z0-9]+([^>]*\\bdata-ui="${name}"[^>]*)>`, "g"))];
  expect(found.length, `the page draws ${found.length} of ${name}, not one`).toBe(1);
  return (found[0] as RegExpMatchArray)[1] as string;
}
/** A config file with one edit, elsewhere: reading a declaration back out of a copy is the only
 *  way to tell a reader from a literal that happens to agree with it. */
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
const EXCLUDES = "        excludes: [released, delivered, met, accepted, done, dropped]";
const NONE: Rollup = { done: 0, open: 0, failed: 0 };
/** The machines the record is kept by, which is where "terminal" is decided. What this tree draws
 *  is what it shows and folds; `assignment` is neither, so its terminals are not this page's. */
const MACHINES = loadMachines();
const DRAWN = [...LEVELS.shows, ...LEVELS.folds] as readonly StatefulEntity[];
const TERMINAL = [...new Set(DRAWN.flatMap((e) => MACHINES[e].terminal))].sort();

const node = (entity: string, id: number, over: Partial<Node> = {}): Node =>
  ({ entity, id, label: `${entity} ${id}`, state: "planned", children: [], rollup: NONE, folded: false, ...over });
/** The record's own nine levels, the four of proof in between, as the ledger keeps them. */
const under = (parent: Node, child: Node): Node => ({ ...parent, children: [child] });
const CHAIN = [["project", 1], ["release", 2], ["epic", 3], ["story", 4], ["requirement", 5],
  ["acceptance_criteria", 6], ["acceptance_test", 7]] as const;
const deepTask = (task: Node = node("task", 8)): Node =>
  CHAIN.reduceRight<Node>((kid, [e, id]) => under(node(e, id), kid), task);
const WHOLE = deepTask(node("task", 8, { children: [node("task_test", 9)] }));
/** The `<li>` of one node, without its descendants' rows. */
function rowOf(body: string, entity: string, id: number): string {
  const found = body.indexOf(`<li id="${entity}-${id}" `);
  expect(found, `the page has no row for ${entity} #${id}`).toBeGreaterThan(-1);
  const rest = body.slice(found), ends = rest.indexOf("<ul>");
  return rest.slice(0, ends === -1 ? rest.indexOf("</li>") : ends);
}
/** How deep a node's row sits in nested lists, counted in `<ul>`s open above it. */
function nesting(body: string, entity: string, id: number): number {
  const before = body.slice(0, body.indexOf(`<li id="${entity}-${id}" `));
  return [...before.matchAll(/<ul/g)].length - [...before.matchAll(/<\/ul>/g)].length;
}
/** Every id in a narrowing, parents before the rows under them. */
const ids = (ns: readonly Node[]): readonly number[] => ns.flatMap((n) => [n.id, ...ids(n.children)]);
/** An attribute's value as the markup carries it, back in the words it was written in. */
const plain = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, `"`).replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const formOf = (body: string): string =>
  body.slice(body.indexOf("<form"), body.indexOf("</form>") + "</form>".length);
const one = (form: string, re: RegExp): string => plain(re.exec(form)?.[1] as string);
/** Where a browser lands on submitting the page's own form with this answer picked and nothing
 *  else touched: the action, then the successful controls — the hidden fields, in the order they
 *  are written, and the select's name against the option chosen. No script is consulted, because
 *  a `get` form has none; this is the whole mechanism. */
function submits(body: string, picked: string): string {
  const form = formOf(body);
  expect(form, "the filter is not a get form").toContain(`method="get"`);
  const fields = [...form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)];
  const query = new URLSearchParams(fields.map(([, n, v]) => [plain(n as string), plain(v as string)]));
  expect([...form.matchAll(/<option value="([^"]*)"/g)].map((m) => plain(m[1] as string)),
    `no answer of the filter says ${picked}`).toContain(picked);
  query.set(one(form, /<select name="([^"]*)"/), picked);
  return `${one(form, /action="([^"]*)"/)}?${query}`;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("how deep the tree goes is the design's", () => {
  // `folds` overrides `omits` here; and a design that declares no levels refuses.
  it("reads the five levels of work and the four of proof, and moves when the design moves", () => {
    expect(LEVELS.shows).toEqual(["project", "release", "epic", "story", "task"]);
    expect([LEVELS.omits, LEVELS.folds]).toEqual([PROOF, PROOF]);
    const moved = loadLevels(design(SHOWS, "      shows: [project, epic, story, task]"));
    expect(moved.shows).toEqual(["project", "epic", "story", "task"]);
    // A level named by no list is still drawn: a row nobody decided about is kept.
    expect(treeBranches([deepTask()], moved)).toContain(`<li id="release-2" `);
    // Take a level out of `folds` and it is omitted again, its children rising to whoever is left.
    const fewer = loadLevels(design(FOLDS, "        folds: [acceptance_criteria, task_test]"));
    expect(fewer.folds).toEqual(["acceptance_criteria", "task_test"]);
    const body = treeBranches([WHOLE], fewer);
    for (const g of ["requirement-5", "acceptance_test-7"]) expect(body, g).not.toContain(`id="${g}"`);
    expect(body.slice(body.indexOf(`<li id="story-4" `))).toContain(`<ul><li id="acceptance_criteria-6" `);
    for (const [from, missing] of [[SHOWS, /no shows/], [FOLDS, /no web\.folds/]] as const) {
      expect(() => loadLevels(design(from, "")), from).toThrow(TreeDesignError);
      expect(() => loadLevels(design(from, "")), from).toThrow(missing);
    }
  });
});

/** The proof is drawn in the record's own order, and nothing is lifted past it. */
describe("the proof of a story is drawn under the story, and the tree is nested lists", () => {
  const body = treeBranches([WHOLE]);
  it("keeps every level at the depth the record put it, open above the proof and shut at it", () => {
    expect(shown([WHOLE])[0]?.children[0]?.children[0]?.children[0]?.children.map((c) => c.entity))
      .toEqual(["requirement"]);
    expect([body.includes(`<ul class="tree">`), [...body.matchAll(/<ul/g)].length]).toEqual([true, 9]);
    expect(([...CHAIN, ["task", 8], ["task_test", 9]] as const).map(([e, i]) => nesting(body, e, i)))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const proof of LEVELS.folds) expect(body, proof).toContain(`<li id="${proof}-`);
    expect([...body.matchAll(/<li id="/g)]).toHaveLength(9);
    // Nothing is lifted past a proof level: the task hangs under the test that accepts it.
    expect(body.slice(body.indexOf(`<li id="acceptance_test-7" `))).toContain(`<ul><li id="task-8" `);
    for (const tag of ["ul", "li", "details", "summary"]) {
      const shut = [...body.matchAll(new RegExp(`</${tag}>`, "g"))].length;
      expect([...body.matchAll(new RegExp(`<${tag}[ >]`, "g"))], tag).toHaveLength(shut);
    }
    // The work arrives open and the proof does not, so the page lands at story level.
    expect([[...body.matchAll(/<details open>/g)].length, [...body.matchAll(/<details>/g)].length])
      .toEqual([3, 5]);
    for (const [e, id] of [["project", 1], ["release", 2], ["epic", 3]] as const) {
      expect(rowOf(body, e, id), e).toContain(`<details open><summary>`);
    }
    // Each proof row is a disclosure of its own, so the reader opens one level at a time.
    for (const [e, id] of [["requirement", 5], ["acceptance_criteria", 6]] as const) {
      expect(rowOf(body, e, id), e).toContain(`<details><summary>`);
    }
    expect(rowOf(body, "task_test", 9)).not.toMatch(/<(details|summary)/);
    for (const v of ["onclick", "aria-expanded"]) expect(body, v).not.toContain(v);
    const open = `<li id="story-4" data-ui="tree.node">`;
    expect(body).toContain(`${open}<details><summary><span class="label">`);
    expect(body.slice(body.indexOf(open))).toContain(`</summary><ul><li id="requirement-5" `);
    // The story's is the page's first shut disclosure and every proof row is after it.
    const shut = body.indexOf("<details><summary>");
    expect(shut).toBe(body.indexOf(open) + open.length);
    for (const p of LEVELS.folds) expect(body.indexOf(`<li id="${p}-`), p).toBeGreaterThan(shut);
  });
  // A row is a sentence: label, id, kind, state, and what hangs under it, said once.
  it("leads a row with the label, then the id, the kind, the state and the rollup", () => {
    const said = treeBranches([node("story", 4, { label: "ship the tree page" })]);
    expect(rowOf(said, "story", 4)).toContain(`<span class="label">ship the tree page</span> · ` +
      `<span class="id">#4</span> · <span class="kind">story</span> · <span class="state">planned</span>`);
    const full = treeBranches([node("epic", 3, { rollup: { done: 3, open: 1, failed: 0 } })]);
    expect(rowOf(full, "epic", 3)).toContain(`<span class="rollup">3 done, 1 open</span>`);
    // Never a bucket at nothing, and nothing at all when every bucket is at nothing.
    expect(rowOf(full, "epic", 3)).not.toContain("failed");
    expect(rowOf(treeBranches([node("task", 8)]), "task", 8).endsWith(`class="state">planned</span>`)).toBe(true);
    // Sibling roots are separate trees, an empty record says so, and words reach as words.
    const two = treeBranches([node("project", 1), node("project", 2)]);
    expect([nesting(two, "project", 1), nesting(two, "project", 2), [...two.matchAll(/<ul/g)].length])
      .toEqual([1, 1, 1]);
    expect(treeBranches([])).toBe(`<p class="empty">nothing in the record yet</p>`);
    const odd = treeBranches([node("story", 4, { label: `a <script> & "quotes"` })]);
    expect(odd).not.toContain("<script>");
    expect(rowOf(odd, "story", 4)).toContain("a &lt;script&gt; &amp; &quot;quotes&quot;");
  });
});

/** The words, the default, the states left out and the line budget are all `ui.yaml`'s: a page
 *  holding any of them as a literal is a page nobody can restate without an edit. */
describe("what the reader is offered is the declaration's", () => {
  const { filter, text } = DECLARED;
  // Open only is stated against the machines: every state one will not move a drawn row out of.
  it("reads the filter's word, parameter, default, submit, answers, budget and every terminal", () => {
    expect([filter.says, filter.param, filter.default]).toEqual(["filter:", "show", "open"]);
    expect([filter.submitId, filter.submit]).toEqual(["tree.filter.submit", "narrow"]);
    expect(filter.options.map((o) => [o.id, o.value, o.says]))
      .toEqual([["tree.filter.open", "open", "open only"], ["tree.filter.all", "all", "all"]]);
    expect([filter.options[1]?.excludes, text.budget, text.more, text.moreId])
      .toEqual([[], 3, "more", "tree.node.more"]);
    expect([...(filter.options[0]?.excludes ?? [])].sort()).toEqual(TERMINAL);
    expect(TERMINAL).toEqual(["accepted", "delivered", "done", "dropped", "met", "released"]);
    // Two are a story's own proof, which the four states written here before this let stand.
    for (const e of ["requirement", "acceptance_criteria"] as const) {
      for (const s of MACHINES[e].terminal) expect(filter.options[0]?.excludes, e).toContain(s);
    }
    // `failed` is not one — no drawn machine calls it terminal, and it is work still owed.
    expect(MACHINES.task.states).toContain("failed");
    expect([TERMINAL.includes("failed"), filter.options[0]?.excludes.includes("failed")])
      .toEqual([false, false]);
    // And a field the declaration does not hold is a refusal, named by what is missing.
    for (const [from, to, said] of [
      [`    says: "filter:"`, "", /tree\.filter\.says says nothing/],
      ["      says: narrow", "", /tree\.filter\.submit\.says says nothing/],
      ["    budget: 3", "", /tree\.text\.budget is no count/],
      [EXCLUDES, "", /excludes\b.*names no states/],
      ["      - id: tree.filter.open", "      - id:", /options\[0\]\.id says nothing/],
    ] as const) {
      expect(() => loadUi(ui(from, to)), from).toThrow(TreeUiError);
      expect(() => loadUi(ui(from, to)), from).toThrow(said);
    }
  });
});

/** The page is more than its tree: a section, one select holding two answers and the control
 *  that sends the picked one — each declared by a dotted name, carried into the markup. */
describe("the filter is one select in a form, and not a row of chips", () => {
  const body = treeSection([WHOLE], at());
  const other = treeSection([WHOLE], at("?show=all"));
  const { filter } = DECLARED;
  it("draws the section, the one filter under it, and exactly the two declared answers", () => {
    expect(body).toContain(`<section class="tree" data-ui="tree"><h2>Tree</h2>`);
    expect(body.indexOf(`data-ui="tree.filter"`)).toBeGreaterThan(body.indexOf(`data-ui="tree"`));
    expect([...body.matchAll(/data-ui="(tree\.filter\.[a-z-]+)"/g)].map((m) => m[1]))
      .toEqual(["tree.filter.open", "tree.filter.all", "tree.filter.submit"]);
    for (const o of filter.options) expect(body, o.id).toContain(`>${o.says}</option>`);
    // The chips are gone, the project's own among them, and so is the disclosure that held them.
    for (const c of ["in-progress", "needs-me", "project"]) expect(body, c).not.toContain(`filter.${c}`);
    for (const g of [`class="tag`, `<details class="pick"`, `<summary>open only`]) expect(body, g).not.toContain(g);
    // One select of the declared answers, and the held one is what a browser shows shut — so
    // the page says what it is narrowed to without being opened.
    expect([[...body.matchAll(/<select/g)].length, [...body.matchAll(/<option /g)].length]).toEqual([1, 2]);
    expect([drawn(body, "tree.filter.open").includes(" selected"), [...body.matchAll(/ selected>/g)].length,
      drawn(other, "tree.filter.all").includes(" selected"),
      drawn(other, "tree.filter.open").includes(" selected")]).toEqual([true, 1, true, false]);
  });
  /** A select goes nowhere on its own and this page has no script to send it, so it sits in a
   *  `get` form on the page's own path that ends in a control the reader presses. */
  it("wraps the select in a get form, ending in the declared submit, and asks for no browser", () => {
    expect(drawn(body, "tree.filter")).toBe(` class="filter" method="get" action="/tree" data-ui="tree.filter"`);
    expect(body).toContain(`<label>${filter.says}<select name="${filter.param}">`);
    expect(body).toContain(`</select></label>`);
    expect(formOf(body))
      .toContain(`<button type="submit" data-ui="${filter.submitId}">${filter.submit}</button></form>`);
    // One form, its submit last, after the select it sends.
    expect([[...body.matchAll(/<form/g)].length, body.indexOf("<button") > body.indexOf("<select")])
      .toEqual([1, true]);
    // Nothing here is a browser's to run: no script, no handler, no link dressed as a control.
    for (const v of ["<script", "onchange", "onclick", "onsubmit", "data-href", "javascript:"]) {
      expect(body, v).not.toContain(v);
    }
    // And the page's own path, not a literal: the form goes back where the reader already is.
    expect(treeSection([WHOLE], new URL("http://localhost/elsewhere?show=all")))
      .toContain(`action="/elsewhere"`);
  });
  /** A `get` submission replaces the whole query with the form's own fields, so everything else
   *  the reader arrived with rides along as hidden ones or is silently thrown away. */
  it("carries the rest of the query as hidden fields, and never the filter's own parameter", () => {
    const kept = treeSection([WHOLE], at("?task=8&show=all&from=board"));
    expect(kept).toContain(`<input type="hidden" name="task" value="8">`);
    expect(kept).toContain(`<input type="hidden" name="from" value="board">`);
    expect([[...kept.matchAll(/<input /g)].length, kept.includes(`name="show" value=`)]).toEqual([2, false]);
    // The fields come before the control, and a reader who arrived with nothing else gets none.
    expect([kept.indexOf("<input") < kept.indexOf("<label>"), body.includes("<input")]).toEqual([true, false]);
    // A person's own words reach a field as words: a value is an attribute, not markup.
    const odd = treeSection([WHOLE], at(`?q=${encodeURIComponent(`a "quote" & <tag>`)}`));
    expect([odd.includes(`name="q" value="a &quot;quote&quot; &amp; &lt;tag&gt;"`), odd.includes("<tag>")])
      .toEqual([true, false]);
    expect([submits(body, "all"), submits(other, "open")])
      .toEqual(["/tree?show=all", "/tree?show=open"]);
    expect([submits(treeSection([WHOLE], at("?task=8")), "all"), submits(kept, "open")])
      .toEqual(["/tree?task=8&show=all", "/tree?task=8&from=board&show=open"]);
    // An absent answer and one nothing offers are both the default, so a mistyped query lands.
    for (const q of ["", "?show=open", "?show=sideways"]) expect(chosen(at(q), filter).value, q).toBe("open");
    expect(chosen(at("?show=all"), filter).value).toBe("all");
  });
});

describe("open only leaves out every terminal state, and nothing else", () => {
  const criteria = [node("acceptance_criteria", 12, { state: "accepted" })];
  const proven = node("requirement", 9, { state: "in_progress", children: criteria });
  const record = [
    node("project", 1, { state: "in_progress", children: [
      node("story", 2, { state: "delivered" }),
      node("story", 3, { state: "on_hold", children: [node("requirement", 7, { state: "met" }), proven] }),
      node("story", 10, { state: "failed" }),
      node("story", 4, { state: "released", children: [node("task", 5, { state: "done" })] }),
    ] }),
    node("project", 6, { label: "wemail", state: "dropped" }),
  ];
  it("keeps only work still owed when nobody asked, and gives the record back for the other", () => {
    // A story's settled proof goes with it; the failed story stays, being work still owed.
    for (const q of ["", "?show=open"]) expect(ids(narrowed(record, at(q))), q).toEqual([1, 3, 9, 10]);
    expect(ids(narrowed(record, at("?show=all")))).toEqual([1, 2, 3, 7, 9, 12, 10, 4, 5, 6]);
    // A left-out row is kept when a kept row hangs under it: a row nobody could place, else.
    const kid = node("story", 2, { state: "in_progress" });
    expect(ids(narrowed([node("project", 11, { state: "released", children: [kid] })], at())))
      .toEqual([11, 2]);
    // The states are the file's: take one out of the list and the rows in it come back.
    expect(ids(narrowed(record, at(), loadUi(ui(EXCLUDES, "        excludes: [dropped]")))))
      .toEqual([1, 2, 3, 7, 9, 12, 10, 4, 5]);
    // Narrowed to nothing says so, rather than that the record is empty — and keeps the form,
    // which is the one control a reader must have in order to undo it.
    const none = treeSection([node("project", 6, { state: "dropped" })], at());
    expect([none.includes("nothing in the record matches this filter"),
      none.includes("nothing in the record yet")]).toEqual([true, false]);
    expect(drawn(none, "tree.filter.open")).toContain(` selected`);
    expect(submits(none, "all")).toBe("/tree?show=all");
    expect(treeSection([], at())).toContain("nothing in the record yet");
  });
});

/** No length was ever agreed for a record's own text, so the row spends the declared budget of
 *  lines on it and the rest goes behind a fold — which sits after the row, never in a summary. */
describe("a long record is cut to the declared budget", () => {
  const { budget, columns } = DECLARED.text;
  const long = [1, 2, 3, 4, 5].map((n) => `line ${n} ${"w".repeat(columns - 10)}`).join(" ");
  const body = treeBranches([node("requirement", 5, { label: long })]);
  it("counts a record's text in lines of its own and of the declared width, and cuts there", () => {
    expect([linesOf("one\ntwo", columns), linesOf(long, columns).length]).toEqual([["one", "two"], 5]);
    // A word longer than the whole width is broken rather than left to run on.
    expect(linesOf("z".repeat(columns * 2), columns)).toHaveLength(2);
    const [said, rest] = spent(long, budget, columns);
    expect(linesOf(said, columns)).toHaveLength(budget);
    expect([said.startsWith("line 1 "), said.includes("line 4")]).toEqual([true, false]);
    expect([rest.includes("line 4"), rest.includes("line 5")]).toEqual([true, true]);
    const row = rowOf(body, "requirement", 5);
    expect(row).toContain(`<span class="label">line 1 `);
    expect(row.slice(0, row.indexOf("<details"))).not.toContain("line 4");
    expect(row).toContain(`<details class="more" data-ui="tree.node.more">`);
    expect(row).toContain(`<summary>more</summary><span class="rest">`);
    expect(row.slice(row.indexOf(`class="rest"`))).toContain("line 5");
    // A fold over nothing is a control that does nothing, so a short record gets none.
    const short = treeBranches([node("requirement", 5, { label: "it holds" })]);
    expect([short.includes(`<span class="label">it holds</span>`), short.includes("tree.node.more")])
      .toEqual([true, false]);
    expect(spent("it holds", budget, columns)).toEqual(["it holds", ""]);
    // The fold sits after the row and never inside a summary: a disclosure nested in one is a
    // disclosure the reader cannot press without pressing the other. It arrives shut, unhandled.
    const parent = treeBranches([node("story", 4, { label: long, children: [node("task", 8)] })]);
    expect(parent).toContain(`</span></summary><details class="more"`);
    expect(parent.slice(parent.indexOf("<summary>"), parent.indexOf("</summary>"))).not.toContain("<details");
    for (const v of [`<details class="more" open`, "onclick"]) expect(parent, v).not.toContain(v);
    // And the budget is the file's, not this page's: restate it and the cut moves with it.
    const cut = rowOf(treeBranches([node("requirement", 5, { label: long })], undefined,
      loadUi(ui("    budget: 3", "    budget: 1"))), "requirement", 5);
    expect(cut.slice(0, cut.indexOf("<details"))).not.toContain("line 2");
    expect(cut.slice(cut.indexOf(`class="rest"`))).toContain("line 2");
  });
});

/** The frame is the shell's, the wiring the file: under `pages/`, at `/tree`, unnamed in `bin.ts`. */
describe("the page is served in the shell, and the surface routes it", () => {
  const BIN = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");
  const PAGES = fileURLToPath(new URL("../src/pages", import.meta.url));
  /** The form is the whole of the filter, so it is pressed against a running surface: the page
   *  that arrives is read, its submit is submitted, and the address it names is fetched. */
  it("answers /tree in the shell, narrowed by the query and by pressing its own submit", async () => {
    let nodes: readonly Node[] = [node("project", 11, { label: "wemail", state: "dropped" }), WHOLE];
    const server = await serve({ "/tree": treeAt(() => nodes) });
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/tree?show=all`);
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
    const body = await res.text();
    expect([body.startsWith("<!doctype html>"), body.includes("<title>wecode</title>")]).toEqual([true, true]);
    // Its tree is inside the shell's one element, narrowed by the answer the query named.
    expect(body.slice(body.indexOf("<main>"), body.indexOf("</main>"))).toContain(`<li id="task-8" `);
    expect([body.includes(`<li id="project-11" data-ui="tree.node">`),
      body === treePage(nodes, at("?show=all")).body]).toEqual([true, true]);
    // The arriving page is narrowed; its own submit, pressed with the other answer picked, is
    // the address that widens it — and the widened page's form narrows it back again.
    const arrived = await (await fetch(`${addressOf(server)}/tree`)).text();
    expect([arrived.includes(`<li id="project-11"`), submits(arrived, "all")]).toEqual([false, "/tree?show=all"]);
    const widened = await (await fetch(`${addressOf(server)}${submits(arrived, "all")}`)).text();
    expect([widened === body, submits(widened, "open")]).toEqual([true, "/tree?show=open"]);
    expect(await (await fetch(`${addressOf(server)}${submits(widened, "open")}`)).text())
      .not.toContain(`<li id="project-11"`);
    // Work moves without anybody reloading, so the record is read again on every request.
    nodes = [];
    expect(await (await fetch(`${addressOf(server)}/tree`)).text()).toContain("nothing in the record yet");
  });
  it("binds /tree to the page, and is named in bin.ts no more than the board is", async () => {
    expect(discovered(readdirSync(PAGES))).toContain("tree");
    expect([pathOf("tree"), pathOf("board")]).toEqual(["/tree", "/"]);
    const record = node("project", 1, { label: "the whole record" });
    const module = (await import("../src/pages/tree.js")) as Record<string, unknown>;
    const routes = { [pathOf("tree")]: mounted("tree", module, { record: () => [record] }) };
    const reply = answer(routes, "GET", "/tree");
    expect([reply.status, reply.body.includes("the whole record")]).toEqual([200, true]);
    expect([BIN.includes("treeAt"), BIN.includes("pages/tree")]).toEqual([false, false]);
  });
});
