/** A head is the only place a section says how to open it.
 *
 *  The proposal raised a key onto the counts that were worth raising, which left the hint
 *  on whichever sections had a number that day. This file holds the other rule: every head
 *  carries its key, the letter is the one views.yaml already gave the box rather than a
 *  second copy of it here, and no two sections share a head — a shared head has room for
 *  one letter and names two boxes, so half of the pair cannot be opened from it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  parse(readFileSync(fileURLToPath(new URL(`../config/${name}`, import.meta.url)), "utf8")) as Record<
    string,
    any
  >;

const design = read("design.yaml");
const views = read("views.yaml");
const head = design.proposal.head as Record<string, any>;
const sections = Object.keys(design.proposal.marks as Record<string, string>);

describe("heads carry their key", () => {
  it("puts a hint on every head, not on the ones with a count to raise", () => {
    expect(head.hint_on).toBe("every_head");
    expect(head.hint).toContain("{key}");
  });

  it("names a box in views.yaml for each of the seven heads", () => {
    expect(head.keys.from).toBe("views.yaml#views.*.key");
    expect(Object.keys(head.keys.sections)).toEqual(sections);
  });

  it("reads each head's letter off the box rather than restating it", () => {
    const letters = sections.map((section) => {
      const box = views.views[head.keys.sections[section]];
      expect(box, `${section} names no box in views.yaml`).toBeTruthy();
      expect(box.key, `${head.keys.sections[section]} declares no key`).toBeTruthy();
      return box.key;
    });
    expect(new Set(letters).size).toBe(sections.length);
    // The letters live in views.yaml alone: the proposal holds names, never keys.
    expect(JSON.stringify(head.keys.sections)).not.toMatch(
      new RegExp(`:"(${letters.join("|")})"`),
    );
  });

  it("unpairs queue from cooking, and shares no head at all", () => {
    expect(design.proposal.heads).toBe("per_section");
    expect(design.proposal.shared_heads ?? []).toEqual([]);
  });

  it("gives queue and cooking a head, a key and a mark each", () => {
    for (const section of ["queue", "cooking"]) {
      expect(sections).toContain(section);
      expect(views.views[head.keys.sections[section]].key).toBeTruthy();
    }
    expect(head.keys.sections.queue).not.toBe(head.keys.sections.cooking);
    expect(design.proposal.marks.queue).not.toBe(design.proposal.marks.cooking);
  });
});
