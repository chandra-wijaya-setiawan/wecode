import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Violation } from "@wecode/core";
// Type-only, and deliberately so — `doctor.ts` imports this module for the invariant it
// builds, and a value imported back the other way would be a cycle. A type is erased.
import type { Invariant } from "./doctor.js";

/** docs/design/19, applied to what a screen drew rather than to what the record says.
 *
 *  Six layout defects reached master in a week and a person found every one of them by
 *  looking at a screenshot. `packages/ui/src/check.ts` answered the first half of that: it
 *  states the rules that hold for every screen — a row drawn in two boxes, a box that
 *  leaves its parent, a key bound twice, a box that collapsed to a frame — and reports them
 *  against a capture. What it does not do is tell anybody. A rule nobody runs on the tick
 *  is a rule that is found by a person, which is the thing being fixed.
 *
 *  So this is the reporting half: the captures a repository keeps become a violation each,
 *  under one invariant, said in the doctor's own words and recorded on the pass like every
 *  other drift.
 *
 *  It owns no rules. The rule is whatever the checker it was handed calls it, reported
 *  verbatim, so a fifth rule added to `check.ts` is reported here the day it is added and
 *  nothing in the runner has to learn its name. */

/** The check's name, as the report and the board say it. */
export const SCREENS_CHECK = "screen_draws_what_it_says";

/** Where captures live, relative to the repository root — one JSON file per screen, named
 *  for the screen. A convention rather than a policy: there is no number here for anyone to
 *  tune, so it is a constant and not a line of config. */
export const SCREENS_DIR = join("docs", "screens");

/** What a checker reports, as much of it as the doctor reads.
 *
 *  `rule` is a bare string and not `check.ts`'s union on purpose: the doctor repeats the
 *  word it is given. A narrower type here would be a second list of the rules, which is the
 *  copy that goes stale. */
export interface Finding {
  readonly rule: string;
  readonly node: string;
  readonly says: string;
}

/** One capture, as the doctor holds it: the name to report it under and the tree, which it
 *  passes on without reading. `T` is the checker's own capture type — the runner does not
 *  depend on `@wecode/ui` and so does not restate its shape. */
export interface Screen<T> {
  /** The screen's name, taken from the file: `board.json` is `board`. */
  readonly name: string;
  /** Repository-relative, forward slashes, so the violation reads the same on every host. */
  readonly path: string;
  /** The captured tree, handed to the checker as-is. */
  readonly capture: T;
}

/** The sentence for one fault. A person reading the report has to be able to open the thing
 *  it is about, so the file is named as well as the box. */
const detail = (screen: Screen<unknown>, found: Finding): string =>
  `${screen.name}: ${found.node} is ${found.rule} — ${found.says} (captured in ${screen.path})`;

/** What a screen draws wrongly, as violations.
 *
 *  Pure, and the part worth reading: captures in, violations out, one per finding, in the
 *  order the screens were read and then the order the checker found them. Nothing is
 *  deduplicated — two boxes each clipped are two things to fix. */
export function faults<T>(
  screens: readonly Screen<T>[],
  check: (capture: T) => readonly Finding[],
): readonly Violation[] {
  const out: Violation[] = [];
  for (const screen of screens) {
    for (const found of check(screen.capture)) {
      out.push({
        invariant: SCREENS_CHECK,
        // A screen is not a row of the record, so there is no id to name it by. The name is.
        entity: "screen",
        id: null,
        slug: screen.name,
        detail: detail(screen, found),
      });
    }
  }
  return out;
}

/** A capture that cannot be parsed is drift too, and the only fault in this module that is
 *  the doctor's own: nobody downstream will ever see it, because nothing downstream can read
 *  it. Reported under the check so it sits with the screen it is about, and never thrown —
 *  one unreadable file must not hide the faults in the files beside it. */
const unreadable = (name: string, path: string, why: string): Violation => ({
  invariant: SCREENS_CHECK,
  entity: "screen",
  id: null,
  slug: name,
  detail: `${name}: the capture could not be read — ${why} (${path})`,
});

/** Whether a capture parsed, as one value: a tree, or the sentence saying why not. */
type Read<T> = { readonly ok: true; readonly capture: T } | { readonly ok: false; readonly why: string };

const parse = <T>(text: string): Read<T> => {
  try {
    return { ok: true, capture: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
};

/** Every capture the repository keeps, in name order, and the ones that would not parse.
 *
 *  A tree with no captures directory is not an error: it is a tree that captures nothing
 *  yet, and a check that threw over a missing directory would report a broken invariant
 *  where the truth is that there is nothing to look at. */
export function capturedScreens<T>(root: string): {
  readonly screens: readonly Screen<T>[];
  readonly broken: readonly Violation[];
} {
  const dir = join(root, SCREENS_DIR);
  const screens: Screen<T>[] = [];
  const broken: Violation[] = [];
  for (const file of entries(dir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    const path = [SCREENS_DIR, file].join("/").split("\\").join("/");
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch (e) {
      broken.push(unreadable(name, path, e instanceof Error ? e.message : String(e)));
      continue;
    }
    const read = parse<T>(text);
    if (read.ok) screens.push({ name, path, capture: read.capture });
    else broken.push(unreadable(name, path, read.why));
  }
  return { screens, broken };
}

/** Sorted, because a report whose lines moved between two identical passes reads as drift
 *  that is not there, and `readdirSync` makes no promise about order. */
const entries = (dir: string): readonly string[] => {
  try {
    return [...readdirSync(dir)].sort();
  } catch {
    return [];
  }
};

/** The check, bound to a repository and to a checker.
 *
 *  It takes no notice of the snapshot: the record has nothing to say about where a box was
 *  drawn. That is why this is the runner's and not core's — core's set is a pure function of
 *  the record, and reading a tree is reading the world.
 *
 *  `check` has no default, and that is the honest state of this slice. The rules live in
 *  `packages/ui/src/check.ts` and `packages/runner` does not depend on `@wecode/ui`, so the
 *  day this runs on the tick is the day a task that may touch `packages/runner/package.json`
 *  and `doctor.ts` hands `check` in. A default that silently reported nothing would look
 *  wired and be dead.
 *
 *  `read` is the seam the test uses: captures are handed in rather than written to disk, so
 *  the case being proven is the check and not the walk. */
export const screenInvariant = <T>(
  root: string,
  check: (capture: T) => readonly Finding[],
  read: (root: string) => {
    readonly screens: readonly Screen<T>[];
    readonly broken: readonly Violation[];
  } = capturedScreens,
): Invariant => ({
  name: SCREENS_CHECK,
  check: (): readonly Violation[] => {
    const { screens, broken } = read(root);
    return [...faults(screens, check), ...broken];
  },
});
