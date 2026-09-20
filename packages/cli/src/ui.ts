import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";

/** `wecode ui check <capture.json>` — the four screen rules, as a command that fails.
 *
 *  A tester can already capture a screen and `@wecode/ui`'s `check` can already read the
 *  capture, but nothing a tester types puts the two together: the rules only run inside
 *  a suite that already knew to call them. So a clipped box reaches master whenever the
 *  screen it clips has no test of its own, which is exactly the screen nobody wrote a
 *  test for. This is the verb that closes that: point it at a capture and it exits
 *  non-zero on a finding, which is the whole of what a gate needs from it.
 *
 *  No rule lives here. The rules are `@wecode/ui`'s and there is one copy of them; this
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

/** Where the rules come from when a caller does not say.
 *
 *  Loaded at the moment of use rather than imported at the top, because `packages/cli`
 *  does not depend on `@wecode/ui` yet — declaring that dependency and exporting `check`
 *  from ui's entry point are both outside this change. Until they land the command says
 *  so, in the one sentence that tells a reader what to do about it, and exits 2. */
async function loadRules(): Promise<Rules> {
  // Not a literal specifier: `packages/cli` cannot resolve `@wecode/ui` until it declares
  // the dependency, and a literal would stop this package compiling before then.
  const from = "@wecode/ui";
  const mod = (await import(from)) as { check?: Rules };
  if (typeof mod.check !== "function") {
    throw new Error("@wecode/ui exports no check — packages/cli does not depend on it yet");
  }
  return mod.check;
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
  readonly children?: readonly Shown[];
}

/** The two ports this command composes, in the order it composes them. They are parameters
 *  with a default for the same reason the rules are: they are proved in `packages/ui`
 *  against designs and trees, and the tests here drive the command. */
export interface Ports {
  readonly expected: (design: unknown) => Shown;
  readonly wireframe: (root: unknown) => string;
}

/** Where the ports come from when a caller does not say. Reached by subpath rather than
 *  through the package entry, because `index.ts` re-exports `wireframe` but not `expected`,
 *  and loaded at the moment of use because `packages/cli` does not depend on `@wecode/ui`
 *  yet — until it does, the command says so in one sentence and exits 2. */
async function loadPorts(): Promise<Ports> {
  // Not literal specifiers: a literal would stop this package compiling before the
  // dependency is declared.
  const from = "@wecode/ui/dist";
  const shape = async (file: string): Promise<Record<string, unknown>> =>
    (await import(`${from}/${file}`)) as Record<string, unknown>;
  const { expected } = (await shape("expected.js")) as Pick<Ports, "expected">;
  const { wireframe } = (await shape("wireframe.js")) as Pick<Ports, "wireframe">;
  if (typeof expected !== "function" || typeof wireframe !== "function") {
    throw new Error("@wecode/ui exports no expected/wireframe — packages/cli does not depend on it yet");
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

/** A captured node as a box: the same coordinates, the same order, `name` read as `title`. */
const asBox = (node: Shown): unknown => ({
  at: node.at,
  title: node.name,
  ...(node.children === undefined ? {} : { children: node.children.map(asBox) }),
});

/** The design a file declares under a name. A design file is a mapping of screen to design
 *  so that one file can hold the screens of one product, which is how a reviewer wants to
 *  read them — `screens:` and then a block per screen. */
function screen(file: string, name: string, parsed: unknown): unknown {
  const screens = (parsed as { screens?: unknown } | null)?.screens;
  if (screens === null || typeof screens !== "object") {
    throw new Error(`${file} declares no screens`);
  }
  const found = (screens as Record<string, unknown>)[name];
  if (found === undefined) {
    const has = Object.keys(screens as object).join(", ");
    throw new Error(`${file} declares no screen ${name} — it declares ${has || "none"}`);
  }
  return found;
}

export async function design(
  args: readonly string[],
  ports: () => Ports | Promise<Ports> = loadPorts,
  read: () => Read | Promise<Read> = loadRead,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { from: { type: "string" }, out: { type: "string" } },
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
  try {
    declared = screen(file, name, (await read())(readFileSync(resolve(file), "utf8")));
  } catch (err) {
    return fail(`cannot read the design at ${file}: ${(err as Error).message}`, 2);
  }

  try {
    const { expected, wireframe } = await ports();
    writeFileSync(out, wireframe(asBox(expected(declared))));
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
