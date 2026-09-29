/** wecode:repo-explorer — the questions wecode asks about a repository, and nothing else.
 *
 *  A client gets the port and one way to open the index behind it. Which index that is —
 *  codegraph today — is not part of the surface, so swapping it is not a change any caller
 *  sees. */
import type { Purpose, Reading, RepoIndex, Use } from "./ports.js";

export {
  UnknownFile,
  UnknownSymbol,
  type Definition,
  type Imported,
  type Purpose,
  type Reading,
  type RepoIndex,
  type SymbolKind,
  type Use,
} from "./ports.js";
export { openCodegraph } from "./adapters/codegraph.js";
export {
  ArchitectureError,
  loadArchitecture,
  nodeAt,
  nodes,
  unclaimed,
  type ArchNode,
  type Architecture,
  type NodeKind,
} from "./architecture.js";

/** The question that ran out of time, named as the port names it. */
export type Question = "read" | "usesOf" | "purposeOf";

/** An AST run that was still going when its budget ran out.
 *
 *  Parsing a repository costs what the machine has left to give, so the same question that
 *  answers in a second on an idle laptop can take ten under load. That is not the index
 *  being wrong, and a caller that treats it as wrong learns something false about the
 *  repository. So it is its own error, carrying what was asked, what it was given and what
 *  it had spent when the budget ran out — enough for a caller to retry it, report it as a
 *  cost, or raise the budget, none of which it could do with a failure.
 *
 *  The work itself is not cancelled: nothing in the port takes a signal, and an index that
 *  has started parsing finishes parsing. What the budget bounds is how long a caller
 *  waits. */
export class OverBudget extends Error {
  constructor(
    readonly question: Question,
    readonly file: string,
    /** What the run was allowed, in milliseconds. */
    readonly budgetMs: number,
    /** What it had spent when the budget ran out, in milliseconds — at least `budgetMs`. */
    readonly spentMs: number,
  ) {
    super(
      `${question} of ${file} is over budget: still running after ${spentMs}ms of ${budgetMs}ms`,
    );
    this.name = "OverBudget";
  }
}

/** Whether a rejection is the budget's doing rather than the repository's. */
export const isOverBudget = (reason: unknown): reason is OverBudget =>
  reason instanceof OverBudget;

/** Run one question under a budget, reporting an over-budget run as `OverBudget`. */
const underBudget = async <T>(
  question: Question,
  file: string,
  budgetMs: number,
  run: () => Promise<T>,
): Promise<T> => {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OverBudget(question, file, budgetMs, Date.now() - started)),
      budgetMs,
    );
    timer.unref?.();
  });
  const work = run();
  // A run that outlives its budget still settles, and the caller is no longer listening.
  // Its late rejection is the budget's business, not an unhandled one.
  work.catch(() => {});
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
};

/** The same index, with every question bounded by `budgetMs`.
 *
 *  A question that answers in time answers exactly as it would have; one that fails fails
 *  with its own error, `UnknownFile` and `UnknownSymbol` included, because a repository
 *  the index cannot answer about is not a cost problem. Only running out of time becomes
 *  `OverBudget`. */
export const withBudget = (index: RepoIndex, budgetMs: number): RepoIndex => {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    throw new RangeError(`a budget must be a positive number of milliseconds, not ${budgetMs}`);
  return {
    root: index.root,
    read: (file: string): Promise<Reading> =>
      underBudget("read", file, budgetMs, () => index.read(file)),
    usesOf: (file: string, symbol: string): Promise<readonly Use[]> =>
      underBudget("usesOf", file, budgetMs, () => index.usesOf(file, symbol)),
    purposeOf: (file: string): Promise<Purpose> =>
      underBudget("purposeOf", file, budgetMs, () => index.purposeOf(file)),
  };
};
