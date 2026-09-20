/** The tree stops at the work, and the proof is read on the page of the row it proves.
 *
 *  The ledger is nine levels deep. Four of them — requirement, acceptance_criteria,
 *  acceptance_test, task_test — are not work being done but the proof a story was done, and
 *  drawn as outline rows they outnumber the work they qualify. This file holds the two
 *  halves of the decision that follows: that the outline declares five levels and names the
 *  four it drops, and that the detail page declares where those four went. A fold would not
 *  do it — a folded row still costs its line — so `omits` is checked against the fold as
 *  well as against `shows`.
 *
 *  The levels named here are the levels packages/core/src/tree.ts walks, so the list is
 *  compared against STATEFUL rather than against a second copy of itself: a rung renamed in
 *  core and not here would otherwise pass.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { STATEFUL } from "@wecode/core";
import { describe, expect, it } from "vitest";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const levels = design.outline.levels as Record<string, any>;
const proof = design.detail.proof as Record<string, any>;

/** The proof rungs, as the ledger spells them. */
const PROOF = ["requirement", "acceptance_criteria", "acceptance_test", "task_test"];

describe("the tree is five levels", () => {
  it("declares the count, and the count is the length of the list", () => {
    expect(levels.count).toBe(5);
    expect(levels.shows).toHaveLength(5);
  });

  it("shows the five rungs that are work, deepest last", () => {
    expect(levels.shows).toEqual(["project", "release", "epic", "story", "task"]);
  });

  it("names every rung it shows and drops as an entity the ledger has", () => {
    for (const rung of [...levels.shows, ...levels.omits]) {
      expect(STATEFUL as readonly string[], rung).toContain(rung);
    }
  });

  it("accounts for the whole ledger: every stateful rung is shown, dropped, or an assignment", () => {
    const placed = [...levels.shows, ...levels.omits, "assignment"];
    expect([...placed].sort()).toEqual([...STATEFUL].sort());
  });

  it("drops the four proof rungs and only those", () => {
    expect([...levels.omits].sort()).toEqual([...PROOF].sort());
  });

  it("shows nothing it also drops", () => {
    for (const rung of levels.omits) expect(levels.shows, rung).not.toContain(rung);
  });

  it("stops the fold at the task, so the dropped rungs are not merely folded away", () => {
    expect(levels.fold_reaches).toBe("task");
    expect(levels.shows.at(-1)).toBe(levels.fold_reaches);
  });
});

describe("the proof rows move to the detail pages", () => {
  it("says where the dropped rungs went, and the detail page answers for them", () => {
    expect(levels.omitted_to).toBe("detail");
    expect(proof).toBeTruthy();
    expect(proof.of).toBe("node");
  });

  it("carries every dropped rung on some detail page, and nothing that was not dropped", () => {
    const carried = Object.values(proof.entities).flat() as string[];
    expect([...carried].sort()).toEqual([...levels.omits].sort());
  });

  it("puts a story's requirements under the story and a task's tests under the task", () => {
    expect(proof.entities.story).toEqual(["requirement", "acceptance_criteria", "acceptance_test"]);
    expect(proof.entities.task).toEqual(["task_test"]);
  });

  it("hangs proof only off rows the outline still draws, so its subject is on the page", () => {
    for (const subject of Object.keys(proof.entities)) {
      expect(levels.shows, subject).toContain(subject);
    }
  });

  it("is a second section on the page the row already opens, not a page of its own", () => {
    expect(proof.under).toBe("children");
    expect(design.detail.screens).toContain(proof.of);
    expect(design.pages.bordered).not.toContain("proof");
  });

  it("nests the three story rungs by the same indent the outline spends on depth", () => {
    expect(proof.nesting).toBe("indent");
    expect(proof.indent).toBe(design.outline.depth.indent);
  });

  it("titles and counts itself the way the children section next to it does", () => {
    expect(proof.title).toContain("{count}");
    expect(proof.title).toContain("{tally}");
    expect(design.detail.children.title).toContain("{tally}");
  });

  it("says something rather than nothing when a row has no proof", () => {
    expect(typeof proof.empty).toBe("string");
    expect(proof.empty.length).toBeGreaterThan(0);
  });

  it("draws proof as columns, since a proof row is a statement and a verdict", () => {
    expect(proof.columns).toContain("statement");
    expect(proof.columns).toContain("state");
  });
});
