import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  openCodegraph,
  type Definition,
  type Imported,
  type Purpose,
  type Reading,
  type RepoIndex,
  type Use,
} from "@wecode/explorer";

/** `wecode explore <question> <file> [symbol]` — the repo-explorer port, as a command.
 *
 *  Three questions, because the port asks four and two of them are one reading. An agent
 *  about to change a file runs `read` to see what is in it, `uses` to see who would
 *  notice, and `purpose` to see what the module was for — the same three facts a reader
 *  would go and get, without the reading.
 *
 *  Which index answers is not decided here. The default is codegraph; a caller passes its
 *  own, which is how this is proved against a fixture repository whose index is a reader
 *  of the source. The command is about the questions and the shape of the answers, and
 *  swapping the index underneath must not change either.
 *
 *  Asynchronous, unlike every other command, because the port is: an index builds a
 *  snapshot of the tree before it can answer anything. `run()` is not async, so the
 *  dispatch hands the answer back through its own promise rather than returning it. */
export async function explore(
  args: readonly string[],
  open: (root: string) => RepoIndex = openCodegraph,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { root: { type: "string" }, json: { type: "boolean" } },
  });
  const [question, file, symbol] = positionals;
  if (question === undefined) return usage();
  if (question !== "read" && question !== "uses" && question !== "purpose") {
    fail(`no such question: ${question}`);
    return usage(1);
  }
  if (file === undefined) return fail(`wecode explore ${question} <file>${question === "uses" ? " <symbol>" : ""}`);
  if (question === "uses" && symbol === undefined) return fail("wecode explore uses <file> <symbol>");

  const index = open(resolve(values.root ?? process.cwd()));
  const json = values.json === true;
  try {
    // One shape per question, printed by one writer: the json is the port's own answer,
    // unreshaped, so a client that parses it is reading the port and not this file.
    if (question === "read") return print(await index.read(file), reading, json);
    if (question === "purpose") return print(await index.purposeOf(file), purpose, json);
    const name = symbol ?? "";
    return print(await index.usesOf(file, name), (u) => usesIn(file, name, u), json);
  } catch (err) {
    // UnknownFile and UnknownSymbol already say what went wrong and about which tree, so
    // there is nothing to add. Anything else is a broken index and reads as itself.
    return fail((err as Error).message);
  }
}

function print<T>(answer: T, lines: (answer: T) => readonly string[], json: boolean): number {
  process.stdout.write(json ? `${JSON.stringify(answer, null, 2)}\n` : `${["", ...lines(answer), ""].join("\n")}`);
  return 0;
}

/** What a file defines and what it brings in, declarations first: the question "what is in
 *  this file" is answered by the names, and the imports are context for them. */
function reading(r: Reading): readonly string[] {
  const out = [r.file, "", "  defines"];
  if (r.defines.length === 0) out.push("    (nothing)");
  for (const d of r.defines) out.push(`    ${defined(d)}`);
  out.push("", "  imports");
  if (r.imports.length === 0) out.push("    (nothing)");
  for (const i of r.imports) out.push(`    ${imported(i)}`);
  return out;
}

/** Exported or not is the first thing on the line: of everything known about a
 *  declaration, it is the one fact that decides whether changing it is anybody else's
 *  business. */
const defined = (d: Definition): string =>
  `${d.exported ? "export" : "      "}  ${pad(d.kind, 9)} ${pad(d.name, 24)} :${d.line}${
    d.doc === null ? "" : `  ${first(d.doc)}`
  }`;

/** The specifier as written, then where it lands — a name that leaves the repository says
 *  so rather than being left to look unresolved. */
const imported = (i: Imported): string =>
  `${pad(i.kind, 9)} ${pad(i.name, 24)} ${i.from} → ${i.resolved ?? "outside the repository"}`;

function purpose(p: Purpose): readonly string[] {
  return [
    p.file,
    "",
    ...(p.doc === null ? ["  says nothing about itself"] : p.doc.split("\n").map((l) => `  ${l}`)),
    "",
    `  offers      ${p.exports.length === 0 ? "nothing" : p.exports.join(", ")}`,
    `  taken up by ${p.dependents.length === 0 ? "nobody" : p.dependents.join(", ")}`,
  ];
}

/** A file:line:column an editor can be pointed at, and a count — "used in four places" is
 *  the answer to "may I change this", and the places are the evidence for it. */
function usesIn(file: string, symbol: string, uses: readonly Use[]): readonly string[] {
  if (uses.length === 0) return [`${symbol} of ${file} is used nowhere`];
  return [
    `${symbol} of ${file}, used in ${uses.length} ${uses.length === 1 ? "place" : "places"}`,
    "",
    ...uses.map((u) => `    ${u.file}:${u.line}:${u.column}`),
  ];
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** A doc comment is a paragraph and a listing is a line, so the listing carries the first
 *  sentence and `purpose` carries the whole thing. */
const first = (doc: string): string => (doc.split("\n")[0] ?? "").trim();

function usage(code = 0): number {
  process.stdout.write(
    [
      "wecode explore — what is in this repository, asked of an index rather than read.",
      "",
      "  wecode explore read <file>             what it defines, and what it brings in",
      "  wecode explore uses <file> <symbol>    every place that symbol is referenced",
      "  wecode explore purpose <file>          its doc, what it offers, who took it up",
      "",
      "  --root <dir>   the checkout to ask about (default: the directory you are in)",
      "  --json         the answer as the port gives it",
      "",
      "Every path in and out is repository-relative: packages/core/src/store.ts.",
      "",
    ].join("\n"),
  );
  return code;
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}
