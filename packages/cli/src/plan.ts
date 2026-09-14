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
  const epic = epicOf(db, shaped?.epic ?? null, values.epic, said);

  if (said.length > 0 || shaped === null || epic === null) {
    return fail([`${file} is not a plan yet:`, ...said.map((s) => `  ${s}`)].join("\n"));
  }

  if (values["dry-run"] === true) {
    process.stdout.write(render(preview(shaped, epic)));
    process.stdout.write("nothing created — this was a dry run\n");
    return 0;
  }

  const made = transact(db, () => create(db, shaped, epic));
  begin(db, made);
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
interface Plan {
  readonly story: string;
  readonly epic: number | null;
  readonly requirements: readonly Requirement[];
}

const KEYS = {
  top: ["story", "epic", "requirements"],
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

function read(doc: unknown, config: ProjectConfig | null, roles: RoleConfig | null, say: string[]): Plan | null {
  const top = mapping(doc, "the file", KEYS.top, say);
  if (top === null) return null;

  const story = required(top, "story", "the file", say);

  let epic: number | null = null;
  if (top["epic"] !== undefined) {
    const n = Number(top["epic"]);
    if (!Number.isInteger(n)) say.push("the file: epic must be an id");
    else epic = n;
  }

  const raw = list(top["requirements"], "the file: requirements", say);
  if (raw.length === 0) say.push("the file: requirements is required, and holds at least one");

  const requirements = raw
    .map((r, i) => requirement(r, `requirement ${i + 1}`, config, roles, say))
    .filter((r) => r !== null);

  return story === null ? null : { story, epic, requirements };
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
  return statement === null ? null : { statement, test, tasks };
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

// ── which epic ───────────────────────────────────────────────────────────────────────────

/** The file's `epic`, then `--epic`, then the newest in-progress epic of this project. */
function epicOf(db: DatabaseSync, inFile: number | null, flag: string | undefined, say: string[]): number | null {
  const here = db.prepare("SELECT id, name FROM project WHERE repo = ?").get(resolve(process.cwd())) as
    | { id: number; name: string }
    | undefined;

  const asked = inFile ?? (flag === undefined ? null : Number(flag));
  if (asked !== null) {
    if (!Number.isInteger(asked)) {
      say.push(`--epic ${String(flag)} is not an id`);
      return null;
    }
    const theirs = db
      .prepare(
        "SELECT p.id AS id, p.name AS name FROM epic e JOIN release r ON r.id = e.release_id " +
          "JOIN project p ON p.id = r.project_id WHERE e.id = ?",
      )
      .get(asked) as { id: number; name: string } | undefined;

    if (theirs === undefined) {
      say.push(`no epic #${asked}`);
      return null;
    }
    // The same guard `create` has. Ids are global.
    if (here !== undefined && theirs.id !== here.id) {
      say.push(
        `epic #${asked} belongs to project #${theirs.id} ${theirs.name}, but you are in #${here.id} ${here.name}`,
      );
      return null;
    }
    return asked;
  }

  if (here === undefined) {
    say.push("no epic given, and this repository is not an onboarded project.\n  --epic <id>");
    return null;
  }
  const newest = db
    .prepare(
      "SELECT e.id AS id FROM epic e JOIN release r ON r.id = e.release_id " +
        "WHERE r.project_id = ? AND e.state = 'in_progress' ORDER BY e.id DESC LIMIT 1",
    )
    .get(here.id) as { id: number } | undefined;
  if (newest === undefined) {
    say.push(`no epic given, and project #${here.id} ${here.name} has no in-progress epic.\n  --epic <id>`);
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
  readonly story: number;
  readonly requirements: readonly MadeRequirement[];
}

/** Every row `create` would have written, in the same order. Called inside one transaction:
 *  a file that fails halfway leaves nothing behind. */
function create(db: DatabaseSync, p: Plan, epic: number): Made {
  const make = new Maker(db);
  const story = make.story(epic, p.story);

  const requirements = p.requirements.map((r) => {
    const requirement = make.requirement(story, r.statement);
    const criteria = r.criteria.map((c) => {
      const id = make.criteria(requirement, c.statement);
      const test = make.acceptanceTest(id, c.statement, "script", c.test);
      const tasks = c.tasks.map((t) => {
        const scope: Scope = { write: [...t.scope], tools: [...t.tools] };
        const task = make.task(test, t.title, { role: t.role, scope });
        return { id: task, test: make.taskTest(task, t.title, "script", t.test) };
      });
      return { id, test, tasks };
    });
    return { id: requirement, criteria };
  });

  return { story, requirements };
}

/** Delivers each test whose artefact resolves, and starts everything it created. A chain
 *  that needs six `start` commands afterwards is the same ceremony moved. */
function begin(db: DatabaseSync, made: Made): void {
  const engine = new Engine(db);
  const go = (entity: "story" | "requirement" | "acceptance_criteria" | "task", id: number, verb: string): void => {
    engine.apply(entity, id, verb, "operator");
  };
  const deliver = (entity: "acceptance_test" | "task_test", id: number): void => {
    // Refused when the artefact is empty, which is the guard doing its job, not a failure.
    engine.apply(entity, id, "deliver", "operator");
  };

  go("story", made.story, "start");
  for (const r of made.requirements) {
    go("requirement", r.id, "start");
    for (const c of r.criteria) {
      go("acceptance_criteria", c.id, "start");
      deliver("acceptance_test", c.test);
      for (const t of c.tasks) {
        // The task_test is ready first, or the task may not be attempted.
        deliver("task_test", t.test);
        go("task", t.id, "start");
      }
    }
  }
}

// ── printing ─────────────────────────────────────────────────────────────────────────────

interface Line {
  readonly label: string;
  readonly id: number | null;
  readonly state: string | null;
  readonly children: readonly Line[];
}

/** What it made, read back off the ledger's rows: ids come back as a shape, not one at a time. */
function shape(db: DatabaseSync, made: Made): Line {
  const of = (table: string, id: number, label: string, children: readonly Line[] = []): Line => {
    const row = db.prepare(`SELECT ${label} AS label, state FROM ${table} WHERE id = ?`).get(id) as
      | { label: string; state: string }
      | undefined;
    return { label: row?.label ?? "", id, state: row?.state ?? null, children };
  };

  return of(
    "story",
    made.story,
    "title",
    made.requirements.map((r) =>
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
  );
}

/** The same shape, before anything exists. */
function preview(p: Plan, epic: number): Line {
  const line = (label: string, children: readonly Line[] = []): Line => ({ label, id: null, state: null, children });
  const artefact = (t: string | null): string => (t === null ? "no artefact" : t);

  return line(
    `${p.story}   under epic #${epic}`,
    p.requirements.map((r) =>
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
  );
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
