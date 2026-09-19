/** The ink adapter behind the ViewIndex port.
 *
 *  It is .ts and not .tsx on purpose: there is no markup here worth the compiler setting.
 *  What there is, is the one thing an adapter is for — turning the lines the port already
 *  decided on into the thing this renderer draws, a column of `Text` nodes.
 *
 *  The wording and the arrangement are `indexLines`' and are not repeated: an adapter that
 *  laid the columns out again would be a second screen that only agrees with the first
 *  until somebody edits one of them. What is this file's own is the emphasis — the title
 *  and each box's letter are bold, because the letter is the part you are looking for. */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { CapturedNode } from "../check.js";
import { indexLines, type ViewIndex, type ViewIndexScreen } from "../ports.js";

/** The letter, and then the rest of the line. The split is by width rather than by
 *  re-reading the view, so the emphasis cannot drift from the text. */
const KEY = 1;

const line = (text: string, at: number): ReactElement =>
  createElement(
    Text,
    { key: at },
    createElement(Text, { bold: true }, text.slice(0, KEY)),
    text.slice(KEY),
  );

export const inkViewIndex: ViewIndex<ReactElement> = {
  draw(screen: ViewIndexScreen): ReactElement {
    const [title, ...rows] = indexLines(screen);
    return createElement(
      Box,
      { flexDirection: "column" },
      createElement(Text, { key: "title", bold: true }, title ?? ""),
      ...rows.map(line),
    );
  },
};

/** Every string under a node, in the order it was drawn. A `Text` holds strings and other
 *  `Text`s, and the frame is the concatenation — which is exactly what a reader sees, and
 *  why the emphasised letter and its line come back as one line and not two. */
const text = (node: ReactNode): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) {
    return text((node.props as { children?: ReactNode }).children);
  }
  return "";
};

/** The letter a row opens on, as the frame states it: the first `KEY` characters, which is
 *  the same split `line` drew and the only place the frame records a key at all. */
const keyOf = (row: string): string | undefined =>
  row.length >= KEY ? row.slice(0, KEY) : undefined;

/** What the adapter drew, read back off the frame it returned.
 *
 *  The point of reading back rather than re-deriving is that this function is not allowed
 *  to consult the screen: it is handed a frame and nothing else, so a bug in `draw` comes
 *  back in the capture instead of being papered over by a second trip through
 *  `indexLines`. check.ts and diff.ts then hold a terminal screen to the same four rules
 *  and four words as a page.
 *
 *  A terminal has no layout engine here — the frame is a column of lines — so the geometry
 *  is the geometry of text: one row per line, each as wide as it is long, the root as wide
 *  as its widest line. A box is named by what is left of its line after the letter, which
 *  is the only name the frame gives it; the line itself is what it holds. */
export function inkCapture(frame: ReactElement): CapturedNode {
  const kids = (frame.props as { children?: ReactNode }).children;
  const lines = (Array.isArray(kids) ? kids.flat(Infinity) : [kids]).map(text);
  const [title = "", ...rows] = lines;
  return {
    name: title,
    at: { x: 0, y: 0, width: Math.max(0, ...lines.map((l) => l.length)), height: lines.length },
    rows: [title],
    children: rows.map((row, i): CapturedNode => {
      const at = { x: 0, y: i + 1, width: row.length, height: 1 };
      const key = keyOf(row);
      const box = { name: row.slice(KEY).trim(), at, rows: [row] };
      return key === undefined ? box : { ...box, key };
    }),
  };
}
