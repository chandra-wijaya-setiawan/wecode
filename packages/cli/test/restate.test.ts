import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(mkdtempSync(join(tmpdir(), "wecode-cli-")), "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const complained = (): string => err.join("");

/** One of everything, with story #1 carrying the mistake: it says binary, and this project
 *  is typescript. Wrong words, nothing wrong with the record. */
const tree = (): void => {
  expect(run(["init"])).toBe(0);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront", "--path", process.cwd()]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "packaging"]);
  run(["story", "create", "--parent", "1", "ship the binary"]);
  run(["requirement", "create", "--parent", "1", "one binary per release"]);
  run(["acceptance_criteria", "create", "--parent", "1", "the binary runs"]);
  run(["acceptance_test", "create", "--parent", "1", "binary starts", "--artefact", "bash run.sh"]);
  run(["task", "create", "--parent", "1", "build the binary", "--role", "engineer"]);
  run(["task_test", "create", "--parent", "1", "binary exists", "--artefact", "vitest run"]);
  out.length = 0;
};

const conn = () => open(process.env["WECODE_DB"] as string);

const rowOf = (table: string, col: string, id: number): { words: string; slug: string; state: string } =>
  conn()
    .prepare(`SELECT ${col} AS words, slug, state FROM ${table} WHERE id = ?`)
    .get(id) as { words: string; slug: string; state: string };

const ledgerOf = (entity: string, id: number) =>
  conn()
    .prepare("SELECT verb, from_state, to_state, actor FROM ledger WHERE entity = ? AND entity_id = ? ORDER BY id")
    .all(entity, id) as { verb: string; from_state: string; to_state: string; actor: string }[];

describe("wecode <entity> restate", () => {
  it("rewrites a story's title in place, leaving the slug where it was", () => {
    tree();
    const before = rowOf("story", "title", 1);
    expect(before.words).toBe("ship the binary");

    expect(run(["story", "restate", "1", "--to", "ship the typescript bundle"])).toBe(0);
    expect(said()).toContain('was "ship the binary"');
    expect(said()).toContain('now "ship the typescript bundle"');

    const after = rowOf("story", "title", 1);
    expect(after.words).toBe("ship the typescript bundle");
    // The slug is the name of every worktree and branch cut for this story. It does not
    // follow the prose, and that is the whole reason the prose could be corrected at all.
    expect(after.slug).toBe(before.slug);
    expect(after.slug).toBe("ship-the-binary");
  });

  it("puts the previous wording on the ledger, so the correction is part of the record", () => {
    tree();
    expect(run(["story", "restate", "1", "--to", "ship the typescript bundle"])).toBe(0);

    const rows = ledgerOf("story", 1).filter((r) => r.verb === "restate");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toContain('was "ship the binary"');
  });

  it("does not move the state, and its ledger row says nothing happened", () => {
    tree();
    run(["story", "start", "1"]);
    const before = rowOf("story", "title", 1);
    expect(before.state).not.toBe("");
    out.length = 0;

    expect(run(["story", "restate", "1", "--to", "ship the typescript bundle"])).toBe(0);
    const after = rowOf("story", "title", 1);
    expect(after.state).toBe(before.state);

    const row = ledgerOf("story", 1).filter((r) => r.verb === "restate")[0];
    expect(row?.from_state).toBe(before.state);
    expect(row?.to_state).toBe(before.state);
  });

  it("refuses to touch a state: there is no flag for one, and no verdict is a typo", () => {
    tree();
    run(["story", "start", "1"]);
    const before = rowOf("story", "title", 1);
    out.length = 0;
    err.length = 0;

    expect(run(["story", "restate", "1", "--state", "done"])).toBe(1);
    expect(complained()).toContain("--to");

    // Neither the state nor the words moved, and nothing was written to the ledger.
    const after = rowOf("story", "title", 1);
    expect(after.state).toBe(before.state);
    expect(after.words).toBe(before.words);
    expect(ledgerOf("story", 1).filter((r) => r.verb === "restate")).toHaveLength(0);

    // And a state name given as the new wording is only ever wording.
    expect(run(["story", "restate", "1", "--to", "done"])).toBe(0);
    expect(rowOf("story", "title", 1).state).toBe(before.state);
    expect(rowOf("story", "title", 1).words).toBe("done");
  });

  it("corrects every entity that carries prose", () => {
    tree();
    const each: [string, string][] = [
      ["epic", "title"],
      ["story", "title"],
      ["requirement", "statement"],
      ["acceptance_criteria", "statement"],
      ["acceptance_test", "statement"],
      ["task", "title"],
      ["task_test", "statement"],
    ];
    for (const [entity, col] of each) {
      expect(run([entity, "restate", "1", "--to", `${entity} says typescript`])).toBe(0);
      expect(rowOf(entity, col, 1).words).toBe(`${entity} says typescript`);
      expect(ledgerOf(entity, 1).filter((r) => r.verb === "restate")).toHaveLength(1);
    }
  });

  it("refuses empty words, an entity with no prose, and an id that is not there", () => {
    tree();
    expect(run(["story", "restate", "1", "--to", "   "])).toBe(1);
    expect(complained()).toContain("nothing to say");
    expect(rowOf("story", "title", 1).words).toBe("ship the binary");

    err.length = 0;
    expect(run(["worker", "restate", "1", "--to", "x"])).toBe(1);
    expect(complained()).toContain("carry prose to restate");

    err.length = 0;
    expect(run(["story", "restate", "99", "--to", "x"])).toBe(1);
    expect(complained()).toContain("no story #99");

    err.length = 0;
    expect(run(["story", "restate", "1"])).toBe(1);
    expect(complained()).toContain("--to");
  });
});
