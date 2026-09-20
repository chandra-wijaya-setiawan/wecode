import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  actorOf,
  Completions,
  Engine,
  Maker,
  OPERATOR,
  currentDatabase,
  databaseOf,
  open,
  restate,
  isRestatable,
  RESTATABLE,
  STATEFUL,
  TRANSITIONS,
  Verbs,
  type Actor,
  type Outcome,
  type StatefulEntity,
  type TestKind,
  type WorkerKind,
} from "@wecode/core";
// The typed query layer is not on `@wecode/core`'s index, so it is reached by its own path.
import { queries } from "@wecode/core/dist/db.js";
// What a record is: the tables, the shape of the tree, and the verbs that amend one row —
// scope, artefact, retry. Namespaced because `task`, `project` and `scope` are all words
// this file uses for something else.
import * as ent from "./verbs/entity.js";
// The making verbs: create's help, and the artefact a test is proved by.
import * as make from "./verbs/make.js";
import { paint } from "./paint.js";
// The verbs that act. Namespaced because several of them — `worker`, `answer` — are also
// words this file uses for a table or a column.
import * as act from "./verbs/run-and-see.js";
// The verbs that only look: board, doctor, delivered, explore, design. Namespaced for the
// same reason — `board` and `design` are also words this file uses.
import * as see from "./verbs/see.js";
// Namespaced because `tree` is already the core query that reads the whole shape back.
import * as rungs from "./verbs/tree.js";
// Namespaced for the same reason: `requirement` and `task` are already tables in this file.
import * as work from "./verbs/work.js";
// The listings and the two help texts that are not the manual: workspaces, tree, lessons,
// an entity's states and verbs. Namespaced because `lesson` and `workspaces` are words
// this file's dispatch spells too.
import * as use from "./verbs/usage.js";
// The two commands that hold the process open. Namespaced because `wait` is the name of
// the head dispatch compares against as well as the name of the function.
import * as until from "./verbs/wait.js";

const DB = (): string => currentDatabase();

const isStateful = (s: string): s is StatefulEntity => (STATEFUL as readonly string[]).includes(s);

export function run(argv: readonly string[]): number {
  try {
    return dispatch(argv);
  } catch (err) {
    return fail(err instanceof Missing ? err.message : `${(err as Error).message}`);
  }
}

function dispatch(argv: readonly string[]): number {
  const [head, ...rest] = argv;
  if (head === undefined || head === "--help" || head === "-h" || (head === "help" && rest.length === 0)) {
    return usage();
  }
  // --help after a command is the whole manual; after an entity it is that entity's verbs.
  if (rest[0] === "--help" || rest[0] === "-h") return isStateful(head) ? use.entityHelp(look, head) : usage();
  if (head === "help") {
    const what = rest[0] ?? "";
    return isStateful(what) ? use.entityHelp(look, what) : usage();
  }
  if (head === "board") return see.board(seen(rest));
  if (head === "doctor") return see.doctor(rest);
  if (head === "init") return init(rest);
  if (head === "answer") return act.answer(seen(rest));
  if (head === "ask") return act.ask(seen(rest));
  if (head === "show") return show(rest);
  if (head === "land") return act.land(seen(rest));
  if (head === "onboard") return act.onboard(seen(rest));
  if (head === "plan") return act.plan(rest);
  if (head === "explore") return later(see.explore(rest));
  if (head === "paint") return later(paint(rest));
  if (head === "workspaces") return use.workspaces(look);
  if (head === "tree") return use.showTree(look, rest);
  if (head === "watch") return until.watch(at, rest);
  if (head === "wait") return until.wait(at, rest);
  // Before verb(): `delivered` is a story state as well as a command, so falling through
  // would read it as an entity and answer "delivered has no states".
  if (head === "delivered") return see.delivered(rest);
  if (head === "lessons") return use.showLessons(look, rest);
  if (head === "lesson") return use.lesson(look, rest);
  return verb(head, rest);
}

/** The commands whose answer is not known by the time dispatch returns.
 *
 *  A repository index builds a snapshot, and the projector loads `@wecode/lens` at the moment
 *  of use, so both are async and `run()` is not — bin.ts assigns what run() returns straight to
 *  process.exitCode, and a promise is not an exit code. So the command settles the exit
 *  code itself once the index has answered; node does not exit while that promise is
 *  outstanding, and nothing after it here overwrites a non-zero one.
 *
 *  A caller who needs the answer rather than the side effect awaits `answered()`. */
let pending: Promise<number> = Promise.resolve(0);

function later(answer: Promise<number>): number {
  pending = answer.then((code) => {
    if (code !== 0) process.exitCode = code;
    return code;
  });
  return 0;
}

/** What the last such command answered, once it has. Zero when none has been asked. */
export const answered = (): Promise<number> => pending;

/** `wecode init [name] [--workspace <name>]` — an empty workspace, and nothing else.
 *
 *  A workspace holds projects; onboarding a repository is what puts one in it. This exists
 *  for the case where you want the workspace before you have a repository.
 *
 *  Which workspace it makes is not read off the directory you are standing in. Resolving
 *  through this repository's pointer made `wecode init` inside an onboarded repo report
 *  "workspace at …/acme" — it named the workspace you were already in and created nothing.
 *  A name given here wins; otherwise an explicit database, then an explicit name in the
 *  environment, then "default". The pointer never decides. */
function init(args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { workspace: { type: "string" } },
  });
  const asked = values.workspace ?? positionals[0];
  const path =
    asked !== undefined
      ? databaseOf(asked)
      : process.env["WECODE_DB"] !== undefined
        ? resolve(process.env["WECODE_DB"])
        : databaseOf(process.env["WECODE_WORKSPACE"] ?? "default");

  mkdirSync(dirname(path), { recursive: true });
  open(path).close();
  process.stdout.write(`workspace at ${path}\n  wecode onboard   in a repository, to put a project in it\n`);
  return 0;
}

// ─── the record ──────────────────────────────────────────────────────────────────────────
//
// The tables, the row shapes and the shape of the tree live in `verbs/entity.ts` now. They
// are still reached by this file's name, because this is the name the rest of the cli knows
// them by: `verbs/run-and-see.ts` imports the row types from here, and `typed-run.test.ts`
// holds DECLARED against `PRAGMA table_info`.
export type {
  AcceptanceTestRow, AssignmentRow, CriteriaRow, LandedRow, ProjectRow, RequirementRow,
  StoryRow, TaskRow, TestRow, WorkerRow, WorkspaceRow,
} from "./verbs/entity.js";
export { DECLARED } from "./verbs/entity.js";

const {
  acceptanceTest, assignment, criteria, project, requirement, story, task, worker,
  workspace, landedBranch, ENTITIES,
} = ent;

/** What the entity half is lent: the workspace database, how a refusal is said, and who is
 *  asking. The three things only this file knows. */
const at: ent.At = { conn: db, fail, actor: () => whoIsAsking() };

/** What a listing in `verbs/usage.ts` is lent on top of that: the project this repository
 *  is, which is this file's to answer because it is the one that knows where you stand. */
const look: use.Look = { ...at, here: () => hereProject() };

/** The project this repository is, or null when you are standing outside all of them. */
function hereProject(): { id: number; name: string } | null {
  return queries(db())
    .selectFrom(project)
    .select(["id", "name"])
    .where("repo", "=", resolve(process.cwd()))
    .get();
}

/** What run.ts lends the verbs in `verbs/run-and-see.ts`: the argv tail they were given,
 *  and the four things only this file knows — the workspace database, how a refusal is
 *  said, where you are standing, and the tables. */
const TABLES: act.Tables = {
  workspace, project, story, requirement, criteria, acceptanceTest, task, worker, assignment, landedBranch,
};

const seen = (args: readonly string[]): act.See => ({
  args, conn: db, fail, hereProject, actor: whoIsAsking, tables: TABLES,
});

/** `wecode show <entity> <id>` — one record, whatever state it is in, and where it lives.
 *
 *  A record is shown in every state, dropped and done included: somebody reading an id out of
 *  old notes is asking what became of it, and a refusal answers that with silence. When the id
 *  is not there at all, the ids that are there are the answer — the epic did not vanish, it was
 *  rebuilt under another number, and only a list of the live ones says so. */
function show(args: readonly string[]): number {
  const [entity, raw] = args;
  const id = Number(raw);
  if (entity === undefined || !Number.isInteger(id)) return fail("wecode show <entity> <id>");
  const kind = ENTITIES[entity];
  if (kind === undefined) {
    return fail(`no entity called ${entity}. There is ${Object.keys(ENTITIES).join(", ")}`);
  }
  const q = queries(db());
  const row = kind.row(q, id);
  if (row === null) return fail(ent.instead(q, entity, id));
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === "") continue;
    process.stdout.write(`${k.padEnd(18)} ${String(v)}\n`);
  }
  const owner = ent.projectOf(at, entity, id);
  if (owner !== null) process.stdout.write(`${"project".padEnd(18)} #${owner.id} ${owner.name}\n`);
  return 0;
}

/** Every command but init and onboard needs a database. A missing one is the commonest
 *  first contact there is — it used to be an unhandled exception and a stack trace. */
function db() {
  const path = DB();
  if (!existsSync(path)) {
    throw new Missing(
      `no wecode workspace at ${path}.\n  wecode onboard   to set this project up`,
    );
  }
  return open(path);
}

class Missing extends Error {}



/** One invocation of the facade: every method on `Verbs` and on `Completions` takes an id
 *  and an actor and answers an Outcome, so a verb resolved off the command line has this
 *  one shape. */
type Invocation = (id: number, actor: Actor) => Outcome;

/** Who the command is attributed to: the environment's actor, or the person at the terminal.
 *  One place, so no command invents a second spelling of the same identity — and a blank
 *  `WECODE_ACTOR` is nobody rather than an empty name on the ledger. */
const whoIsAsking = (): Actor => actorOf(process.env["WECODE_ACTOR"]) ?? OPERATOR;

/** The facade method the command line's `<entity> <verb>` names, or null when no row of the
 *  machine table names that verb at all.
 *
 *  The machine table is not copied here. `TRANSITIONS` is generated beside `Verbs` from the
 *  same config and carries each row's method name, so the lookup resolves a name it was
 *  given rather than one this file spells — a verb renamed in machines.yaml regenerates
 *  both sides and this keeps working.
 *
 *  A declared verb resolves either way: an actor's verb to a `Verbs` method, a completion
 *  verb — `story deliver`, `task finish` — to a `Completions` one. The engine judged both
 *  before and judges both now, through the same guard; what is gone is the string call that
 *  reached them. Null is left for one thing only, a verb nobody declared. */
function invocation(
  verbs: Verbs,
  completions: Completions,
  entity: StatefulEntity,
  name: string,
): Invocation | null {
  const row = TRANSITIONS.find((t) => t.entity === entity && t.verb === name);
  if (row === undefined) return null;
  // Generated names, held against the two classes by facade.test.ts, so one descriptor is
  // there: `method` and `completion` are never both null and never both set.
  const on = row.method === null ? Completions.prototype : Verbs.prototype;
  const found = Object.getOwnPropertyDescriptor(on, row.method ?? (row.completion as string));
  const method = found?.value as Invocation | undefined;
  const self = row.method === null ? completions : verbs;
  return method === undefined ? null : (id, actor) => method.call(self, id, actor);
}

/** `wecode <entity> <verb> [id|args]` — the surface in docs/design/06. */
function verb(entity: string, rest: readonly string[]): number {
  const [name, ...args] = rest;
  if (name === undefined) return fail(`wecode ${entity} <verb> …`);

  // `design` is the one word that names both a record and a drawing. `show` is the
  // drawing — a screen declared in a file, projected to an svg, no ledger involved — and
  // every other verb, `create` first, is the row, so it goes on down this function.
  // The split is here rather than in dispatch() so the row stays the default and the
  // drawing the exception, both read in one place.
  if (entity === "design" && name === "show") return later(see.design([name, ...args]));

  // parseArgs would call --help an unknown option. It is the one place a newcomer looks
  // for create's flags, so answer it here, before the flags are parsed at all.
  const asked = args.some((a) => a === "--help" || a === "-h");
  if (name === "create") return asked ? make.createHelp(at, entity) : create(entity, args);
  if (name === "scope") return asked ? ent.scopeHelp() : ent.scope(at, entity, args);
  if (name === "artefact") return asked ? make.artefactHelp() : make.artefact(at, entity, args);
  if (name === "restate") return asked ? use.restateHelp() : restateVerb(entity, args);
  if (name === "retry" && entity === "task") return ent.retry(at, args);

  if (!isStateful(entity)) return fail(`${entity} has no states; its only verb is create`);
  const id = Number(args[0]);
  if (!Number.isInteger(id)) return fail(`wecode ${entity} ${name} <id>`);

  const actor = whoIsAsking();
  const engine = new Engine(db());
  const invoke = invocation(new Verbs(engine), new Completions(engine), entity, name);
  // Only a verb no row of the machine table declares is left to the string call, and the
  // engine answers it with the same sentence it always did.
  const out = invoke === null ? engine.apply(entity, id, name, actor) : invoke(id, actor);
  if (!out.ok) return fail(out.why);

  for (const c of out.changes) {
    process.stdout.write(`${c.entity} #${c.id}  ${c.from} → ${c.to}${c.automatic ? "  (cascade)" : ""}\n`);
  }
  return 0;
}

/** `wecode story restate <id> --to "the words that are right"`
 *
 *  The cure for a typo. Before this the only route was to drop the record and create it
 *  again, which costs the slug (taken forever, so the replacement must be worded round it),
 *  a drop event on the ledger for what was a typo, and every record citing the id, which
 *  now points at a dropped row.
 *
 *  It takes only words. There is no flag here that names a state, and none is accepted:
 *  what happened to a record is a verdict, and a verdict is not a thing you retype. */
function restateVerb(entity: string, args: readonly string[]): number {
  if (!isRestatable(entity)) {
    return fail(`only ${Object.keys(RESTATABLE).join(", ")} carry prose to restate`);
  }
  const how = `wecode ${entity} restate <id> --to "<the words that are right>"`;
  let values: { to?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { to: { type: "string" } },
    }));
  } catch {
    // An unknown flag — `--state` among them — is the usage line, not a crash.
    return fail(how);
  }
  const id = Number(positionals[0]);
  if (!Number.isInteger(id) || values.to === undefined) return fail(how);

  // The same guard scope and artefact have: ids are global, and this one writes.
  const wrong = ent.elsewhere(at, entity, id);
  if (wrong !== null) return fail(wrong);

  try {
    const who = whoIsAsking();
    const said = restate(db(), entity, id, values.to, who);
    process.stdout.write(`${entity} #${id} restated  was "${said.was}"  now "${said.now}"\n`);
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}


function create(entity: string, args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      parent: { type: "string" }, kind: { type: "string" }, artefact: { type: "string" },
      role: { type: "string" }, path: { type: "string" }, project: { type: "string" },
    },
  });
  const text = positionals.join(" ");
  const parent = Number(values["parent"]);

  // Ids are global. A parent in another project's tree is how a story ends up built in the
  // wrong repository — the agents run wherever the task's project points, which is correct
  // and was not what anybody meant.
  if (Number.isInteger(parent) && values["project"] === undefined) {
    const wrong = ent.crossesProject(at, entity, parent);
    if (wrong !== null) return fail(wrong);
  }
  const make = new Maker(db());
  const needsParent = (): number => {
    if (!Number.isInteger(parent)) throw new Error(`wecode ${entity} create --parent <id> "<text>"`);
    return parent;
  };
  const rung: rungs.Rung = { make, text, parent: needsParent, path: values["path"] ?? process.cwd() };
  // A thunk, so the artefact fallback only reads the project's config when a test is what
  // is being made — it is a question about the working directory, and the other three
  // never asked it.
  const job = (): work.Work => ({
    make, text, parent: needsParent,
    kind: kindOf(values["kind"]), artefact: artefactOr(values["artefact"]), role: values["role"] ?? "",
  });

  try {
    let id: number;
    switch (entity) {
      case "workspace": id = rungs.workspace(rung); break;
      case "project": id = rungs.project(rung); break;
      case "release": id = rungs.release(rung); break;
      case "epic": id = rungs.epic(rung); break;
      case "story": id = rungs.story(rung); break;
      case "requirement": id = work.requirement(job()); break;
      case "acceptance_criteria": id = work.acceptanceCriteria(job()); break;
      case "acceptance_test": id = work.acceptanceTest(job()); break;
      case "task_test": id = work.taskTest(job()); break;
      case "task": id = work.task(job()); break;
      case "worker":
        id = act.worker({
          make, text, role: values["role"] ?? "", kind: (values["kind"] ?? "agent") as WorkerKind,
        });
        break;
      default:
        return fail(`no such entity: ${entity}`);
    }
    // Say what it joined. --parent takes any number, and ids are global: attaching to
    // another project's tree is silent otherwise, and was.
    process.stdout.write(`${entity} #${id}${ent.under(at, entity, id)}\n`);
    return 0;
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** A test with no artefact falls back to the project's own test command, which onboarding
 *  learned from the repository. Retyping it into every test is how they drift. */
function artefactOr(given: string | undefined): string | null {
  if (given !== undefined) return given;
  return ent.projectConfig()?.test ?? null;
}

function kindOf(v: string | undefined): TestKind {
  return v === "judged" ? "judged" : "script";
}

function fail(why: string): number {
  process.stderr.write(`${why}\n`);
  return 1;
}

function usage(): number {
  process.stdout.write(
    [
      "wecode — deterministic project management for a developer and their coding agents.",
      "",
      "Work is written down as tests before it is built. Agents get one task each inside a",
      "scope they cannot leave. Nothing is finished because an agent said so: a task is done",
      "when its tests pass, and a story is delivered when every test that proves it passes.",
      "",
      "THE SHAPE OF THE WORK",
      "  project → release → epic → story → requirement → acceptance_criteria",
      "                                      → acceptance_test → task → task_test",
      "",
      "  requirement          a rule that must be true",
      "  acceptance_criteria  one named expectation that proves it",
      "  acceptance_test      the command that proves the criteria",
      "  task                 work that exists to make one acceptance_test pass",
      "  task_test            the task's own unit test",
      "",
      "START HERE",
      "  wecode onboard [name] [--workspace <ws>]   learn this repo, join a workspace, write config",
      "  wecode init [name]                         an empty workspace, before you have a repo",
      "  wecode board [--all]                       what is running, waiting, queued, failed",
      "  wecode workspaces                          which workspaces exist, and which is current",
      "",
      "MAKING WORK",
      '  wecode <entity> create --parent <id> "<text>" [--artefact "<cmd>"] [--role <name>]',
      '  wecode task scope <id> --write "a.ts,b.ts"  which files that task may change',
      '  wecode <test> artefact <id> --set "<cmd>"   fix the command a test is proved by',
      '  wecode <entity> restate <id> --to "<words>" fix the wording, keeping the slug',
      "  wecode plan <file.yaml> [--epic <id>]      a whole story as one document (--dry-run to look)",
      "  wecode worker create <name> --role engineer --kind agent",
      "",
      "MOVING WORK",
      "  wecode <entity> <verb> <id>                start, deliver, pass, fail, drop, retry …",
      '  wecode ask <task> "<question>"             put a decision in needs you (--option "yes=<cost>")',
      '  wecode answer <assignment> "<text>"        clears a needs_human',
      "  wecode land <story>                        merge a delivered story into your branch",
      "",
      "LOOKING",
      "  wecode show <entity> <id>                  one record",
      "  wecode tree [project]                      the whole shape, project to task_test",
      "  wecode watch [--project N] [--json]        one line per state change, forever (--once to drain)",
      "  wecode wait <entity> <id>                  block until it settles; the exit code is the answer",
      "  wecode <entity> --help                     that entity's states and verbs",
      "  wecode delivered [--all] [--project N]     what wecode can already do (--json)",
      "  wecode explore read|uses|purpose <file>    what is in this repository, asked of an index",
      "  wecode paint open|poll|end|export <file>   a drawing in front of a person, and what they said",
      "  wecode lessons [--project N]               what earlier attempts here learned",
      "  wecode lesson drop <id>                    a wrong lesson is worse than none",
      "  wecode doctor                              one pass of the invariants; non-zero if any is broken",
      "",
      "RUNNING",
      "  wecode-runner --once                       one tick: allocate, run an agent, prove, land",
      "  wecode-runner                              the loop",
      "  wecode-tui                                 the live board",
      "",
      `entities: ${STATEFUL.join(", ")}, workspace, role, worker`,
      "",
      "RULES THAT BITE",
      "  a task needs a scope, a role and a task_test that is ready before it can start",
      "  two tasks whose write scopes overlap will not run at the same time",
      "  a failing test is the answer — make another task, do not edit the code by hand",
      "",
      "WHAT WECODE WILL NOT DO",
      "  it will not decide what to build — you write the requirement, it holds you to it",
      "  it will not judge work by an agent's word — only a test that ran says done",
      "  it will not let an agent widen its own scope — a scope is set before the work starts",
      "  it will not edit your code itself — every change arrives as a task an agent ran",
      "  it will not push, release or deploy — landing stops at a merge into your branch",
      "  it will not replace your test runner, vcs or ci — it drives the ones you have",
      "",
    ].join("\n"),
  );
  return 0;
}


