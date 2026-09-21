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
 *  depth nine still has its label on the screen.
 *
 *  It is the whole of what a row spends on its depth. A level is read off the column the
 *  labels line up in — a comparison between rows rather than a count of spaces on one.
 *
 *  Nine levels at two columns is eighteen, and the sentence after them wraps rather than
 *  being cut, so the deepest row still says everything it has to say. */
export const INDENT = 2;

/** A row's indent: that much again for every level above it, and nothing else.
 *
 *  The rail and the tees and elbows that hung each level off the one above are retired.
 *  They said what the indent was already saying, and they said it at two columns a level
 *  on every level above the row — at depth nine that is eighteen columns of the label's
 *  own width spent repeating the label's position.
 *
 *  A root is flush: sibling roots are separate trees rather than one branch, so nothing
 *  hangs off a root and no column of the screen belongs to it. */
export const indentOf = (depth: number): string => " ".repeat(INDENT * depth);

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
  const walk = (nodes: readonly Node[], depth: number): void => {
    for (const n of nodes) {
      const open = expanded.has(nodeKey(n));
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
          what: `${indentOf(depth)}${marker} ${n.label}`,
          state: n.state,
          detail: detail.join(" · "),
        },
        entity: n.entity as StatefulEntity,
        node: n,
      });
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(forest, 0);
  return out;
}

/** A detail whose first part is an entity's name is that row's kind, put there by
 *  `outlineRows`; what follows it is the rollup. */
const KINDS: ReadonlySet<string> = new Set<string>(STATEFUL);

/** The indent and the fold mark a row opens with, and the label after them.
 *
 *  `outlineRows` writes the three as one string because the cursor, the search and the
 *  fold keys all read `what`; the drawing splits it again here, where the indent is
 *  measured. A row at no depth at all still has its mark. */
const HEAD = /^( *)([-+ ]) /;

export interface Head {
  /** Columns of indent in front of the mark: the row's depth, already multiplied out. */
  readonly indent: number;
  readonly marker: string;
  readonly label: string;
}

export function splitHead(what: string): Head {
  const hit = HEAD.exec(what);
  if (hit === null) return { indent: 0, marker: "", label: what };
  const [all, pad, mark] = hit;
  return { indent: (pad ?? "").length, marker: mark ?? "", label: what.slice(all.length) };
}

/** What the parts of a sentence are joined by — the separator the rollup and the rest of
 *  the screen's prose already use, so the whole line reads as one list of things. */
const JOIN = " · ";

/** A row's short identity, said the way every other list says it: a code, not a number. */
export const outlineId = (row: Row): string => `#${row.id}`;

/** The row's kind, lifted out of the detail `outlineRows` wrote it at the head of. A row
 *  whose detail opens with something else has no kind, and says none. */
export function outlineEntity(row: Row): string {
  const first = row.detail === "" ? "" : (row.detail.split(JOIN)[0] ?? "");
  return KINDS.has(first) ? first : "";
}

/** The row as one string, in `outline.row.order`: the label first, because the label is
 *  what the row is, and then its particulars in full words — the id, the kind, the state,
 *  and whatever the detail still had to say, ending in the rollup.
 *
 *  Nothing is padded to anything: a column is as wide as the widest row in the tree, so a
 *  shallow row paid the deepest row's width and bought a line that was mostly blank. A
 *  part with nothing to say is dropped with its separator rather than written empty. */
export function sentence(row: Row): string {
  const parts = row.detail === "" ? [] : row.detail.split(JOIN);
  const kind = outlineEntity(row);
  const rest = kind === "" ? parts : parts.slice(1);
  const { label } = splitHead(row.what);
  return [label, outlineId(row), kind, row.state, ...rest].filter((s) => s !== "").join(JOIN);
}

/** The column the label begins at, and so the column a wrapped line resumes at: past the
 *  indent the row's depth costs, and past the one column the fold mark takes. */
export const labelAt = (head: Head): number => head.indent + head.marker.length + 1;

/** How far a row may run, and what the last line ends in when it had more to say. A row
 *  allowed to run on is a row that can push the rest of the tree off the page. */
const MAX_LINES = 3;
const ELIDE = "…";

/** Break `text` at its spaces into lines of `room` columns. Nothing is dropped here: a
 *  word too wide for a line of its own is broken across lines rather than cut, because
 *  `outline.row.truncate` is false. */
function fold(text: string, room: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length <= room) {
      line = `${line} ${word}`;
      continue;
    }
    if (line !== "") out.push(line);
    line = word;
    while (line.length > room) {
      out.push(line.slice(0, room));
      line = line.slice(room);
    }
  }
  out.push(line);
  return out;
}

/** The lines a row is allowed, ending in the elision when there were more of them. The
 *  elision is the reader's only sign that the row went on, so it is never itself pushed
 *  off the end: a last line with no room for it gives up a character of its own. */
function capped(lines: readonly string[], room: number): string[] {
  if (lines.length <= MAX_LINES) return [...lines];
  const kept = lines.slice(0, MAX_LINES);
  const last = kept[MAX_LINES - 1] ?? "";
  kept[MAX_LINES - 1] =
    last.length < room ? `${last}${ELIDE}` : `${last.slice(0, Math.max(room - 1, 0))}${ELIDE}`;
  return kept;
}

/** One row, drawn as design.yaml declares it: one string, indented by its depth, opening
 *  with the fold mark and then the sentence.
 *
 *  Depth is the indent and nothing else. A reader counting spaces is not what the indent
 *  asks of them — the rows above are indented too, so a level is read off the column the
 *  labels line up in rather than off any one row's width.
 *
 *  A sentence that is cut is not a sentence, so it is not cut: what will not fit continues
 *  on the next line, under where the label began, for three lines at most. */
export function outlineRow(row: Row, width: number): string[] {
  const head = splitHead(row.what);
  const at = labelAt(head);
  const lead = `${" ".repeat(head.indent)}${head.marker} `;
  const text = sentence(row);
  // Too narrow to wrap into is too narrow to draw the row's own shape in at all.
  if (width - at <= 0) return [clip(`${lead}${text}`, width)];
  return capped(fold(text, width - at), width - at).map((line, i) =>
    i === 0 ? `${lead}${line}` : `${" ".repeat(at)}${line}`,
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
 *  its depth drawn as the indent the wrap has to resume under. */
export function outlineLines(
  rows: readonly Row[],
  height: number,
  cursor: number | null,
  width: number,
): Line[] {
  if (height <= 0) return [];
  const drawn = rows.map((row) => outlineRow(row, width));
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
 *  visible row as config/design.yaml declares one: a sentence indented by its depth, led
 *  by the label and followed by the id, the kind, the state and the rollup.
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
