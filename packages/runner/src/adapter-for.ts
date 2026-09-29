import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import type { BudgetConfig } from "./budget.js";

/** The worker the runner spawns, built from what the operator declared.
 *
 *  Two things about an attempt belong to the operator rather than to the machine it runs
 *  on: which model it thinks with, and how hard. Both are in budget.yaml, and both were
 *  being dropped here — `new ClaudeCodeAdapter()` took the adapter's own defaults, so the
 *  `effort` the operator set was read by nothing at all and the model was a literal in the
 *  adapter. An operator who edited the file and saw no change was right.
 *
 *  A function of its own, rather than a line in `bin.ts`, because the wiring is the claim:
 *  everything else in that file takes a lease, opens a database and starts a clock, so a
 *  proof that reached this through it would have to run a daemon to read one constructor. */
export function adapterFor(
  budget: BudgetConfig,
  /** Where a session's transcript is written. The adapter's own default — a directory under
   *  the working directory — when not given; named here so a proof can spawn into a temp
   *  directory instead of the checkout. */
  sessions?: string,
): ClaudeCodeAdapter {
  // `undefined` for the binary and the permission mode rather than the literals they stand
  // for: those two are the adapter's, and restating them would be a second place to change
  // them. Only what budget.yaml decides is passed — and `model` being absent there is
  // itself passed on, so the adapter's declared default stands rather than the machine's.
  return new ClaudeCodeAdapter(undefined, sessions, undefined, budget.model, budget.effort);
}
