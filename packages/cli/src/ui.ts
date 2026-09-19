import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

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
