/** The making half of the entity verbs: what `create` answers `--help` with, the artefact a
 *  test is proved by, and the three verbs a sketch needs — the verbs and their help both.
 *
 *  `verbs/entity.ts` holds what a record *is*; this holds the verbs that say how one comes
 *  to be and how it is proved. The split is arithmetic as much as meaning: one file
 *  carrying both halves is over the ceiling. Context still arrives as `At`, borrowed from
 *  `verbs/entity.ts` rather than redeclared, and `create` itself stays in run.ts because it
 *  is the one verb that reaches the engine for every entity at once. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addSketch, dropSketch, setArtefact, setScriptPath, sketchAt, sketches } from "@wecode/core";
import { elsewhere, type At } from "./entity.js";

/** Which flags each entity's create reads, and what one call looks like. The two must
 *  agree with run.ts's switch, and nothing else can check that they do. */
const CREATE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  workspace: ["path"], project: ["parent", "path"],
  release: ["parent"], epic: ["parent"], story: ["parent"],
  requirement: ["parent"], acceptance_criteria: ["parent"],
  acceptance_test: ["parent", "kind", "artefact"],
  task_test: ["parent", "kind", "artefact"],
  task: ["parent", "role"],
  worker: ["role", "kind"],
};

const FLAG_MEANS: Readonly<Record<string, string>> = {
  parent: "<id>     the record it hangs off — required, and ids are global",
  path: "<dir>      where the repository is (default: the current directory)",
  kind: "<kind>     acceptance_test / task_test: how it is run; worker: agent or human",
  artefact: "<cmd>  the command that proves it (default: this project's test command)",
  role: "<name>     which role does the work",
};

const CREATE_EXAMPLE: Readonly<Record<string, string>> = {
  workspace: 'wecode workspace create "acme" --path .',
  project: 'wecode project create --parent 1 "storefront" --path .',
  acceptance_test: 'wecode acceptance_test create --parent 1 "mail arrives" --artefact "bash mail.sh"',
  task_test: 'wecode task_test create --parent 1 "mailer called" --artefact "vitest run"',
  task: 'wecode task create --parent 1 "send the mail" --role engineer',
  worker: "wecode worker create ada --role engineer --kind agent",
};

export function createHelp(at: At, entity: string): number {
  const flags = CREATE_FLAGS[entity];
  if (flags === undefined) return at.fail(`no such entity: ${entity}`);

  const example = CREATE_EXAMPLE[entity] ?? `wecode ${entity} create --parent 1 "<text>"`;
  const lines = [`wecode ${entity} create [flags] "<text>"`, "", "  the text is everything that is not a flag", ""];
  for (const f of flags) lines.push(`  --${f} ${FLAG_MEANS[f]}`);
  process.stdout.write(`${lines.join("\n")}\n\n  ${example}\n\n`);
  return 0;
}

/** `wecode acceptance_test artefact <id> --set "bash test/mail.sh" [--script-path test/mail.sh]`
 *
 *  Without this the only cure for a wrongly typed artefact was to drop the test, which
 *  cascades its parent to a settled state and cannot be undone. */
export function artefact(at: At, entity: string, args: readonly string[]): number {
  if (entity !== "acceptance_test" && entity !== "task_test") {
    return at.fail("only an acceptance_test or a task_test carries an artefact");
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { set: { type: "string" }, "script-path": { type: "string" } },
  });
  const id = Number(positionals[0]);
  const how = `wecode ${entity} artefact <id> --set "<cmd>" [--script-path <path>]`;
  if (!Number.isInteger(id)) return at.fail(how);

  // The same guard scope has: ids are global, and this one writes.
  const wrong = elsewhere(at, entity, id);
  if (wrong !== null) return at.fail(wrong);

  const path = values["script-path"];
  if (values.set === undefined && path === undefined) return at.fail(how);

  try {
    if (values.set !== undefined) {
      setArtefact(at.conn(), entity, id, values.set);
      process.stdout.write(`${entity} #${id} artefact ${values.set}\n`);
    }
    if (path !== undefined) {
      // An empty --script-path clears it: the path is spec, and a test may stop having one.
      setScriptPath(at.conn(), entity, id, path.trim() === "" ? null : path);
      process.stdout.write(
        path.trim() === ""
          ? `${entity} #${id} script path cleared\n`
          : `${entity} #${id} script path ${path}\n`,
      );
    }
    return 0;
  } catch (err) {
    return at.fail((err as Error).message);
  }
}

export function artefactHelp(): number {
  process.stdout.write(
    [
      "wecode <acceptance_test|task_test> artefact <id> [flags]",
      "",
      "  the command that proves the test, and where its script is meant to live.",
      "  changing the command clears any recorded red-at-base run: that run proved",
      "  something about the old command.",
      "",
      "  --set <cmd>          the command — refused when it is empty",
      "  --script-path <path> where the script lives (empty to clear it)",
      "",
      '  wecode acceptance_test artefact 1 --set "bash test/mail.sh" --script-path test/mail.sh',
      "",
      "",
    ].join("\n"),
  );
  return 0;
}

// ─── a sketch ────────────────────────────────────────────────────────────────────────────
//
// A drawing made before there is any work to hang it on. `packages/core/src/sketch.ts` owns
// the row; what these three verbs add is the file.
//
// The drawing is html on disk and not a column, and that is the whole design. An agent is
// the one who draws it, and an agent edits files: a picture kept in a column would need a
// verb to fetch it out, a verb to put it back, and a diff nobody could read — a second way
// to write a file, worse than the one every tool already has. So the column holds the path
// and the directory holds the drawing.

const grey = (s: string): string => `\u001b[2m${s}\u001b[0m`;

const SKETCH_HOW = [
  'wecode sketch create "<name>" --kind <kind> --says "<one line>"',
  "wecode sketch list [--limit <n>]",
  "wecode sketch drop <id>",
].join("\n  ");

/** `wecode sketch <create|list|drop>` — the three things there are to do with a drawing.
 *
 *  Where the workspace is arrives as `home` rather than being read here, for the reason the
 *  database arrives as `At.conn`: this module decides nothing about where you are standing.
 *  Only `create` writes a file, so only it is told. */
export function sketch(at: At, args: readonly string[], home: string): number {
  const [verb, ...rest] = args;
  if (verb === "create") return draw(at, rest, home);
  if (verb === "list") return drawings(at, rest);
  if (verb === "drop") return undraw(at, rest);
  return at.fail(`  ${SKETCH_HOW}`);
}

/** `wecode sketch create "the board" --kind wireframe --says "what a person sees first"`
 *
 *  Writes the drawing, then records it. That order, because a row whose file is not there
 *  yet is a listing with a dead path in it, and a file with no row is only an html file in
 *  a directory — the harmless direction of the same race. */
function draw(at: At, args: readonly string[], home: string): number {
  let name: string;
  let kind: string;
  let says: string;
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { kind: { type: "string" }, says: { type: "string" } },
    });
    name = positionals.join(" ").trim();
    kind = (values.kind ?? "").trim();
    says = (values.says ?? "").trim();
  } catch {
    // An unknown flag is the usage line, not a crash.
    return at.fail(`  ${SKETCH_HOW}`);
  }
  if (name === "" || kind === "" || says === "") {
    return at.fail(`a sketch needs a name, a kind and a line saying what it is\n  ${SKETCH_HOW}`);
  }

  const dir = join(home, "sketches");
  const html = free(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
    // `wx` rather than a plain write: `free` already looked, and the one thing this verb
    // must never do is paint over a drawing somebody made.
    writeFileSync(html, starter(name, says), { flag: "wx" });
    const id = addSketch(at.conn(), { name, kind, says, html });
    process.stdout.write(`sketch #${id} ${name}  ${grey(kind)}\n  ${html}\n`);
    return 0;
  } catch (err) {
    return at.fail((err as Error).message);
  }
}

/** A file name from the operator's words, and never one that is taken. `name` is not UNIQUE
 *  in the record on purpose — redrawing the same idea twice is two sketches — so the second
 *  one gets its own file instead of overwriting the first. */
function free(dir: string, name: string): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sketch";
  let path = join(dir, `${stem}.html`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stem}-${n}.html`);
  return path;
}

/** What is in the file before anybody has drawn in it: enough to open in a browser and see
 *  which sketch it is, and no more. A template with a layout in it would be this verb
 *  deciding what the drawing looks like, which is the one thing the drawing is for. */
const starter = (name: string, says: string): string =>
  [
    "<!doctype html>",
    '<html lang="en">',
    '<meta charset="utf-8">',
    `<title>${words(name)}</title>`,
    `<h1>${words(name)}</h1>`,
    `<p>${words(says)}</p>`,
    "",
  ].join("\n");

/** A person's own words, written as words. They arrive from a command line and land in a
 *  document a browser parses, so `<` is a character here and never the start of a tag. */
const words = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `wecode sketch list [--limit <n>]` — every drawing, newest first, with where it is.
 *
 *  The path is on the line because it is what you do next with a sketch: open it. */
function drawings(at: At, args: readonly string[]): number {
  const how = "wecode sketch list [--limit <n>]";
  let limit: number | null;
  try {
    const { values } = parseArgs({ args: [...args], options: { limit: { type: "string" } } });
    limit = values.limit === undefined ? null : Number(values.limit);
  } catch {
    return at.fail(how);
  }
  if (limit !== null && !Number.isInteger(limit)) return at.fail(how);

  const found = sketches(at.conn(), limit);
  if (found.length === 0) {
    process.stdout.write("no sketches yet\n");
    return 0;
  }
  for (const s of found) {
    process.stdout.write(`  #${String(s.id).padStart(3)}  ${s.name}  ${grey(s.kind)}\n`);
    process.stdout.write(`        ${s.says}\n`);
    process.stdout.write(`        ${grey(s.html)}\n`);
  }
  return 0;
}

/** `wecode sketch drop <id>` — the row goes and the drawing stays.
 *
 *  Deleting the html here would make this a command that removes a file the operator may
 *  have linked from somewhere this record cannot see, and the sketch that has just left the
 *  record is exactly the one somebody may still want to look at. So the path is printed:
 *  what is gone is the row, and this says where the drawing still is. */
function undraw(at: At, args: readonly string[]): number {
  const how = "wecode sketch drop <id>";
  const id = Number(args[0]);
  if (args[0] === undefined || !Number.isInteger(id)) return at.fail(how);

  const conn = at.conn();
  const was = sketchAt(conn, id);
  if (was === null || !dropSketch(conn, id)) return at.fail(`no sketch #${id}`);
  process.stdout.write(`sketch #${id} dropped  the drawing stays at ${was.html}\n`);
  return 0;
}
