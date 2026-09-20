/** One reusable list at three sizes — see config/tui-contract.yaml. Ink lays the boxes out;
 *  what a cell says when it will not fit, and which rows a height shows, are this file's. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Box, Text } from "ink";
import { parse } from "yaml";
import { STATEFUL } from "@wecode/core";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));
const DESIGN = fileURLToPath(new URL("../config/design.yaml", import.meta.url));

/** An allowance, or a spend against one, in the two dimensions that run out. */
export interface Spend {
  readonly tokens: number;
  readonly seconds: number;
}

export interface Row {
  readonly id: number;
  readonly what: string;
  readonly state: string;
  readonly detail: string;
  /** Only a running row carries these. Absent is not zero: no allowance, no gauge. */
  readonly budget?: Spend;
  readonly spent?: Spend;
}

/** The row contract, on every screen: this file alone decides it. */
export const COLUMNS = ["code", "state", "description"] as const;

/** The three, plus the names screens used to pass; naming one changes nothing drawn. */
export type Column = (typeof COLUMNS)[number] | "#" | "what" | "detail";

/** A detail that is only an entity's name is the row's kind, not anything to read. */
const KINDS: ReadonlySet<string> = new Set<string>(STATEFUL);

/** The row's short identity, said aloud — with the kind where the screen omits it. */
export const code = (row: Row): string =>
  KINDS.has(row.detail) ? `${row.detail.replace(/_/g, " ")} #${row.id}` : `#${row.id}`;

/** What is left once code and state have taken theirs: the label, and the unspent detail. */
export const description = (row: Row): string =>
  row.detail === "" || KINDS.has(row.detail) ? row.what : `${row.what} · ${row.detail}`;

/** Two spaces between columns; a terminal has no rules to lean on. */
const GAP = "  ";

/** Colour carries state and nothing else; Ink reads "" as no colour. */
const PLAIN = "";

export class CookingError extends Error {}

/** Why a row is in flight, and how one with that answer is drawn — every word views.yaml's. */
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

  // A state in two groups is two whys for one row, decided by the order of the file.
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

/** Read once, and not at import: a read at module scope gates loading, not drawing. */
let cached: CookingConfig | null = null;
export const cooking = (): CookingConfig => (cached ??= loadCooking());

/** For tests, and for a config reloaded under a running board. */
export const forgetCooking = (): void => {
  cached = null;
  marks = null;
};

let marks: ReadonlyMap<string, string> | null = null;

/** The glyph a section is headed with, by the name views.yaml declares it under — a view,
 *  an off-page box, or `services`. Which sections there are is that file's; what one *is*,
 *  in one character, is the signed proposal's — so the glyph comes off design.yaml's
 *  `proposal.marks`, keyed by the section's title said as one word, and views.yaml's own
 *  `mark` answers only where the proposal is silent: the lead, and the off-page box. */
export const sectionMark = (name: string, path: string = CONFIG): string => {
  if (marks === null) {
    const doc = (parse(readFileSync(path, "utf8")) ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    const said = { ...doc["views"], ...doc["off_page"], services: doc["services"] };
    const drawn = (((parse(readFileSync(DESIGN, "utf8")) ?? {}) as Record<string, Record<string, unknown>>)["proposal"]?.["marks"] ?? {}) as Record<string, unknown>;
    const titled = (v: Record<string, unknown> | undefined, n: string): string => String(v?.["title"] ?? n).toLowerCase().replace(/ /g, "_");
    marks = new Map(Object.entries(said).map(([n, v]) => [n, String(drawn[titled(v, n)] ?? v?.["mark"] ?? " ")]));
  }
  return marks.get(name) ?? " ";
};

export const groupOf = (state: string): CookingGroup | undefined =>
  cooking().groups.find((g) => g.states.includes(state));

/** Every cooking row has a why. A state no group claims answers with its own word. */
export const why = (row: Row): string =>
  groupOf(row.state)?.why ?? row.state.replace(/_/g, " ");

export const mark = (row: Row): string => groupOf(row.state)?.mark ?? cooking().ungrouped.mark;

export function stateColour(state: string): string {
  return groupOf(state)?.colour ?? cooking().ungrouped.colour;
}

/** Grouped by why, in views.yaml's order and, inside a group, arrival order; ungrouped
 *  rows last. */
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

/** How wide each column must be. Passed down so a screen's boxes share one set. */
export function columnWidths(rows: readonly Row[], _columns?: readonly Column[]): number[] {
  return COLUMNS.map((c) => Math.max(...rows.map((r) => cell(r, c).length), 0));
}

/** Rows the height can show, scrolled so the cursor is among them. `per` is a row's cost. */
function window(count: number, height: number, cursor: number | null, per = 1): [number, number] {
  if (count <= Math.floor(height / per)) return [0, count];
  // One line goes to the "… and N more" tally.
  const shown = Math.max(Math.floor((height - 1) / per), 0);
  if (cursor === null || cursor < shown) return [0, shown];
  const first = Math.min(cursor - shown + 1, count - shown);
  return [first, first + shown];
}

/** A drawn line: text, cursor, and the state its colour comes from. A tally has neither. */
export interface Line {
  readonly text: string;
  readonly state: string;
  readonly cursor: boolean;
}

/** The glyph and the space after it, off the front of every row's own width. */
const GLYPH = 2;

export function listLines(
  rows: readonly Row[], height: number, cursor: number | null, width: number,
  widths?: readonly number[],
): Line[] {
  if (height <= 0) return [];
  const [first, last] = window(rows.length, height, cursor);
  const visible = rows.slice(first, last);
  const sizes = widths ?? columnWidths(visible);
  const body = Math.max(width - GLYPH, 0);

  // Columns pad to a shared width and the description gives way first, being last. The
  // glyph leads: what a row is doing is scanned down a column, not read out of a word.
  const lines = visible.map((row, i) => ({
    text: `${mark(row)} ${clip(COLUMNS.map((c, j) => pad(cell(row, c), sizes[j] ?? 0)).join(GAP).trimEnd(), body)}`.trimEnd(),
    state: row.state,
    cursor: cursor !== null && first + i === cursor,
  }));

  const hidden = rows.length - visible.length;
  if (hidden > 0) {
    lines.push({ text: clip(`… and ${hidden} more`, width), state: PLAIN, cursor: false });
  }
  return lines;
}

/** The cooking box's lines: the grouping and the why, both read off views.yaml. The why
 *  closes, sized from the whole list so scrolling does not slide its column sideways. */
export function cookingLines(
  rows: readonly Row[], height: number, cursor: number | null, width: number,
): Line[] {
  const grouped = groupCooking(rows);
  const whys = Math.max(...grouped.map((row) => why(row).length), 0);
  const [first, last] = window(grouped.length, height, cursor);
  // The gap before the why, and the why: what is left is the row's own.
  const body = Math.max(width - whys - GAP.length, 0);
  return listLines(grouped, height, cursor, body).map((line, i) => {
    // The "… and N more" tally has no row behind it: no why to give.
    if (first + i >= last) return line;
    // Clipped again: on a narrow box the why goes first, and rightly — the row is the row.
    const text = `${pad(line.text, body)}${GAP}${why(grouped[first + i] as Row)}`.trimEnd();
    return { ...line, text: clip(text, width) };
  });
}

/** The one group a list knows by name; which states are in it stays in views.yaml. */
const SETTLED = "settled";

export const isSettled = (state: string): boolean => groupOf(state)?.name === SETTLED;

export interface SectionProps extends ListProps {
  /** The caller's sentence for holding nothing: a box's own words are in views.yaml. */
  readonly empty: string;
}

/** A list in two sections: the open rows, then one line standing for everything settled —
 *  twenty finished rows are one fact, and the height goes back to what still wants
 *  something. An empty section is one line too. The cursor indexes the open rows. */
export function sectionLines(
  rows: readonly Row[], height: number, cursor: number | null, width: number,
  empty: string, widths?: readonly number[],
): Line[] {
  if (height <= 0) return [];
  const open = rows.filter((r) => !isSettled(r.state));
  const done = rows.filter((r) => isSettled(r.state));
  const one = done[0];
  const tally: Line[] = one === undefined ? [] : [
    { text: clip(`${mark(one)} ${done.length} ${SETTLED}`, width), state: one.state, cursor: false },
  ];
  // Both want the last line; the open rows take it, being the ones that still want something.
  const room = height - tally.length;
  const body =
    open.length > 0 ? listLines(open, Math.max(room, 1), cursor, width, widths)
    : room > 0 && tally.length === 0 ? [{ text: clip(empty, width), state: PLAIN, cursor: false }]
    : [];
  return [...body, ...tally].slice(0, height);
}

/** Break text at its spaces so no line runs past `width`, into at most `max` lines. A word
 *  too wide for a line is cut like any cell, and an overrun takes the same ellipsis. */
export function wrap(text: string, width: number, max: number): string[] {
  if (width <= 0 || max <= 0) return [];
  const out = [""];
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    const at = out.length - 1;
    const line = out[at] as string;
    const next = line === "" ? word : `${line} ${word}`;
    // On the last line the overflow is clipped and the rest goes unsaid; anywhere else the
    // word starts a line, cut where it stands if it is wider than a line of its own.
    if (next.length <= width) out[at] = next;
    else if (out.length === max) { out[at] = clip(next, width); break; }
    else if (line === "") out[at] = clip(word, width);
    else out.push(clip(word, width));
  }
  return out;
}

/** Wide enough to read a tenth off, narrow enough to leave the numbers room beside it. */
const BAR = 10;

/** How far through its allowance a row is: whichever of tokens and the clock is nearer the
 *  end, named. Zero is a budget nobody set, so a row with neither draws none; the bar stops
 *  at full and the percentage does not. */
export function gauge(row: Row): string {
  const { budget, spent } = row;
  if (budget === undefined || spent === undefined) return "";
  const both = [
    ["tokens", spent.tokens, budget.tokens],
    ["time", spent.seconds, budget.seconds],
  ] as const;
  const live = both.filter(([, , given]) => given > 0);
  if (live.length === 0) return "";
  const [name, used, given] = live.reduce((a, b) => (b[1] / b[2] > a[1] / a[2] ? b : a));
  const on = Math.round(Math.min(used / given, 1) * BAR);
  return `[${"█".repeat(on)}${"░".repeat(BAR - on)}] ${Math.round((used / given) * 100)}% ${name}`;
}

/** A running row is three lines, always: the cursor and the fold count in rows. */
export const RUNNING_LINES = 3;

/** Ink gives an empty Text no height, so one space holds a row's empty line open. */
const held = (text: string, width: number): string => (text === "" && width > 0 ? " " : text);

/** One running row: code and state lead, the title wraps under them, the foot carries the
 *  gauge and the detail. Only the title wraps, because only it is a sentence. */
function runningRow(row: Row, width: number, sizes: readonly number[]): string[] {
  const head = `${pad(code(row), sizes[0] ?? 0)}${GAP}${pad(row.state, sizes[1] ?? 0)}${GAP}`;
  const title = wrap(row.what, Math.max(width - head.length, 0), RUNNING_LINES - 1);
  const bar = gauge(row);
  const indent = " ".repeat(head.length);
  const foot = bar === "" ? row.detail : `${bar}${GAP}${row.detail}`;
  return [`${head}${title[0] ?? ""}`, `${indent}${title[1] ?? ""}`, `${indent}${foot}`].map(
    (line) => held(clip(line.trimEnd(), width), width),
  );
}

/** The running box's lines. The fold counts in rows, so a height that cannot hold a whole
 *  row draws none of it; the cursor inverts all three, the row being what is selected. */
export function runningLines(
  rows: readonly Row[], height: number, cursor: number | null, width: number,
): Line[] {
  if (height <= 0) return [];
  const [first, last] = window(rows.length, height, cursor, RUNNING_LINES);
  const visible = rows.slice(first, last);
  // Code and state keep their columns, so every head lines up; the description is no column.
  const widest = (of: (r: Row) => string): number => Math.max(...visible.map((r) => of(r).length), 0);
  const sizes = [widest(code), widest((r) => r.state)];
  const lines = visible.flatMap((row, i) =>
    runningRow(row, width, sizes).map((text) => ({
      text,
      state: row.state,
      cursor: cursor !== null && first + i === cursor,
    })),
  );

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

export function List({ rows, height, cursor, width, widths }: ListProps) {
  return <Lines lines={listLines(rows, height, cursor, width, widths)} />;
}

export function SectionList({ rows, height, cursor, width, widths, empty }: SectionProps) {
  return <Lines lines={sectionLines(rows, height, cursor, width, empty, widths)} />;
}

/** The running box: the same list, three lines to a row. `widths` is ignored. */
export function RunningList({ rows, height, cursor, width }: ListProps) {
  return <Lines lines={runningLines(rows, height, cursor, width)} />;
}

const Lines = ({ lines }: { readonly lines: readonly Line[] }) => (
  <Box flexDirection="column">
    {lines.map((line, i) => (
      <Text key={i} wrap="truncate" inverse={line.cursor} color={stateColour(line.state)}>
        {line.text}
      </Text>
    ))}
  </Box>
);
