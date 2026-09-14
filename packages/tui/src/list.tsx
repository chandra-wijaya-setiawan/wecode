/** One reusable list at three sizes — see config/tui-contract.yaml. The arithmetic is the
 *  part worth keeping: Ink lays the boxes out, but what a cell says once it will not fit,
 *  and which rows a height can show, are still decisions this file makes. */
import { Box, Text } from "ink";
import { STATEFUL } from "@wecode/core";

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

const RED = ["failed", "dropped"];
const YELLOW = ["waiting", "on_hold", "pending", "blocked"];
const GREEN = ["delivered", "released", "done", "passed", "met", "accepted", "succeeded"];

export function stateColour(state: string): string {
  if (RED.includes(state)) return "red";
  if (YELLOW.includes(state)) return "yellow";
  if (GREEN.includes(state)) return "green";
  return PLAIN;
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
