import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob, relative, resolve } from "node:path";

/** The yaml reader, borrowed from core the way `plan.ts` borrows it: the cli declares no
 *  dependency of its own on a parser. */
const { parse } = createRequire(new URL("../../node_modules/@wecode/core/package.json", import.meta.url))("yaml") as {
  parse: (text: string) => unknown;
};

/** What a refusal needs to know about a task: who it is, what it may write, and whether a
 *  person wrote that scope. Structural, so `plan.ts` keeps its own shapes and this module
 *  neither imports them nor has to be opened when a field it does not read is added. */
interface ScopedTask {
  readonly title: string;
  readonly scope: readonly string[];
  readonly given: boolean;
}

/** One rung of the ladder, as these rules read it: the tree below it, and the tasks under
 *  its criteria. */
interface Rung {
  readonly kind: string;
  readonly id: number | null;
  readonly name: string | null;
  readonly children: readonly Rung[];
  readonly requirements: readonly { readonly criteria: readonly { readonly tasks: readonly ScopedTask[] }[] }[];
}

const tasksUnder = (l: Rung): readonly ScopedTask[] => l.requirements.flatMap((r) => r.criteria.flatMap((c) => c.tasks));

const storyName = (l: Rung): string => l.name ?? `#${String(l.id)}`;

/** Two tasks under one story that may both write a path are two agents editing one file at
 *  once: whichever lands second either loses the other's work or fails to apply, and no test
 *  says which. The story is the unit because its tasks are what run together. Refused here,
 *  where moving one path from one task to the other costs a line, rather than at merge. */
export function collisions(l: Rung, say: string[]): void {
  for (const c of l.children) collisions(c, say);
  if (l.kind !== "story") return;
  const tasks = tasksUnder(l).filter((t) => t.given);
  const story = storyName(l);
  for (const [i, a] of tasks.entries()) {
    for (const b of tasks.slice(i + 1)) {
      const path = shared(a.scope, b.scope);
      if (path !== null) {
        say.push(`story ${story}: ${a.title} and ${b.title} both write ${path}; two tasks under one story share no path`);
      }
    }
  }
}

/** Where the tree says which component owns which module. A repository without this file
 *  claims nothing, so it has no owner to go missing and the rule below never fires. */
export const OWNERS = "packages/core/config/components.yaml";

/** A scope path that spells one new module: a literal file — no wildcard, so the plan means
 *  this file and not a shape — under some package's `src/`, which is not there yet. A path
 *  already on disk is an edit, and an edit needs no new row. */
export function newModules(scope: readonly string[]): readonly string[] {
  return scope.filter(
    (p) => !p.includes("*") && /^packages\/[^/]+\/src\/.+\.tsx?$/.test(p) && !existsSync(resolve(process.cwd(), p)),
  );
}

/** A module whose owner nobody may write is a module with no owner: the map that says which
 *  component a file belongs to is checked by a test, so the story goes red on a row its own
 *  scope forbids it to add. The story is the unit because any task under it may carry the
 *  map — one hand adds the module, another may add the row. Refused here, where scoping one
 *  more file costs a line, rather than at pass time, where it costs the story. */
export function owners(l: Rung, say: string[]): void {
  for (const c of l.children) owners(c, say);
  if (l.kind !== "story" || !existsSync(resolve(process.cwd(), OWNERS))) return;
  const tasks = tasksUnder(l);
  if (tasks.some((t) => t.scope.some((g) => matchesGlob(OWNERS, g)))) return;
  const story = storyName(l);
  for (const t of tasks) {
    for (const module of newModules(t.scope)) {
      say.push(`story ${story}: ${t.title} adds ${module}, and no task here may write ${OWNERS}`);
    }
  }
}

/** The first pair of globs from two scopes that can write the same file, named as the file
 *  says them. Two globs collide when neither segment rules the other out — a wildcard in a
 *  segment reaches whatever a name there reaches, and `**` reaches everything below it. */
export function shared(a: readonly string[], b: readonly string[]): string | null {
  for (const x of a) {
    for (const y of b) {
      if (overlaps(x, y)) return x === y ? x : `${x} and ${y}`;
    }
  }
  return null;
}

export function overlaps(x: string, y: string): boolean {
  const g = x.split("/");
  const h = y.split("/");
  for (let i = 0; i < Math.min(g.length, h.length); i++) {
    if (g[i] === "**" || h[i] === "**") return true;
    if (!matchesGlob(g[i] as string, h[i] as string) && !matchesGlob(h[i] as string, g[i] as string)) return false;
  }
  return g.length === h.length;
}

/** The files a test command names: a word carrying a slash whose last segment has an
 *  extension. `packages/tui` is a filter over whatever is there; `test/list.test.ts` is a
 *  file, and either it is there or nothing runs. */
export function files(artefact: string): readonly string[] {
  return artefact
    .split(/\s+/)
    .map((w) => w.replace(/^['"]+|['"]+$/g, ""))
    .filter((w) => w.includes("/") && /\.[A-Za-z0-9]+$/.test(w.slice(w.lastIndexOf("/") + 1)));
}

/** A test command naming a file that is not there and that nobody is scoped to write runs
 *  no tests and passes — `vitest run maler` is green forever. It is refused by path, while
 *  the whole file is still being read, because a typo costs a keystroke here and a story at
 *  pass time. A path some task under it will write is not yet a file and is not a mistake.
 *  `gate` is the criteria statement, for the caller that has a scope of its own. A test file
 *  outside that scope is refused only when the task must write it — the statement is not in it
 *  yet, so the assertion that grades the task is one these hands would have to author. A file
 *  already carrying the statement is red at base and wants no edit: the task turns it green
 *  from its own source, and naming it in scope only widens what an agent may break. A path
 *  that is not a test file at all is not a gate, and is nobody's to write. */
export function artefacts(test: string | null, scope: readonly string[], where: string, say: string[], gate: string | null = null): void {
  for (const path of test === null ? [] : files(test)) {
    if (scope.some((g) => matchesGlob(path, g))) continue;
    const here = resolve(process.cwd(), path);
    if (!existsSync(here)) say.push(`${where}: test: no file matches ${path}`);
    else if (gate !== null && /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !readFileSync(here, "utf8").includes(gate)) say.push(`${where}: test: ${path} is a gate this scope cannot write`);
  }
}

/** A gate is red at base only if these hands can turn it green: one importing a module that is not on disk and that no task under this story writes is red for another story's reason. */
export function needs(test: string | null, scope: readonly string[], where: string, say: string[]): void {
  for (const path of (test === null ? [] : files(test)).filter((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) && existsSync(resolve(process.cwd(), p)))) {
    for (const [, spec] of readFileSync(resolve(process.cwd(), path), "utf8").matchAll(/\bfrom\s+["'](\.[^"']*)["']/g)) {
      const base = relative(process.cwd(), resolve(process.cwd(), path, "..", spec as string)).replaceAll("\\", "/").replace(/\.[cm]?jsx?$/, "");
      const asked = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`];
      if (asked.some((c) => existsSync(resolve(process.cwd(), c)) || scope.some((g) => matchesGlob(c, g)))) continue;
      say.push(`${where}: test: ${path} needs ${base}.ts, which no task under this story writes`);
    }
  }
}

/** The workspace's packages, as `pnpm-workspace.yaml` spells them: the globs are that file's
 *  to declare, not this module's to assume, and a tree with no workspace file has no packages
 *  and so nothing to reach past. */
export function workspace(root: string): readonly { dir: string; name: string }[] {
  const file = resolve(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, "utf8")) as { packages?: unknown } | null;
  const globs = Array.isArray(doc?.packages) ? doc.packages.filter((g): g is string => typeof g === "string") : [];
  const out: { dir: string; name: string }[] = [];
  for (const glob of globs) {
    const parent = glob.endsWith("/*") ? glob.slice(0, -2) : null;
    if (parent === null || !existsSync(resolve(root, parent))) continue;
    for (const entry of readdirSync(resolve(root, parent))) {
      const manifest = resolve(root, parent, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
      out.push({ dir: `${parent}/${entry}`, name: typeof name === "string" ? name : entry });
    }
  }
  return out;
}

/** Whether a scope glob can write anything inside a directory. Compared segment by segment, so
 *  that a wildcard in the package slot reaches every package and a named one reaches its own. */
export function touches(glob: string, dir: string): boolean {
  const g = glob.split("/");
  const d = dir.split("/");
  for (let i = 0; i < Math.min(g.length, d.length); i++) {
    if (g[i] === "**") return true;
    if (!matchesGlob(d[i] as string, g[i] as string)) return false;
  }
  return true;
}

/** The packages a command runs: one it names by path, and one it names by `--filter`. Both
 *  are how pnpm is told which package a suite belongs to, and both narrow the run to it. */
export function runs(test: string, packages: readonly { dir: string; name: string }[]): readonly string[] {
  const words = test.split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, ""));
  const filtered = new Set<string>();
  for (const [i, w] of words.entries()) {
    const arg = w.startsWith("--filter=") ? w.slice("--filter=".length) : w === "--filter" ? words[i + 1] : undefined;
    if (arg !== undefined) filtered.add(arg.replace(/^[.^]+|\.+$/g, ""));
  }
  return packages
    .filter((p) => filtered.has(p.name) || words.some((w) => w === p.dir || w.startsWith(`${p.dir}/`)))
    .map((p) => p.dir);
}

/** A task whose test runs a package its scope cannot write is a task that cannot change its
 *  own verdict: the suite is green or red on work done elsewhere, and the agent is graded on
 *  a tree it may not touch. Refused at plan time, where it costs one line of the file. */
export function reach(test: string | null, scope: readonly string[], where: string, say: string[]): void {
  if (test === null) return;
  for (const dir of runs(test, workspace(process.cwd()))) {
    if (scope.some((g) => touches(g, dir))) continue;
    say.push(`${where}: test: runs ${dir}, which this scope cannot reach`);
  }
}
