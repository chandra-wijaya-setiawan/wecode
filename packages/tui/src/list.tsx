/** One reusable list at three sizes — see config/tui-contract.yaml. The arithmetic is the
 *  part worth keeping: Ink lays the boxes out, but what a cell says once it will not fit,
 *  and which rows a height can show, are still decisions this file makes. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Box, Text } from "ink";
import { parse } from "yaml";
import { STATEFUL } from "@wecode/core";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));

export interface Row {
  readonly id: number;
  readonly what: string;
  readonly state: string;
  readonly detail: string;
}

/** The row contract: a code, a state, a description, in that order, on every screen. This
 *  file is the only thing that decides it, so a screen cannot invent its own layout. */
export const COLUMNS = ["code", "state", "description"] as const;

/** The three, plus the names screens used to pass. The old names are still a type so that a
 *  screen naming them compiles; naming any of them changes nothing that is drawn. */
export type Column = (typeof COLUMNS)[number] | "#" | "what" | "detail";

/** A detail that is only an entity's name is the row's kind, not anything to read. */
const KINDS: ReadonlySet<string> = new Set<string>(STATEFUL);

/** The row's short identity as a person would say it aloud. The kind is said only where the
 *  screen does not already say it — a roadmap box and a node's children mix kinds, and the
 *  board marks those rows by putting the kind in the detail. */
export const code = (row: Row): string =>
  KINDS.has(row.detail) ? `${row.detail.replace(/_/g, " ")} #${row.id}` : `#${row.id}`;

/** What is left once the code and the state have taken theirs: the label, and the detail
 *  where the code did not already spend it. */
export const description = (row: Row): string =>
  row.detail === "" || KINDS.has(row.detail) ? row.what : `${row.what} · ${row.detail}`;

/** Two spaces between columns; a terminal has no rules to lean on. */
const GAP = "  ";

/** Colour carries state and nothing else. Ink reads "" as no colour, so a state with
 *  nothing to say about itself is drawn plain. */
const PLAIN = "";

export class CookingError extends Error {}

/** One answer to "why is this row in flight", and how a row that has that answer is drawn.
 *  Every word of it — the why, the mark, the colour and which states earn it — is declared
 *  in views.yaml, because none of them is something this file can work out. */
export interface CookingGroup {
  readonly name: string;
  readonly why: string;
  readonly mark: string;
  readonly colour: string;
  readonly states: readonly string[];
}

export interface CookingConfig {
  /** Drawn in this order: what wants a person first, what is already done last. */
  readonly groups: readonly CookingGroup[];
  readonly ungrouped: { readonly mark: string; readonly colour: string };
}

const str = (v: unknown, where: string): string => {
  if (typeof v !== "string") throw new CookingError(`${where} must be a string`);
  return v;
};

export function loadCooking(path: string = CONFIG): CookingConfig {
  const top = (parse(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
  const c = top["cooking"];
  if (c === null || typeof c !== "object") throw new CookingError("views.yaml has no cooking");
  const cfg = c as Record<string, unknown>;

  const groups = cfg["groups"];
  if (!Array.isArray(groups)) throw new CookingError("cooking.groups must be a list");
  const loaded = groups.map((g: unknown, i: number): CookingGroup => {
    const d = (g ?? {}) as Record<string, unknown>;
    const at = `cooking.groups[${i}]`;
    const states = d["states"];
    if (!Array.isArray(states) || states.some((s) => typeof s !== "string")) {
      throw new CookingError(`${at}.states must be a list of strings`);
    }
    return {
      name: str(d["name"], `${at}.name`),
      why: str(d["why"], `${at}.why`),
      mark: str(d["mark"], `${at}.mark`),
      colour: str(d["colour"], `${at}.colour`),
      states: states as string[],
    };
  });

  // A state in two groups is two whys for one row, and which one you get would come down to
  // the order of the file. Refuse to start rather than draw whichever won.
  const seen = new Set<string>();
  for (const g of loaded) {
    for (const s of g.states) {
      if (seen.has(s)) throw new CookingError(`cooking: ${s} is in more than one group`);
      seen.add(s);
    }
  }

  const un = (cfg["ungrouped"] ?? {}) as Record<string, unknown>;
  return {
    groups: loaded,
    ungrouped: {
      mark: str(un["mark"], "cooking.ungrouped.mark"),
      colour: str(un["colour"], "cooking.ungrouped.colour"),
    },
  };
}

/** Read once, and not at import: list.tsx is pulled in by every screen there is, and a read
 *  at module scope would make the config a condition of loading the module rather than of
 *  drawing a row. */
let cached: CookingConfig | null = null;
export const cooking = (): CookingConfig => (cached ??= loadCooking());

/** For tests, and for a config reloaded under a running board. */
export const forgetCooking = (): void => {
  cached = null;
};

export const groupOf = (state: string): CookingGroup | undefined =>
  cooking().groups.find((g) => g.states.includes(state));

/** Every cooking row has a why. A state no group claims still answers the question — with
 *  its own word, which is the most that can honestly be said about it. */
export const why = (row: Row): string =>
  groupOf(row.state)?.why ?? row.state.replace(/_/g, " ");

export const mark = (row: Row): string => groupOf(row.state)?.mark ?? cooking().ungrouped.mark;

export function stateColour(state: string): string {
  return groupOf(state)?.colour ?? cooking().ungrouped.colour;
}

/** Grouped: the rows gathered by their why, in the order views.yaml declares the groups,
 *  and inside a group in the order they arrived. The rows no group claims come last. */
export function groupCooking(rows: readonly Row[]): readonly Row[] {
  const order = cooking().groups.map((g) => g.name);
  const rank = (row: Row): number => {
    const g = groupOf(row.state);
    return g === undefined ? order.length : order.indexOf(g.name);
  };
  return rows
    .map((row, i) => [row, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([row]) => row);
}

const cell = (row: Row, column: (typeof COLUMNS)[number]): string =>
  column === "code" ? code(row) : column === "state" ? row.state : description(row);

/** Never wrap: a cell too wide for its slot loses its tail to an ellipsis. */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return text.slice(0, width - 1) + "…";
}

const pad = (text: string, width: number): string => text.padEnd(width, " ");

/** How wide each column has to be to hold every row given. Passed down from the screen so
 *  that every box on it shares one set of widths and the columns line up down the whole
 *  screen; a list given none sizes itself to the rows it can see. A caller may still name
 *  columns, and they are ignored: the set is this file's, so a screen cannot lay itself
 *  out. The parameter is here only so callers that still pass one keep compiling. */
export function columnWidths(rows: readonly Row[], _columns?: readonly Column[]): number[] {
  return COLUMNS.map((c) => Math.max(...rows.map((r) => cell(r, c).length), 0));
}

/**
 * Rows the height can show, scrolled so the cursor is among them. Without the scroll a
 * cursor past the fold is marked on a line nobody can see.
 */
function window(count: number, height: number, cursor: number | null): [number, number] {
  if (count <= height) return [0, count];
  // One line goes to the "… and N more" tally.
  const shown = Math.max(height - 1, 0);
  if (cursor === null || cursor < shown) return [0, shown];
  const first = Math.min(cursor - shown + 1, count - shown);
  return [first, first + shown];
}

/** A drawn line: the text, whether the cursor is on it, and the state its colour comes
 *  from. The tally at the foot is a line with no row behind it, so it has neither. */
export interface Line {
  readonly text: string;
  readonly state: string;
  readonly cursor: boolean;
}

export function listLines(
  rows: readonly Row[],
  height: number,
  cursor: number | null,
  width: number,
  widths?: readonly number[],
): Line[] {
  if (height <= 0) return [];
  const [first, last] = window(rows.length, height, cursor);
  const visible = rows.slice(first, last);
  const sizes = widths ?? columnWidths(visible);

  // Columns are padded to a shared width; the composed line is what the terminal cuts. A
  // line, not a cell, is what has to fit, and the description is what the cut reaches first
  // because it is last.
  const lines = visible.map((row, i) => ({
    text: clip(COLUMNS.map((c, j) => pad(cell(row, c), sizes[j] ?? 0)).join(GAP).trimEnd(), width),
    state: row.state,
    cursor: cursor !== null && first + i === cursor,
  }));

  const hidden = rows.length - visible.length;
  if (hidden > 0) {
    lines.push({ text: clip(`… and ${hidden} more`, width), state: PLAIN, cursor: false });
  }
  return lines;
}

/** The cooking box's lines. Same arithmetic as any other list — the grouping, the mark and
 *  the why are the whole difference, and they are all read off views.yaml.
 *
 *  The mark leads the line and the why closes it, so the two things a person scans for are
 *  at the two edges and the row itself is between them. The why column is as wide as the
 *  widest why on the whole list rather than on the visible slice, so scrolling does not slide
 *  the column sideways under the reader.
 *
 *  The cursor still indexes the rows given; it is the grouped order they are drawn in, so a
 *  caller that moves a cursor must move it over `groupCooking(rows)`. */
export function cookingLines(
  rows: readonly Row[],
  height: number,
  cursor: number | null,
  width: number,
): Line[] {
  const grouped = groupCooking(rows);
  const whys = Math.max(...grouped.map((row) => why(row).length), 0);
  const [first, last] = window(grouped.length, height, cursor);
  // The mark and its space, and the gap before the why: what is left is the row's own.
  const body = Math.max(width - whys - 2 - GAP.length, 0);
  return listLines(grouped, height, cursor, body).map((line, i) => {
    // One line past the visible rows is the "… and N more" tally: it has no row behind it,
    // so it has neither a group to mark nor a why to give, and it is left as it was drawn.
    if (first + i >= last) return line;
    const row = grouped[first + i] as Row;
    // Clipped once more at the end: on a narrow box the why is what the cut reaches first,
    // which is the right thing to lose — the row is still the row.
    const text = `${mark(row)} ${pad(line.text, body)}${GAP}${why(row)}`.trimEnd();
    return { ...line, text: clip(text, width) };
  });
}

export interface ListProps {
  readonly rows: readonly Row[];
  /** Ignored, and accepted only so a screen that still names columns keeps compiling. */
  readonly columns?: readonly Column[];
  readonly height: number;
  readonly cursor: number | null;
  readonly width: number;
  readonly widths?: readonly number[];
}

/** The cursor row is inverted rather than marked with a character: a gutter costs a column
 *  on every line for one row's sake. */
export function List({ rows, height, cursor, width, widths }: ListProps) {
  return (
    <Box flexDirection="column">
      {listLines(rows, height, cursor, width, widths).map((line, i) => (
        <Text key={i} wrap="truncate" inverse={line.cursor} color={stateColour(line.state)}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
