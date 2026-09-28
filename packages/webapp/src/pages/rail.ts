/** The swimlanes beside one row of the tree, as one `<svg>`.
 *
 *  A tree drawn as an indent alone asks the reader to count spaces. `the-tree-you-can-read`
 *  draws the lanes instead, the way a commit graph does: the line leaves the parent's node
 *  going right, turns down, and becomes the lane its children are threaded on — so a child
 *  is a node sitting on a line rather than a stub hanging off a phantom vertical, and a lane
 *  stops at the last row on it instead of running on into nothing.
 *
 *  The measurements are that sketch's, which took them from VS Code's own graph
 *  (`scmHistory.ts`): a lane every 11px, a row 22px tall, the node halfway down it at radius
 *  4, a corner of radius 5 where the line turns, and a 1.6 stroke. They are written here as
 *  numbers because they are one drawing's proportions and not a policy anybody tunes; what
 *  is tunable about this surface lives in `config/ui.yaml`.
 *
 *  One row at a time, and no memory between rows. The svg is flush left and every lane sits
 *  at the same x in every row, so the rails meet across rows without this function ever
 *  seeing two: what a row needs to know is how deep it is, which lanes above it are still
 *  carrying a later sibling, whether it is the last row on its own lane, whether it is the
 *  first with nothing above to come down from, and whether anything hangs under it. The
 *  caller walking the tree knows all five; this file knows none of them and asks.
 *
 *  It decides no colour. The node's fill is the caller's — the state's hue, which is the
 *  page's decision and not a drawing's — and every line is `currentColor` under the lane
 *  index it draws, so one hue per rung is a rule the stylesheet writes and nothing here has
 *  an opinion about. A drawing that named a colour would be a second look, and the look is
 *  the design's.
 *
 *  The rail is decoration, so it is `aria-hidden`: the depth it draws is the nesting the
 *  list already carries, and a reader who is not looking at it should not be read eleven
 *  pixels of path. */
import { escape } from "./board.js";

/** The sketch's geometry. `MIDDLE` is where the node sits and where the line out of it
 *  leaves — half a row down, which is what makes the lanes of two touching rows one line. */
const GAP = 11;
const ROW = 22;
const MIDDLE = ROW / 2;
const NODE = 4;
const CORNER = 5;
const STROKE = 1.6;

/** Where a lane is. Lane 0 is the outermost, and the svg keeps a lane's width to its right
 *  so that a node's own children have somewhere to be drawn. */
const laneAt = (lane: number): number => GAP * (lane + 1);

/** One segment of rail, told apart by the lane it occupies rather than by a colour. */
const line = (lane: number, d: string): string =>
  `<path class="lane" data-lane="${lane}" fill="none" stroke="currentColor" ` +
  `stroke-linecap="round" stroke-width="${STROKE}" d="${d}"/>`;

/** Where one row sits in the tree, as the drawing needs it. */
export interface Rail {
  /** How deep the row is. Depth 0 is a root, and the row's own lane. */
  readonly depth: number;
  /** The lanes above this row still carrying a later sibling. A lane whose last row is
   *  already drawn is not live, and nothing is drawn in it. */
  readonly live: readonly number[];
  /** Whether this is the last row on its own lane — the lane ends at this node. */
  readonly last: boolean;
  /** Whether this is the first row on its own lane with nothing above it to come down from
   *  — the first row of the outermost lane, and nothing else. Every other lane is begun by
   *  the turn the row above drew or carried, so it arrives at the top edge; this one is
   *  begun by its own node, and a line drawn to the top edge here would be a lane coming out
   *  of a parent that is not there. */
  readonly first: boolean;
  /** Whether anything hangs under this row, which is what the line out of the node is
   *  for. */
  readonly children: boolean;
  /** The node's colour, which the caller decides. */
  readonly fill: string;
}

/** The rail for one row: the live lanes above it running straight through, its own lane
 *  arriving from the row above and either passing through or ending at the node, the turn
 *  down into the lane its children are drawn on, and the node itself.
 *
 *  The own lane is drawn from the top edge because that is usually where it comes from: a
 *  first child's lane is the turn its parent drew in the row above, and a later sibling's is
 *  the lane the row above passed through. The one row neither is true of is the first row of
 *  the outermost lane — nothing is above it — and there the lane starts at the node. */
export function rail(row: Rail): string {
  const x = laneAt(row.depth);
  const width = x + GAP;
  const above = [...new Set(row.live)]
    .filter((lane) => lane < row.depth)
    .sort((a, b) => a - b)
    .map((lane) => line(lane, `M ${laneAt(lane)} 0 V ${ROW}`));
  const own = line(row.depth, `M ${x} ${row.first ? MIDDLE : 0} V ${row.last ? MIDDLE : ROW}`);
  const turn = row.children
    ? line(
        row.depth + 1,
        `M ${x} ${MIDDLE} H ${x + GAP - CORNER} ` +
          `A ${CORNER} ${CORNER} 0 0 1 ${x + GAP} ${MIDDLE + CORNER} V ${ROW}`,
      )
    : "";
  const node =
    `<circle class="node" cx="${x}" cy="${MIDDLE}" r="${NODE}" fill="${escape(row.fill)}"/>`;
  return (
    `<svg class="rail" aria-hidden="true" width="${width}" height="${ROW}" ` +
    `viewBox="0 0 ${width} ${ROW}">${above.join("")}${own}${turn}${node}</svg>`
  );
}
