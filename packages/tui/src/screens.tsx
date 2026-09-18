/** What an App looks like — see config/tui-contract.yaml. Nothing here decides anything:
 *  every component is a pure function of the App's state, so a screen can be asserted on
 *  by rendering it rather than by driving a terminal.
 *
 *  The widths are Yoga's problem now. What is left to this file is which boxes there are,
 *  what each is called, and which one holds the cursor. */
import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { boxKeys, type App, type Screen } from "./app.js";
import { clip, columnWidths, List, type Column, type Row } from "./list.js";
import { Outline, OUTLINE } from "./outline.js";
import { loadServices, Services, SERVICE_ROWS } from "./services.js";

/** Read once. The box's words are configuration, but re-parsing a file on every frame
 *  would put a disk read on the refresh tick. */
const SERVICES = loadServices();

/** Every column, on every screen. views.yaml declares title, filter, rows and empty but no
 *  columns, so there is nothing per-box to honour here: a box and its full-height page
 *  differ only in which rows they keep. */
export const COLUMNS: readonly Column[] = ["#", "what", "state", "detail"];

/** The keys each screen answers, in the order a reader scans them. App.key handles j k g G
 *  + - enter esc q r v a; esc and +/- are the two a screen can lack, because the dashboard
 *  has nothing to pop and only the outline folds. Everything else is on every screen.
 *
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

interface PanelProps {
  readonly title: string;
  readonly letter?: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly children: ReactNode;
}

/** A bordered box whose title sits in its top border, carrying the count and the letter
 *  `v` opens it by. The title is drawn absolutely one row above the content, which is the
 *  border row — Ink has no title of its own, and this is the whole of the arithmetic. */
export function Panel({ title, letter, width, height, children }: PanelProps) {
  const named = letter === undefined ? "" : ` [${letter}]`;
  const label = clip(` ${title}${named} `, Math.max(width - 4, 0));
  return (
    <Box
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      width={width}
      height={height}
    >
      <Box position="absolute" marginTop={-1} marginLeft={1}>
        <Text wrap="truncate">{label}</Text>
      </Box>
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

/** Where each box's rows start in App.lines(), which is every box's rows end to end. The
 *  cursor is one number over that whole run, so a box has to know its own offset to tell
 *  whether the cursor is in it. A box is as tall as the rows it has, up to the height it
 *  declares: an empty box that kept its declared height would push the rest off screen. */
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
 *  height it declares.
 *
 *  The services box is first because a dead runner or a schema this build cannot read is
 *  the reason every box under it is wrong, and reading the board before that is reading a
 *  board that may have stopped moving an hour ago. It is not in `page.order`: it is not a
 *  filter over the board, it holds no rows the cursor can reach, and `v` does not open it. */
export function Dashboard({ app, width }: ScreenProps) {
  const rows = app.lines();
  const widths = columnWidths(boardRows(app), COLUMNS);
  const key = letters(app);
  const inner = width - BORDER;
  return (
    <>
      <Panel title={SERVICES.title} width={width} height={SERVICE_ROWS + BORDER}>
        <Services app={app} width={inner} config={SERVICES} />
      </Panel>
      {boxes(app, rows).map((box) => {
        // The cursor runs over every box's rows at once; only the box holding it draws one.
        const local = app.cursor - box.at;
        const cursor = local >= 0 && local < box.rows.length ? local : null;
        return (
          <Panel
            key={box.name}
            title={`${box.title} (${box.rows.length})`}
            letter={key.get(box.name)}
            width={width}
            height={box.height + BORDER}
          >
            {box.rows.length === 0 ? (
              <Empty what={box.empty} width={inner} />
            ) : (
              <List
                rows={box.rows}
                columns={COLUMNS}
                height={box.height}
                cursor={cursor}
                width={inner}
                widths={widths}
              />
            )}
          </Panel>
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

/** How the children stand, most of them first and ties by name, as `ready 2 · done 1`.
 *  A count per state rather than the states in row order: the block is read to learn
 *  whether the record is waiting on one thing or on twenty, and a list that repeated
 *  `ready` twenty times would answer that only by being counted.
 *
 *  An em dash when there are none, because a blank line reads as a line that failed to
 *  draw rather than as a record with nothing under it. */
export function tally(rows: readonly Row[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  if (counts.size === 0) return "—";
  return [...counts]
    .sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
    .map(([state, n]) => `${state} ${n}`)
    .join(" · ");
}

/** The summary block, then the record's children as a list. The block is what an App knows
 *  about the record it is on — App exposes the screen's entity and id, not the row it was
 *  opened from, so the label and state are not among them — and what the children it just
 *  drew add up to, which is the part you came to the screen for. */
export function Node({
  app,
  screen,
  width,
  height,
}: ScreenProps & { readonly screen: Screen & { kind: "node" } }) {
  const rows = app.lines();
  const fields: [string, string][] = [
    ["entity", screen.entity],
    ["id", `#${screen.id}`],
    ["children", String(rows.length)],
    ["states", tally(rows)],
  ];
  const gutter = Math.max(...fields.map(([k]) => k.length));
  const inner = width - BORDER;
  // The summary, its border, and the children's border: what is left is the list.
  const children = Math.max(height - fields.length - 2 * BORDER, 1);
  return (
    <>
      <Panel
        title={`${screen.entity} #${screen.id}`}
        width={width}
        height={fields.length + BORDER}
      >
        {fields.map(([k, v]) => (
          <Text key={k} wrap="truncate">
            {clip(`${k.padEnd(gutter)}  ${v}`, inner)}
          </Text>
        ))}
      </Panel>
      <Panel title={`children (${rows.length})`} width={width} height={children + BORDER}>
        {rows.length === 0 ? (
          <Empty what="nothing under it" width={inner} />
        ) : (
          <List
            rows={rows}
            columns={COLUMNS}
            height={children}
            cursor={app.cursor}
            width={inner}
          />
        )}
      </Panel>
    </>
  );
}

/** The bar is the last line and names every key the screen answers. A key it omits is a
 *  way in nobody can find, so the only thing it drops is esc, and only where esc is
 *  refused. It is not a box: a border round it would cost two of the lines it exists to
 *  leave for the work. */
export function KeyBar({
  screen,
  width,
}: {
  readonly screen: Screen;
  readonly width: number;
}) {
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
        ) : (
          <Node app={app} screen={screen} width={width} height={body} />
        )}
      </Box>
      {app.status === "" ? null : <Text wrap="truncate">{clip(app.status, width)}</Text>}
      <KeyBar screen={screen} width={width} />
    </Box>
  );
}
