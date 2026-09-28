/** The tree page: the record as nested lists, every level of it, arriving open at the task.
 *
 *  The nodes are hand-made, for the reason the board's rows are: what is held here is the page,
 *  and that the tree is the record's shape is `@wecode/core`'s `tree()`, tested where it lives.
 *
 *  Four things beyond the tree, none written out here. The depth is the design's; the filter's
 *  words, default and excluded states are `config/ui.yaml`'s, as is what a row calls each level —
 *  each read back out of an edited copy of the file that declares it, what is drawn named by the
 *  `data-ui` it carries, because an assertion on a class proves only that two files were written
 *  the same afternoon. What open only leaves out is checked against the machines that decide what
 *  terminal means, and `passed` — which they will not settle — against the `invalidate` that is
 *  why. And the filter needs no browser: the form is read off the page, submitted the way a `get`
 *  form is, and the address it names fetched. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMachines, type Node, type Rollup, type StatefulEntity } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/index.js";
import { discovered, mounted, pathOf } from "../src/pages/discover.js";
import { chosen, loadLevels, loadUi, narrowed, shown,
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
// The lines this renderer reads, which are the web block's and not the shared five.
const SHOWS = "        shows: [story, acceptance_criteria, acceptance_test, task]";
const OMITS = "        omits: [project, release, epic, requirement, task_test]";
const FOLDS = "        folds: []";
const EXCLUDES = "        excludes: [released, delivered, met, accepted, done, dropped, passed]";
const NONE: Rollup = { done: 0, open: 0, failed: 0 };
/** The machines the record is kept by, which is where "terminal" is decided. What this tree draws
 *  is what it shows and folds; `assignment` is neither, so its terminals are not this page's. */
const MACHINES = loadMachines();
const DRAWN = [...LEVELS.shows, ...LEVELS.folds] as readonly StatefulEntity[];
/** Every level the record keeps, drawn or not: the narrowing runs before the thinning, so a
 *  rung this renderer hides is still a rung the filter has to have an answer for. */
const KEPT = ["project", "release", "epic", "story", "requirement", "acceptance_criteria",
  "acceptance_test", "task", "task_test"] as const;
const TERMINAL = [...new Set(KEPT.flatMap((e) => MACHINES[e].terminal))].sort();

const node = (entity: string, id: number, over: Partial<Node> = {}): Node =>
  ({ entity, id, label: `${entity} ${id}`, state: "planned", children: [], rollup: NONE, folded: false, ...over });
/** The record's own nine levels. The ledger keeps every one; what this renderer draws of them
 *  is the web block's business, so the fixture is the whole chain and the page is what thins
 *  it. `RUNGS` is what should survive that thinning. */
const under = (parent: Node, child: Node): Node => ({ ...parent, children: [child] });
const LEDGER = [["project", 1], ["release", 2], ["epic", 3], ["story", 4], ["requirement", 5],
  ["acceptance_criteria", 6], ["acceptance_test", 7]] as const;
/** The rungs the web tree keeps, in the order it keeps them. */
const CHAIN = [["story", 4], ["acceptance_criteria", 6], ["acceptance_test", 7]] as const;
/** The rungs it drops: three above the story, and the requirement that wraps one criterion. */
const DROPPED = [["project", 1], ["release", 2], ["epic", 3], ["requirement", 5]] as const;
const deepTask = (task: Node = node("task", 8)): Node =>
  LEDGER.reduceRight<Node>((kid, [e, id]) => under(node(e, id), kid), task);
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
/** Where a browser lands on submitting the page's own form with this answer picked: the action,
 *  the hidden fields in the order written, then every select — `show` at the option chosen and
 *  the rest as the page holds them. No script is consulted, a `get` form having none. The form
 *  holds two selects and a browser sends both, which is how the project a reader is standing in
 *  survives their asking for the finished work. */
function submits(body: string, picked: string): string {
  const form = formOf(body);
  expect(form, "the filter is not a get form").toContain(`method="get"`);
  const fields = [...form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)];
  const query = new URLSearchParams(fields.map(([, n, v]) => [plain(n as string), plain(v as string)]));
  expect([...form.matchAll(/<option value="([^"]*)"/g)].map((m) => plain(m[1] as string)),
    `no answer of the filter says ${picked}`).toContain(picked);
  for (const m of form.matchAll(/<select name="([^"]*)">([\s\S]*?)<\/select>/g)) {
    const name = plain(m[1] as string);
    const held = /<option value="([^"]*)"[^>]* selected>/.exec(m[2] as string);
    query.set(name, name === "show" ? picked : plain(held?.[1] ?? ""));
  }
  return `${one(form, /action="([^"]*)"/)}?${query}`;
}

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((done) => s.close(done)); });

describe("how deep the tree goes is the design's", () => {
  // `folds` overrides `omits` here; and a design that declares no levels refuses.
  it("reads the rungs the web block names, and moves when the design moves", () => {
    // Anchored at the story. Project, release and epic answer where a story lives, which a
    // picker above the tree answers once instead of three rungs answering on every row; the
    // requirement wraps a single criterion in 502 of 583 cases. The cockpit still shows its
    // five — `shared.outline.levels` is untouched, and the tui's own test holds it to them.
    expect(LEVELS.shows).toEqual(["story", "acceptance_criteria", "acceptance_test", "task"]);
    expect(LEVELS.omits).toEqual(["project", "release", "epic", "requirement", "task_test"]);
    expect(LEVELS.folds).toEqual([]);
    const moved = loadLevels(design(SHOWS, "        shows: [epic, story, task]"));
    expect(moved.shows).toEqual(["epic", "story", "task"]);
    // A level named by no list is still drawn: a row nobody decided about is kept.
    expect(treeBranches([deepTask()], loadLevels(design(OMITS, "        omits: [project, epic]"))))
      .toContain(`<li id="release-2" `);
    // Name a level in `folds` and it arrives shut, with everything above it, so the page lands
    // higher up. It changes nothing about which rows are drawn: `shows` names the test rung, so
    // folding it only shuts it — `omits` is what would drop it, requirement dropped either way.
    const fewer = loadLevels(design(FOLDS, "        folds: [acceptance_criteria]"));
    expect(fewer.folds).toEqual(["acceptance_criteria"]);
    const body = treeBranches([WHOLE], fewer);
    expect(body, "requirement-5").not.toContain(`id="requirement-5"`);
    expect(body, "acceptance_test-7").toContain(`id="acceptance_test-7"`);
    for (const [e, i] of DROPPED) expect(treeBranches([WHOLE]), `${e} is drawn`).not.toContain(`id="${e}-${i}"`);
    expect(body.slice(body.indexOf(`<li id="story-4" `))).toContain(`<ul><li id="acceptance_criteria-6" `);
    // Taking the web block's own `shows` away is not a refusal: the shared list answers for
    // a key the block leaves out, which is what makes it an override rather than a second
    // declaration to keep in step. `web.folds` has no shared twin, so its absence still is.
    expect(loadLevels(design(SHOWS, "")).shows).toEqual(["project", "release", "epic", "story", "task"]);
    for (const t of [TreeDesignError, /no web\.folds/])
      expect(() => loadLevels(design(FOLDS, "")), "web.folds").toThrow(t);
  });
});

/** The proof is drawn in the record's own order, and nothing is lifted past it. */
describe("the proof of a story is drawn under the story, and the tree is nested lists", () => {
  const body = treeBranches([WHOLE]);
  it("keeps every level at the depth the record put it, and arrives open down to the task", () => {
    // The story is the root here: the three above it gave their children up, and the
    // requirement gave its criterion to the story.
    expect(shown([WHOLE])[0]?.entity).toBe("story");
    expect(shown([WHOLE])[0]?.children.map((c) => c.entity)).toEqual(["acceptance_criteria"]);
    expect([body.includes(`<ul class="tree">`), [...body.matchAll(/<ul/g)].length]).toEqual([true, 4]);
    expect(([...CHAIN, ["task", 8]] as const).map(([e, i]) => nesting(body, e, i))).toEqual([1, 2, 3, 4]);
    for (const proof of LEVELS.folds) expect(body, proof).toContain(`<li id="${proof}-`);
    expect([...body.matchAll(/<li id="/g)]).toHaveLength(4);
    // Nothing is lifted past a proof level: the task hangs under the test that accepts it.
    expect(body.slice(body.indexOf(`<li id="acceptance_test-7" `))).toContain(`<ul><li id="task-8" `);
    for (const t of ["ul", "li", "details", "summary"]) expect([...body.matchAll(new RegExp(`<${t}[ >]`, "g"))].length,
      t).toBe([...body.matchAll(new RegExp(`</${t}>`, "g"))].length);
    // Every branch arrives open, because `folds` names no level: the page lands at the task,
    // which is the row somebody is at. Arriving at the story asked three clicks to reach it.
    expect([[...body.matchAll(/<details open/g)].length, [...body.matchAll(/<details/g)].length]).toEqual([3, 3]);
    // And each is a disclosure of its own, so a reader can shut one level at a time.
    for (const [e, id] of [["story", 4], ["acceptance_criteria", 6], ["acceptance_test", 7]] as const)
      expect(rowOf(body, e, id), e).toContain(`<details open`);
    // The task is the last rung this tree draws, so it is a row and not a disclosure.
    expect(rowOf(body, "task", 8)).not.toMatch(/<(details|summary)/);
    for (const v of ["onclick", "aria-expanded"]) expect(body, v).not.toContain(v);
    const open = `<li id="story-4" data-ui="tree.node">`;
    expect(body).toContain(open);
    // The requirement is not drawn, so what hangs under the story is its criterion.
    expect(body.slice(body.indexOf(open))).toContain(`<li id="acceptance_criteria-6" `);
    // Name the criterion a fold and it arrives shut, with the rows under it still drawn.
    const folded = treeBranches([WHOLE], loadLevels(design(FOLDS, "        folds: [acceptance_criteria]")));
    expect(rowOf(folded, "acceptance_criteria", 6)).toContain(`<details><summary`);
    expect(folded).toContain(`<li id="task-8" `);
  });
  // Five columns and not a sentence, because a reader scans a column and has to read a sentence:
  // the rail first, so depth is drawn once, then the kind, the id, the words and the state.
  // Nothing joins them — the ` · ` that used to made the row one line of prose, and with it there
  // no two rows' text began at the same place. The state ends it; `style` leads its span so the
  // row still *ends* `class="state">…`.
  it("draws a row as the rail, the kind, the id, the words and the state, and ends there", () => {
    const said = treeBranches([node("story", 4, { label: "ship the tree page" })]);
    expect(rowOf(said, "story", 4)).toContain(`<span class="kind">story</span>` +
      `<span class="id">#4</span><span class="label" title="ship the tree page">ship the tree page</span>` +
      `<span style="--hue:var(--st-planned, currentColor)" class="state">planned</span>`);
    expect([...rowOf(said, "story", 4).matchAll(/<span [^>]*class="([a-z]+)"/g)].map((m) => m[1])).toEqual(["kind", "id", "label", "state"]);
    expect([said.includes(`<div class="row"><svg`), said.includes(" · ")]).toEqual([true, false]);
    const counted = { rollup: { done: 3, open: 1, failed: 2 } };
    const [full, over] = [treeBranches([node("story", 3, counted)]), treeBranches([node("story", 3, { ...counted, children: [node("story", 4)] })])];
    for (const g of ["rollup", "3 done", "1 open", "2 failed", "done"]) for (const b of [full, over]) expect(b, g).not.toContain(g);
    expect([rowOf(full, "story", 3).endsWith(`class="state">planned</span></div>`), rowOf(over, "story", 3).endsWith(`class="state">planned</span></summary>`)]).toEqual([true, true]);
    expect(rowOf(treeBranches([node("task", 8)]), "task", 8).endsWith(`class="state">planned</span></div>`)).toBe(true);
    // The rail opens the row, so a row's columns are one grid; sibling roots are separate
    // trees, an empty record says so, and words reach as words.
    const two = treeBranches([node("story", 1), node("story", 2)]);
    expect([nesting(two, "story", 1), nesting(two, "story", 2), [...two.matchAll(/<ul/g)].length]).toEqual([1, 1, 1]);
    expect(treeBranches([])).toBe(`<p class="empty">nothing in the record yet</p>`);
    const odd = treeBranches([node("story", 4, { label: `a <script> & "quotes"` })]);
    expect([odd.includes("<script>"), rowOf(odd, "story", 4).includes("a &lt;script&gt; &amp; &quot;quotes&quot;")]).toEqual([false, true]);
  });
});

/** The words, the default, the states left out and the line budget are all `ui.yaml`'s: a page
 *  holding any of them as a literal is a page nobody can restate without an edit. */
describe("what the reader is offered is the declaration's", () => {
  const { filter } = DECLARED;
  // Open only is stated against the machines where they answer — every state one will not move a
  // drawn row out of — and over them at the one state they cannot settle, which is `passed`.
  it("reads the word, parameter, default, submit, answers, every terminal and passed", () => {
    expect([filter.says, filter.param, filter.default]).toEqual(["filter:", "show", "open"]);
    expect([filter.submitId, filter.submit]).toEqual(["tree.filter.submit", "narrow"]);
    expect(filter.options.map((o) => [o.id, o.value, o.says]))
      .toEqual([["tree.filter.open", "open", "open only"], ["tree.filter.all", "all", "all"]]);
    expect(filter.options[1]?.excludes).toEqual([]);
    expect([...(filter.options[0]?.excludes ?? [])].sort()).toEqual([...TERMINAL, "passed"].sort());
    expect(TERMINAL).toEqual(["accepted", "delivered", "done", "dropped", "met", "released"]);
    // Two are a story's own proof, which the four states written here before this let stand.
    for (const e of ["requirement", "acceptance_criteria"] as const)
      for (const s of MACHINES[e].terminal) expect(filter.options[0]?.excludes, e).toContain(s);
    // And `passed` is the one the machines cannot settle for this page: it is a state of both
    // test levels the tree draws, terminal on neither — each holds an `invalidate` back out of
    // it — so it is left out for being nothing owed, never for being a row that cannot move.
    for (const e of ["acceptance_test"] as const) {
      expect([DRAWN.includes(e), MACHINES[e].states.includes("passed"), MACHINES[e].terminal], e)
        .toEqual([true, true, ["dropped"]]);
      expect(MACHINES[e].transitions.filter((t) => t.from.includes("passed")).map((t) => [t.verb, t.to]), e)
        .toEqual([["invalidate", "ready"]]);
    }
    // `failed` is not one — no drawn machine calls it terminal, and it is work still owed.
    expect(MACHINES.task.states).toContain("failed");
    expect([TERMINAL.includes("failed"), filter.options[0]?.excludes.includes("failed")]) .toEqual([false, false]);
    // And a field the declaration does not hold is a refusal, named by what is missing.
    for (const [from, to, said] of [
      [`    says: "filter:"`, "", /tree\.filter\.says says nothing/],
      ["      says: narrow", "", /tree\.filter\.submit\.says says nothing/],
      [EXCLUDES, "", /excludes\b.*names no states/],
      ["      - id: tree.filter.open", "      - id:", /options\[0\]\.id says nothing/],
    ] as const) for (const t of [TreeUiError, said]) expect(() => loadUi(ui(from, to)), from).toThrow(t);
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
    // Two selects — this filter and the project picker beside it — each of the declared answers,
    // and the held one of each is what a browser shows shut, so the page says what it is narrowed
    // to unopened. Four options: the filter's two, all-projects, and the one project held.
    expect([[...body.matchAll(/<select/g)].length, [...body.matchAll(/<option /g)].length]).toEqual([2, 4]);
    expect([drawn(body, "tree.filter.open").includes(" selected"), [...body.matchAll(/ selected>/g)].length,
      drawn(other, "tree.filter.all").includes(" selected"),
      drawn(other, "tree.filter.open").includes(" selected")]).toEqual([true, 2, true, false]);
  });
  /** A select goes nowhere on its own and this page has no script to send it, so it sits in a
   *  `get` form on the page's own path that ends in a control the reader presses. */
  it("wraps the select in a get form, ending in the declared submit, and asks for no browser", () => {
    expect(drawn(body, "tree.filter")).toBe(` class="filter" method="get" action="/tree" data-ui="tree.filter"`);
    expect(body).toContain(`<label>${filter.says}<select name="${filter.param}">`);
    expect(body).toContain(`</select></label>`);
    expect(formOf(body)).toContain(`<button type="submit" data-ui="${filter.submitId}">${filter.submit}</button></form>`);
    // One form, its submit last, after the select it sends.
    expect([[...body.matchAll(/<form/g)].length, body.indexOf("<button") > body.indexOf("<select")])
      .toEqual([1, true]);
    // Nothing here is a browser's to run: no script, no handler, no link dressed as a control.
    for (const v of ["<script", "onchange", "onclick", "onsubmit", "data-href", "javascript:"]) expect(body, v).not.toContain(v);
    // And the page's own path, not a literal: the form goes back where the reader already is.
    expect(treeSection([WHOLE], new URL("http://localhost/elsewhere?show=all"))).toContain(`action="/elsewhere"`);
  });
  it("carries the rest of the query as hidden fields, and never the filter's own parameter", () => {
    const kept = treeSection([WHOLE], at("?task=8&show=all&from=board"));
    expect(kept).toContain(`<input type="hidden" name="task" value="8">`);
    expect(kept).toContain(`<input type="hidden" name="from" value="board">`);
    expect([[...kept.matchAll(/<input /g)].length, kept.includes(`name="show" value=`)]).toEqual([2, false]);
    // The fields come before the control, a reader who arrived with nothing else gets none, and
    // a person's own words reach a field as words: a value is an attribute, not markup.
    expect([kept.indexOf("<input") < kept.indexOf("<label>"), body.includes("<input")]).toEqual([true, false]);
    const odd = treeSection([WHOLE], at(`?q=${encodeURIComponent(`a "quote" & <tag>`)}`));
    expect([odd.includes(`name="q" value="a &quot;quote&quot; &amp; &lt;tag&gt;"`), odd.includes("<tag>")]).toEqual([true, false]);
    expect([submits(body, "all"), submits(other, "open")])
      .toEqual(["/tree?project=all&show=all", "/tree?project=all&show=open"]);
    expect([submits(treeSection([WHOLE], at("?task=8")), "all"), submits(kept, "open")])
      .toEqual(["/tree?task=8&project=all&show=all", "/tree?task=8&from=board&project=all&show=open"]);
    // An absent answer and one nothing offers are both the default, so a mistyped query lands.
    for (const q of ["", "?show=open", "?show=sideways"]) expect(chosen(at(q), filter).value, q).toBe("open");
    expect(chosen(at("?show=all"), filter).value).toBe("all");
  });
});

describe("open only leaves out every terminal state and every passed test, and nothing else", () => {
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
    expect(ids(narrowed([node("project", 11, { state: "released", children: [kid] })], at()))).toEqual([11, 2]);
    // The states are the file's: take one out of the list and the rows in it come back.
    expect(ids(narrowed(record, at(), loadUi(ui(EXCLUDES, "        excludes: [dropped]"))))).toEqual([1, 2, 3, 7, 9, 12, 10, 4, 5]);
    // Narrowed to nothing says so, rather than that the record is empty — and keeps the form,
    // which is the one control a reader must have in order to undo it.
    const none = treeSection([node("project", 6, { state: "dropped" })], at());
    expect([none.includes("nothing in the record matches this filter"), none.includes("nothing in the record yet")]).toEqual([true, false]);
    expect([drawn(none, "tree.filter.open").includes(" selected"), submits(none, "all"),
      treeSection([], at()).includes("nothing in the record yet")]).toEqual([true, "/tree?project=all&show=all", true]);
    // The headline of the change before this: a requirement in `met` no longer keeps a `delivered`
    // standing. `met` was not one of the four states written here before, so the requirement read
    // as work still owed, and the story it hangs under was kept in order to place it.
    const settled = [node("story", 20, { state: "delivered", children: [node("requirement", 21, { state: "met" })] })];
    const four = "        excludes: [released, delivered, done, dropped]";
    expect([ids(narrowed(settled, at())), ids(narrowed(settled, at(), loadUi(ui(EXCLUDES, four))))]).toEqual([[], [20, 21]]);
  });
  /** The one state in the list the machines do not settle: a green test is nothing owed, but no
   *  machine may call `passed` terminal — each test holds `invalidate`, `passed` back to `ready`, for
   *  when the artefact it proves moves under it. So the row is left out by this file's own decision. */
  it("leaves out a passed test, which no machine of a drawn level calls terminal", () => {
    const six = `        excludes: [${TERMINAL.join(", ")}]`;
    // Two greens and one red under a story still being worked: only the red is work still owed.
    const mixed = [node("story", 30, { state: "in_progress", children: [
      node("acceptance_test", 31, { state: "passed" }), node("task_test", 32, { state: "passed" }),
      node("task_test", 33, { state: "failed" })] })];
    expect([ids(narrowed(mixed, at())), ids(narrowed(mixed, at(), loadUi(ui(EXCLUDES, six))))]).toEqual([[30, 33], [30, 31, 32, 33]]);
    // And the headline: a delivered story whose only proof is green no longer stands. Under the six
    // terminal states the `passed` test read as work owed, and the story was kept to place it.
    const green = [node("story", 40, { state: "delivered", children: [node("acceptance_test", 41, { state: "passed" })] })];
    expect([ids(narrowed(green, at())), ids(narrowed(green, at(), loadUi(ui(EXCLUDES, six))))]).toEqual([[], [40, 41]]);
  });
});

/** What a row calls a level is `ui.yaml`'s word: `acceptance_criteria` spends more of a 22px row
 *  than the record's own words do, so sketch #7 signed the short ones, and a level the file names
 *  none for is drawn by the record's own name — the one answer that cannot be wrong. The text is
 *  drawn whole and cut by the sheet: the budget of lines counted here before put the rest behind
 *  a fold, and the fold cost a second line on half the real record's rows, breaking the rail. */
describe("a row says what the declaration says, on one line", () => {
  const long = [1, 2, 3, 4, 5].map((n) => `line ${n} ${"w".repeat(86)}`).join(" ");
  it("calls a level the declared word, and an undeclared one the record's own name", () => {
    expect([DECLARED.kinds["acceptance_criteria"], DECLARED.kinds["acceptance_test"], DECLARED.kinds["task_test"]]).toEqual(["criterion", "test", "proof"]);
    const drawn = treeBranches([node("acceptance_criteria", 5)]);
    expect([drawn.includes(`<span class="kind">criterion</span>`), drawn.includes("acceptance_criteria<")]).toEqual([true, false]);
    // The word is the file's: restate it and the row moves. Take it away and the record answers.
    for (const [from, to, said] of [["    acceptance_criteria: criterion", "    acceptance_criteria: rule", "rule"],
      ["    acceptance_criteria: criterion\n", "", "acceptance_criteria"]] as const)
      expect(treeBranches([node("acceptance_criteria", 5)], undefined, loadUi(ui(from, to))), said).toContain(`<span class="kind">${said}</span>`);
    for (const [from, to, said] of [["  kinds:\n", "  absent:\n", /tree\.kinds names no level/],
      ["    story: story", "    story:", /tree\.kinds\.story says nothing/]] as const) for (const t of [TreeUiError, said]) expect(() => loadUi(ui(from, to)), from).toThrow(t);
  });
  // One row, one line: nothing sits between a row and the next, which keeps one rail touching the next.
  it("draws the whole of a long record, carries it in title, and spends no fold", () => {
    const body = treeBranches([node("acceptance_criteria", 5, { label: long })]);
    expect(rowOf(body, "acceptance_criteria", 5)).toContain(`<span class="label" title="${long}">${long}</span>`);
    const parent = treeBranches([node("story", 4, { label: long, children: [node("task", 8)] })]);
    for (const b of [body, parent])
      for (const g of [`class="more"`, "tree.node.more", `class="rest"`]) expect(b, g).not.toContain(g);
    expect([parent.includes(`</span></summary><ul>`), body.includes(`</span></div></li>`)]).toEqual([true, true]);
  });
});

/** The frame is the shell's, the wiring the file: under `pages/`, at `/tree`, unnamed in `bin.ts`. */
describe("the page is served in the shell, and the surface routes it", () => {
  const BIN = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");
  const PAGES = fileURLToPath(new URL("../src/pages", import.meta.url));
  /** The form is the whole of the filter, so it is pressed against a running surface: the page
   *  that arrives is read, its submit is submitted, and the address it names is fetched. */
  it("answers /tree in the shell, narrowed by the query and by pressing its own submit", async () => {
    let nodes: readonly Node[] = [node("story", 11, { label: "wemail", state: "dropped" }), WHOLE];
    const server = await serve({ "/tree": treeAt(() => nodes) }); servers.push(server);
    const res = await fetch(`${addressOf(server)}/tree?show=all`);
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
    const body = await res.text();
    expect([body.startsWith("<!doctype html>"), body.includes("<title>wecode</title>")]).toEqual([true, true]);
    // Its tree is inside the shell's one element, narrowed by the answer the query named.
    expect(body.slice(body.indexOf("<main>"), body.indexOf("</main>"))).toContain(`<li id="task-8" `);
    expect([body.includes(`<li id="story-11" data-ui="tree.node">`), body === treePage(nodes, at("?show=all")).body]).toEqual([true, true]);
    // The arriving page is narrowed; its own submit, pressed with the other answer picked, is
    // the address that widens it — and the widened page's form narrows it back again.
    const arrived = await (await fetch(`${addressOf(server)}/tree`)).text();
    expect([arrived.includes(`<li id="story-11"`), submits(arrived, "all")]).toEqual([false, "/tree?project=all&show=all"]);
    const widened = await (await fetch(`${addressOf(server)}${submits(arrived, "all")}`)).text();
    expect([widened === body, submits(widened, "open")]).toEqual([true, "/tree?project=all&show=open"]);
    expect(await (await fetch(`${addressOf(server)}${submits(widened, "open")}`)).text()).not.toContain(`<li id="story-11"`);
    // Work moves without anybody reloading, so the record is read again on every request.
    nodes = [];
    expect(await (await fetch(`${addressOf(server)}/tree`)).text()).toContain("nothing in the record yet");
  });
  it("binds /tree to the page, and is named in bin.ts no more than the board is", async () => {
    expect(discovered(readdirSync(PAGES))).toContain("tree");
    expect([pathOf("tree"), pathOf("board")]).toEqual(["/tree", "/"]);
    const record = node("story", 1, { label: "the whole record" });
    const module = (await import("../src/pages/tree.js")) as Record<string, unknown>;
    const routes = { [pathOf("tree")]: mounted("tree", module, { record: () => [record] }) };
    const reply = answer(routes, "GET", "/tree");
    expect([reply.status, reply.body.includes("the whole record")]).toEqual([200, true]);
    expect([BIN.includes("treeAt"), BIN.includes("pages/tree")]).toEqual([false, false]);
  });
});
