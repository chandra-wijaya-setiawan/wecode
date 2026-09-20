import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import {
  Engine,
  Maker,
  OPERATOR,
  currentDatabase,
  loadRoles,
  open,
  readProjectConfig,
  transact,
  Verbs,
  withinCeiling,
  type Outcome,
  type ProjectConfig,
  type RoleConfig,
  type Scope,
} from "@wecode/core";
// The dialect is not on core's public surface — `index.ts` re-exports no `db.js`, and this
// command may not widen it — so it is imported by the path the built package already
// publishes, which is the same `dist` every other import from core above resolves to.
import { queries, table, type Dialect } from "@wecode/core/dist/db.js";
import { openCodegraph, type RepoIndex } from "@wecode/explorer";
import { promised, proposeScope, type Promised, type Proposal } from "./scope-proposal.js";

// yaml is @wecode/core's dependency, and this package declares none of its own. Resolving it
// from core's package rather than from here uses the one copy the workspace already has.
const { parse } = createRequire(new URL("../node_modules/@wecode/core/package.json", import.meta.url))("yaml") as {
  parse: (s: string) => unknown;
};

/** `wecode plan <file.yaml>` — docs/design/13. A whole story as one document: checked
 *  whole, created whole, started, and printed back as a shape. */
export function plan(args: readonly string[], openIndex: (root: string) => RepoIndex = openCodegraph): number {
  // Before parseArgs, which would call --help an unknown option and throw past this command.
  // The file's shape is the one thing a newcomer cannot guess, so --help is the schema itself.
  if (args.some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(help());
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      epic: { type: "string" },
      "dry-run": { type: "boolean" },
      "propose-scope": { type: "boolean" },
      root: { type: "string" },
    },
  });
  const file = positionals[0];
  if (file === undefined) return fail("wecode plan <file.yaml> [--epic <id>] [--dry-run] [--propose-scope]");
  if (!existsSync(file)) return fail(`no such file: ${file}`);

  const path = currentDatabase();
  if (!existsSync(path)) {
    return fail(`no wecode workspace at ${path}.\n  wecode onboard   to set this project up`);
  }
  const db = open(path);

  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (err) {
    return fail(`${file}: ${(err as Error).message}`);
  }

  const config = readProjectConfig(resolve(process.cwd(), "config/project.yaml"));
  const roles = rolesHere();

  // Everything the file gets wrong, at once, before a row exists. A plan read one error at
  // a time is the eighteen commands again.
  const said: string[] = [];
  const shaped = read(doc, config, roles, said);
  const parent = shaped === null ? null : parentOf(db, shaped, values.epic, said);
  if (shaped !== null && shaped.top !== null) {
    duplicated(db, shaped.top, said);
    joined(db, shaped.top, said);
  }

  if (said.length > 0 || shaped === null || shaped.top === null || parent === null) {
    return fail([`${file} is not a plan yet:`, ...said.map((s) => `  ${s}`)].join("\n"));
  }

  // Before --dry-run, which would print the shape of a story nobody has a scope for yet.
  if (values["propose-scope"] === true) {
    return proposing(shaped.top as Level, resolve(values.root ?? process.cwd()), openIndex);
  }

  if (values["dry-run"] === true) {
    process.stdout.write(render(preview(shaped.top, parent)));
    process.stdout.write("nothing created — this was a dry run\n");
    return 0;
  }

  // Creation and starting are one transaction, not two. A plan that died between them left
  // story #171 created and unstarted, a tree nobody would ever run and a person had to
  // finish by hand; a plan that dies anywhere now leaves nothing at all.
  let made: Made;
  try {
    made = transact(db, () => {
      const rows = create(db, shaped.top as Level, parent);
      begin(db, rows);
      return rows;
    });
  } catch (err) {
    // A row the ledger itself refuses — a version that is not major.minor.patch. The
    // transaction is already rolled back, so nothing is behind us.
    return fail(`${file} is not a plan yet:\n  ${(err as Error).message}`);
  }
  process.stdout.write(render(shape(db, made)));
  return 0;
}

function rolesHere(): RoleConfig | null {
  const path = resolve(process.cwd(), "config/roles.yaml");
  if (!existsSync(path)) return null;
  try {
    return loadRoles(path);
  } catch {
    // A broken roles.yaml is that file's complaint to make, not this one's.
    return null;
  }
}

// ── what the file says ───────────────────────────────────────────────────────────────────

interface Task {
  readonly title: string;
  readonly scope: readonly string[];
  readonly tools: readonly string[];
  readonly test: string | null;
  readonly role: string;
  /** Whether the file spelled this scope out. A scope fallen back to from `project.yaml` is
   *  that file's to answer for, and every task in the plan would carry the same one, so the
   *  one-path-one-task rule judges only the scopes a person wrote here. */
  readonly given: boolean;
  /** The symbols the task says it will deliver, `file:symbol` each. Kept but never created
   *  from: a promise is what `--propose-scope` asks the tree about, and a scope is still
   *  written by a person. */
  readonly promises: readonly Promised[];
}
interface Criteria {
  readonly statement: string;
  readonly test: string | null;
  readonly tasks: readonly Task[];
}
interface Requirement {
  /** The existing requirement this one joins, when the file named an id instead of a
   *  sentence. The criteria under it are created there rather than under a new row. */
  readonly id: number | null;
  readonly statement: string | null;
  readonly criteria: readonly Criteria[];
}
/** One rung of the ladder the file describes. A release holds epics, an epic holds stories,
 *  a story holds requirements — so one shape, read, created, started and printed once. */
interface Level {
  readonly kind: Root;
  readonly id: number | null;
  readonly name: string | null;
  readonly children: readonly Level[];
  readonly requirements: readonly Requirement[];
}
/** What the file declared, kept even when its body did not read, so the root it named and
 *  the parent it hangs off are still judged and reported in the same breath. */
interface Plan {
  readonly root: Root;
  readonly join: number | null;
  readonly parent: number | null;
  readonly top: Level | null;
}

type Root = "story" | "epic" | "release";

const ROOTS: readonly string[] = ["story", "epic", "release"];
/** The row above each root, which a sentence is created under; and the key holding its children. */
const ABOVE = { story: "epic", epic: "release", release: null } as const;
const CHILDREN: Record<Root, string> = { story: "requirements", epic: "stories", release: "epics" };
const BELOW = { story: null, epic: "story", release: "epic" } as const;

const KEYS = {
  requirement: ["requirement", "statement", "criteria"],
  criteria: ["statement", "test", "tasks"],
  task: ["title", "scope", "test", "role", "promises"],
} as const;

const DEFAULT_TOOLS = ["bash", "read", "edit", "write"] as const;

/** The schema, written from the same constants `read` judges a file by, so the two cannot
 *  drift: a key added to KEYS or CHILDREN is documented by having been added. */
function help(): string {
  const pad = (s: string, n = 16): string => s.padEnd(n);
  const rows = [
    ["the file", `${ROOTS.join(" | ")} — the first key names the root`],
    ...ROOTS.map((r) => [
      r,
      `${ABOVE[r as Root] === null ? "" : `${String(ABOVE[r as Root])} (the row it hangs off), `}${CHILDREN[r as Root]}`,
    ]),
    ["requirement", KEYS.requirement.join(", ")],
    ["criteria", KEYS.criteria.join(", ")],
    ["task", KEYS.task.join(", ")],
  ];
  return [
    // The first line is the usage `plan-help.test.ts` pins; a flag that creates nothing
    // goes under it rather than into it.
    "wecode plan <file.yaml> [--epic <id>] [--dry-run]",
    "wecode plan <file.yaml> --propose-scope [--root <dir>]",
    "",
    "A whole story as one document: checked whole, created whole, and started.",
    "An unknown key is an error — a typo that silently plans nothing is worse.",
    "",
    "  story: the cockpit is one reusable list      # or an id, to join that story",
    "  epic: 3                                      # optional; --epic <id> or the newest in-progress otherwise",
    "  requirements:                                # required, at least one",
    "    - requirement: 12                          # or an id, to hang new criteria off that requirement",
    "    - statement: a person sees one list",
    "      criteria:",
    "        - statement: the list renders at three sizes",
    "          test: pnpm test list                 # optional; config/project.yaml test otherwise",
    "          tasks:",
    "            - title: render the list",
    '              scope: ["src/**", "test/**"]     # optional; project source + tests otherwise',
    '              promises: ["src/list.ts:renderList"]  # optional; --propose-scope asks the tree about these',
    "              test: pnpm test list             # optional",
    "              role: engineer                   # optional; engineer otherwise",
    "",
    "keys",
    ...rows.map(([where, keys]) => `  ${pad(where as string)}${keys as string}`),
    "",
    "A test naming a file is refused unless that file exists or some task's scope writes it.",
    `A criteria naming no test of its own gets an extra ${AUTHORS} task that writes one.`,
    `A task's tools come from its role, or ${DEFAULT_TOOLS.join(", ")} when there are no roles.`,
    "Two tasks under one story must not spell a scope path that both can write.",
    `A story adding a new packages/*/src module must have ${OWNERS} in some task's scope.`,
    "A requirement given as an id joins that requirement, which must be one of the joined story's.",
    `An epic holds ${CHILDREN.epic}, a release holds ${CHILDREN.release}; only the root joins an existing row by id.`,
    "",
    "--propose-scope creates nothing. It asks the repository index where each promised symbol",
    "lives and who uses it, and prints the scope those promises ask for, per task, to paste.",
    "",
  ].join("\n");
}

/** An unknown key is an error. A typo that silently plans nothing is worse than a refusal. */
function mapping(v: unknown, where: string, allowed: readonly string[], say: string[]): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    say.push(`${where}: expected a mapping`);
    return null;
  }
  const m = v as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!allowed.includes(key)) say.push(`${where}: unknown key ${key}`);
  }
  return m;
}

function required(m: Record<string, unknown>, key: string, where: string, say: string[]): string | null {
  const v = m[key];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  say.push(`${where}: ${key} is required`);
  return null;
}

function optional(v: unknown, where: string, say: string[]): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || v.trim() === "") {
    say.push(`${where}: expected a non-empty string`);
    return null;
  }
  return v.trim();
}

/** The symbols a task promises. A spec that is not `file:symbol` is refused by name: a
 *  promise nobody can check against the tree is worse than no promise. */
function promise(v: unknown, where: string, say: string[]): readonly Promised[] {
  const out: Promised[] = [];
  for (const spec of list(v, where, say)) {
    if (typeof spec !== "string") {
      say.push(`${where}: expected file:symbol, not ${typeof spec}`);
      continue;
    }
    const one = promised(spec);
    if (one === null) say.push(`${where}: ${spec} is not file:symbol`);
    else out.push(one);
  }
  return out;
}

function list(v: unknown, where: string, say: string[]): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    say.push(`${where}: expected a list`);
    return [];
  }
  return v;
}

/** The file's first key names the root. Nothing is created until that much is settled: a
 *  file with no root, or with two, is refused by name before a parent is even looked up. */
function read(doc: unknown, config: ProjectConfig | null, roles: RoleConfig | null, say: string[]): Plan | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    say.push("the file: expected a mapping");
    return null;
  }
  const keys = Object.keys(doc as Record<string, unknown>);
  const first = keys[0];
  if (first === undefined || !ROOTS.includes(first)) {
    say.push(`the file: the first key names the root, and is one of story, epic, release${found(first)}`);
    return null;
  }
  const root = first as Root;

  // A root may carry the key naming the row above it — that is its parent, not a second
  // root. Any other root key is a second root, and the file has to say which it means.
  const others = keys.filter((k) => k !== root && k !== ABOVE[root] && ROOTS.includes(k));
  if (others.length > 0) {
    say.push(`the file: more than one root — ${[root, ...others].join(" and ")}; a file declares exactly one`);
    return null;
  }

  const allowed = [root, ...(ABOVE[root] === null ? [] : [ABOVE[root] as string]), CHILDREN[root]];
  const m = mapping(doc, "the file", allowed, say);
  if (m === null) return null;

  let parent: number | null = null;
  const above = ABOVE[root];
  if (above !== null && m[above] !== undefined) {
    const n = Number(m[above]);
    if (!Number.isInteger(n)) say.push(`the file: ${above} must be an id`);
    else parent = n;
  }

  const top = level(m, root, "the file", config, roles, say);
  if (top !== null) {
    collisions(top, say);
    owners(top, say);
  }
  return { root, join: top?.id ?? id(m[root]), parent, top };
}

/** Two tasks under one story that may both write a path are two agents editing one file at
 *  once: whichever lands second either loses the other's work or fails to apply, and no test
 *  says which. The story is the unit because its tasks are what run together. Refused here,
 *  where moving one path from one task to the other costs a line, rather than at merge. */
function collisions(l: Level, say: string[]): void {
  for (const c of l.children) collisions(c, say);
  if (l.kind !== "story") return;
  const tasks = l.requirements.flatMap((r) => r.criteria.flatMap((c) => c.tasks)).filter((t) => t.given);
  const story = l.name ?? `#${String(l.id)}`;
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
const OWNERS = "packages/core/config/components.yaml";

/** A scope path that spells one new module: a literal file — no wildcard, so the plan means
 *  this file and not a shape — under some package's `src/`, which is not there yet. A path
 *  already on disk is an edit, and an edit needs no new row. */
function newModules(scope: readonly string[]): readonly string[] {
  return scope.filter(
    (p) => !p.includes("*") && /^packages\/[^/]+\/src\/.+\.tsx?$/.test(p) && !existsSync(resolve(process.cwd(), p)),
  );
}

/** A module whose owner nobody may write is a module with no owner: the map that says which
 *  component a file belongs to is checked by a test, so the story goes red on a row its own
 *  scope forbids it to add. The story is the unit because any task under it may carry the
 *  map — one hand adds the module, another may add the row. Refused here, where scoping one
 *  more file costs a line, rather than at pass time, where it costs the story. */
function owners(l: Level, say: string[]): void {
  for (const c of l.children) owners(c, say);
  if (l.kind !== "story" || !existsSync(resolve(process.cwd(), OWNERS))) return;
  const tasks = l.requirements.flatMap((r) => r.criteria.flatMap((c) => c.tasks));
  if (tasks.some((t) => t.scope.some((g) => matchesGlob(OWNERS, g)))) return;
  const story = l.name ?? `#${String(l.id)}`;
  for (const t of tasks) {
    for (const module of newModules(t.scope)) {
      say.push(`story ${story}: ${t.title} adds ${module}, and no task here may write ${OWNERS}`);
    }
  }
}

/** The first pair of globs from two scopes that can write the same file, named as the file
 *  says them. Two globs collide when neither segment rules the other out — a wildcard in a
 *  segment reaches whatever a name there reaches, and `**` reaches everything below it. */
function shared(a: readonly string[], b: readonly string[]): string | null {
  for (const x of a) {
    for (const y of b) {
      if (overlaps(x, y)) return x === y ? x : `${x} and ${y}`;
    }
  }
  return null;
}

function overlaps(x: string, y: string): boolean {
  const g = x.split("/");
  const h = y.split("/");
  for (let i = 0; i < Math.min(g.length, h.length); i++) {
    if (g[i] === "**" || h[i] === "**") return true;
    if (!matchesGlob(g[i] as string, h[i] as string) && !matchesGlob(h[i] as string, g[i] as string)) return false;
  }
  return g.length === h.length;
}

const found = (key: string | undefined): string => (key === undefined ? "; this one is empty" : `, not ${key}`);

/** A root given as a number joins that existing row; a sentence is created under its parent. */
function id(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function level(
  m: Record<string, unknown>,
  kind: Root,
  where: string,
  config: ProjectConfig | null,
  roles: RoleConfig | null,
  say: string[],
): Level | null {
  const joined = id(m[kind]);
  const name = joined === null ? required(m, kind, where, say) : null;

  const key = CHILDREN[kind];
  const raw = list(m[key], `${where}: ${key}`, say);
  if (raw.length === 0) say.push(`${where}: ${key} is required, and holds at least one`);

  const under = (i: number, what: string): string => (where === "the file" ? `${what} ${i}` : `${where}, ${what} ${i}`);
  const next = BELOW[kind];

  const requirements =
    next !== null
      ? []
      : raw.map((r, i) => requirement(r, under(i + 1, "requirement"), config, roles, say)).filter((r) => r !== null);
  const children =
    next === null
      ? []
      : raw.map((c, i) => child(c, next, under(i + 1, next), config, roles, say)).filter((c) => c !== null);

  return joined === null && name === null ? null : { kind, id: joined, name, children, requirements };
}

/** Only the root joins an existing row. A story listed inside a new epic is one this file
 *  is making; an id there would say the epic both is and is not that story's parent. */
function child(
  v: unknown,
  kind: Root,
  where: string,
  config: ProjectConfig | null,
  roles: RoleConfig | null,
  say: string[],
): Level | null {
  const m = mapping(v, where, [kind, CHILDREN[kind]], say);
  if (m === null) return null;
  const made = level(m, kind, where, config, roles, say);
  if (made !== null && made.id !== null) {
    say.push(`${where}: ${kind} must be a sentence here — only the root joins an existing row by id`);
    return null;
  }
  return made;
}

function requirement(
  v: unknown,
  where: string,
  config: ProjectConfig | null,
  roles: RoleConfig | null,
  say: string[],
): Requirement | null {
  const m = mapping(v, where, KEYS.requirement, say);
  if (m === null) return null;

  // A requirement given as an id is one the ledger already holds, and the criteria under it
  // are new children of that row. A sentence there would say the same requirement twice.
  const joined = id(m["requirement"]);
  if (m["requirement"] !== undefined && joined === null) say.push(`${where}: requirement must be an id`);
  if (joined !== null && m["statement"] !== undefined) {
    say.push(`${where}: requirement #${joined} already exists, so statement must not be given too`);
  }
  const statement = joined === null ? required(m, "statement", where, say) : null;

  const criteria = list(m["criteria"], `${where}: criteria`, say)
    .map((c, i) => criterion(c, `${where}, criteria ${i + 1}`, config, roles, say))
    .filter((c) => c !== null);
  // A joined requirement is named to hang criteria off; naming one and hanging nothing off
  // it creates nothing at all, which is a typo rather than a plan.
  if (joined !== null && criteria.length === 0) {
    say.push(`${where}: requirement #${joined} is joined to hang criteria off, and there are none`);
  }

  return joined === null && statement === null ? null : { id: joined, statement, criteria };
}

/** The files a test command names: a word carrying a slash whose last segment has an
 *  extension. `packages/tui` is a filter over whatever is there; `test/list.test.ts` is a
 *  file, and either it is there or nothing runs. */
function files(artefact: string): readonly string[] {
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
function artefacts(test: string | null, scope: readonly string[], where: string, say: string[], gate: string | null = null): void {
  for (const path of test === null ? [] : files(test)) {
    if (scope.some((g) => matchesGlob(path, g))) continue;
    const here = resolve(process.cwd(), path);
    if (!existsSync(here)) say.push(`${where}: test: no file matches ${path}`);
    else if (gate !== null && /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !readFileSync(here, "utf8").includes(gate)) say.push(`${where}: test: ${path} is a gate this scope cannot write`);
  }
}

/** A gate is red at base only if these hands can turn it green: one importing a module that is not on disk and that no task under this story writes is red for another story's reason. */
function needs(test: string | null, scope: readonly string[], where: string, say: string[]): void {
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
function workspace(root: string): readonly { dir: string; name: string }[] {
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
function touches(glob: string, dir: string): boolean {
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
function runs(test: string, packages: readonly { dir: string; name: string }[]): readonly string[] {
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
function reach(test: string | null, scope: readonly string[], where: string, say: string[]): void {
  if (test === null) return;
  for (const dir of runs(test, workspace(process.cwd()))) {
    if (scope.some((g) => touches(g, dir))) continue;
    say.push(`${where}: test: runs ${dir}, which this scope cannot reach`);
  }
}

function criterion(v: unknown, where: string, config: ProjectConfig | null, roles: RoleConfig | null, say: string[]): Criteria | null {
  const m = mapping(v, where, KEYS.criteria, say);
  if (m === null) return null;
  const statement = required(m, "statement", where, say);
  const test = optional(m["test"], `${where}: test`, say) ?? config?.test ?? null;
  const tasks = list(m["tasks"], `${where}: tasks`, say)
    .map((t, i) => task(t, `${where}, task ${i + 1}`, config, roles, say, statement))
    .filter((t) => t !== null);
  if (statement === null) return null;

  // A criteria that names no test of its own has nobody writing one. The task that writes it
  // is the acceptance-tester's, not the engineer's — the two must not be the same pair of hands.
  const authoring = m["test"] === undefined ? authoringTask(statement, config, roles) : null;
  const all = authoring === null ? tasks : [...tasks, authoring];

  // Only what this file spells: a path in `project.yaml`'s fallback is that file's to answer
  // for. A criteria has no scope of its own, so the test it names may be one its tasks write.
  if (m["test"] !== undefined) { artefacts(test, all.flatMap((t) => t.scope), where, say); needs(test, all.flatMap((t) => t.scope), where, say); }
  return { statement, test, tasks: all };
}

const AUTHORS = "acceptance-tester";

/** The task that writes the missing acceptance test. Its brief is the criteria statement and
 *  nothing else, and a test that passes before the feature exists is not the test. */
function authoringTask(statement: string, config: ProjectConfig | null, roles: RoleConfig | null): Task | null {
  // The scope is the role's, so without the role there is no scope to give, and no task.
  const def = roles?.roles[AUTHORS];
  if (def === undefined) return null;
  return {
    title: `write the acceptance test for: ${statement} — from the criteria statement alone, and check it fails before the feature exists`,
    scope: [...def.scope.write],
    tools: [...def.scope.tools],
    test: config?.test ?? null,
    role: AUTHORS,
    given: false,
    promises: [],
  };
}

function task(v: unknown, where: string, config: ProjectConfig | null, roles: RoleConfig | null, say: string[], statement: string | null): Task | null {
  const m = mapping(v, where, KEYS.task, say);
  if (m === null) return null;
  const title = required(m, "title", where, say);
  const role = optional(m["role"], `${where}: role`, say) ?? "engineer";
  const test = optional(m["test"], `${where}: test`, say) ?? config?.test ?? null;

  const given = m["scope"] === undefined ? null : list(m["scope"], `${where}: scope`, say);
  const scope = given !== null ? given.filter((g): g is string => typeof g === "string") : config === null ? null : [...config.source, ...config.tests];

  // A task that may change anything is not a task.
  if (scope === null || scope.length === 0) {
    say.push(`${where}: no scope, and no config/project.yaml to fall back to`);
  }

  const def = roles?.roles[role];
  if (roles !== null && def === undefined) say.push(`${where}: no role named ${role}`);
  const tools = def === undefined ? [...DEFAULT_TOOLS] : [...def.scope.tools];

  // A scope that leaves the role's ceiling is refused here rather than at start, so the
  // whole file is judged before any of it is written.
  if (def !== undefined && scope !== null) {
    const within = withinCeiling(def.scope, { write: scope, tools });
    if (!within.ok) say.push(`${where}: ${within.why}`);
  }

  if (m["test"] !== undefined) artefacts(test, scope ?? [], where, say, statement);

  // Unlike the path check above, this one judges the fallback test too: a project-wide command
  // that narrows to one package is as unreachable as one the file spells out.
  if (scope !== null) reach(test, scope, where, say);

  const promises = promise(m["promises"], `${where}: promises`, say);

  return title === null || scope === null || scope.length === 0
    ? null
    : { title, scope, tools, test, role, given: m["scope"] !== undefined, promises };
}

// ── the rows this command reads ──────────────────────────────────────────────────────────

/** The columns this command reads, and only those. A narrow declaration is not a second copy
 *  of the schema: it is the ask, and `typed-plan.test.ts` holds each list against
 *  `PRAGMA table_info`, so a column renamed out from under it fails a test rather than a
 *  command. The names are plural because `task`, `requirement` and `criterion` are already
 *  functions in this module. */
const projects = table<{ id: number; name: string; repo: string }>("project", ["id", "name", "repo"]);

interface ReleaseRow {
  id: number;
  project_id: number;
  version: string;
  state: string;
}
const releases = table<ReleaseRow>("release", ["id", "project_id", "version", "state"]);

interface EpicRow {
  id: number;
  release_id: number;
  title: string;
  state: string;
}
const epics = table<EpicRow>("epic", ["id", "release_id", "title", "state"]);

interface StoryRow {
  id: number;
  epic_id: number;
  title: string;
  state: string;
}
const stories = table<StoryRow>("story", ["id", "epic_id", "title", "state"]);

interface RequirementRow {
  id: number;
  story_id: number;
  statement: string;
  state: string;
}
const requirements = table<RequirementRow>("requirement", ["id", "story_id", "statement", "state"]);

interface CriteriaRow {
  id: number;
  requirement_id: number;
  statement: string;
  state: string;
}
const criteria = table<CriteriaRow>("acceptance_criteria", ["id", "requirement_id", "statement", "state"]);

/** A test row, of either kind: the two tables carry the same columns this command reads. */
interface TestRow {
  id: number;
  statement: string;
  state: string;
}
const acceptanceTests = table<TestRow>("acceptance_test", ["id", "statement", "state"]);
const taskTests = table<TestRow>("task_test", ["id", "statement", "state"]);

const taskRows = table<{ id: number; title: string; state: string }>("task", ["id", "title", "state"]);

/** Every entity this command reads back by id. */
type Entity = Root | "requirement" | "acceptance_criteria" | "acceptance_test" | "task" | "task_test";

/** A row as this command wants it: the label it is named by — a release is its version, the
 *  rest are titles or statements — and the state it is in. */
interface NamedRow {
  readonly label: string;
  readonly state: string;
}

const named = <R extends { state: string }>(row: R | null, label: (r: R) => string): NamedRow | null =>
  row === null ? null : { label: label(row), state: row.state };

/** One closure per entity, replacing the two queries that interpolated a table name and a
 *  column name into their own SQL. The label column is chosen inside the closure, where the
 *  row's type still knows that column exists; interpolated, it was checked by nothing. */
const READ: Record<Entity, (q: Dialect, id: number) => NamedRow | null> = {
  release: (q, id) =>
    named(q.selectFrom(releases).select(["version", "state"]).where("id", "=", id).get(), (r) => r.version),
  epic: (q, id) => named(q.selectFrom(epics).select(["title", "state"]).where("id", "=", id).get(), (r) => r.title),
  story: (q, id) => named(q.selectFrom(stories).select(["title", "state"]).where("id", "=", id).get(), (r) => r.title),
  requirement: (q, id) =>
    named(q.selectFrom(requirements).select(["statement", "state"]).where("id", "=", id).get(), (r) => r.statement),
  acceptance_criteria: (q, id) =>
    named(q.selectFrom(criteria).select(["statement", "state"]).where("id", "=", id).get(), (r) => r.statement),
  acceptance_test: (q, id) =>
    named(q.selectFrom(acceptanceTests).select(["statement", "state"]).where("id", "=", id).get(), (r) => r.statement),
  task: (q, id) => named(q.selectFrom(taskRows).select(["title", "state"]).where("id", "=", id).get(), (r) => r.title),
  task_test: (q, id) =>
    named(q.selectFrom(taskTests).select(["statement", "state"]).where("id", "=", id).get(), (r) => r.statement),
};

// ── which parent ─────────────────────────────────────────────────────────────────────────

interface Here {
  readonly id: number;
  readonly name: string;
}

/** Whose project a row is in, one rung at a time. Ids are global, so every id a file names
 *  is asked this. The joins three SQL strings spelled are these three walks: the dialect has
 *  no JOIN, and a missing row anywhere up the chain is null — which is exactly what the join
 *  did with it, it matched nothing. */
const projectOfRelease = (q: Dialect, id: number): number | null =>
  q.selectFrom(releases).select(["project_id"]).where("id", "=", id).get()?.project_id ?? null;

const projectOfEpic = (q: Dialect, id: number): number | null => {
  const row = q.selectFrom(epics).select(["release_id"]).where("id", "=", id).get();
  return row === null ? null : projectOfRelease(q, row.release_id);
};

const projectOfStory = (q: Dialect, id: number): number | null => {
  const row = q.selectFrom(stories).select(["epic_id"]).where("id", "=", id).get();
  return row === null ? null : projectOfEpic(q, row.epic_id);
};

/** The walk up from each root. A `Record<Root, TableDef<Row>>` cannot carry this — the three
 *  tables have three row shapes, and `TableDef<Row>`'s column list makes it invariant in Row
 *  — so the lookup carries the closure instead, and each column is named where its own row
 *  type still knows it. */
const PROJECT_OF: Record<Root, (q: Dialect, id: number) => number | null> = {
  story: projectOfStory,
  epic: projectOfEpic,
  release: projectOfRelease,
};

const projectHere = (db: DatabaseSync, repo: string): Here | null =>
  queries(db).selectFrom(projects).select(["id", "name"]).where("repo", "=", repo).get();

/** The same guard `create` has. Ids are global. */
function owned(db: DatabaseSync, kind: Root, row: number, here: Here | null, say: string[]): boolean {
  const q = queries(db);
  const owner = PROJECT_OF[kind](q, row);
  const theirs = owner === null ? null : q.selectFrom(projects).select(["id", "name"]).where("id", "=", owner).get();
  if (theirs === null) {
    say.push(`no ${kind} #${row}`);
    return false;
  }
  if (here !== null && theirs.id !== here.id) {
    say.push(`${kind} #${row} belongs to project #${theirs.id} ${theirs.name}, but you are in #${here.id} ${here.name}`);
    return false;
  }
  return true;
}

/** The newest in-progress row of a kind in this project, which a sentence hangs off. Ids
 *  ascend, so the `ORDER BY id DESC LIMIT 1` is a `Math.max` here — the dialect spells
 *  neither, and the rows it caps are one project's. */
function newest(db: DatabaseSync, kind: "epic" | "release", project: number): number | null {
  const q = queries(db);
  const ids =
    kind === "release"
      ? q
          .selectFrom(releases)
          .select(["id"])
          .where("project_id", "=", project)
          .where("state", "=", IN_PROGRESS)
          .all()
          .map((r) => r.id)
      : ((): number[] => {
          const mine = q
            .selectFrom(releases)
            .select(["id"])
            .where("project_id", "=", project)
            .all()
            .map((r) => r.id);
          return q
            .selectFrom(epics)
            .select(["id", "release_id"])
            .where("state", "=", IN_PROGRESS)
            .all()
            .filter((e) => mine.includes(e.release_id))
            .map((e) => e.id);
        })();
  return ids.length === 0 ? null : Math.max(...ids);
}

const IN_PROGRESS = "in_progress";

/** The row the file hangs off: the parent named in the file, then `--epic`, then the newest
 *  in-progress row above it. A root given as an id joins that row instead, and needs none. */
function parentOf(db: DatabaseSync, p: Plan, flag: string | undefined, say: string[]): number | null {
  const here = projectHere(db, resolve(process.cwd()));

  if (p.join !== null) {
    if (!owned(db, p.root, p.join, here, say)) return null;
    if (p.parent !== null) {
      say.push(`the file: ${p.root} #${p.join} already exists, so ${String(ABOVE[p.root])} must not be given too`);
      return null;
    }
    return 0;
  }

  const kind = ABOVE[p.root];
  // A new release hangs off the project this repository is, and nothing else names it.
  if (kind === null) {
    if (here === null) {
      say.push("a new release belongs to a project, and this repository is not an onboarded project");
      return null;
    }
    return here.id;
  }

  let asked = p.parent;
  if (asked === null && flag !== undefined) {
    const n = Number(flag);
    if (!Number.isInteger(n)) {
      say.push(`--epic ${flag} is not an id`);
      return null;
    }
    if (kind === "epic") asked = n;
    else {
      // `--epic` names an epic; a new epic wants the release that epic is in.
      if (!owned(db, "epic", n, here, say)) return null;
      // `owned` has just proved the epic is there, so the row it hangs off is too.
      const row = queries(db).selectFrom(epics).select(["release_id"]).where("id", "=", n).get();
      if (row !== null) return row.release_id;
      say.push(`no epic #${n}`);
      return null;
    }
  }

  if (asked !== null) return owned(db, kind, asked, here, say) ? asked : null;

  if (here === null) {
    say.push(`no ${kind} given, and this repository is not an onboarded project.\n  --epic <id>`);
    return null;
  }
  const latest = newest(db, kind, here.id);
  if (latest === null) {
    say.push(`no ${kind} given, and project #${here.id} ${here.name} has no in-progress ${kind}.\n  --epic <id>`);
    return null;
  }
  return latest;
}

// ── what this project has already said ───────────────────────────────────────────────────

/** The oldest of the matching rows. Ids ascend, so `ORDER BY id LIMIT 1` is a `Math.min`. */
const oldest = (ids: readonly number[]): number | null => (ids.length === 0 ? null : Math.min(...ids));

/** A story in this project already titled this. The sentence narrows the rows first — it is
 *  the selective half of the old WHERE — and the project each match is in is the walk up. */
const sameStory = (q: Dialect, project: number, title: string): number | null =>
  oldest(
    q
      .selectFrom(stories)
      .select(["id", "epic_id"])
      .where("title", "=", title)
      .all()
      .filter((s) => projectOfEpic(q, s.epic_id) === project)
      .map((s) => s.id),
  );

const sameCriteria = (q: Dialect, project: number, statement: string): number | null =>
  oldest(
    q
      .selectFrom(criteria)
      .select(["id", "requirement_id"])
      .where("statement", "=", statement)
      .all()
      .filter((c) => {
        const r = q.selectFrom(requirements).select(["story_id"]).where("id", "=", c.requirement_id).get();
        return r !== null && projectOfStory(q, r.story_id) === project;
      })
      .map((c) => c.id),
  );

/** A story or criteria this project has already said. Planning the same sentence twice makes
 *  a second tree nobody asked for and two agents doing one job, so the file is refused by the
 *  id it duplicates — which is also where the work already is. A root joined by id carries no
 *  sentence of its own and duplicates nothing. */
function duplicated(db: DatabaseSync, top: Level, say: string[]): void {
  const here = projectHere(db, resolve(process.cwd()));
  if (here === null) return;
  const q = queries(db);

  const walk = (l: Level): void => {
    if (l.kind === "story" && l.name !== null) {
      const hit = sameStory(q, here.id, l.name);
      if (hit !== null) say.push(`story #${hit} already says ${l.name}`);
    }
    for (const c of l.children) walk(c);
    for (const r of l.requirements) {
      for (const c of r.criteria) {
        const hit = sameCriteria(q, here.id, c.statement);
        if (hit !== null) say.push(`criteria #${hit} already says ${c.statement}`);
      }
    }
  };
  walk(top);
}

/** Every requirement the file joined by id, held against the ledger: the row is there, and
 *  it is one of the rows of the very story this file joined. Criteria hung off a requirement
 *  under some other story would be work filed where nobody is looking for it, and off a
 *  requirement of a story this file is only now making is impossible — that story has no
 *  rows yet, so the id can only be someone else's. */
function joined(db: DatabaseSync, top: Level, say: string[]): void {
  const q = queries(db);
  const walk = (l: Level): void => {
    for (const r of l.requirements) {
      if (r.id === null) continue;
      const row = q.selectFrom(requirements).select(["story_id"]).where("id", "=", r.id).get();
      if (row === null) say.push(`no requirement #${r.id}`);
      else if (l.id === null) {
        say.push(`requirement #${r.id} is under story #${row.story_id}, and this file makes a new story — join that story by id to hang criteria off it`);
      } else if (row.story_id !== l.id) {
        say.push(`requirement #${r.id} belongs to story #${row.story_id}, but this file joined story #${l.id}`);
      }
    }
    for (const c of l.children) walk(c);
  };
  walk(top);
}

// ── creating ─────────────────────────────────────────────────────────────────────────────

interface MadeTask {
  readonly id: number;
  readonly test: number;
}
interface MadeCriteria {
  readonly id: number;
  readonly test: number;
  readonly tasks: readonly MadeTask[];
}
interface MadeRequirement {
  readonly id: number;
  readonly criteria: readonly MadeCriteria[];
}
interface Made {
  readonly kind: Root;
  readonly id: number;
  readonly children: readonly Made[];
  readonly requirements: readonly MadeRequirement[];
}

/** Every row `create` would have written, in the same order. Called inside one transaction:
 *  a file that fails halfway leaves nothing behind. */
function create(db: DatabaseSync, top: Level, parent: number): Made {
  const make = new Maker(db);
  const row = (l: Level, under: number): number => {
    if (l.id !== null) return l.id;
    const name = l.name ?? "";
    if (l.kind === "release") return make.release(under, name);
    return l.kind === "epic" ? make.epic(under, name) : make.story(under, name);
  };

  const walk = (l: Level, under: number): Made => {
    const id = row(l, under);
    const requirements = l.requirements.map((r) => {
      const requirement = r.id ?? make.requirement(id, r.statement ?? "");
      const criteria = r.criteria.map((c) => {
        const criterion = make.criteria(requirement, c.statement);
        const test = make.acceptanceTest(criterion, c.statement, "script", c.test);
        const tasks = c.tasks.map((t) => {
          const scope: Scope = { write: [...t.scope], tools: [...t.tools] };
          const task = make.task(test, t.title, { role: t.role, scope });
          return { id: task, test: make.taskTest(task, t.title, "script", t.test) };
        });
        return { id: criterion, test, tasks };
      });
      return { id: requirement, criteria };
    });
    return { kind: l.kind, id, children: l.children.map((c) => walk(c, id)), requirements };
  };

  return walk(top, parent);
}

/** The start each rung of the tree gets, and the deliver each test gets, as the facade
 *  spells them. `engine.apply("requirement", id, "start", …)` was checked by nothing: the
 *  entity and the verb were strings, and a verb that no longer existed on that machine was
 *  a refusal at runtime. One method per rung says the same thing where the compiler can see
 *  it, in the shape `READ` above already uses for the same reason. */
const START: Record<Root | "requirement" | "acceptance_criteria" | "task", (v: Verbs, id: number) => Outcome> = {
  release: (v, id) => v.startRelease(id, OPERATOR),
  epic: (v, id) => v.startEpic(id, OPERATOR),
  story: (v, id) => v.startStory(id, OPERATOR),
  requirement: (v, id) => v.startRequirement(id, OPERATOR),
  acceptance_criteria: (v, id) => v.startAcceptanceCriteria(id, OPERATOR),
  task: (v, id) => v.startTask(id, OPERATOR),
};

const DELIVER: Record<"acceptance_test" | "task_test", (v: Verbs, id: number) => Outcome> = {
  acceptance_test: (v, id) => v.deliverAcceptanceTest(id, OPERATOR),
  task_test: (v, id) => v.deliverTaskTest(id, OPERATOR),
};

/** Delivers each test whose artefact resolves, and starts everything it created. A chain
 *  that needs six `start` commands afterwards is the same ceremony moved. */
function begin(db: DatabaseSync, made: Made): void {
  const verbs = new Verbs(new Engine(db));
  /** Starts a row still sitting in planned, and leaves one genuinely underway alone. The row
   *  a file joined by id may be either: joining #107 says where this work hangs, not that
   *  anyone ever started it, and a requirement running under a planned story can never be
   *  delivered because the story it would deliver through has not begun. */
  const go = (entity: Root | "requirement" | "acceptance_criteria" | "task", id: number): void => {
    if (READ[entity](queries(db), id)?.state === "planned") START[entity](verbs, id);
  };
  const deliver = (entity: "acceptance_test" | "task_test", id: number): void => {
    // Refused when the artefact is empty, which is the guard doing its job, not a failure.
    DELIVER[entity](verbs, id);
  };

  // Ancestors first: a child started under a parent still in planned is the bug this order
  // rules out, whether the parent was written by this file or joined by id.
  const walk = (l: Made): void => {
    go(l.kind, l.id);
    for (const c of l.children) walk(c);
    for (const r of l.requirements) {
      go("requirement", r.id);
      for (const c of r.criteria) {
        go("acceptance_criteria", c.id);
        deliver("acceptance_test", c.test);
        for (const t of c.tasks) {
          // The task_test is ready first, or the task may not be attempted.
          deliver("task_test", t.test);
          go("task", t.id);
        }
      }
    }
  };
  walk(made);
}

// ── printing ─────────────────────────────────────────────────────────────────────────────

interface Line {
  readonly label: string;
  readonly id: number | null;
  readonly state: string | null;
  readonly children: readonly Line[];
}

/** What it made, read back off the ledger's rows: ids come back as a shape, not one at a time.
 *  Which column names a rung is `READ`'s business now — a release is its version, the rest
 *  are titles or statements — so no name is spelled twice here. */
function shape(db: DatabaseSync, made: Made): Line {
  const q = queries(db);
  const of = (entity: Entity, id: number, children: readonly Line[] = []): Line => {
    const row = READ[entity](q, id);
    return { label: row?.label ?? "", id, state: row?.state ?? null, children };
  };

  const walk = (l: Made): Line =>
    of(l.kind, l.id, [
      ...l.children.map(walk),
      ...l.requirements.map((r) =>
        of(
          "requirement",
          r.id,
          r.criteria.map((c) =>
            of("acceptance_criteria", c.id, [
              of(
                "acceptance_test",
                c.test,
                c.tasks.map((t) => of("task", t.id, [of("task_test", t.test)])),
              ),
            ]),
          ),
        ),
      ),
    ]);

  return walk(made);
}

/** The same shape, before anything exists. */
function preview(top: Level, parent: number): Line {
  const line = (label: string, children: readonly Line[] = []): Line => ({ label, id: null, state: null, children });
  const artefact = (t: string | null): string => (t === null ? "no artefact" : t);

  const walk = (l: Level, root: boolean): Line =>
    line(root ? `${l.name ?? ""}   under ${ABOVE[l.kind] ?? "project"} #${parent}` : (l.name ?? ""), [
      ...l.children.map((c) => walk(c, false)),
      ...l.requirements.map((r) =>
        line(
          r.id === null ? (r.statement ?? "") : `requirement #${r.id}   joined`,
          r.criteria.map((c) =>
            line(c.statement, [
              line(
                `${c.statement}  [${artefact(c.test)}]`,
                c.tasks.map((t) =>
                  line(`${t.title}  ${t.role}  ${t.scope.join(", ")}`, [line(`${t.title}  [${artefact(t.test)}]`)]),
                ),
              ),
            ]),
          ),
        ),
      ),
    ]);

  // A root joined by id is printed as the row it is, with what this file would hang off it.
  const root = walk(top, top.id === null);
  return top.id === null ? root : { ...root, label: `${top.kind} #${top.id}   joined`, id: null };
}

// ── the scope the promises ask for ───────────────────────────────────────────────────────

/** The one answer this command does not have by the time it returns.
 *
 *  A repository index builds a snapshot before it can answer anything, so the proposal is
 *  async and `plan()` is not — bin.ts assigns what dispatch returns straight to
 *  process.exitCode, and a promise is not an exit code. So the proposal settles the exit
 *  code itself; node does not exit while that promise is outstanding. A caller who needs
 *  the answer rather than the printing awaits `proposedScope()`. */
let pending: Promise<number> = Promise.resolve(0);

/** What the last `wecode plan --propose-scope` answered, once it has. Zero when none has
 *  been asked. */
export const proposedScope = (): Promise<number> => pending;

function proposing(top: Level, root: string, openIndex: (root: string) => RepoIndex): number {
  const promising = [...tasksOf(top)].filter((t) => t.promises.length > 0);
  if (promising.length === 0) {
    return fail(
      [
        "no task in this plan promises a symbol, so there is nothing to propose a scope from.",
        '  promises: ["packages/tui/src/list.ts:renderList"]   on a task, and ask again',
      ].join("\n"),
    );
  }
  pending = propose(promising, root, openIndex).then((code) => {
    if (code !== 0) process.exitCode = code;
    return code;
  });
  return 0;
}

/** Every promising task's scope, asked of the tree and printed for a person to paste.
 *  Nothing is written: a scope is the operator's to widen or narrow, and a command that
 *  edited one from a promise would be the agent setting its own ceiling. */
async function propose(tasks: readonly Task[], root: string, openIndex: (root: string) => RepoIndex): Promise<number> {
  let index: RepoIndex;
  try {
    index = openIndex(root);
  } catch (err) {
    return fail(`${root}: ${(err as Error).message}`);
  }
  const out: string[] = [`the scope these promises ask for, in ${root}`];
  for (const task of tasks) {
    try {
      out.push(...proposal(task, await proposeScope(index, task.promises)));
    } catch (err) {
      // A broken index, which reads as itself. UnknownFile and UnknownSymbol never get
      // here — a promised module the index does not hold is an answer, not a failure.
      return fail((err as Error).message);
    }
  }
  process.stdout.write(`${[...out, "", "nothing created — a proposed scope is pasted by a person, never written"].join("\n")}\n`);
  return 0;
}

/** One task's proposal: the line to paste, then why each path of it is there. The reasons
 *  are under the scope rather than instead of it, because the paste is the point and the
 *  reasons are what a person disagrees with. */
function proposal(task: Task, p: Proposal): readonly string[] {
  const width = p.write.reduce((w, path) => Math.max(w, path.length), 0);
  return [
    "",
    `  ${task.title}`,
    `    scope: [${p.write.map((path) => `"${path}"`).join(", ")}]`,
    "",
    ...p.because.map((b) => `      ${b.path.padEnd(width)}   ${b.why}`),
  ];
}

/** Every task the plan holds, in the order the file writes them. */
function* tasksOf(level: Level): Generator<Task> {
  for (const child of level.children) yield* tasksOf(child);
  for (const requirement of level.requirements) {
    for (const criteria of requirement.criteria) yield* criteria.tasks;
  }
}

function render(root: Line): string {
  const out: string[] = [];
  const walk = (n: Line, prefix: string, last: boolean, top: boolean): void => {
    const elbow = top ? "" : last ? "└── " : "├── ";
    const id = n.id === null ? "" : `${grey(`#${n.id}`)} `;
    const state = n.state === null ? "" : `  ${grey(n.state)}`;
    out.push(`${prefix}${elbow}${id}${n.label}${state}\n`);
    const next = top ? "" : prefix + (last ? "    " : "│   ");
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, false));
  };
  walk(root, "", true, true);
  return out.join("");
}

const grey = (s: string): string => `[2m${s}[0m`;

function fail(why: string): number {
  process.stderr.write(`${why}\n`);
  return 1;
}
