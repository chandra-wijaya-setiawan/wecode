/** What an App looks like — see config/tui-contract.yaml. Nothing here decides anything:
 *  every component is a pure function of the App's state, so a screen can be asserted on
 *  by rendering it rather than by driving a terminal. The widths are Yoga's problem now;
 *  what is left to this file is which regions there are, what each is called, which one
 *  holds the cursor, and which of them is worth a border. */
import type { ReactNode } from "react";
import { Box, Text } from "ink";
// By path, as app.ts imports it: index.ts names what board.ts offers one export at a time.
import type { AssignmentFacts } from "@wecode/core/dist/board.js";
import { boxKeys, type App, type Screen } from "./app.js";
import { clip, columnWidths, List, sectionMark, type Column, type Row } from "./list.js";
import { Outline, OUTLINE } from "./outline.js";
import { loadServices, Services, SERVICE_ROWS } from "./services.js";

/** Read once. The box's words are configuration, but re-parsing a file on every frame
 *  would put a disk read on the refresh tick. */
const SERVICES = loadServices();

/** Every column, on every screen: a box and its full-height page differ only in rows. */
export const COLUMNS: readonly Column[] = ["#", "what", "state", "detail"];

/** The keys each screen answers, in scan order. esc and +/- are the two a screen can lack.
 *  A function rather than a constant: the outline names its own key, and this module and
 *  that one each draw part of the other, so the list cannot be built at import time. */
const KEYS = (): readonly (readonly [string, string])[] => [
  ["j/k", "move"],
  ["g/G", "top/end"],
  ["+/-", "fold"],
  ["enter", "open"],
  ["esc", "back"],
  ["v", "box"],
  [`v ${OUTLINE.key}`, "outline"],
  ["a", "act"],
  ["r", "refresh"],
  ["q", "quit"],
];

/** Whether a key does anything on this screen. Only these two are ever dropped: the rest
 *  are on every bar, because a key the bar omits is a screen with no way in. */
const answered = (key: string, kind: Screen["kind"]): boolean => {
  if (key === "esc") return kind !== "dashboard";
  if (key === "+/-") return kind === "outline";
  return true;
};

/** A border costs a column each side. */
const BORDER = 2;

/** A rule costs one line, where a border costs two and two columns with it. */
const RULE = 1;

interface PanelProps {
  readonly title: string;
  /** A section's glyph, from views.yaml. A Panel has none: a page is one thing. */
  readonly mark?: string | undefined;
  readonly letter?: string | undefined;
  /** How many rows the region holds, drawn at a Section's far end. A Panel has none. */
  readonly count?: number | undefined;
  readonly width: number;
  readonly height: number;
  readonly children: ReactNode;
}

/** A bordered box whose title sits in its top border with the count and the letter `v`
 *  opens it by. Ink has no title, so it is drawn absolutely onto the border row. */
export function Panel({ title, letter, width, height, children }: PanelProps) {
  const head = clip(` ${label(title, letter)} `, Math.max(width - 4, 0));
  return (
    <Box
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      width={width}
      height={height}
    >
      <Box position="absolute" marginTop={-1} marginLeft={1}>
        <Text wrap="truncate">{head}</Text>
      </Box>
      {children}
    </Box>
  );
}

/** A region's name, with the letter `v` opens it by. The letter is not capitalised with
 *  the name: it is the key a person types, not a word. */
const label = (title: string, letter: string | undefined): string =>
  `${title}${letter === undefined ? "" : ` [${letter}]`}`;

/** A dashboard section: a rule carrying the section's own glyph, its name in capitals and,
 *  at the far end, its count; its rows under it at the full width. A border would repeat,
 *  for two lines and two columns, a separation the rule already makes. The count is pushed
 *  to the width: the numbers down a page of eight are then a column to compare, and the
 *  dashes are the fill that holds each in place. */
function Section({ title, mark, letter, count, width, height, children }: PanelProps) {
  const tail = count === undefined ? "" : ` ${count}`;
  const head = clip(`── ${mark} ${label(title.toUpperCase(), letter)} `, width - tail.length);
  return (
    <Box flexDirection="column" flexShrink={0} width={width} height={height}>
      <Text wrap="truncate">{head.padEnd(width - tail.length, "─") + tail}</Text>
      {children}
    </Box>
  );
}

/** What a box says when it holds nothing, in that box's own words. */
function Empty({ what, width }: { readonly what: string; readonly width: number }) {
  return <Text wrap="truncate">{clip(what, width)}</Text>;
}

/** The letter each view is opened by, keyed the way App keys it so the bar and the box
 *  cannot disagree about which letter reaches which box. */
function letters(app: App): ReadonlyMap<string, string> {
  return new Map([...boxKeys(app.views)].map(([k, v]) => [v.name, k]));
}

/** Every row the board holds, whatever screen is up. Column widths come from this rather
 *  than from what is on screen, so a box on the dashboard and the same box at full height
 *  line their columns up in the same places. */
function boardRows(app: App): Row[] {
  const board = app.boardNow();
  return app.views.flatMap((v) => board[v.filter].map((row) => ({ ...row })));
}

/** Where each box's rows start in App.lines(): the cursor is one number over every box's
 *  rows end to end, so a box needs its offset to tell whether it holds the cursor. A box is
 *  as tall as the rows it has, up to the height it declares. */
function boxes(
  app: App,
  rows: readonly Row[],
): { name: string; title: string; empty: string; rows: Row[]; at: number; height: number }[] {
  const board = app.boardNow();
  let at = 0;
  return app.views.map((view) => {
    const count = board[view.filter].length;
    const box = {
      name: view.name,
      title: view.title,
      empty: view.empty,
      rows: rows.slice(at, at + count),
      at,
      height: Math.min(Math.max(count, 1), view.rows),
    };
    at += count;
    return box;
  });
}

interface ScreenProps {
  readonly app: App;
  readonly width: number;
  readonly height: number;
}

/** What is holding the workspace up, then every box in config order, each trimmed to the
 *  height it declares. Each is a section — a rule with its name in it — and not a box: see
 *  Section for what the borders cost and what the page bought with them back.
 *
 *  The services section is first because a dead runner or a schema this build cannot read
 *  is the reason every box under it is wrong, and reading the board before that is reading
 *  a board that may have stopped moving an hour ago. It is not in `page.order`: it is not a
 *  filter over the board, it holds no rows the cursor can reach, and `v` does not open it. */
export function Dashboard({ app, width }: ScreenProps) {
  const rows = app.lines();
  const widths = columnWidths(boardRows(app), COLUMNS);
  const key = letters(app);
  // Sized from the rows it will draw: services.tsx adds a pulse line per project on top of
  // its four fixed ones, and a section shorter than its children draws them over the rule.
  const serviceRows = SERVICE_ROWS + app.boardNow().projects.length;
  return (
    <>
      <Section
        title={SERVICES.title}
        mark={sectionMark("services")}
        width={width}
        height={serviceRows + RULE}
      >
        <Services app={app} width={width} config={SERVICES} />
      </Section>
      {boxes(app, rows).map((box) => {
        // The cursor runs over every box's rows at once; only the box holding it draws one.
        const local = app.cursor - box.at;
        const cursor = local >= 0 && local < box.rows.length ? local : null;
        return (
          <Section
            key={box.name}
            title={box.title}
            count={box.rows.length}
            mark={sectionMark(box.name)}
            letter={key.get(box.name)}
            width={width}
            height={box.height + RULE}
          >
            {box.rows.length === 0 ? (
              <Empty what={box.empty} width={width} />
            ) : (
              <List
                rows={box.rows}
                columns={COLUMNS}
                height={box.height}
                cursor={cursor}
                width={width}
                widths={widths}
              />
            )}
          </Section>
        );
      })}
    </>
  );
}

/** One filter, given every line the screen has. */
export function BoxPage({
  app,
  screen,
  width,
  height,
}: ScreenProps & { readonly screen: Screen & { kind: "box" } }) {
  const rows = app.lines();
  const widths = columnWidths(boardRows(app), COLUMNS);
  const inner = width - BORDER;
  return (
    <Panel
      title={`${screen.view.title} (${rows.length})`}
      letter={letters(app).get(screen.view.name)}
      width={width}
      height={height}
    >
      {rows.length === 0 ? (
        <Empty what={screen.view.empty} width={inner} />
      ) : (
        <List
          rows={rows}
          columns={COLUMNS}
          height={height - BORDER}
          cursor={app.cursor}
          width={inner}
          widths={widths}
        />
      )}
    </Panel>
  );
}

/** A count in the digits that say it belongs to the word before it: `ready²` is one token,
 *  where in `ready 2` the eye must decide whether the 2 opens the next pair. */
const superscript = (n: number): string =>
  String(n).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)] as string);

/** How the children stand, most first and ties by name, as `ready² · done¹`. A count per
 *  state, not the states in row order: the block is read to learn whether the record waits
 *  on one thing or twenty. An em dash for none — a blank line reads as a failed draw. */
export function tally(rows: readonly Row[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  if (counts.size === 0) return "—";
  return [...counts]
    .sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
    .map(([state, n]) => `${state}${superscript(n)}`)
    .join(" · ");
}

type Field = readonly [string, string];

/** A value broken onto as many lines as it needs, on spaces or mid-word. Ink would wrap
 *  the whole `name  value` line back to column zero; a continuation under the gutter is
 *  what makes the names a column you can run your eye down. */
function fold(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (let word of value.split(/\s+/).filter((w) => w !== "")) {
    while (word.length > width) {
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

/** A record's facts as text: `name  value`, names left-aligned into a gutter as wide as the
 *  longest of them. Every detail screen's block is this, so the blocks line up with each
 *  other rather than each choosing its own gutter. `wrap` is what a page with the whole
 *  terminal to itself does with a value too long for one line; a block sized to
 *  `fields.length` cannot afford it and clips instead. */
export function fieldLines(fields: readonly Field[], width: number, wrap = false): string[] {
  const gutter = Math.max(...fields.map(([k]) => k.length));
  return fields.flatMap(([k, v]) => {
    const head = `${k.padEnd(gutter)}  `;
    if (!wrap) return [clip(head + v, width)];
    const pad = " ".repeat(gutter + 2);
    return fold(v, width - gutter - 2).map((part, i) => (i === 0 ? head : pad) + part);
  });
}

function Fields({
  fields,
  width,
}: {
  readonly fields: readonly Field[];
  readonly width: number;
}) {
  return (
    <>
      {fieldLines(fields, width).map((line, i) => (
        <Text key={`${i}`} wrap="truncate">
          {line}
        </Text>
      ))}
    </>
  );
}

/** How long an assignment may say nothing and still be called alive. The runner ticks
 *  every 15 seconds by default and writes `last_seen` on each observation it makes, so a
 *  minute is four missed ticks: long enough that a slow tick is not an alarm, short enough
 *  that a worker who died is not still being called alive a coffee later. A literal here
 *  and not in views.yaml only because that file declares boxes and this is not one. */
export const ALIVE_FOR_MS = 4 * 15_000;

/** Tokens as the board writes them, `2.0k`, so the page and the running box's detail count
 *  in the same unit. */
const tokens = (n: number): string => `${(n / 1000).toFixed(1)}k`;

/** A spend as a share of what was allowed. Nothing when nothing was allowed: `0 of 0` is
 *  not 0% or 100%, it is a budget nobody set, and a percentage would invent one. */
const share = (used: number, given: number): string =>
  given <= 0 ? "" : ` (${Math.round((used / given) * 100)}%)`;

/** What it has spent against what it was given, both dimensions on one line. A spend with
 *  no allowance beside it answers no question an operator has. */
export function budgetLine(facts: AssignmentFacts | null): string {
  if (facts === null) return "—";
  const { budget, spent } = facts;
  return [
    `${tokens(spent.tokens)} of ${tokens(budget.tokens)} tokens${share(spent.tokens, budget.tokens)}`,
    `${spent.seconds}s of ${budget.seconds}s${share(spent.seconds, budget.seconds)}`,
  ].join(" · ");
}

/** Whole seconds under a minute, whole minutes above it: the page is read to learn whether
 *  a beat was a moment ago or an hour ago, and no reading of it turns on the seconds. */
const ago = (ms: number): string => {
  const seconds = Math.max(Math.trunc(ms / 1000), 0);
  return seconds < 60 ? `${seconds}s ago` : `${Math.trunc(seconds / 60)}m ago`;
};

/** Whether anything is still working this assignment, in a word and then the evidence for
 *  it. The word comes first because it is the one thing read off this page at a glance, and
 *  a bare timestamp makes the reader do the subtraction themselves.
 *
 *  A finished assignment is not silent, it is over — calling it silent would put an alarm
 *  on every record the board has ever closed. */
export function beatLine(facts: AssignmentFacts | null): string {
  if (facts === null) return "—";
  if (!facts.open) return facts.beat === null ? "over · never reported" : `over · last ${ago(facts.silent ?? 0)}`;
  if (facts.silent === null) return "no beat yet · dispatched and not started";
  return `${facts.silent <= ALIVE_FOR_MS ? "alive" : "silent"} · last beat ${ago(facts.silent)}`;
}

/** As many of these lines as the panel has room for, and a count of what was dropped. A
 *  page that drew past its own border would overwrite the status line and the key bar,
 *  which are the two lines that always have to be readable. */
export function fit(lines: readonly string[], rows: number, width: number): string[] {
  if (rows <= 0) return [];
  if (lines.length <= rows) return [...lines];
  const kept = lines.slice(0, Math.max(rows - 1, 0));
  return [...kept, clip(`… and ${lines.length - kept.length} more`, width)];
}

/** What is known about one assignment, on a screen of its own, filling it.
 *
 *  Half the fields are the board's row, because the board already decided what an
 *  assignment is worth saying and a second reading could disagree with it. The other half
 *  is what four columns had no room for: what it was allowed, what it has used, and when it
 *  last spoke. Neither half restates the other, so neither can contradict it.
 *
 *  The values wrap rather than clip: half a question with an ellipsis on it is a page you
 *  have to leave to read. No children box — an assignment is a leaf. */
export function Assignment({
  screen,
  facts,
  width,
  height,
}: {
  readonly screen: Screen & { kind: "assignment" };
  readonly facts: AssignmentFacts | null;
  readonly width: number;
  readonly height: number;
}) {
  const { row } = screen;
  const fields: Field[] = [
    ["entity", "assignment"],
    ["id", `#${screen.id}`],
    ["objective", row.what],
    ["state", row.state],
    ["budget", budgetLine(facts)],
    ["beat", beatLine(facts)],
    ["worktree", facts === null ? "—" : facts.worktree],
    ["detail", row.detail === "" ? "—" : row.detail],
  ];
  const inner = width - BORDER;
  const body = Math.max(height - BORDER, 1);
  return (
    <Panel title={`assignment #${screen.id} · ${row.state}`} width={width} height={body + BORDER}>
      {fit(fieldLines(fields, inner, true), body, inner).map((line, i) => (
        <Text key={`${i}`} wrap="truncate">
          {line}
        </Text>
      ))}
    </Panel>
  );
}

/** The summary block, then the record's children as a list. The screen carries the row it
 *  was opened from, so the block leads with what the record is called and how it stands:
 *  `task #3` named a screen after its key rather than after its work, and the reader who
 *  pressed enter on a line already knows the id — what they came for is the title. What the
 *  children add up to goes on the children box's title, next to the count it refines. */
export function Node({
  app,
  screen,
  width,
  height,
}: ScreenProps & { readonly screen: Screen & { kind: "node" } }) {
  const rows = app.lines();
  const { row } = screen;
  const fields: [string, string][] = [
    ["entity", screen.entity],
    ["id", `#${screen.id}`],
    ["title", row.what],
    ["state", row.state],
    ["children", String(rows.length)],
  ];
  const inner = width - BORDER;
  // The summary, its border, and the children's border: what is left is the list.
  const children = Math.max(height - fields.length - 2 * BORDER, 1);
  return (
    <>
      <Panel title={`${row.what} · ${row.state}`} width={width} height={fields.length + BORDER}>
        <Fields fields={fields} width={inner} />
      </Panel>
      <Panel
        title={`children (${rows.length}) · ${tally(rows)}`}
        width={width}
        height={children + BORDER}
      >
        {rows.length === 0 ? (
          <Empty what="nothing under it" width={inner} />
        ) : (
          <List rows={rows} columns={COLUMNS} height={children} cursor={app.cursor} width={inner} />
        )}
      </Panel>
    </>
  );
}

/** The bar is the last line and names every key the screen answers. A key it omits is a
 *  way in nobody can find, so the only thing it drops is esc, and only where esc is
 *  refused. It is not a box: a border round it would cost two of the lines it exists to
 *  leave for the work — which is the argument the dashboard's sections now make too. */
export function KeyBar({ screen, width }: { readonly screen: Screen; readonly width: number }) {
  const keys = KEYS().filter(([k]) => answered(k, screen.kind));
  return (
    <Text wrap="truncate">{clip(keys.map(([k, what]) => `${k} ${what}`).join("  "), width)}</Text>
  );
}

/** The whole frame, as tall as the terminal: the screen's own boxes, the one line the App
 *  has to say anything on, and the key bar under them. */
export function Cockpit({ app, width, height }: ScreenProps) {
  const screen = app.screen;
  const bars = (app.status === "" ? 0 : 1) + 1;
  const body = Math.max(height - bars, 0);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {/* The height is stated as well as grown into. A box left to flex clips what
          overflows it only sometimes, and the rest of the time the box that did not fit
          is drawn straight through the two lines that always have to be readable. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} height={body} overflow="hidden">
        {screen.kind === "dashboard" ? (
          <Dashboard app={app} width={width} height={body} />
        ) : screen.kind === "box" ? (
          <BoxPage app={app} screen={screen} width={width} height={body} />
        ) : screen.kind === "outline" ? (
          <Outline app={app} width={width} height={body} />
        ) : screen.kind === "assignment" ? (
          <Assignment screen={screen} facts={app.factsNow()} width={width} height={body} />
        ) : (
          <Node app={app} screen={screen} width={width} height={body} />
        )}
      </Box>
      {app.status === "" ? null : <Text wrap="truncate">{clip(app.status, width)}</Text>}
      <KeyBar screen={screen} width={width} />
    </Box>
  );
}
