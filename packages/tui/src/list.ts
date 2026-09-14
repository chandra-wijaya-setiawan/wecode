/** One reusable list at three sizes — see config/tui-contract.yaml. */
export interface Row {
  readonly id: number;
  readonly what: string;
  readonly state: string;
  readonly detail: string;
}

export type Column = "#" | "what" | "state" | "detail";

/** Two spaces between columns; a terminal has no rules to lean on. */
const GAP = "  ";

/** The cursor gutter is always drawn, so a box and its full-height page line up. */
const MARK = "> ";
const NO_MARK = "  ";

const cell = (row: Row, column: Column): string =>
  column === "#" ? String(row.id) : row[column];

/** Never wrap: a cell too wide for its slot loses its tail to an ellipsis. */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return text.slice(0, width - 1) + "…";
}

const pad = (text: string, width: number): string => text.padEnd(width, " ");

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

export function renderList(
  rows: readonly Row[],
  columns: readonly Column[],
  height: number,
  cursor: number | null,
  width: number,
): string[] {
  if (height <= 0 || columns.length === 0) return [];
  const [first, last] = window(rows.length, height, cursor);
  const visible = rows.slice(first, last);

  // Columns are as wide as the widest thing in them; the composed line is what the width
  // cuts. A line, not a cell, is what has to fit.
  const widths = columns.map((c) => Math.max(...visible.map((r) => cell(r, c).length), 0));

  const lines = visible.map((row, i) => {
    const mark = cursor !== null && first + i === cursor ? MARK : NO_MARK;
    const cells = columns.map((c, j) => pad(cell(row, c), widths[j] ?? 0));
    return clip((mark + cells.join(GAP)).trimEnd(), width);
  });

  const hidden = rows.length - visible.length;
  if (hidden > 0) lines.push(clip(`${NO_MARK}… and ${hidden} more`, width));
  return lines;
}
