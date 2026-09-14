/** What an App looks like — see config/tui-contract.yaml. Nothing here decides anything:
 *  draw() is a pure function of the App's state, so a screen can be asserted on as a
 *  string rather than driven through a terminal. */
import type { App, Screen } from "./app.js";
import { renderList, type Column, type Row } from "./list.js";

/** Every column, on every screen. views.yaml declares title, filter, rows and empty but no
 *  columns, so there is nothing per-box to honour here: a box and its full-height page
 *  differ only in which rows they keep. */
const COLUMNS: readonly Column[] = ["#", "what", "state", "detail"];

/** The keys each screen answers, in the order a reader scans them. App.key handles j k g G
 *  enter esc q r v a; esc is the one key a screen can lack, because the dashboard is the
 *  bottom of the stack and has nothing to pop. Everything else is on every screen. */
const KEYS: readonly (readonly [string, string])[] = [
  ["j/k", "move"],
  ["g/G", "top/end"],
  ["enter", "open"],
  ["esc", "back"],
  ["v", "box"],
  ["a", "act"],
  ["r", "refresh"],
  ["q", "quit"],
];

const clip = (text: string, width: number): string =>
  width <= 0 ? "" : text.length <= width ? text : text.slice(0, width - 1) + "…";

/** The bar is the last line and names every key the screen answers. A key it omits is a
 *  way in nobody can find, so the only thing it drops is esc, and only where esc is
 *  refused. */
export function keyBar(screen: Screen, width: number): string {
  const keys = KEYS.filter(([k]) => k !== "esc" || screen.kind !== "dashboard");
  return clip(keys.map(([k, what]) => `${k} ${what}`).join("  "), width);
}

/** Where each box's rows start in App.lines(), which is every box's rows end to end. The
 *  cursor is one number over that whole run, so a box has to know its own offset to tell
 *  whether the cursor is in it. */
function boxes(app: App, rows: readonly Row[]): { title: string; empty: string; rows: Row[]; at: number; height: number }[] {
  const board = app.boardNow();
  let at = 0;
  return app.views.map((view) => {
    const count = board[view.filter].length;
    const box = { title: view.title, empty: view.empty, rows: rows.slice(at, at + count), at, height: view.rows };
    at += count;
    return box;
  });
}

function dashboard(app: App, width: number, height: number): string[] {
  const rows = app.lines();
  const out: string[] = [];
  for (const box of boxes(app, rows)) {
    out.push(clip(`${box.title} (${box.rows.length})`, width));
    if (box.rows.length === 0) {
      out.push(clip(`  ${box.empty}`, width));
      continue;
    }
    // The cursor runs over every box's rows at once; only the box holding it draws one.
    const local = app.cursor - box.at;
    const cursor = local >= 0 && local < box.rows.length ? local : null;
    out.push(...renderList(box.rows, COLUMNS, box.height, cursor, width));
  }
  return out.slice(0, height);
}

/** One filter, given every line the screen has. */
function box(app: App, screen: Screen & { kind: "box" }, width: number, height: number): string[] {
  const rows = app.lines();
  const head = clip(`${screen.view.title} (${rows.length})`, width);
  if (rows.length === 0) return [head, clip(`  ${screen.view.empty}`, width)].slice(0, height);
  return [head, ...renderList(rows, COLUMNS, Math.max(height - 1, 0), app.cursor, width)].slice(0, height);
}

/** The record's fields, then its children as a list. The fields are what an App knows
 *  about the record it is on — App exposes the screen's entity and id, not the row it was
 *  opened from, so the label and state are not among them. */
function node(app: App, screen: Screen & { kind: "node" }, width: number, height: number): string[] {
  const rows = app.lines();
  const fields: [string, string][] = [
    ["entity", screen.entity],
    ["id", `#${screen.id}`],
    ["children", String(rows.length)],
  ];
  const pad = Math.max(...fields.map(([k]) => k.length));
  const out = fields.map(([k, v]) => clip(`${k.padEnd(pad)}  ${v}`, width));
  out.push("");
  out.push(clip(`children (${rows.length})`, width));
  if (rows.length === 0) out.push(clip("  nothing under it", width));
  else out.push(...renderList(rows, COLUMNS, Math.max(height - out.length - 1, 0), app.cursor, width));
  return out.slice(0, height);
}

/** The whole frame, as tall as the terminal: the screen's own lines, then blank down to
 *  the last line, which is the key bar. */
export function draw(app: App, width: number, height: number): string {
  if (height <= 0) return "";
  const screen = app.screen;
  const body =
    screen.kind === "dashboard"
      ? dashboard(app, width, height - 1)
      : screen.kind === "box"
        ? box(app, screen, width, height - 1)
        : node(app, screen, width, height - 1);

  const lines = body.slice(0, height - 1);
  if (app.status !== "" && lines.length < height - 1) lines.push(clip(app.status, width));
  while (lines.length < height - 1) lines.push("");
  lines.push(keyBar(screen, width));
  return lines.join("\n");
}
