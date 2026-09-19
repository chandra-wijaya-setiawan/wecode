/** The whole tree as one outline — see docs/design/16. The boxes each answer one question
 *  about the work; this answers where a row sits in the work, which no filter can.
 *
 *  It is one box, not a stack of screens: folding is a set of node keys held by the
 *  screen, so opening a project and closing it again is two keystrokes rather than a
 *  descent and five escs back out. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Box, Text } from "ink";
import { STATEFUL, type Node, type StatefulEntity } from "@wecode/core";
import type { App } from "./app.js";
import { clip, stateColour, type Line, type Row } from "./list.js";
import { Panel } from "./screens.js";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));

/** A border costs a column each side. */
const BORDER = 2;

/** Two columns of indent per level: deep enough to read, cheap enough that a task_test at
 *  depth nine still has its label on the screen. The connectors are drawn inside that same
 *  budget rather than on top of it, so a level that reads at a glance costs no label width. */
export const INDENT = 2;

/** The tee a row hangs off its parent by, and the elbow the last of the siblings hangs off
 *  instead. That difference is the whole point: a bare indent has to be counted to know
 *  which level a row is on, and a branch that visibly closes does not. */
const TEE = "├─";
const ELBOW = "└─";

/** Under an ancestor that still has siblings to come the branch keeps going, so its column
 *  carries a rail; under the last of them there is nothing below and the column is blank. */
const RAIL = "│ ";
const CLEAR = "  ";

/** A row's guide columns, one per level above it, ending in its own connector.
 *
 *  `closed` runs from the level under the roots down to this row, and says at each level
 *  whether that node was the last of its siblings. The roots are left out and drawn flush:
 *  sibling roots are separate trees rather than one branch, so nothing hangs off a root and
 *  no column of the screen belongs to it. */
export function connector(closed: readonly boolean[]): string {
  if (closed.length === 0) return "";
  const rails = closed.slice(0, -1).map((last) => (last ? CLEAR : RAIL));
  return `${rails.join("")}${closed[closed.length - 1] ? ELBOW : TEE}`;
}

/** The repeating columns the outline can draw, beside the tree itself. Order is config's;
 *  the names are the code's, so a column the config asks for either draws or fails to load. */
export const OUTLINE_COLUMNS = ["tree", "id", "type", "state"] as const;
export type OutlineColumn = (typeof OUTLINE_COLUMNS)[number];

export interface OutlineConfig {
  readonly title: string;
  readonly key: string;
  /** The entity the outline is folded to when it opens. */
  readonly depth: string;
  readonly empty: string;
  /** Left to right, what the line is made of. */
  readonly columns: readonly OutlineColumn[];
  /** How many characters the type and the state each get. */
  readonly abbreviate: number;
  /** The words a plain cut would not tell apart, shortened by hand. */
  readonly abbreviations: Readonly<Record<string, string>>;
}

export class OutlineError extends Error {}

/** Title, key and fold depth are data, and they live beside the boxes' own. A key here
 *  that no bar draws is a screen with no way in, so the bar reads it from this too. */
export function loadOutline(path: string = CONFIG): OutlineConfig {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  const top = (raw ?? {}) as Record<string, unknown>;
  const o = top["outline"];
  if (o === null || typeof o !== "object") throw new OutlineError("views.yaml declares no outline");
  const v = o as Record<string, unknown>;
  const key = v["key"];
  if (typeof key !== "string" || key.length !== 1) {
    throw new OutlineError(`outline.key must be one letter, not ${String(key)}`);
  }
  return {
    title: typeof v["title"] === "string" ? v["title"] : "Outline",
    key,
    depth: typeof v["depth"] === "string" ? v["depth"] : "story",
    empty: typeof v["empty"] === "string" ? v["empty"] : "-",
    columns: columnsOf(v["columns"]),
    abbreviate: typeof v["abbreviate"] === "number" ? v["abbreviate"] : 4,
    abbreviations: wordsOf(v["abbreviations"]),
  };
}

/** The declared order, checked against the names this file draws. An unknown column is a
 *  line the code cannot compose, and failing to load says so where it can be fixed. */
function columnsOf(raw: unknown): readonly OutlineColumn[] {
  if (raw === undefined) return OUTLINE_COLUMNS;
  if (!Array.isArray(raw)) throw new OutlineError("outline.columns must be a list");
  return raw.map((c) => {
    if (!OUTLINE_COLUMNS.includes(c as OutlineColumn)) {
      throw new OutlineError(`outline.columns names no column ${String(c)}`);
    }
    return c as OutlineColumn;
  });
}

const wordsOf = (raw: unknown): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [word, short] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof short === "string") out[word] = short;
  }
  return out;
};

export const OUTLINE: OutlineConfig = loadOutline();

/** A node's identity across a refresh. Two entities share an id freely, so the entity is
 *  half of the key. */
export const nodeKey = (n: Node): string => `${n.entity}#${n.id}`;

/** How much of the tree the outline is drawing. `all` is every row there is; `open` is the
 *  work still owed and the rows it hangs under. */
export type OutlineScope = "open" | "all";

/** What each scope is called on the screen, because a narrowed outline that looks like the
 *  whole one is a screen that lies about what is left. */
export const SCOPE_LABEL: Readonly<Record<OutlineScope, string>> = {
  open: "open work",
  all: "all work",
};

/** How the box's title says which scope it is in. Only the narrowed one is named: `all` is
 *  what the outline means unqualified, and a title that said so on every screen would spend
 *  columns to tell you that nothing is being hidden. The exception is what needs saying. */
export const scopeTitle = (scope: OutlineScope, count: number): string =>
  scope === "all"
    ? `${OUTLINE.title} (${count})`
    : `${OUTLINE.title} — ${SCOPE_LABEL[scope]} (${count})`;

/** The letter each scope is asked for by, after `f`. */
export const SCOPE_KEYS: ReadonlyMap<string, OutlineScope> = new Map([
  ["o", "open"],
  ["a", "all"],
]);

/** States nothing is owed in: the landed terminal of every machine in
 *  config/machines.yaml, plus `dropped`.
 *
 *  `failed` is deliberately absent. A failed test is work still owed — the same reading
 *  delivered.ts takes — so narrowing to open work must keep it, or the one screen you go
 *  to for what is left would hide the rows that most need you. */
const SETTLED: ReadonlySet<string> = new Set([
  "released",
  "delivered",
  "met",
  "accepted",
  "passed",
  "done",
  "dropped",
]);

/** Whether this row is itself work still owed, ignoring what hangs under it. */
export const isOpenWork = (n: Node): boolean => !SETTLED.has(n.state);

/** What an empty *narrowed* outline says. `outline.empty` in views.yaml cannot serve: it
 *  tells you to create a project, and here the projects exist and are finished. It belongs
 *  beside that one in the config, which this story's scope does not reach. */
export const NOTHING_OPEN = "no open work — everything here has landed or been dropped";

/** A row drawn where its own parent is not. The flag rides on the node rather than beside
 *  it because `openWork` hands the forest straight to the folding and the rows, and a set
 *  kept alongside would have to be threaded through every one of them. */
interface Rooted extends Node {
  readonly orphaned?: boolean;
}

/** Whether this row was lifted out from under a settled parent. */
export const isOrphan = (n: Node): boolean => (n as Rooted).orphaned === true;

/** What the screen calls such a row. Narrowing to open work is read for what is left, and a
 *  row silently promoted a level would answer "where does this sit" with a lie; the word is
 *  the outline admitting it moved the row rather than hiding that it did. */
export const ORPHANED = "orphaned";

/** The forest with the settled work cut out of it — all of it, including the rows open work
 *  hangs under. A landed parent is not work still owed, and keeping it to host its children
 *  is the narrowing showing you the very rows you asked it to drop.
 *
 *  What hangs under a cut row is lifted into its place, in its order, so nothing open is
 *  lost with the parent. The lifted rows are marked `orphaned`, because that is the one
 *  thing the tree can no longer tell you: the guide beside them now draws a parent that is
 *  not theirs. */
export function openWork(forest: readonly Node[]): readonly Node[] {
  const lift = (nodes: readonly Node[]): Node[] =>
    nodes.flatMap((n) => {
      const children = lift(n.children);
      if (isOpenWork(n)) return [{ ...n, children }];
      // Already an orphan stays one: it is lifted again, not re-parented.
      return children.map((c): Rooted => ({ ...c, orphaned: true }));
    });
  return lift(forest);
}

/** The keys expanded when the outline opens: everything above the level it folds to. The
 *  level itself is shown and its children are not, which is what folded *to* means. */
export function foldedTo(forest: readonly Node[], entity: string): ReadonlySet<string> {
  const keys = new Set<string>();
  const walk = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      if (n.entity === entity) continue;
      keys.add(nodeKey(n));
      walk(n.children);
    }
  };
  walk(forest);
  return keys;
}

/** What is behind a folded row: how much hangs under it, and in what states. A project
 *  row that says only `in_progress` has told you nothing you did not know from it being
 *  on the board, and the whole point of a folded row is that it answers without opening. */
export function rollup(node: Node): string {
  const tally = new Map<string, number>();
  let under = 0;
  const walk = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      under += 1;
      tally.set(n.state, (tally.get(n.state) ?? 0) + 1);
      walk(n.children);
    }
  };
  walk(node.children);
  if (under === 0) return "";
  const states = [...tally]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([state, n]) => `${n} ${state}`);
  return [`${under} under`, ...states].join(" · ");
}

/** How far down the tree goes, counted in levels of children below the roots. */
export function treeDepth(forest: readonly Node[]): number {
  let deepest = 0;
  const walk = (nodes: readonly Node[], depth: number): void => {
    for (const n of nodes) {
      if (depth > deepest) deepest = depth;
      walk(n.children, depth + 1);
    }
  };
  walk(forest, 0);
  return deepest;
}

/** Every key above `depth`, so the outline stands open exactly that far and no further.
 *  Depth 0 is the roots alone; depth 1 is the roots with their children under them.
 *
 *  This is `foldedTo` counted rather than named. The config folds to an entity because a
 *  person says "show me the stories"; the keys move by number because from a story the
 *  next thing you want is one level more, whatever that level happens to be called. */
export function foldedToDepth(forest: readonly Node[], depth: number): ReadonlySet<string> {
  const keys = new Set<string>();
  const walk = (nodes: readonly Node[], at: number): void => {
    if (at >= depth) return;
    for (const n of nodes) {
      // A childless row has nothing to open, and a key on it would make two outlines that
      // draw the same rows compare unequal.
      if (n.children.length === 0) continue;
      keys.add(nodeKey(n));
      walk(n.children, at + 1);
    }
  };
  walk(forest, 0);
  return keys;
}

/** The depth the outline currently stands open to: the deepest row it is drawing.
 *
 *  It is read back off the rows rather than held as a number beside them, because the fold
 *  keys open single nodes too. A number kept alongside would disagree with the screen the
 *  first time someone opened one project by hand, and then a depth keystroke would jump
 *  somewhere nobody asked for. */
export function openDepth(forest: readonly Node[], expanded: ReadonlySet<string>): number {
  let deepest = 0;
  const walk = (nodes: readonly Node[], depth: number): void => {
    for (const n of nodes) {
      if (depth > deepest) deepest = depth;
      if (expanded.has(nodeKey(n))) walk(n.children, depth + 1);
    }
  };
  walk(forest, 0);
  return deepest;
}

/** One depth further in, or one further out — the whole outline at once, which is the
 *  point: a tree read a node at a time is a tree nobody finishes reading.
 *
 *  Both ends are walls, not wraps. Pressing in at the bottom leaves the screen alone; a
 *  fold key that silently jumped back to the roots would lose the reader's place. */
export function atDepth(
  forest: readonly Node[],
  expanded: ReadonlySet<string>,
  by: number,
): ReadonlySet<string> {
  const want = openDepth(forest, expanded) + by;
  return foldedToDepth(forest, Math.min(Math.max(want, 0), treeDepth(forest)));
}

/** A line of the outline: the row as drawn, what it is a row of, and the node behind it so
 *  the fold keys do not have to walk the tree again to find what the cursor is on. */
export interface OutlineLine {
  readonly row: Row;
  readonly entity: StatefulEntity;
  readonly node: Node;
}

/** Every row the folding leaves visible, in the tree's own order.
 *
 *  `next` is the id of the task that will be dispatched next. It is passed in rather than
 *  worked out: the order tasks run in belongs to the allocator, and a second opinion about
 *  it drawn on the screen would be a lie the moment the two disagree. */
export function outlineRows(
  forest: readonly Node[],
  expanded: ReadonlySet<string>,
  next: number | null,
): OutlineLine[] {
  const out: OutlineLine[] = [];
  const walk = (nodes: readonly Node[], closed: readonly boolean[], root: boolean): void => {
    for (const [i, n] of nodes.entries()) {
      const open = expanded.has(nodeKey(n));
      const here = root ? [] : [...closed, i === nodes.length - 1];
      // The fold marker is the key that changes it, so the row says what to press.
      const marker = n.children.length === 0 ? " " : open ? "-" : "+";
      const isNext = next !== null && n.entity === "task" && n.id === next;
      const detail = [
        n.entity,
        isOrphan(n) ? ORPHANED : "",
        isNext ? "next to run" : "",
        rollup(n),
      ].filter((s) => s !== "");
      out.push({
        row: {
          id: n.id,
          what: `${connector(here)}${marker} ${n.label}`,
          state: n.state,
          detail: detail.join(" · "),
        },
        entity: n.entity as StatefulEntity,
        node: n,
      });
      if (open) walk(n.children, here, false);
    }
  };
  walk(forest, [], true);
  return out;
}

/** A word in the columns the config gives it: the hand-written short form where there is
 *  one, and otherwise the word's own first characters. Two spaces between columns; the same
 *  gap the shared list keeps. */
export function abbreviate(word: string, config: OutlineConfig = OUTLINE): string {
  return config.abbreviations[word] ?? word.slice(0, config.abbreviate);
}

const GAP = "  ";

/** The tree cell in its column: the guide flush left, the fold marker flush right, and the
 *  padding the depth did not spend between them.
 *
 *  The column is as wide as the deepest row, so padding it on the right strands a shallow
 *  row's marker whole levels away from the id it belongs to — on the real tree that is a
 *  dozen blank columns between the `+` and the `#`, and the two have to be read as one
 *  thing: the marker says what pressing does to *that* row. The guide is what has to stay
 *  left, because a rail only means anything in the column its parent drew it in. So the
 *  gap goes where nothing is read — inside the row's own indent. */
export function padTree(cell: string, size: number): string {
  if (cell === "") return "".padEnd(size, " ");
  return `${cell.slice(0, -1).padEnd(size - 1, " ")}${cell.slice(-1)}`;
}

/** A detail whose first part is an entity's name is that row's kind, put there by
 *  `outlineRows`; what follows it is the rollup and is nobody's column. */
const KINDS: ReadonlySet<string> = new Set<string>(STATEFUL);

/** The guide and fold marker a row opens with, and the label after them.
 *
 *  `outlineRows` draws the three as one string because the cursor, the search and the fold
 *  keys all read `what`; the columns split it again here, where the connector's characters
 *  are declared. A row with no guide at all still has its marker. */
const GUIDE = new RegExp(`^((?:${RAIL}|${CLEAR}|${TEE}|${ELBOW})*[-+ ]) `);

export function splitTree(what: string): [string, string] {
  const hit = GUIDE.exec(what);
  return hit === null ? ["", what] : [hit[1] ?? "", what.slice(hit[0].length)];
}

/** A row cut into its declared columns, with the prose the columns did not claim last. The
 *  tree cell is the guide and the fold marker alone: a label inside it is a cell as wide as
 *  the longest name in the tree, and the id it pushes right is then read at a different
 *  column on every row. Out of the cell, the label leads the prose — the one part of the
 *  line whose width is nobody's business but its own. */
export function outlineCells(row: Row, config: OutlineConfig = OUTLINE): string[] {
  const parts = row.detail === "" ? [] : row.detail.split(" · ");
  const kind = parts.length > 0 && KINDS.has(parts[0] ?? "") ? parts[0] ?? "" : "";
  const [guide, label] = splitTree(row.what);
  const cell: Readonly<Record<OutlineColumn, string>> = {
    tree: guide,
    id: `#${row.id}`,
    type: kind === "" ? "" : abbreviate(kind, config),
    state: abbreviate(row.state, config),
  };
  const prose = [label, ...parts.slice(kind === "" ? 0 : 1)].filter((s) => s !== "");
  return [...config.columns.map((c) => cell[c]), prose.join(" · ")];
}

/** How wide each declared column has to be to hold every row: one set for the whole tree,
 *  so the columns line up down all of it rather than per screenful. */
export function outlineWidths(rows: readonly Row[], config: OutlineConfig = OUTLINE): number[] {
  const cells = rows.map((r) => outlineCells(r, config));
  return config.columns.map((_, j) => Math.max(...cells.map((c) => (c[j] ?? "").length), 0));
}

/** Rows the height can show, scrolled so the cursor is among them. The shared list does
 *  this arithmetic too, and fixes the column order with it; the outline keeps the order and
 *  pays for the window again. */
function window(count: number, height: number, cursor: number | null): [number, number] {
  if (count <= height) return [0, count];
  // One line goes to the "… and N more" tally.
  const shown = Math.max(height - 1, 0);
  if (cursor === null || cursor < shown) return [0, shown];
  const first = Math.min(cursor - shown + 1, count - shown);
  return [first, first + shown];
}

/** The outline's own lines, in the declared order. It does not go through the shared list
 *  because that list's contract is the code and the state first and the description last —
 *  right for a box of unrelated rows, and for a tree it buries the guide mid-line. */
export function outlineLines(
  rows: readonly Row[],
  height: number,
  cursor: number | null,
  width: number,
  config: OutlineConfig = OUTLINE,
): Line[] {
  if (height <= 0) return [];
  const sizes = outlineWidths(rows, config);
  const [first, last] = window(rows.length, height, cursor);
  const lines = rows.slice(first, last).map((row, i) => ({
    text: clip(
      outlineCells(row, config)
        .map((c, j) =>
          config.columns[j] === "tree" ? padTree(c, sizes[j] ?? 0) : c.padEnd(sizes[j] ?? 0, " "),
        )
        .join(GAP)
        .trimEnd(),
      width,
    ),
    state: row.state,
    cursor: cursor !== null && first + i === cursor,
  }));
  const hidden = rows.length - lines.length;
  if (hidden > 0) lines.push({ text: clip(`… and ${hidden} more`, width), state: "", cursor: false });
  return lines;
}

/** One box, titled with its scope, its count and the letter that opens it, holding every
 *  visible row at one set of column widths so the ids and states line up down the whole
 *  tree.
 *
 *  The scope is in the title rather than only in the status line, because the status line is
 *  the last thing that happened and this is what you are looking at: a narrowed outline is
 *  read for minutes after the keystroke that narrowed it scrolled away. */
export function Outline({
  app,
  width,
  height,
}: {
  readonly app: App;
  readonly width: number;
  readonly height: number;
}) {
  const rows = app.lines();
  const inner = width - BORDER;
  return (
    <Panel
      title={scopeTitle(app.outlineScope, rows.length)}
      letter={OUTLINE.key}
      width={width}
      height={height}
    >
      {rows.length === 0 ? (
        <Text wrap="truncate">
          {clip(app.outlineScope === "open" ? NOTHING_OPEN : OUTLINE.empty, inner)}
        </Text>
      ) : (
        <Box flexDirection="column">
          {outlineLines(rows, height - BORDER, app.cursor, inner).map((line, i) => (
            <Text key={i} wrap="truncate" inverse={line.cursor} color={stateColour(line.state)}>
              {line.text}
            </Text>
          ))}
        </Box>
      )}
    </Panel>
  );
}
