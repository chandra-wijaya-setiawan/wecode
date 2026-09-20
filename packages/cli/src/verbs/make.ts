/** The making half of the entity verbs: what `create` answers `--help` with, and the
 *  artefact a test is proved by — the verb and its help both.
 *
 *  `verbs/entity.ts` holds what a record *is*; this holds the two verbs that say how one
 *  comes to be and how it is proved. The split is arithmetic as much as meaning: one file
 *  carrying both halves is over the ceiling. Context still arrives as `At`, borrowed from
 *  `verbs/entity.ts` rather than redeclared, and `create` itself stays in run.ts because it
 *  is the one verb that reaches the engine for every entity at once. */
import { parseArgs } from "node:util";
import { setArtefact, setScriptPath } from "@wecode/core";
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
