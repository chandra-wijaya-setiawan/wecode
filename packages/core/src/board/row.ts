/** What a row of the board says, and nothing about where the rows come from.
 *
 *  Every group in `board.ts` is a different query over a different table, and every one of
 *  them ends in the same four fields: an id, what the thing is, the state it is in, and one
 *  line of detail. Shaping that line — reading a timestamp the way the dialect read it,
 *  turning it into minutes, turning a budget into thousands of tokens, cutting a test's
 *  output down to the line worth carrying, and putting an age at the head of a folded row —
 *  is the half of the board that has no database in it at all.
 *
 *  So it is here, where it can be read and held on its own. This module imports nothing
 *  from the record; `board.ts` imports it and keeps the queries. */

/** The board's groups. Each is a filter over the same record — see docs/design/01. */
export interface Row {
  readonly id: number;
  readonly what: string;
  readonly state: string;
  readonly detail: string;
}

/** SQLite's `julianday` reads a bare timestamp as UTC where `Date.parse` reads it as local
 *  time. The record writes ISO-8601 with a Z, but a hand-edited row may not, so the Z is
 *  supplied rather than assumed. */
export const instant = (at: string): number => Date.parse(/([Zz]|[+-]\d\d:?\d\d)$/.test(at) ? at : `${at}Z`);

/** `(julianday('now') - julianday(at)) * 1440` — minutes, unrounded, as the threshold on a
 *  waiting assignment compares them. An unparseable timestamp is no elapsed time at all:
 *  the arithmetic was NULL, and a NULL detail is a row the cockpit cannot draw. */
export const elapsed = (at: string, asOf: number): number => {
  const then = instant(at);
  return Number.isNaN(then) ? 0 : (asOf - then) / 60000;
};

/** And `cast(… AS int)` over it: SQLite truncates towards zero, and so does this. */
export const minutes = (at: string, asOf: number): number => Math.trunc(elapsed(at, asOf));

/** `coalesce(json_extract(a.spent, '$.tokens'), 0) / 1000`, divided the way SQLite divides
 *  it: two integers truncate. Malformed JSON reads as nothing spent — a board that throws
 *  on one bad row is no board at all. */
export const thousands = (spent: string | null): number => {
  let tokens: unknown = null;
  try {
    tokens = spent === null ? null : (JSON.parse(spent) as { tokens?: unknown }).tokens;
  } catch {
    tokens = null;
  }
  const n = typeof tokens === "number" ? tokens : 0;
  return Number.isInteger(n) ? Math.trunc(n / 1000) : n / 1000;
};

/** Every panel is drawn in id order, which is the order the rows were written in. */
export const byId = (a: Row, b: Row): number => a.id - b.id;

/** The one line of a test's output worth carrying. A failing runner says why on its last
 *  line — the assertion, the exception, the exit status — and everything above it is the
 *  part you only need once you have decided to go and look. Output ends in blank lines far
 *  more often than not, so the last *non-blank* line is the one meant here. */
const WIDTH = 120;
export function lastLine(output: string | null | undefined): string {
  if (output === null || output === undefined) return "";
  const line = output
    .split("\n")
    .map((l) => l.trimEnd())
    .findLast((l) => l.trim() !== "");
  if (line === undefined) return "";
  const trimmed = line.trim();
  return trimmed.length > WIDTH ? `${trimmed.slice(0, WIDTH - 1)}…` : trimmed;
}

/** A cooking row and the instant it has last moved, off its own record.
 *
 *  Beside the row rather than on it: a field only the fold reads has no business on what
 *  the cockpit draws, and the instant cannot be looked up by id afterwards — an epic and a
 *  story can share one, and `stale` alone gathers rows from four tables. */
export interface Aged {
  readonly since: string;
  readonly row: Row;
}

/** Oldest first: the smallest instant, then by id, so a tick with nothing moving draws the
 *  same list twice. A row the record cannot date sorts last — reading an unparseable
 *  timestamp as *now* would put it at the head, which is the one place a person looks. */
const sat = (a: Aged): number => {
  const then = instant(a.since);
  return Number.isNaN(then) ? Number.POSITIVE_INFINITY : then;
};

export const oldestFirst = (a: Aged, b: Aged): number => {
  const x = sat(a);
  const y = sat(b);
  return x === y ? a.row.id - b.row.id : x - y;
};

/** The age leads the detail, so it is a column the eye can run down a list whose rows are
 *  otherwise four kinds of thing. A panel whose detail already says the same minutes does
 *  not say them twice; one that says a different number keeps it, being about something
 *  else. */
export const withAge = (a: Aged, asOf: number): Row => {
  const age = `${minutes(a.since, asOf)}m`;
  const detail = a.row.detail.replace(new RegExp(` · ${age}(?= · |$)`), "");
  return { ...a.row, detail: detail === "" ? age : `${age} · ${detail}` };
};

/** The fold itself: every aged row from every machine-side panel, oldest first, each
 *  carrying how long it has been sitting. */
export const folded = (aged: readonly Aged[], asOf: number): readonly Row[] =>
  [...aged].sort(oldestFirst).map((a) => withAge(a, asOf));
