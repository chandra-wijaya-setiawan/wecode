import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadMachines, STATEFUL, type MachineSet, type StatefulEntity } from "@wecode/core";

/** `wecode capabilities [--json]` — what wecode can do, for a reader that is not a person.
 *
 *  An orchestrating agent drove this repository on 16 Sep without being able to ask this
 *  question. It looked for `wecode capabilities` and `wecode describe --json`, found
 *  neither, read the gap as a product gap, and recommended building `wecode delivered`,
 *  which had already landed. So the answer here is never typed out: every line of it is
 *  read from something that would break if it were wrong.
 *
 *    commands   the dispatch table in run.ts, each with the line the manual gives it
 *    entities   the rows of docs/design/03, held against the entities that have machines
 *    verbs      the transitions in machines.yaml, plus the verbs the cli answers itself
 *    nonGoals   what wecode deliberately does not cover
 *
 *  Only the last of those is declared rather than derived, because nothing in the tree
 *  records it. It belongs in a config file — a non-goal is data the product owner changes,
 *  not code — and the scope of the task that wrote this file reaches no config file that
 *  could hold it. Moving `NON_GOALS` into `config/capabilities.yaml` is the follow-up. */
export class CapabilityError extends Error {}

const RUN = fileURLToPath(new URL("../src/run.ts", import.meta.url));
const ENTITIES = fileURLToPath(new URL("../../../docs/design/03. Entity Definition.md", import.meta.url));

export interface Command {
  readonly name: string;
  readonly line: string;
}

export interface Entity {
  readonly name: string;
  readonly line: string;
  readonly states: readonly string[];
  readonly verbs: readonly string[];
}

export interface Verb {
  readonly entity: string;
  readonly verb: string;
  readonly line: string;
  readonly guard: string | null;
  readonly automatic: boolean;
}

export interface NonGoal {
  readonly name: string;
  readonly line: string;
}

export interface SelfDescription {
  readonly commands: readonly Command[];
  readonly entities: readonly Entity[];
  readonly verbs: readonly Verb[];
  readonly nonGoals: readonly NonGoal[];
}

/** What wecode is not for.
 *
 *  Each line is a boundary somebody has already tried to cross. A non-goal is as much of
 *  the answer as a capability is: an agent that cannot see the edge plans work wecode will
 *  refuse, or reimplements what wecode declines to do on purpose. */
export const NON_GOALS: readonly NonGoal[] = [
  { name: "writing the code", line: "wecode dispatches a session to write it; wecode itself never edits a diff" },
  { name: "believing a worker", line: "a report is not a verdict — the tests are run and the diff is read (docs/design/01)" },
  { name: "reviewing by opinion", line: "there is no approve-by-taste: a criteria is accepted because its test passed" },
  { name: "building, deploying or releasing", line: "no pipeline, no artefacts, no environments — a release here is a record" },
  { name: "tracking work people do by hand", line: "every task is shaped for one worker under one scope, agent or human, and is proved the same way" },
  { name: "telling you when something happens", line: "docs/design/15 designs subscriptions; no port exists, so the board and the TUI are the only way to look" },
  { name: "remembering a conversation", line: "the record is the memory; nothing carries over from a session but what it wrote down" },
];

/** The verbs and commands the manual does not itemise, and why each is here rather than
 *  scraped: `help` is the manual, so it cannot be a line in it, and the five verbs the cli
 *  answers before a name reaches a machine are documented in usage() by shape
 *  (`wecode <entity> create …`) rather than under a name a scrape can key on. */
const INTRINSIC: Readonly<Record<string, string>> = {
  help: "the manual; `wecode <entity> help` is that entity's states and verbs",
  create: "make a record under a parent — `wecode <entity> create --parent <id> \"<text>\"`",
  scope: "which files a task may change — `wecode task scope <id> --write \"a.ts,b.ts\"`",
  artefact: "the command a test is proved by — `wecode <test> artefact <id> --set \"<cmd>\"`",
  restate: "fix the wording, keeping the slug — `wecode <entity> restate <id> --to \"<words>\"`",
  retry: "the way back from failed, with a reason — `wecode task retry <id> --reason \"<why>\"`",
};

const source = (path: string): string => readFileSync(path, "utf8");

/** Every spelling `wecode <entity> <verb>` accepts — the stateful ones, and the three that
 *  have no state. A command never shares a name with one of these. */
const ENTITY_NAMES: ReadonlySet<string> = new Set<string>([...STATEFUL, "workspace", "role", "worker"]);

/** The dispatch table, read as data: every name `dispatch()` compares the first argument
 *  against. A command reachable by typing it is exactly one of these. */
export const commandsIn = (run: string): readonly string[] =>
  unique([...run.matchAll(/head === "([a-z_]+)"/g)].map((m) => m[1] as string));

/** The verbs the cli answers itself, before a name reaches a machine. */
export const verbsIn = (run: string): readonly string[] =>
  unique([...run.matchAll(/name === "([a-z_]+)"/g)].map((m) => m[1] as string));

/** usage() and nothing else. The other help texts in run.ts spell commands too — in prose,
 *  and in an entity's own manual — and a scrape that read them took "here, to make this
 *  repository one" as what `onboard` does. The manual is one function; this is it. */
function manual(run: string): string {
  const at = run.indexOf("function usage(");
  return at === -1 ? "" : run.slice(at, run.indexOf("\n}", at));
}

/** The manual, read as data: `wecode <name> <shape>   <what it does>`, keyed by name. The
 *  first line for a name wins, and a line whose head is a placeholder (`wecode <entity>
 *  create`) belongs to no command, so it is not matched at all. */
export function linesIn(run: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const raw of manual(run).split("\n")) {
    // The quote is whichever one the line opened with: several of these lines hold a
    // double quote inside single quotes, and one that stops at any quote loses them.
    const line = /^\s*(['"]) {2}wecode ([a-z_]+)(.*)\1,?\s*$/.exec(raw);
    if (line === null) continue;
    const [, , name = "", rest = ""] = line;
    const said = rest.split(/ {2,}/).slice(1).join(" ").trim();
    // `wecode task scope <id> …` documents a verb under an entity, not a command called
    // task. Only a head that is not an entity name is a command's line.
    if (said !== "" && !found.has(name) && !ENTITY_NAMES.has(name)) found.set(name, said);
  }
  return found;
}

/** The rows of docs/design/03 — the one page that says in a sentence what each entity is. */
export function entityLines(page: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const raw of page.split("\n")) {
    const row = /^\|\s*\*\*([a-z_]+)\*\*\s*\|\s*(.+?)\s*\|\s*$/.exec(raw);
    if (row !== null) found.set(row[1] as string, row[2] as string);
  }
  return found;
}

/** Every name the description would have to invent a line for. Empty is the invariant: a
 *  command added to dispatch without a line in the manual is named here, and the
 *  description refuses to be written at all. */
export function undocumented(run: string): readonly string[] {
  const lines = linesIn(run);
  const has = (n: string): boolean => lines.has(n) || INTRINSIC[n] !== undefined;
  return [...commandsIn(run), ...verbsIn(run)].filter((n) => !has(n)).sort();
}

export interface Sources {
  readonly run?: string;
  readonly entities?: string;
  readonly machines?: MachineSet;
}

/** wecode, as one document. */
export function describe(from: Sources = {}): SelfDescription {
  const run = from.run ?? source(RUN);
  const page = from.entities ?? source(ENTITIES);
  const machines = from.machines ?? loadMachines();

  const missing = undocumented(run);
  if (missing.length > 0) {
    throw new CapabilityError(
      `no line for ${missing.join(", ")} — a command is not a capability until the manual says what it does`,
    );
  }

  const lines = linesIn(run);
  const said = (name: string): string => lines.get(name) ?? (INTRINSIC[name] as string);
  const described = entityLines(page);

  const stateful = new Set<string>(STATEFUL);
  const unnamed = [...stateful].filter((e) => !described.has(e));
  if (unnamed.length > 0) {
    throw new CapabilityError(`docs/design/03 says nothing about ${unnamed.sort().join(", ")}`);
  }

  const verbs: Verb[] = [];
  for (const entity of STATEFUL) {
    for (const t of machines[entity].transitions) {
      verbs.push({
        entity,
        verb: t.verb,
        line: `${t.from.join(" | ")} → ${t.to}`,
        guard: t.guard ?? null,
        automatic: t.automatic === true,
      });
    }
  }
  for (const verb of verbsIn(run)) {
    verbs.push({ entity: "<entity>", verb, line: said(verb), guard: null, automatic: false });
  }

  return {
    commands: commandsIn(run)
      .map((name) => ({ name, line: said(name) }))
      .sort(byName),
    entities: [...described].map(([name, line]) => {
      // An entity without a machine is not a gap: workspace, role and worker have no state
      // because nothing depends on one. They are capabilities all the same.
      const m = stateful.has(name) ? machines[name as StatefulEntity] : null;
      return { name, line, states: m?.states ?? [], verbs: (m?.transitions ?? []).map((t) => t.verb) };
    }),
    verbs,
    nonGoals: NON_GOALS,
  };
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

const unique = (names: readonly string[]): readonly string[] => [...new Set(names)];

/** `wecode capabilities [--json]` — the whole surface, either as json or as lines. */
export function capabilities(args: readonly string[]): number {
  const { values } = parseArgs({ args: [...args], options: { json: { type: "boolean" } } });

  let doc: SelfDescription;
  try {
    doc = describe();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return 0;
  }

  const out: string[] = ["", "COMMANDS"];
  for (const c of doc.commands) out.push(`  wecode ${c.name.padEnd(12)} ${c.line}`);
  out.push("", "ENTITIES");
  for (const e of doc.entities) out.push(`  ${e.name.padEnd(20)} ${e.line}`);
  out.push("", "VERBS");
  for (const v of doc.verbs) out.push(`  ${v.entity} ${v.verb.padEnd(10)} ${v.line}`);
  out.push("", "NOT WHAT WECODE IS FOR");
  for (const n of doc.nonGoals) out.push(`  ${n.name} — ${n.line}`);
  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}
