import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import {
  Engine,
  Maker,
  currentDatabase,
  loadRoles,
  open,
  readProjectConfig,
  transact,
  withinCeiling,
  type ProjectConfig,
  type RoleConfig,
  type Scope,
} from "@wecode/core";

// yaml is @wecode/core's dependency, and this package declares none of its own. Resolving it
// from core's package rather than from here uses the one copy the workspace already has.
const { parse } = createRequire(new URL("../node_modules/@wecode/core/package.json", import.meta.url))("yaml") as {
  parse: (s: string) => unknown;
};

/** `wecode plan <file.yaml>` — docs/design/13. A whole story as one document: checked
 *  whole, created whole, started, and printed back as a shape. */
export function plan(args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { epic: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const file = positionals[0];
  if (file === undefined) return fail("wecode plan <file.yaml> [--epic <id>] [--dry-run]");
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

  if (said.length > 0 || shaped === null || shaped.top === null || parent === null) {
    return fail([`${file} is not a plan yet:`, ...said.map((s) => `  ${s}`)].join("\n"));
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
}
interface Criteria {
  readonly statement: string;
  readonly test: string | null;
  readonly tasks: readonly Task[];
}
interface Requirement {
  readonly statement: string;
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
  requirement: ["statement", "criteria"],
  criteria: ["statement", "test", "tasks"],
  task: ["title", "scope", "test", "role"],
} as const;

const DEFAULT_TOOLS = ["bash", "read", "edit", "write"] as const;

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
  return { root, join: top?.id ?? id(m[root]), parent, top };
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
  const statement = required(m, "statement", where, say);
  const criteria = list(m["criteria"], `${where}: criteria`, say)
    .map((c, i) => criterion(c, `${where}, criteria ${i + 1}`, config, roles, say))
    .filter((c) => c !== null);
  return statement === null ? null : { statement, criteria };
}

function criterion(
  v: unknown,
  where: string,
  config: ProjectConfig | null,
  roles: RoleConfig | null,
  say: string[],
): Criteria | null {
  const m = mapping(v, where, KEYS.criteria, say);
  if (m === null) return null;
  const statement = required(m, "statement", where, say);
  const test = optional(m["test"], `${where}: test`, say) ?? config?.test ?? null;
  const tasks = list(m["tasks"], `${where}: tasks`, say)
    .map((t, i) => task(t, `${where}, task ${i + 1}`, config, roles, say))
    .filter((t) => t !== null);
  if (statement === null) return null;

  // A criteria that names no test of its own has nobody writing one. The task that writes it
  // is the acceptance-tester's, not the engineer's — the two must not be the same pair of hands.
  const authoring = m["test"] === undefined ? authoringTask(statement, config, roles) : null;
  return { statement, test, tasks: authoring === null ? tasks : [...tasks, authoring] };
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
  };
}

function task(
  v: unknown,
  where: string,
  config: ProjectConfig | null,
  roles: RoleConfig | null,
  say: string[],
): Task | null {
  const m = mapping(v, where, KEYS.task, say);
  if (m === null) return null;
  const title = required(m, "title", where, say);
  const role = optional(m["role"], `${where}: role`, say) ?? "engineer";
  const test = optional(m["test"], `${where}: test`, say) ?? config?.test ?? null;

  const given = m["scope"] === undefined ? null : list(m["scope"], `${where}: scope`, say);
  const scope =
    given !== null
      ? given.filter((g): g is string => typeof g === "string")
      : config === null
        ? null
        : [...config.source, ...config.tests];

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

  return title === null || scope === null || scope.length === 0 ? null : { title, scope, tools, test, role };
}

// ── which parent ─────────────────────────────────────────────────────────────────────────

interface Here {
  readonly id: number;
  readonly name: string;
}

/** Whose project a row is in. Ids are global, so every id a file names is asked this. */
const OWNER: Record<Root, string> = {
  story:
    "SELECT p.id AS id, p.name AS name FROM story s JOIN epic e ON e.id = s.epic_id " +
    "JOIN release r ON r.id = e.release_id JOIN project p ON p.id = r.project_id WHERE s.id = ?",
  epic:
    "SELECT p.id AS id, p.name AS name FROM epic e JOIN release r ON r.id = e.release_id " +
    "JOIN project p ON p.id = r.project_id WHERE e.id = ?",
  release: "SELECT p.id AS id, p.name AS name FROM release r JOIN project p ON p.id = r.project_id WHERE r.id = ?",
};

/** The newest in-progress row of a kind in this project, which a sentence hangs off. */
const NEWEST: Record<"epic" | "release", string> = {
  epic:
    "SELECT e.id AS id FROM epic e JOIN release r ON r.id = e.release_id " +
    "WHERE r.project_id = ? AND e.state = 'in_progress' ORDER BY e.id DESC LIMIT 1",
  release: "SELECT id FROM release WHERE project_id = ? AND state = 'in_progress' ORDER BY id DESC LIMIT 1",
};

/** The same guard `create` has. Ids are global. */
function owned(db: DatabaseSync, kind: Root, row: number, here: Here | undefined, say: string[]): boolean {
  const theirs = db.prepare(OWNER[kind]).get(row) as Here | undefined;
  if (theirs === undefined) {
    say.push(`no ${kind} #${row}`);
    return false;
  }
  if (here !== undefined && theirs.id !== here.id) {
    say.push(`${kind} #${row} belongs to project #${theirs.id} ${theirs.name}, but you are in #${here.id} ${here.name}`);
    return false;
  }
  return true;
}

/** The row the file hangs off: the parent named in the file, then `--epic`, then the newest
 *  in-progress row above it. A root given as an id joins that row instead, and needs none. */
function parentOf(db: DatabaseSync, p: Plan, flag: string | undefined, say: string[]): number | null {
  const here = db.prepare("SELECT id, name FROM project WHERE repo = ?").get(resolve(process.cwd())) as Here | undefined;

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
    if (here === undefined) {
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
      return (db.prepare("SELECT release_id AS id FROM epic WHERE id = ?").get(n) as { id: number }).id;
    }
  }

  if (asked !== null) return owned(db, kind, asked, here, say) ? asked : null;

  if (here === undefined) {
    say.push(`no ${kind} given, and this repository is not an onboarded project.\n  --epic <id>`);
    return null;
  }
  const newest = db.prepare(NEWEST[kind]).get(here.id) as { id: number } | undefined;
  if (newest === undefined) {
    say.push(`no ${kind} given, and project #${here.id} ${here.name} has no in-progress ${kind}.\n  --epic <id>`);
    return null;
  }
  return newest.id;
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
      const requirement = make.requirement(id, r.statement);
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

/** Delivers each test whose artefact resolves, and starts everything it created. A chain
 *  that needs six `start` commands afterwards is the same ceremony moved. */
function begin(db: DatabaseSync, made: Made): void {
  const engine = new Engine(db);
  /** Starts a row still sitting in planned, and leaves one genuinely underway alone. The row
   *  a file joined by id may be either: joining #107 says where this work hangs, not that
   *  anyone ever started it, and a requirement running under a planned story can never be
   *  delivered because the story it would deliver through has not begun. */
  const go = (entity: Root | "requirement" | "acceptance_criteria" | "task", id: number): void => {
    const row = db.prepare(`SELECT state FROM ${entity} WHERE id = ?`).get(id) as { state: string } | undefined;
    if (row?.state === "planned") engine.apply(entity, id, "start", "operator");
  };
  const deliver = (entity: "acceptance_test" | "task_test", id: number): void => {
    // Refused when the artefact is empty, which is the guard doing its job, not a failure.
    engine.apply(entity, id, "deliver", "operator");
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

/** The column each rung is named by. A release is its version; the rest are titles. */
const NAMED: Record<Root, string> = { release: "version", epic: "title", story: "title" };

/** What it made, read back off the ledger's rows: ids come back as a shape, not one at a time. */
function shape(db: DatabaseSync, made: Made): Line {
  const of = (table: string, id: number, label: string, children: readonly Line[] = []): Line => {
    const row = db.prepare(`SELECT ${label} AS label, state FROM ${table} WHERE id = ?`).get(id) as
      | { label: string; state: string }
      | undefined;
    return { label: row?.label ?? "", id, state: row?.state ?? null, children };
  };

  const walk = (l: Made): Line =>
    of(l.kind, l.id, NAMED[l.kind], [
      ...l.children.map(walk),
      ...l.requirements.map((r) =>
        of(
          "requirement",
          r.id,
          "statement",
          r.criteria.map((c) =>
            of("acceptance_criteria", c.id, "statement", [
              of(
                "acceptance_test",
                c.test,
                "statement",
                c.tasks.map((t) => of("task", t.id, "title", [of("task_test", t.test, "statement")])),
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
          r.statement,
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
