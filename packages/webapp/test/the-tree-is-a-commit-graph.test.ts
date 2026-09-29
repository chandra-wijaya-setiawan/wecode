/** The tree page drawn the way a commit graph draws history, proven off the served `/tree`.
 *
 *  Sketch #7 — `~/.wecode/workspaces/cws/sketches/the-tree-you-can-read.html`, signed in review
 *  — settles both the shape and the measurements, and it took the measurements from VS Code's
 *  own graph (`scmHistory.ts`): a lane every 11px, a row 22px tall, the node a disc of radius 4
 *  at the middle of the row, and a corner of radius 5 where a lane turns down. Those four
 *  numbers are the whole geometry and they are asserted as numbers here, because a rail drawn
 *  to a different density is a different drawing however well it reads in isolation.
 *
 *  What the sketch draws, and what is checked below, is a graph and not a file tree. A file
 *  tree reaches sideways out of a vertical to each child. A graph branches: the line leaves the
 *  parent's node going right, turns down, and becomes a lane its children are threaded on — so
 *  a child is a node sitting on a line rather than a stub hanging off a phantom vertical, and
 *  the lane stops at the last row on it instead of running on into nothing. A row's depth is
 *  which lane it sits in; nothing here reads an indent.
 *
 *  Four claims, one `describe` each: every row holds one rail carrying exactly one node, at the
 *  lane its depth puts it on; a row with children emits one elbow into the next lane and the
 *  row under it carries that lane; a lane is drawn only as far as the last node on it; and with
 *  the requirement rung folded away a story's criteria are drawn on the story's own lane rather
 *  than leaving a lane with nothing threaded on it.
 *
 *  The markup is read off a real server rather than off `treeSection`, because the claim is
 *  about what a reader is sent. The nodes are hand-made, for the reason the rest of this
 *  package's page tests make theirs: what is held here is the drawing, and that the tree is the
 *  record's shape is `@wecode/core`'s, tested where it lives. Which rungs are drawn is the
 *  design's, so folding the requirement rung away is done by editing a copy of the file that
 *  declares it and never by a literal agreeing with one. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, serve } from "../src/index.js";
import { type Levels, loadLevels, shown, treeAt } from "../src/pages/tree.js";

/** The geometry, read off sketch #7. `LANE` is the gap between one lane and the next, `ROW` the
 *  height of a row, `NODE` the radius of the disc on it and `CORNER` the radius of the turn a
 *  lane makes coming out of its parent's node. The node sits at the middle of the row. */
const LANE = 11;
const ROW = 22;
const NODE = 4;
const CORNER = 5;
const MID = ROW / 2;

/** The record the page is given. Two stories so the outermost lane has a first row and a last
 *  one that are not the same row; two requirements under the first so a lane is once carried
 *  past a row and once ended on it; two tasks under one criterion and none under the other, so
 *  a row with children and a leaf are both drawn at the same depth. Every id is distinct from
 *  every other, across levels as well as within one: a fixture where a story and its
 *  requirement are both #1 cannot tell a row's own lane from its parent's. */
const NONE: Rollup = { done: 0, open: 0, failed: 0 };
const node = (entity: string, id: number, children: readonly Node[] = []): Node =>
  ({ entity, id, label: `${entity} ${id}`, state: "in_progress", children, rollup: NONE, folded: false });
const TREE: readonly Node[] = [
  node("story", 1, [
    node("requirement", 2, [node("acceptance_criteria", 3, [node("task", 4), node("task", 5)])]),
    node("requirement", 6, [node("acceptance_criteria", 7)]),
  ]),
  node("story", 8),
];

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((done) => s.close(done)); });

/** The page as a reader is sent it. `show=all` so the filter narrows nothing and every row of
 *  the fixture reaches the markup — what is being read here is the rail, not the filter. */
async function served(levels?: Levels): Promise<string> {
  const server = await serve({ "/tree": treeAt(() => TREE, levels) });
  servers.push(server);
  return await (await fetch(`${addressOf(server)}/tree?show=all`)).text();
}

/** The design with the requirement rung put back into what the web tree draws, read out of an
 *  edited copy of the file that declares it. The tree leaves it out by default — 502 of 583
 *  requirements hold exactly one criterion — so showing it is the edit, not hiding it. */
const DESIGN = fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url));
const OMITS = "        omits: [project, release, epic, requirement, task_test]";
function withRequirements(): Levels {
  const text = readFileSync(DESIGN, "utf8");
  expect(text, "the design no longer declares web.omits as this test edits it").toContain(OMITS);
  const said = join(mkdtempSync(join(tmpdir(), "wecode-rail-")), "design.yaml");
  writeFileSync(said, text.replace(OMITS, "        omits: [project, release, epic, task_test]"));
  return loadLevels(said);
}

type Pt = readonly [number, number];
/** One straight run or one arc of a path, with where it began and where it ended, and — when it
 *  is an arc — its two radii and which way it sweeps. Read as geometry rather than as a string,
 *  so a rail drawn to the sketch passes however the `d` is spaced, and one drawn to other
 *  measurements never does. */
interface Seg { readonly from: Pt; readonly to: Pt; readonly arc: readonly number[] | null }
const TAKES: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, A: 7 };
function segments(d: string): readonly Seg[] {
  const out: Seg[] = [];
  let [x, y] = [0, 0];
  for (const m of d.matchAll(/([MLHVA])\s*([-\d.,\s]*)/gi)) {
    const cmd = (m[1] as string).toUpperCase();
    const rel = m[1] !== cmd;
    const n = ((m[2] as string).match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const take = TAKES[cmd] as number;
    expect(n.length > 0 && n.length % take === 0, `${cmd} of "${d}" takes ${take} numbers`).toBe(true);
    for (let i = 0; i < n.length; i += take) {
      const a = n.slice(i, i + take);
      const from: Pt = [x, y];
      if (cmd === "H") x = (rel ? x : 0) + (a[0] as number);
      else if (cmd === "V") y = (rel ? y : 0) + (a[0] as number);
      else {
        x = (rel ? x : 0) + (a[take - 2] as number);
        y = (rel ? y : 0) + (a[take - 1] as number);
      }
      if (cmd === "M" && i === 0) continue;
      // An arc keeps its two radii and its sweep flag: which way a corner turns is the
      // difference between a lane arching over toward its parent's node and one sagging away.
      out.push({ from, to: [x, y], arc: cmd === "A" ? [a[0] as number, a[1] as number, a[4] as number] : null });
    }
  }
  return out;
}

/** A vertical the rail draws, as the lane it is: which lane, and between which two heights. */
interface Lane { readonly x: number; readonly y0: number; readonly y1: number }
/** One row's rail: the box it is drawn in, its one node, the lanes it carries and the elbows it
 *  emits. That it is one `<svg>` holding exactly one `<circle>` is asserted here, because every
 *  reading below depends on it and a row with two nodes is not a row of a graph. */
interface Rail {
  readonly box: Record<string, string>;
  readonly node: Record<string, string>;
  readonly lanes: readonly Lane[];
  readonly elbows: readonly (readonly Seg[])[];
}
const attrs = (s: string): Record<string, string> =>
  Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1] as string, m[2] as string]));
const num = (of: Record<string, string>, key: string): number => Number(of[key]);

function railOf(row: string, at: string): Rail {
  const svgs = [...row.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)];
  expect(svgs.length, `row ${at} holds ${svgs.length} rails, not one`).toBe(1);
  const [, open, inner] = svgs[0] as RegExpMatchArray;
  const circles = [...(inner as string).matchAll(/<circle\b([^>]*?)\/?>/g)];
  expect(circles.length, `row ${at} holds ${circles.length} nodes, not one`).toBe(1);
  const lanes: Lane[] = [];
  const elbows: (readonly Seg[])[] = [];
  for (const p of (inner as string).matchAll(/<path\b([^>]*?)\/?>/g)) {
    const segs = segments(attrs(p[1] as string)["d"] ?? "");
    const one = segs[0];
    if (segs.length === 1 && one && one.arc === null && one.from[0] === one.to[0]) {
      lanes.push({ x: one.from[0], y0: Math.min(one.from[1], one.to[1]), y1: Math.max(one.from[1], one.to[1]) });
      continue;
    }
    // Anything else must be the elbow, which is three runs: out, round, down.
    expect(segs.map((s) => s.arc !== null), `row ${at} draws a path that is neither a lane nor an elbow`)
      .toEqual([false, true, false]);
    elbows.push(segs);
  }
  return { box: attrs(open as string), node: attrs((circles[0] as RegExpMatchArray)[1] as string), lanes, elbows };
}

/** Every row of the page, in the order the document holds them, each with its own markup and
 *  none of its descendants' — a row's own ends where the list of what hangs under it begins. */
const rows = (body: string): readonly (readonly [string, string])[] =>
  [...body.matchAll(/<li id="([^"]+)" data-ui="tree\.node">/g)].map((m) => {
    const rest = body.slice((m.index as number) + (m[0] as string).length);
    const ends = ["<ul>", "</li>"].map((t) => rest.indexOf(t)).filter((i) => i > -1);
    return [m[1] as string, rest.slice(0, Math.min(...ends))] as const;
  });

/** What the sketch draws for one row: which lane its node sits in, which lanes the rail carries
 *  and between which heights, and which lane its elbow makes. Stated once, walked over the tree
 *  the page is actually drawing, so every row is checked and not only the ones named below.
 *
 *  A lane is drawn on a row from the top of the row unless nothing above feeds it, which is
 *  true only of the first row of the outermost lane — every other lane is begun by the elbow on
 *  the row above it. It is drawn to the bottom of the row unless the row is the last on it, in
 *  which case it stops at the node. An ancestor's lane is carried past a row only while that
 *  ancestor still has a row to come; once it has ended it is not redrawn lower down. */
interface Drawn {
  readonly at: string;
  readonly depth: number;
  readonly x: number;
  readonly lanes: readonly Lane[];
  readonly elbow: number | null;
}
function asSketched(ns: readonly Node[], above: readonly number[] = [], depth = 0): readonly Drawn[] {
  return ns.flatMap((n, i) => {
    const x = LANE * (depth + 1);
    const last = i === ns.length - 1;
    const mine: Lane = { x, y0: depth === 0 && i === 0 ? MID : 0, y1: last ? MID : ROW };
    return [
      { at: `${n.entity}-${n.id}`, depth, x,
        lanes: [...above.map((a) => ({ x: a, y0: 0, y1: ROW })), mine],
        elbow: n.children.length > 0 ? x + LANE : null },
      ...asSketched(n.children, last ? above : [...above, x], depth + 1),
    ];
  });
}

/** The page and what the sketch says it should be, side by side and in step. */
async function drawing(levels?: Levels): Promise<readonly (readonly [Drawn, Rail])[]> {
  const body = await served(levels);
  const want = asSketched(shown(TREE, levels ?? loadLevels()));
  const got = rows(body);
  expect(got.map(([at]) => at), "the page draws other rows than the record gave it").toEqual(want.map((w) => w.at));
  return want.map((w, i) => [w, railOf((got[i] as readonly [string, string])[1], w.at)] as const);
}
/** Which lanes have a node on them, and which are drawn at all, across a whole page. */
const spread = (page: readonly (readonly [Drawn, Rail])[]) => [
  [...new Set(page.flatMap(([, r]) => r.lanes.map((l) => l.x)))].sort((a, b) => a - b),
  [...new Set(page.map(([, r]) => num(r.node, "cx")))].sort((a, b) => a - b),
];

describe("every row of the tree carries exactly one node, drawn on a lane", () => {
  // One rail, one node, and the node on the lane its depth puts it in — the box is one lane
  // wider than the node so there is room for the lane the row may branch into, which is what
  // makes the rail's width the reading of its depth.
  it("draws one rail holding one node a row, at the lane its depth puts it on", async () => {
    const page = await drawing();
    expect(page.length, "the fixture draws no rows").toBe(6);
    for (const [w, rail] of page) {
      const wide = LANE * (w.depth + 2);
      expect([rail.box["width"], rail.box["height"], rail.box["viewBox"]], w.at)
        .toEqual([`${wide}`, `${ROW}`, `0 0 ${wide} ${ROW}`]);
      expect([num(rail.node, "cx"), num(rail.node, "cy"), num(rail.node, "r")], w.at)
        .toEqual([w.x, MID, NODE]);
      // The node is a node on a line and never a dot beside one: the row's own lane runs
      // through it, whichever way that lane is going.
      expect(rail.lanes.some((l) => l.x === w.x && l.y0 <= MID && l.y1 >= MID),
        `${w.at}: the node at ${num(rail.node, "cx")} sits on no lane the row draws`).toBe(true);
    }
    // Three rungs in this fixture, three lanes, 11px apart — and no lane drawn anywhere that
    // nothing sits on. The requirement is not one of them, so the tasks come in at 33.
    expect(spread(page)).toEqual([[11, 22, 33], [11, 22, 33]]);
  });
});

describe("a lane leaves its parent's node going right, turns down, and carries its children", () => {
  // Out of the node horizontally, round a corner of 5, into the next lane vertically — the
  // straight runs meet the bend the other way round, which is what makes it arch over toward
  // the lane rather than sag away from it.
  it("emits one elbow a parent, into the next lane, and threads the row under it on that lane", async () => {
    const page = await drawing();
    for (const [i, [w, rail]] of page.entries()) {
      expect(rail.elbows.length, `${w.at} draws ${rail.elbows.length} elbows`).toBe(w.elbow === null ? 0 : 1);
      if (w.elbow === null) continue;
      const [right, bend, down] = rail.elbows[0] as readonly Seg[];
      expect([(right as Seg).from, (right as Seg).to], `${w.at} does not leave its node going right`)
        .toEqual([[w.x, MID], [w.elbow - CORNER, MID]]);
      expect([(bend as Seg).arc, (bend as Seg).to], `${w.at} does not turn on a corner of ${CORNER}`)
        .toEqual([[CORNER, CORNER, 1], [w.elbow, MID + CORNER]]);
      expect([(down as Seg).arc, (down as Seg).to], `${w.at} does not run down into the next lane`)
        .toEqual([null, [w.elbow, ROW]]);
      // The row under it is its first child, its node on the lane the elbow has just made, and
      // the lane picked up at the top of that row where the elbow left it at this row's bottom.
      const [kid, under] = page[i + 1] as readonly [Drawn, Rail];
      expect([kid.x, num(under.node, "cx")], `${w.at} branches a lane nothing is on`)
        .toEqual([w.elbow, w.elbow]);
      const carried = under.lanes.filter((l) => l.x === w.elbow);
      expect(carried.length, `${kid.at} does not carry lane ${w.elbow}`).toBe(1);
      expect((carried[0] as Lane).y0, `${kid.at} does not pick the lane up where the elbow left it`).toBe(0);
    }
    // A row with nothing under it branches nothing: the leaves are the two here that have none.
    expect(page.filter(([, r]) => r.elbows.length === 0).map(([w]) => w.at))
      .toEqual(["task-4", "task-5", "acceptance_criteria-7", "story-8"]);
  });
});

describe("a lane stops at the last row on it rather than running on into nothing", () => {
  it("draws a lane down to the node on its last row, and the whole row on every other", async () => {
    const page = await drawing();
    for (const [w, rail] of page) {
      expect([...rail.lanes].sort((a, b) => a.x - b.x), `${w.at} carries other lanes than the sketch`)
        .toEqual([...w.lanes].sort((a, b) => a.x - b.x));
    }
    const lane = (at: string, x: number): Lane | undefined =>
      (page.find(([w]) => w.at === at) as readonly [Drawn, Rail])[1].lanes.find((l) => l.x === x);
    // Spelled out at the lane gap the sketch uses, so the numbers are asserted and not only the
    // shape: the last task on the task lane draws it to its node and stops; the one above it
    // carries the lane the full height of the row.
    expect(lane("task-5", 33)).toEqual({ x: 33, y0: 0, y1: 11 });
    expect(lane("task-4", 33)).toEqual({ x: 33, y0: 0, y1: 22 });
    // The outermost lane at both ends: the last story ends it, and the first story begins it at
    // its own node, because no elbow above fed it and a lane out of nothing reads as a lane
    // whose parent has scrolled off.
    expect(lane("story-8", 11)).toEqual({ x: 11, y0: 0, y1: 11 });
    expect(lane("story-1", 11)).toEqual({ x: 11, y0: 11, y1: 22 });
    // Both criteria hang off the story now that the requirement between them is not drawn, so
    // criterion 3 is not the last on its lane: it carries it the full height, the two tasks
    // under it carry it on, and criterion 7 is the one that ends it at its own node.
    expect(lane("acceptance_criteria-3", 22)).toEqual({ x: 22, y0: 0, y1: 22 });
    for (const at of ["task-4", "task-5"])
      expect(lane(at, 22), `${at} drops a lane that is still live`).toEqual({ x: 22, y0: 0, y1: 22 });
    expect(lane("acceptance_criteria-7", 22)).toEqual({ x: 22, y0: 0, y1: 11 });
    // And the story's own lane is carried past every row under it, at the full height, until
    // the last story ends it.
    expect(lane("task-4", 11)).toEqual({ x: 11, y0: 0, y1: 22 });
    expect(lane("acceptance_criteria-7", 11)).toEqual({ x: 11, y0: 0, y1: 22 });
  });
});

describe("hiding the requirement rung moves its criteria onto the story's own lane", () => {
  // The rung is hidden by the design and not by the page, so this is the design edited — and
  // what a criterion then sits on is the lane the story's own elbow makes, one lane in from
  // where it was, with everything under it coming in a lane too.
  it("draws a criterion on the lane the story branches, and leaves no lane with nothing on it", async () => {
    const [wide, narrow] = [await drawing(withRequirements()), await drawing()];
    expect(narrow.map(([w]) => w.at), "the requirement rung is drawn by default")
      .not.toContain("requirement-2");
    expect(wide.map(([w]) => w.at), "putting the rung back does not draw it")
      .toContain("requirement-2");
    expect(narrow.map(([w]) => w.at))
      .toEqual(["story-1", "acceptance_criteria-3", "task-4", "task-5", "acceptance_criteria-7", "story-8"]);
    const cx = (page: readonly (readonly [Drawn, Rail])[], at: string): number =>
      num((page.find(([w]) => w.at === at) as readonly [Drawn, Rail])[1].node, "cx");
    const rail = (at: string): Rail => (narrow.find(([w]) => w.at === at) as readonly [Drawn, Rail])[1];
    // Shown, a criterion is a lane out from its requirement; folded away, it is on the story's.
    expect([cx(wide, "acceptance_criteria-3"), cx(wide, "task-4")]).toEqual([LANE * 3, LANE * 4]);
    expect([cx(narrow, "acceptance_criteria-3"), cx(narrow, "acceptance_criteria-7")])
      .toEqual([LANE * 2, LANE * 2]);
    expect([cx(narrow, "task-4"), cx(narrow, "story-1")]).toEqual([LANE * 3, LANE]);
    // The story's elbow still makes exactly one lane, and that is the lane the criterion is on.
    const [story] = rail("story-1").elbows;
    expect(((story as readonly Seg[])[2] as Seg).to, "the story branches somewhere else").toEqual([LANE * 2, ROW]);
    expect(rail("acceptance_criteria-3").lanes.filter((l) => l.x === LANE * 2))
      .toEqual([{ x: LANE * 2, y0: 0, y1: ROW }]);
    // Three rungs drawn, three lanes, and a node on every one of them: the rung that went away
    // took its lane with it rather than leaving an empty one indented where it used to be.
    expect(spread(narrow)).toEqual([[11, 22, 33], [11, 22, 33]]);
    expect(rail("acceptance_criteria-3").box["width"], "the rail is still as wide as the rung it lost")
      .toBe(`${LANE * 3}`);
  });
});
