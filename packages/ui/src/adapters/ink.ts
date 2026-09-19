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
import { createElement, type ReactElement } from "react";
import { Box, Text } from "ink";
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
