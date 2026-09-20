/** The commands that print a listing or a manual.
 *
 *  `workspaces`, `tree`, `lessons` and `<entity> --help` all answer with a list of what is
 *  there — the workspaces on this machine, the shape of one project, what earlier attempts
 *  learned, the states and verbs an entity has. `lesson drop` is here with them because a
 *  wrong lesson is read off the same list it is dropped from.
 *
 *  The one manual that is not here is `usage()` itself. It stays in run.ts because
 *  `capabilities.ts` reads the self-description out of that file's text — it slices the
 *  manual by `run.indexOf("function usage(")` — so the lines are data held where the
 *  scrape looks for them, and moving them would silently empty `wecode capabilities`.
 *
 *  Everything here is lent the workspace database and how a refusal is said, the same way
 *  the entity verbs are, plus the one thing only run.ts knows: which project you are
 *  standing in. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  currentDatabase,
  databaseOf,
  dropLesson,
  lessons,
  listWorkspaces,
  loadMachines,
  open,
  tree,
  RESTATABLE,
  STATEFUL,
  type Node,
  type StatefulEntity,
} from "@wecode/core";
// The typed query layer is not on `@wecode/core`'s index, so it is reached by its own path.
import { queries } from "@wecode/core/dist/db.js";
import { assignment, project, type At } from "./entity.js";

/** What a listing is lent: everything `At` carries, and the project this repository is —
 *  which is run.ts's to answer, because it is the one that knows where you are standing. */
export interface Look extends At {
  readonly here: () => { id: number; name: string } | null;
}

const isStateful = (s: string): s is StatefulEntity => (STATEFUL as readonly string[]).includes(s);

const dimNum = (id: number): string => `\u001b[2m#${id}\u001b[0m`;
const grey = (s: string): string => `\u001b[2m${s}\u001b[0m`;

/** `wecode workspaces` — which ones exist, and which one you are talking to. */
export function workspaces(at: Look): number {
  const known = listWorkspaces();
  if (known.length === 0) {
    return at.fail("no workspaces yet.\n  wecode onboard   in a repository, to make one");
  }
  const here = currentDatabase();
  for (const name of known) {
    const path = databaseOf(name);
    const n = existsSync(path) ? projectCount(path) : 0;
    process.stdout.write(`${path === here ? "*" : " "} ${name.padEnd(16)} ${n} project${n === 1 ? "" : "s"}\n`);
  }
  return 0;
}

export function projectCount(path: string): number {
  const conn = open(path);
  // No `count(*)` in the dialect. One column of every row is what a count over a table this
  // size costs anyway, and it is a number nothing has to be cast to.
  const n = queries(conn).selectFrom(project).select(["id"]).all().length;
  conn.close();
  return n;
}

/** `wecode tree [project]` — the whole shape, project to task_test. */
export function showTree(at: Look, args: readonly string[]): number {
  const only = args[0] === undefined ? undefined : Number(args[0]);
  const nodes = tree(at.conn(), only);
  if (nodes.length === 0) return at.fail(only === undefined ? "no projects yet" : `no project #${only}`);

  const mark: Readonly<Record<string, string>> = {
    delivered: "✓",
    released: "✓",
    met: "✓",
    accepted: "✓",
    passed: "✓",
    done: "✓",
    dropped: "·",
    failed: "✗",
    on_hold: "‖",
  };

  const walk = (n: Node, prefix: string, last: boolean, top: boolean): void => {
    const elbow = top ? "" : last ? "└── " : "├── ";
    const state = mark[n.state] ?? "○";
    const label = n.label.length > 64 ? `${n.label.slice(0, 63)}…` : n.label;
    process.stdout.write(`${prefix}${elbow}${state} ${dimNum(n.id)} ${label}  ${grey(n.state)}\n`);
    const next = top ? "" : prefix + (last ? "    " : "│   ");
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, false));
  };

  for (const root of nodes) walk(root, "", true, true);
  return 0;
}

/** What to say to somebody standing in a directory that is not a project: the command that
 *  would put one here, and — only when the workspace already holds projects — the ids that
 *  could be asked for instead. "no project here" alone left the next move to be guessed,
 *  and the guess was usually that the workspace was broken. */
function noProjectHere(at: Look, command: string): string {
  const rows = queries(at.conn())
    .selectFrom(project)
    .select(["id", "name"])
    .all()
    .sort((a, b) => a.id - b.id);
  const shown = rows.slice(0, 5).map((r) => `    #${r.id}  ${r.name}`);
  const more = rows.length > shown.length ? [`    … and ${rows.length - shown.length} more`] : [];
  return [
    // The first clause is kept as it was: another test reads this refusal by that phrase.
    `no project here — ${resolve(process.cwd())} is not one.`,
    "  wecode onboard   here, to make this repository one",
    ...(rows.length === 0 ? [] : [`  ${command} --project <id>   for a project you already have:`, ...shown, ...more]),
  ].join("\n");
}

/** `wecode lessons [--project N]` — what earlier attempts on this repository learned.
 *
 *  Each line carries the assignment that learned it and how old it is, because those are
 *  what a suspicious lesson is judged on: a lesson is a note about a world that changes. */
export function showLessons(at: Look, args: readonly string[]): number {
  const { values } = parseArgs({ args: [...args], options: { project: { type: "string" } } });
  const chosen = values.project === undefined ? at.here()?.id ?? null : Number(values.project);
  if (chosen === null) {
    return at.fail(noProjectHere(at, "wecode lessons"));
  }
  if (!Number.isInteger(chosen)) return at.fail("wecode lessons --project <id>");

  const conn = at.conn();
  const found = lessons(conn, chosen);
  if (found.length === 0) {
    process.stdout.write("no lessons here yet\n");
    return 0;
  }
  for (const l of found) {
    const from = l.assignment_id === null ? "by hand" : assignmentName(conn, l.assignment_id);
    process.stdout.write(`  #${String(l.id).padStart(3)}  ${l.text}\n`);
    process.stdout.write(`        ${grey(`${from} · ${age(l.created_at)}`)}\n`);
  }
  return 0;
}

/** The assignment a lesson came from, so a suspicious one can be traced back to the attempt
 *  that wrote it. The foreign key is what makes the row certain to be there. */
function assignmentName(conn: ReturnType<typeof open>, id: number): string {
  const row = queries(conn).selectFrom(assignment).select(["slug"]).where("id", "=", id).get();
  return row === null ? `assignment #${id}` : `${row.slug} #${id}`;
}

function age(when: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(when)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

/** `wecode lesson drop <id>` — the operator's call, like everything else that is a
 *  judgement. A wrong lesson is worse than none, so this is one command with no ceremony. */
export function lesson(at: Look, args: readonly string[]): number {
  const [name, raw] = args;
  if (name !== "drop") return at.fail("wecode lesson drop <id>");
  const id = Number(raw);
  if (!Number.isInteger(id)) return at.fail("wecode lesson drop <id>");
  if (!dropLesson(at.conn(), id)) return at.fail(`no lesson #${id}`);
  process.stdout.write(`lesson #${id} dropped\n`);
  return 0;
}

/** Every state and verb an entity has, read off the machine table — so help cannot drift
 *  from what the engine will actually allow. */
export function entityHelp(at: Look, entity: string): number {
  if (!isStateful(entity)) return at.fail(`${entity} has no states. Its only verb is create.`);

  const m = loadMachines()[entity];
  process.stdout.write(`${entity}\n\n  states  ${m.states.join(" · ")}\n\n`);

  const width = Math.max(...m.transitions.map((t) => t.verb.length));
  for (const t of m.transitions) {
    const guard = t.guard === undefined ? "" : `  [${t.guard}]`;
    const who = t.automatic === true ? "  (automatic — nobody invokes it)" : "";
    process.stdout.write(`  ${t.verb.padEnd(width)}  ${t.from.join(" | ")} → ${t.to}${guard}${who}\n`);
  }
  process.stdout.write(`\n  wecode ${entity} <verb> <id>\n\n`);
  return 0;
}

export function restateHelp(): number {
  process.stdout.write(
    [
      `wecode <${Object.keys(RESTATABLE).join("|")}> restate <id> --to "<words>"`,
      "",
      "  correct the wording of a record without dropping it. the old wording goes on",
      "  the ledger, so the correction is itself part of the record.",
      "",
      "  the slug does not move: worktrees and branches are named after it.",
      "  this corrects words only — it can never change a state.",
      "",
      '  wecode story restate 201 --to "the typescript build ships a bundle"',
      "",
      "",
    ].join("\n"),
  );
  return 0;
}
