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
import { clip, stateColour, type Line, type Row } from "./list.js";import { Panel } from "./screens.js";

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

export interface OutlineConfig {
  readonly title: string;
  readonly key: string;
  /** The entity the outline is folded to when it opens. */
  readonly depth: string;
  readonly empty: string;
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
  };
}

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

/** A detail whose first part is an entity's name is that row's kind, put there by
 *  `outlineRows`; what follows it is the rollup. */
const KINDS: ReadonlySet<string> = new Set<string>(STATEFUL);

/** The guide and fold marker a row opens with, and the label after them.
 *
 *  `outlineRows` draws the three as one string because the cursor, the search and the fold
 *  keys all read `what`; the drawing splits it again here, where the connector's characters
 *  are declared. A row with no guide at all still has its marker. */
const GUIDE = new RegExp(`^((?:${RAIL}|${CLEAR}|${TEE}|${ELBOW})*[-+ ]) `);

export function splitTree(what: string): [string, string] {
  const hit = GUIDE.exec(what);
  return hit === null ? ["", what] : [hit[1] ?? "", what.slice(hit[0].length)];
}

/** What the parts of a sentence are joined by — the separator the rollup and the rest of
 *  the screen's prose already use, so the whole line reads as one list of things. */
const JOIN = " · ";

/** Two columns between one column and the next, as config/design.yaml writes the row.
 *  A terminal has no rules to lean on, so the gap is the whole of the separation. */
const GAP = "  ";

/** The row's columns, in `outline.row.order`. The three that are scanned lead, in the
 *  order they narrow the tree; the one that varies in width is last. */
export const OUTLINE_ROW = ["id", "entity", "state", "description"] as const;

/** A row's short identity, said the way every other list says it: a code, not a number. */
export const outlineId = (row: Row): string => `#${row.id}`;

/** The row's kind, lifted out of the detail `outlineRows` wrote it at the head of. A row
 *  whose detail opens with something else has no kind to draw and takes a blank cell. */
export function outlineEntity(row: Row): string {
  const first = row.detail === "" ? "" : (row.detail.split(JOIN)[0] ?? "");
  return KINDS.has(first) ? first : "";
}

/** What the description is made of, once the three columns have taken theirs: the label,
 *  and whatever the detail still had to say — the orphan mark, the next task, the rollup.
 *  The guide is not in here; it is a fixed prefix the wrap must not break. */
export function outlineText(row: Row): string {
  const parts = row.detail === "" ? [] : row.detail.split(JOIN);
  const rest = outlineEntity(row) === "" ? parts : parts.slice(1);
  const [, label] = splitTree(row.what);
  return [label, ...rest].filter((s) => s !== "").join(JOIN);
}

/** How wide each of the three fixed columns is: its own longest value, and not a column
 *  more. A width taken from the widest row anywhere is what the description is spared. */
export function outlineWidths(rows: readonly Row[]): readonly number[] {
  const cells = [outlineId, outlineEntity, (r: Row): string => r.state];
  return cells.map((of) => Math.max(...rows.map((r) => of(r).length), 0));
}

/** The column the description begins at, and so the column a wrapped line resumes at. */
export const describedAt = (widths: readonly number[]): number =>
  widths.reduce((n, w) => n + w + GAP.length, 0);

/** Break `text` at its spaces into a first line of `first` columns and the rest of `rest`,
 *  as many lines as it takes. Nothing is dropped: a word too wide for a line of its own is
 *  broken across lines rather than cut, because `outline.row.truncate` is false. */
function fold(text: string, first: number, rest: number): string[] {
  const out: string[] = [];
  let line = "";
  const room = (): number => (out.length === 0 ? first : rest);
  for (const word of text.split(" ").filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length <= room()) {
      line = `${line} ${word}`;
      continue;
    }
    if (line !== "") out.push(line);
    line = word;
    while (line.length > room()) {
      out.push(line.slice(0, room()));
      line = line.slice(room());
    }
  }
  out.push(line);
  return out;
}

/** One row, drawn as design.yaml declares it: the id right-aligned in its column, the kind
 *  and the state left-aligned in theirs, and the description taking whatever is left.
 *
 *  Depth is in the description, as a connector rather than as an indent — a rail exactly
 *  where the branch above is still going, and a tee or an elbow where this row hangs off
 *  it. An indent says the same thing only to a reader willing to count spaces.
 *
 *  A line is a sentence once the three columns are past, so it is not cut: what will not
 *  fit continues on the next line, under where the description began. */
export function outlineRow(row: Row, widths: readonly number[], width: number): string[] {
  const lead =
    [
      outlineId(row).padStart(widths[0] ?? 0),
      outlineEntity(row).padEnd(widths[1] ?? 0),
      row.state.padEnd(widths[2] ?? 0),
    ].join(GAP) + GAP;
  const at = describedAt(widths);
  const [guide] = splitTree(row.what);
  const opens = guide === "" ? "" : `${guide} `;
  const text = outlineText(row);
  // Too narrow to wrap into is too narrow to draw the row's own shape in at all.
  if (width - at - opens.length <= 0) return [clip(`${lead}${opens}${text}`, width)];
  return fold(text, width - at - opens.length, width - at).map((line, i) =>
    i === 0 ? `${lead}${opens}${line}` : `${" ".repeat(at)}${line}`,
  );
}

/** Rows the height can show, scrolled so the cursor is among them. `costs` is how many
 *  lines each row takes, because a wrapped row is worth more than one and a window counted
 *  in rows would draw past the box's own border. */
function window(costs: readonly number[], height: number, cursor: number | null): [number, number] {
  if (costs.reduce((a, b) => a + b, 0) <= height) return [0, costs.length];
  // One line goes to the "… and N more" tally.
  const room = Math.max(height - 1, 0);
  const end = (from: number): number => {
    let used = 0;
    let i = from;
    while (i < costs.length && used + (costs[i] ?? 0) <= room) used += costs[i++] ?? 0;
    // A row taller than the whole box still gets the box: it is drawn as far as it goes
    // and cut there, which is a row the reader can see the start of rather than none.
    return i === from && from < costs.length ? from + 1 : i;
  };
  let first = 0;
  if (cursor !== null) while (first < costs.length && cursor >= end(first)) first += 1;
  return [first, end(first)];
}

/** The outline's own lines. It does not go through the shared list because that list's
 *  contract is one line per row, clipped — and a tree's row is a sentence that wraps, with
 *  its depth drawn in the description the wrap has to keep clear of. */
export function outlineLines(
  rows: readonly Row[],
  height: number,
  cursor: number | null,
  width: number,
): Line[] {
  if (height <= 0) return [];
  const widths = outlineWidths(rows);
  const drawn = rows.map((row) => outlineRow(row, widths, width));
  const [first, last] = window(drawn.map((d) => d.length), height, cursor);
  const lines: Line[] = [];
  for (let i = first; i < last; i += 1) {
    // A wrapped row is one row: every line of it carries the state it is coloured by, and
    // the cursor covers all of it rather than only the line the label started on.
    for (const text of drawn[i] ?? []) {
      lines.push({ text, state: (rows[i] as Row).state, cursor: cursor === i });
    }
  }
  const hidden = rows.length - (last - first);
  // The tally's own line comes off the box before the rows are cut to what is left.
  const budget = hidden > 0 ? Math.max(height - 1, 0) : height;
  if (lines.length > budget) lines.length = budget;
  if (hidden > 0) lines.push({ text: clip(`… and ${hidden} more`, width), state: "", cursor: false });
  return lines;
}

/** One box, titled with its scope, its count and the letter that opens it, holding every
 *  visible row as config/design.yaml declares one: id, kind and state in their own columns,
 *  and then the description with the tree drawn into it.
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
