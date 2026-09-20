/** How much of the tree the map accounts for, and the one rule that guards it.
 *
 *  `unclaimed` in architecture.ts answers "which modules has nobody put in a box". This
 *  module turns that list into a number a change can be compared against, and then refuses
 *  a change on exactly one ground: it left a smaller share of the tree accounted for than
 *  it found. A repository that is already behind is not asked to catch up in one diff —
 *  holding the line is enough — and a diff that adds an unclaimed module while claiming
 *  two others is not punished for the arithmetic of the day it landed.
 *
 *  A pure function over two lists, deliberately. The caller gathers the modules of a tree
 *  and loads the map; nothing here reads a checkout, so the same measurement is taken of
 *  what is on disk, what is on a branch, and what a fixture makes up. */
import { claims, type ComponentMap } from "@wecode/core";

/** The share of a tree's modules that the map claims, with the shortfall named.
 *
 *  `modules` is every module of the tree, as `<package>/<module>` — the same spelling
 *  `claims` and `unclaimed` use. `ratio` is `covered / modules.length`, and is 1 for an
 *  empty tree: nothing is unaccounted for when there is nothing there. */
export interface Coverage {
  readonly modules: readonly string[];
  /** The modules the map claims, sorted. */
  readonly claimed: readonly string[];
  /** The modules nothing claims, sorted. This is what a refusal is about. */
  readonly unclaimed: readonly string[];
  readonly ratio: number;
}

/** Whether a change may land, and why. A refusal always names the modules that caused it,
 *  because "coverage fell" is not something a person can act on and a list of files is. */
export interface Verdict {
  readonly refused: boolean;
  readonly before: number;
  readonly after: number;
  /** Modules unclaimed after the change that were not unclaimed before, sorted. Empty on
   *  an acceptance; never empty on a refusal, since coverage cannot fall without one. */
  readonly exposed: readonly string[];
  /** One line, in the caller's voice: what happened and what to do about it. */
  readonly reason: string;
}

/** A recorded number of modules the map is allowed to leave unclaimed, and what a tree
 *  measured against it did. The ceiling is carried beside the map rather than recomputed,
 *  so a repository that is behind is held where it was found and no further. */
export interface CeilingVerdict {
  readonly refused: boolean;
  /** The number that was recorded before the change. */
  readonly ceiling: number;
  /** The number of unclaimed modules after it. */
  readonly unmapped: number;
  /** What the ceiling becomes: the tree's own number when it is lower, else the ceiling.
   *  It never rises, which is the whole of the rule. */
  readonly lowered: number;
  /** Every module nothing claims, sorted. Named on a refusal, because a number is not
   *  something a person can act on and a list of modules is. Empty on an acceptance. */
  readonly loose: readonly string[];
  readonly reason: string;
}

const sorted = (modules: Iterable<string>): readonly string[] => [...new Set(modules)].sort();

const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

/** Measures a map against a tree. `tree` is every module the tree really has, as
 *  `<package>/<module>`; duplicates and order do not matter. */
export function measure(map: ComponentMap, tree: readonly string[]): Coverage {
  const modules = sorted(tree);
  const claimed = new Set(claims(map));
  const covered = modules.filter((m) => claimed.has(m));
  const unclaimed = modules.filter((m) => !claimed.has(m));
  return {
    modules,
    claimed: covered,
    unclaimed,
    ratio: modules.length === 0 ? 1 : covered.length / modules.length,
  };
}

/** Judges a change by its two measurements. Refuses when, and only when, the share of the
 *  tree the map accounts for is lower after than before. */
export function judge(before: Coverage, after: Coverage): Verdict {
  const was = new Set(before.unclaimed);
  const exposed = sorted(after.unclaimed.filter((m) => !was.has(m)));
  const refused = after.ratio < before.ratio;
  const reason = refused
    ? `map coverage falls from ${pct(before.ratio)} to ${pct(after.ratio)}: ` +
      `nothing claims ${exposed.join(", ")}. Add a row to components.yaml.`
    : `map coverage holds at ${pct(after.ratio)}, from ${pct(before.ratio)}.`;
  return {
    refused,
    before: before.ratio,
    after: after.ratio,
    exposed: refused ? exposed : [],
    reason,
  };
}

/** The number a tree records: how many of its modules the map leaves unclaimed. This is
 *  what is written back beside the map once a change is accepted. */
export const ceilingOf = (coverage: Coverage): number => coverage.unclaimed.length;

/** Judges a tree against a recorded ceiling. Refuses when, and only when, more modules are
 *  unclaimed than the ceiling allows; and reports the ceiling the accepted tree leaves
 *  behind, which is the lower of the two and so only ever falls.
 *
 *  A negative or absent ceiling is read as "none recorded yet": nothing to fall from, so
 *  the tree's own number is adopted and the change stands. */
export function against(ceiling: number, after: Coverage): CeilingVerdict {
  const unmapped = ceilingOf(after);
  const recorded = Number.isFinite(ceiling) && ceiling >= 0 ? Math.floor(ceiling) : unmapped;
  const refused = unmapped > recorded;
  const lowered = Math.min(recorded, unmapped);
  const reason = refused
    ? `the map leaves ${unmapped} modules unclaimed, over its ceiling of ${recorded}: ` +
      `nothing claims ${after.unclaimed.join(", ")}. Add a row to components.yaml.`
    : unmapped < recorded
      ? `the unmapped ceiling falls from ${recorded} to ${unmapped}.`
      : `the map leaves ${unmapped} modules unclaimed, at its ceiling.`;
  return {
    refused,
    ceiling: recorded,
    unmapped,
    lowered,
    loose: refused ? after.unclaimed : [],
    reason,
  };
}
