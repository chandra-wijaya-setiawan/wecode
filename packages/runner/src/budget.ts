import { readFileSync } from "node:fs";
import { parse } from "yaml";

export class BudgetConfigError extends Error {}

/** How hard a worker is told to think. Three names rather than a number, because the
 *  operator picks the level and only this file knows what it costs. */
export type Effort = "low" | "medium" | "high";

const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

/** What each level is worth, in thinking tokens.
 *
 *  A harness left to decide for itself reads whatever the machine it woke up on was
 *  configured with, so two runs of one assignment are not one assignment. The level is
 *  budget.yaml's; the number is here because it is a property of the harness, not of the
 *  work. */
export const THINKING_TOKENS: Readonly<Record<Effort, number>> = {
  low: 4000,
  medium: 10000,
  high: 31999,
};

export interface BudgetConfig {
  readonly max_open: number;
  readonly max_open_per_role: Readonly<Record<string, number>>;
  readonly order: { readonly fresh_first: boolean; readonly oldest_first: boolean };
  /** The effort every worker is spawned with. One setting, not one per role: a role that
   *  needs less thinking needs a smaller scope. */
  readonly effort: Effort;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  max_open: 3,
  max_open_per_role: {},
  order: { fresh_first: true, oldest_first: true },
  effort: "high",
};

/** docs/design/10. Raising max_open is the easiest change in the file and usually the
 *  wrong one, so the default is deliberately small. */
export function loadBudget(path: string): BudgetConfig {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new BudgetConfigError("budget.yaml is not a mapping");
  const top = raw as Record<string, unknown>;

  for (const key of Object.keys(top)) {
    if (!["max_open", "max_open_per_role", "order", "collision", "effort"].includes(key)) {
      throw new BudgetConfigError(`unknown key: ${key}`);
    }
  }

  const max_open = top["max_open"];
  if (max_open !== undefined && (typeof max_open !== "number" || max_open < 1)) {
    throw new BudgetConfigError("max_open must be a number of at least 1");
  }

  const perRole: Record<string, number> = {};
  const raw_per = top["max_open_per_role"];
  if (raw_per !== undefined) {
    if (raw_per === null || typeof raw_per !== "object") {
      throw new BudgetConfigError("max_open_per_role must be a mapping");
    }
    for (const [role, n] of Object.entries(raw_per as Record<string, unknown>)) {
      if (typeof n !== "number" || n < 0) throw new BudgetConfigError(`${role}: not a count`);
      perRole[role] = n;
    }
  }

  const effort = top["effort"];
  if (effort !== undefined && !EFFORTS.includes(effort as Effort)) {
    throw new BudgetConfigError(`effort must be one of ${EFFORTS.join(", ")}`);
  }

  const order = (top["order"] ?? {}) as Record<string, unknown>;
  return {
    effort: effort === undefined ? DEFAULT_BUDGET.effort : (effort as Effort),
    max_open: typeof max_open === "number" ? max_open : DEFAULT_BUDGET.max_open,
    max_open_per_role: perRole,
    order: {
      fresh_first: order["fresh_first"] !== false,
      oldest_first: order["oldest_first"] !== false,
    },
  };
}
