/** The whole tree as one outline — see docs/design/16. The boxes each answer one question
 *  about the work; this answers where a row sits in the work, which no filter can.
 *
 *  It is one box, not a stack of screens: folding is a set of node keys held by the
 *  screen, so opening a project and closing it again is two keystrokes rather than a
 *  descent and five escs back out. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Text } from "ink";
import type { Node, StatefulEntity } from "@wecode/core";
import type { App } from "./app.js";
import { clip, columnWidths, List, type Row } from "./list.js";
import { COLUMNS, Panel } from "./screens.js";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));

/** A border costs a column each side. */
const BORDER = 2;

/** Two spaces of indent per level: deep enough to read, cheap enough that a task_test at
 *  depth nine still has its label on the screen. */
const INDENT = "  ";

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
      const detail = [n.entity, isNext ? "next to run" : "", rollup(n)].filter((s) => s !== "");
      out.push({
        row: {
          id: n.id,
          what: `${INDENT.repeat(depth)}${marker} ${n.label}`,
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

/** One box, titled with its count and the letter that opens it, holding every visible row
 *  at one set of column widths so the ids and states line up down the whole tree. */
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
      title={`${OUTLINE.title} (${rows.length})`}
      letter={OUTLINE.key}
      width={width}
      height={height}
    >
      {rows.length === 0 ? (
        <Text wrap="truncate">{clip(OUTLINE.empty, inner)}</Text>
      ) : (
        <List
          rows={rows}
          columns={COLUMNS}
          height={height - BORDER}
          cursor={app.cursor}
          width={inner}
          widths={columnWidths(rows, COLUMNS)}
        />
      )}
    </Panel>
  );
}
