/** design.yaml declares a head exactly once, and the gate reads that one.
 *
 *  It declared two. `proposal.head` was the screen the operator signed — the mark in
 *  column zero, no dashes, the count at the right edge with the box's letter raised onto
 *  it. Beside it sat `head:`, written by reading screens.tsx: `── ⟐ QUEUE [q] ──── 1`.
 *  The gate was pointed at the transcript, so the board could not move to the signed
 *  screen without turning its own gate red, and twenty dispatches refused the work rather
 *  than pick between two designs. Deleting one was the decision, and this file is what
 *  stops a second one growing back.
 *
 *  Asserted against the file's text and against what the loader reads, because the claim
 *  is about the declaration and not about any one frame.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { cockpitDesign } from "../src/views.js";
import { loadViews } from "../src/views.js";

const path = fileURLToPath(new URL("../config/design.yaml", import.meta.url));
const text = readFileSync(path, "utf8");
const file = parse(text) as Record<string, any>;

/** Every `head:` key anywhere in the document, by the path it sits at. */
function heads(node: unknown, at: string[] = []): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => [
    ...(key === "head" ? [[...at, key].join(".")] : []),
    ...heads(value, [...at, key]),
  ]);
}

describe("design.yaml declares one head", () => {
  it("names a head in one place, and that place is the proposal", () => {
    // `proposal:` at the foot of the file is an alias of `shared.proposal` — the same
    // node reached by a second name — so a head found under both is still one head.
    const found = heads(file);
    expect(found).toContain("shared.proposal.head");
    expect(new Set(found.map((at) => at.replace(/^proposal\./, "shared.proposal."))).size).toBe(1);
    expect(file["shared"]["proposal"]["head"]).toBe(file["proposal"]["head"]);
  });

  it("keeps no compatibility alias for the retired one at the foot of the file", () => {
    expect(file["head"]).toBeUndefined();
    expect(text).not.toMatch(/^head:/m);
    // The other aliases are untouched: this is one deletion, not a rename of the tail.
    for (const name of ["page", "detail", "outline", "key_bar", "proposal", "dashboard"]) {
      expect(file[name], `${name} lost its alias`).toBeTruthy();
    }
  });

  it("leaves no renderer holding a head of its own", () => {
    for (const [name, half] of Object.entries(file["renderers"] as Record<string, any>)) {
      expect(half["head"], `${name} declares its own head`).toBeUndefined();
    }
  });

  it("says nowhere that a head is written with dashes", () => {
    const head = file["shared"]["proposal"]["head"] as Record<string, unknown>;
    expect(head["dashes"]).toBe("none");
    expect(head["line"]).not.toMatch(/[-─]/);
    expect(JSON.stringify(head)).not.toContain("──");
  });

  it("gives the seated box's fraction to the one head that is left", () => {
    const head = file["shared"]["proposal"]["head"] as Record<string, any>;
    expect(head.seated.box).toBe("running");
    expect(head.seated.of).toBe("workers");
    expect(head.seated.count).toBe("{held}/{seats}");
  });
});

describe("the loader reads that one head", () => {
  /** The tree views.ts builds is what the gate and the SVG projector both read, so a head
   *  the loader could not find would be a board with its names in the wrong case and no
   *  test on the config alone would notice. */
  it("cases every box's name the way the proposal cases a head", () => {
    const tree = cockpitDesign({ width: 100, height: 40 });
    const titles = loadViews().map((v) => v.title.toUpperCase());
    expect(file["shared"]["proposal"]["head"]["case"]).toBe("upper");
    for (const title of titles) {
      expect(tree.parts?.some((p) => p.name === title), `no box named ${title}`).toBe(true);
    }
  });
});
