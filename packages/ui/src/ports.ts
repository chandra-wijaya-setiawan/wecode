/** The ViewIndex port: the index of boxes a person opens by letter, said without naming a
 *  renderer.
 *
 *  The index is the one screen that answers "what can I press", so what it must say is a
 *  contract and not a component's private business. This module holds that contract twice
 *  over: `ViewIndex` is the shape an adapter implements, and `indexLines` is the text every
 *  adapter has to come out with. An adapter that draws its own arrangement of the same data
 *  is a second answer to a question with one answer — so the text is written here, once,
 *  and test/view-index.test.ts holds both the contract and the ink adapter against the same
 *  fixture screen.
 *
 *  No product words live in this file. The screen's title, the titles of the boxes and
 *  whatever is said beside an off-page one all arrive as data, because they are the
 *  caller's — in the cockpit's case, views.yaml's. */

/** One box, as the index knows it. */
export interface IndexedView {
  /** The letter it opens on. One character: the index is a keyboard, not a menu. */
  readonly key: string;
  readonly title: string;
  /** What to say beside the title — that it is off the page, how many rows it keeps, or
   *  nothing at all. The wording is the caller's. */
  readonly note?: string;
}

/** The whole screen, as data. */
export interface ViewIndexScreen {
  readonly title: string;
  readonly views: readonly IndexedView[];
}

/** A way to put that screen in front of a person. `Frame` is whatever the renderer deals
 *  in — a React element for ink, a string for a plain writer — so the cockpit can depend on
 *  this interface and on no renderer. */
export interface ViewIndex<Frame> {
  draw(screen: ViewIndexScreen): Frame;
}

/** Two spaces between every column: one is not a gutter and three is a gap you read across
 *  rather than down. The key column is one character wide because a key is one character. */
const GUTTER = "  ";

/** The screen as the lines a reader sees, top to bottom — the title, then one line per box:
 *  its letter, its title, and its note if it has one. Titles are padded to the longest, so
 *  the notes make a column; a box with no note spends no width on one. */
export function indexLines(screen: ViewIndexScreen): readonly string[] {
  const width = Math.max(0, ...screen.views.map((v) => v.title.length));
  return [
    screen.title,
    ...screen.views.map((v) =>
      v.note === undefined
        ? `${v.key}${GUTTER}${v.title}`
        : `${v.key}${GUTTER}${v.title.padEnd(width)}${GUTTER}${v.note}`,
    ),
  ];
}
