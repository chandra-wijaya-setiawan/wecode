import type { Board } from "@wecode/core";
import type { View } from "./views.js";

const CSI = "\u001b[";
export const clear = `${CSI}2J${CSI}H`;
const dim = (s: string): string => `${CSI}2m${s}${CSI}0m`;
const bold = (s: string): string => `${CSI}1m${s}${CSI}0m`;

const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s.padEnd(n));

/** A one-line header carrying the two counts an operator acts on, then one box per view,
 *  in the order the config gives. A box is its filter's rows, trimmed to
 *  the height it declares, and a count of what did not fit \u2014 a row hidden with nothing
 *  said is the bug this line exists to prevent. */
export function render(board: Board, views: readonly View[], width: number): string {
  const out: string[] = [
    `${bold("wecode")}  ${dim(`${board.running.length} running, ${board.needs_human.length} needs you`)}`,
    "",
  ];
  for (const view of views) {
    const rows = board[view.filter];
    out.push(bold(`${view.title} (${rows.length})`));
    if (rows.length === 0) {
      out.push(dim(`  ${view.empty}`));
    } else {
      for (const row of rows.slice(0, view.rows)) {
        out.push(
          `  ${dim(`#${String(row.id).padStart(4)}`)}  ${pad(row.what, Math.max(20, width - 48))}  ` +
            `${pad(row.state, 14)}${dim(pad(row.detail, 22))}`,
        );
      }
      if (rows.length > view.rows) out.push(dim(`  \u2026 and ${rows.length - view.rows} more`));
    }
    out.push("");
  }
  return out.join("\n");
}
