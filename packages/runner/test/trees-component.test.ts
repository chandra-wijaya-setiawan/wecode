import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadComponents, ownerOf, type ComponentMap } from "@wecode/core";

/** docs/design/09. A branch per story and per task, a worktree per assignment — and one
 *  module that does all of it. `git.ts` used to be listed inside the **foreman**, which made
 *  the refs a detail of starting a session. They are not: the examiner, the synchroniser and
 *  the landing all move branches and trees too, and a box that owns them has to be reachable
 *  by all three. So `trees` is claimed here as a component of its own, and what makes the
 *  claim worth anything is the second half of this file: nothing else in the runner changes
 *  a ref or a checkout. */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const map: ComponentMap = loadComponents();

/** Verbs that change a ref or a checkout. Read-only ones are deliberately absent: asking
 *  `rev-parse` what HEAD is, or `merge-base` whether a branch is contained, tells a caller
 *  where it stands and moves nothing, so the examiner and the doctor may ask them directly.
 *  `merge-base` and `merge-tree` are separate verbs from `merge` and are matched whole, so
 *  a question about a merge is never mistaken for one. */
const MUTATING: readonly string[] = [
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "fetch",
  "gc",
  "merge",
  "mv",
  "prune",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "rm",
  "stash",
  "switch",
  "tag",
  "update-ref",
  "worktree",
];

/** The two modules that do not go through `trees` yet, and the verbs each still runs itself.
 *
 *  This is debt, written down as data rather than left to be discovered: `daemon.ts` puts a
 *  story tree back on its base to prove a test there, and `land-chore.ts` carries a second
 *  implementation of the landing merge — a detached tree, a merge, and a compare-and-swap
 *  `update-ref` — that `Trees.land` already knows how to make. Both belong behind methods on
 *  `Trees`, and moving them needs those files in a scope this story did not have.
 *
 *  The list is asserted exactly, in both directions. A new bypass anywhere in the runner
 *  fails the first test below; migrating one of these two and leaving the row behind fails
 *  the second. It can only shrink. */
const OUTSTANDING: Readonly<Record<string, readonly string[]>> = {
  "daemon.ts": ["checkout", "merge", "reset"],
  "land-chore.ts": ["merge", "update-ref", "worktree"],
};

/** A git invocation, in any of the three shapes the runner writes one: `exec("git", [...])`
 *  and its sync sibling, a module-local `git(cwd, [...])` / `quiet(cwd, [...])` helper, and
 *  the doctor's injected port, which takes the argument array alone. */
const CALL =
  /(?:exec(?:File)?(?:Sync)?\(\s*"git"\s*,\s*|\b(?:git|quiet)\(\s*(?:[^,()]*,\s*)?)\[([^\]]*)\]/g;

/** The source with its prose taken out. These files talk *about* branches and merges at
 *  length — the comment above is itself a paragraph naming half of `MUTATING` — so the
 *  assertions are made against the code, which is the only place a verb could run. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Every git verb a module invokes. The verb is the first plain argument: `-c` and the
 *  `user.name=wecode` that follows it configure the run rather than name it, and a flag
 *  cannot come before the subcommand. An array git is handed dynamically — `[...args]` at
 *  the one call site inside `trees` — names no verb here, and is what the next test pins. */
function verbsOf(source: string): readonly string[] {
  const found = new Set<string>();
  for (const call of code(source).matchAll(CALL)) {
    const first = [...call[1]!.matchAll(/"([^"]*)"/g)]
      .map((m) => m[1]!)
      .find((t) => t !== "-c" && !t.includes("=") && !t.startsWith("-"));
    if (first !== undefined) found.add(first);
  }
  return [...found].sort();
}

const mutating = (source: string): readonly string[] =>
  verbsOf(source).filter((v) => MUTATING.includes(v));

/** Every module of the runner, as its file name relative to `src/`. */
function modules(dir = SRC, prefix = ""): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? modules(join(dir, e.name), `${prefix}${e.name}/`)
      : e.name.endsWith(".ts")
        ? [`${prefix}${e.name}`]
        : [],
  );
}

const sourceOf = (module: string): string => readFileSync(join(SRC, module), "utf8");

describe("trees, as a component of its own", () => {
  it("owns the branch-and-worktree module, and says so", () => {
    const owner = ownerOf(map, "runner", "git");
    expect(owner?.name).toBe("trees");
    expect(owner?.isComponent).toBe(true);
    expect(owner?.layer).toBe("service");
    expect(owner?.owns).toMatch(/branch/);
    expect(owner?.owns).toMatch(/worktree/);
  });

  it("owns that module and nothing else", () => {
    const trees = map.components.find((c) => c.name === "trees");
    expect(trees?.modules).toEqual(["git"]);
  });

  it("takes it off the foreman, which no longer owns a tree", () => {
    const foreman = map.components.find((c) => c.name === "foreman");
    expect(foreman?.modules).not.toContain("git");
    expect(foreman?.modules).toEqual(["foreman", "ports"]);
  });

  it("is the only box that claims it", () => {
    const claimants = map.components
      .filter((c) => c.package === "runner" && c.modules.includes("git"))
      .map((c) => c.name);
    expect(claimants).toEqual(["trees"]);
  });
});

describe("every branch and worktree operation goes through it", () => {
  /** One process spawn for the whole component. Every method reaches git through the same
   *  private helper, which is what makes the error message, the buffer size and the trimmed
   *  stdout one decision instead of thirty-nine. */
  it("reaches git through a single call site inside the component", () => {
    expect([...code(sourceOf("git.ts")).matchAll(/exec\(\s*"git"/g)]).toHaveLength(1);
  });

  /** The surface has to be complete before the rule can be kept: a caller that needs a verb
   *  `trees` does not run has no way through it. */
  it("runs the verbs its callers need — cutting, moving, merging and taking away", () => {
    const verbs = mutating(sourceOf("git.ts"));
    expect(verbs).toEqual([
      "add",
      "branch",
      "checkout",
      "commit",
      "merge",
      "reset",
      "tag",
      "update-ref",
      "worktree",
    ]);
  });

  it("leaves no other module changing a ref or a checkout", () => {
    const bypasses: Record<string, readonly string[]> = {};
    for (const module of modules()) {
      if (module === "git.ts") continue;
      const verbs = mutating(sourceOf(module));
      if (verbs.length > 0) bypasses[module] = verbs;
    }
    expect(bypasses, "modules that run a mutating git verb themselves").toEqual(OUTSTANDING);
  });

  it("names the modules that do not go through it yet, and no others", () => {
    expect(Object.keys(OUTSTANDING).sort()).toEqual(["daemon.ts", "land-chore.ts"]);
    for (const module of Object.keys(OUTSTANDING)) {
      expect(modules(), `${module} is listed as outstanding but is not a module`).toContain(module);
    }
  });

  /** The half of the rule that is already whole. Asking git a question moves nothing, so
   *  these three modules are not bypassing `trees` by asking one — and this says which
   *  modules were checked, so a fourth one appearing is not silently assumed to be read-only. */
  it("leaves the modules that only ask git a question asking it directly", () => {
    expect(verbsOf(sourceOf("examiner.ts"))).toEqual(["rev-parse"]);
    expect(verbsOf(sourceOf("doctor.ts"))).toEqual(["log", "rev-list", "rev-parse"]);
    expect(verbsOf(sourceOf("foreman.ts"))).toEqual([]);
  });
});
