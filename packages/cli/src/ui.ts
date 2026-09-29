import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";

/** `wecode ui check <capture.json>` — the four screen rules, as a command that fails.
 *
 *  A tester can already capture a screen and `@wecode/lens`'s `check` can already read the
 *  capture, but nothing a tester types puts the two together: the rules only run inside
 *  a suite that already knew to call them. So a clipped box reaches master whenever the
 *  screen it clips has no test of its own, which is exactly the screen nobody wrote a
 *  test for. This is the verb that closes that: point it at a capture and it exits
 *  non-zero on a finding, which is the whole of what a gate needs from it.
 *
 *  No rule lives here. The rules are `@wecode/lens`'s and there is one copy of them; this
 *  reads a file, hands the tree over, prints what comes back and turns it into an exit
 *  code. That is why the engine is a parameter with a default — the tests drive it with
 *  a stub and prove the command, not the rules, which are proved where they live.
 *
 *  Three exit codes, because a gate has to tell them apart: 0 the capture is clean, 1 the
 *  screen is wrong, 2 the question could not be asked at all — no file, bad json, no
 *  engine. A tester who cannot distinguish "the screen is fine" from "I pointed at
 *  nothing" has not got a gate. */

/** One fault, as the rules report it and as this prints it. */
export interface Finding {
  readonly rule: string;
  readonly node: string;
  readonly says: string;
}

/** The rules, as this command needs them: a captured tree in, the faults out. The tree is
 *  `unknown` on purpose — its shape is the engine's contract with whoever wrote the
 *  capture, and a second declaration of it here would be a second place to keep right. */
export type Rules = (capture: unknown) => readonly Finding[];

/** `@wecode/lens`'s entry point, however it can be reached from here.
 *
 *  Loaded at the moment of use rather than imported at the top, because `packages/cli` does
 *  not declare `@wecode/lens` — declaring it is a manifest edit and a lockfile with it, both
 *  outside this change. The package name is tried first so that the day the dependency is
 *  declared this needs no edit; failing that it is the sibling build in this repository,
 *  which is where the one copy of these rules actually is. Neither is a second
 *  implementation: both specifiers name the same module, and if neither resolves the
 *  command says so in the one sentence that tells a reader what to do about it, and exits
 *  2 rather than deciding anything itself. */
async function reach(pkg: string, sibling: string): Promise<Record<string, unknown>> {
  // Not literal specifiers: a literal `@wecode/lens` would stop this package compiling
  // before the dependency is declared.
  const here = fileURLToPath(new URL(sibling, import.meta.url));
  let last = "";
  for (const from of [pkg, here]) {
    try {
      return (await import(from)) as Record<string, unknown>;
    } catch (err) {
      last = (err as Error).message;
    }
  }
  throw new Error(`${pkg} cannot be reached — packages/cli does not depend on it yet: ${last}`);
}

const fromLens = (): Promise<Record<string, unknown>> =>
  reach("@wecode/lens", "../../lens/dist/index.js");

/** The gate over the product's own screens, reached the same way and for the same reason:
 *  `@wecode/tui` is where views.yaml and design.yaml are read, and reading them a second
 *  time here would be a mockup that can disagree with the gate the screen is held to. */
const fromTui = (): Promise<Record<string, unknown>> =>
  reach("@wecode/tui", "../../tui/dist/views.js");

/** Where the rules come from when a caller does not say. */
async function loadRules(): Promise<Rules> {
  const { check } = (await fromLens()) as { check?: Rules };
  if (typeof check !== "function") {
    throw new Error("@wecode/lens exports no check — packages/cli does not depend on it yet");
  }
  return check;
}

export async function ui(
  args: readonly string[],
  rules: () => Rules | Promise<Rules> = loadRules,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  });
  const [question, file] = positionals;
  if (question === undefined) return usage();
  if (question !== "check") {
    fail(`no such question: ${question}`);
    return usage(2);
  }
  if (file === undefined) return fail("wecode ui check <capture.json>", 2);

  let capture: unknown;
  try {
    capture = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (err) {
    return fail(`cannot read the capture at ${file}: ${(err as Error).message}`, 2);
  }

  let found: readonly Finding[];
  try {
    found = (await rules())(capture);
  } catch (err) {
    return fail(`cannot check the capture: ${(err as Error).message}`, 2);
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
  } else {
    process.stdout.write(`${[...lines(file, found), ""].join("\n")}`);
  }
  return found.length === 0 ? 0 : 1;
}

/** One line per finding, the rule first: a reader scanning a failed gate is looking for
 *  which rule broke before they are looking at which box broke it. */
function lines(file: string, found: readonly Finding[]): readonly string[] {
  if (found.length === 0) return [`${file}: clean — no finding against the four rules`];
  return [
    `${file}: ${found.length} ${found.length === 1 ? "finding" : "findings"}`,
    "",
    ...found.map((f) => `  ${f.rule}: ${f.node} — ${f.says}`),
  ];
}

/** `wecode design show <screen>` — the declared screen, as a picture on disk.
 *
 *  `expected` turns a design into a tree and `wireframe` turns a tree into SVG, but nothing
 *  an operator types reaches either. So a design crossing the desk arrives as yaml, and the
 *  mockup everyone actually looked at lives in whatever chat message it was pasted into —
 *  which is to say the screen was signed off against a picture nobody can regenerate. This
 *  is the verb that closes that: name a screen, get a file, open it.
 *
 *  It decides no geometry, the same way `check` decides no rule. The design states every
 *  number, `expected` adds the offsets up, `wireframe` writes them out, and what lives here
 *  is the plumbing between them plus the one thing neither side owns — that `expected`
 *  answers a captured node (`name`, `rows`) and `wireframe` draws a box (`title`), which is
 *  one rename and is `asBox` below. The two coordinate shapes are never read here, only
 *  passed along, so there is no second opinion about where a box is.
 *
 *  Two exit codes, because writing a file either happened or did not: 0 the wireframe is at
 *  the path printed, 2 the question could not be asked — no design file, unparseable, no
 *  such screen in it, a design the projection refuses. There is no 1: a design that is
 *  wrong about a screen is what `check` and `diff` are for, and this draws what it is
 *  given. */

/** What a captured node is, as far as the bridge needs to know. `at` is deliberately
 *  `unknown` — the coordinates belong to the design and to the projection, and a shape for
 *  them here would be a third place that has to agree about a rectangle. */
interface Shown {
  readonly name: string;
  readonly at: unknown;
  readonly rows?: readonly string[];
  readonly children?: readonly Shown[];
}

/** The two ports this command composes, in the order it composes them. They are parameters
 *  with a default for the same reason the rules are: they are proved in `packages/lens`
 *  against designs and trees, and the tests here drive the command. */
export interface Ports {
  readonly expected: (design: unknown) => Shown;
  readonly wireframe: (root: unknown, cell: Size) => string;
}

/** Where the ports come from when a caller does not say: `@wecode/lens`'s entry point, which
 *  now names `expected` beside `wireframe`. */
async function loadPorts(): Promise<Ports> {
  const { expected, wireframe } = (await fromLens()) as Partial<Ports>;
  if (typeof expected !== "function" || typeof wireframe !== "function") {
    throw new Error("@wecode/lens exports no expected/wireframe — packages/cli does not depend on it yet");
  }
  return { expected, wireframe };
}

/** How the design file is read. A design is written as yaml — comments, unquoted keys, block
 *  scalars — and the gate over the cockpit's design reads it with `yaml`'s `parse`
 *  (packages/tui/src/views.ts). This reads the same file, so it reads it the same way: one
 *  parser, one set of documents that count as a design. A json fallback made the default
 *  reader depend on which dependency happened to resolve, which is how a design file the
 *  gate accepts could fail to draw. */
export type Read = (text: string) => unknown;

/** Where the reader comes from when a caller does not say. `packages/cli` declares `yaml`,
 *  so this is the parser itself and not a lookup that can come back empty. */
const loadRead = (): Read => parse;

/** A captured node as a box: the same coordinates, the same order, `name` read as `title`,
 *  and the lines it holds carried across unread. A wireframe of a screen that shows only
 *  the outlines is a picture of a filing cabinet — what a reviewer signs off is the words
 *  in the boxes, and the design already states them. */
const asBox = (node: Shown): unknown => ({
  at: node.at,
  title: node.name,
  ...(node.rows === undefined ? {} : { rows: node.rows }),
  ...(node.children === undefined ? {} : { children: node.children.map(asBox) }),
});

/** What the design a file declares under a name is read out of it by.
 *
 *  This used to be a function here, and the gate over the cockpit's design had its own. Two
 *  readers of one file format is two answers to "is this a design" — the projector could
 *  refuse a file the gate accepted, and nobody would find out until an operator typed the
 *  command. So the reading lives in `@wecode/lens` beside `expected`, which is the module
 *  that has to make sense of what comes back, and both sides point at it. */
export type Select = (parsed: unknown, name: string, file: string) => unknown;

/** Where the selection comes from when a caller does not say. */
async function loadSelect(): Promise<Select> {
  const { designScreen } = (await fromLens()) as { designScreen?: Select };
  if (typeof designScreen !== "function") {
    throw new Error("@wecode/lens exports no designScreen — packages/cli does not depend on it yet");
  }
  return designScreen;
}

/** The gate's translation, as this command needs it: a screen's name and the terminal it
 *  is a screen of, and the design tree the product's own config says it is. The tree is
 *  `unknown` for the reason the capture is — its shape is `@wecode/lens`'s, and a second
 *  declaration of it here would be a second place to keep right. */
export type Translate = (name: string, screen: Size) => unknown;

/** Where the translation comes from when a caller does not say. */
async function loadTranslate(): Promise<Translate> {
  const { screenDesign } = (await fromTui()) as { screenDesign?: Translate };
  if (typeof screenDesign !== "function") {
    throw new Error("@wecode/tui exports no screenDesign — packages/cli does not depend on it yet");
  }
  return screenDesign;
}

/** A `<width>x<height>` a caller typed, or the default it left alone. Two flags are written
 *  this way — the terminal a `--real` screen is drawn for, and the cell it is drawn at —
 *  and they are read by one function so they cannot come to disagree about the spelling. */
function pair(flag: string, said: string | undefined, fallback: string): Size {
  const read = /^(\d+)x(\d+)$/.exec(said ?? fallback);
  if (read === null) throw new Error(`${flag} is <width>x<height>, not ${String(said)}`);
  return { width: Number(read[1]), height: Number(read[2]) };
}

interface Size {
  readonly width: number;
  readonly height: number;
}

export async function design(
  args: readonly string[],
  ports: () => Ports | Promise<Ports> = loadPorts,
  read: () => Read | Promise<Read> = loadRead,
  select: () => Select | Promise<Select> = loadSelect,
  translate: () => Translate | Promise<Translate> = loadTranslate,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      cell: { type: "string" },
      from: { type: "string" },
      out: { type: "string" },
      real: { type: "boolean" },
      size: { type: "string" },
    },
  });
  const [question, name] = positionals;
  if (question === undefined) return designUsage();
  if (question !== "show") {
    fail(`no such question: ${question}`);
    return designUsage(2);
  }
  if (name === undefined) return fail("wecode design show <screen>", 2);

  const file = values.from ?? "design.yaml";
  const out = resolve(values.out ?? `${name}.svg`);

  let declared: unknown;
  if (values.real === true) {
    try {
      declared = (await translate())(name, pair("--size", values.size, "80x30"));
    } catch (err) {
      return fail(`cannot read the real design: ${(err as Error).message}`, 2);
    }
  } else {
    try {
      const parsed = (await read())(readFileSync(resolve(file), "utf8"));
      declared = (await select())(parsed, name, file);
    } catch (err) {
      return fail(`cannot read the design at ${file}: ${(err as Error).message}`, 2);
    }
  }

  try {
    const { expected, wireframe } = await ports();
    writeFileSync(out, wireframe(asBox(expected(declared)), pair("--cell", values.cell, "8x16")));
  } catch (err) {
    return fail(`cannot draw ${name}: ${(err as Error).message}`, 2);
  }

  process.stdout.write(`${out}\n`);
  return 0;
}

function designUsage(code = 0): number {
  process.stdout.write(
    [
      "wecode design — the screen as it was declared, drawn before it is built.",
      "",
      "  wecode design show <screen>   write a wireframe of the declared screen, and say where",
      "",
      "  --from <file>   the design file to read (default design.yaml)",
      "  --real          draw the product's own screen, as its config declares it",
      "  --size <w>x<h>  the terminal a --real screen is drawn for (default 80x30)",
      "  --cell <w>x<h>  how big one cell of the screen is drawn (default 8x16)",
      "  --out <file>    where to write the wireframe (default <screen>.svg)",
      "",
      "Exit: 0 written, 2 the screen could not be drawn.",
      "",
    ].join("\n"),
  );
  return code;
}

function usage(code = 0): number {
  process.stdout.write(
    [
      "wecode ui — the rules that hold for every screen, run against a captured one.",
      "",
      "  wecode ui check <capture.json>   report every finding, and fail if there is one",
      "",
      "  --json   the findings as the rules give them",
      "",
      "Exit: 0 clean, 1 at least one finding, 2 the capture could not be checked.",
      "",
    ].join("\n"),
  );
  return code;
}

function fail(message: string, code = 1): number {
  process.stderr.write(`${message}\n`);
  return code;
}
