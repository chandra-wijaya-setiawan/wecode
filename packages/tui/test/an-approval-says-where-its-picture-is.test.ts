/** An approval page says where its picture is, and does not try to be the picture.
 *
 *  A design crossing !ui raises an approval to the operator, and the page it opens names
 *  the design and its state — which is being asked for a signature on something there is
 *  no way to look at. The mockup is already written to a file by `wecode design show`, so
 *  the page owes exactly one more line: that path.
 *
 *  It owes nothing else of the picture. A terminal cannot draw an SVG, and a text
 *  projection beside the file would be a second answer to what the design looks like — so
 *  the absence of an inline projection is declared here too, and a later attempt to draw
 *  one into the page is red rather than helpful.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const detail = design.detail as Record<string, any>;
const approval = detail.approval as Record<string, any>;

describe("an approval says where its picture is", () => {
  it("declares the approval page at all, beside the two records", () => {
    expect(approval).toBeTruthy();
    expect(detail.fields.assignment).toBeTruthy();
  });

  it("is the assignment page with lines added, not a page of its own", () => {
    expect(approval.of).toBe("assignment");
    expect(detail.screens).toContain(approval.of);
    // A page of its own would need its own border, block and title; this one inherits all
    // three, which is what `of` means and what these say it has not quietly stopped meaning.
    for (const key of ["chrome", "block", "title", "fields", "screens"]) {
      expect(approval[key], `approval redeclares ${key}`).toBeUndefined();
    }
  });

  it("adds the mockup path and nothing else", () => {
    expect(approval.adds).toEqual(["mockup"]);
    const lines = [...(detail.fields.assignment as string[]), ...(approval.adds as string[])];
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.filter((name) => name === "mockup")).toHaveLength(1);
  });

  it("makes that line a path, drawn in the block every other field is drawn in", () => {
    const mockup = approval.mockup;
    expect(mockup.name).toBe("mockup");
    expect(mockup.value).toBe("path");
    expect(mockup.entry).toContain("{path}");
    expect(mockup.entry).toContain("{name}");
    // The same two-space gutter as detail.block.entry, with `path` in the value's place.
    expect(mockup.entry).toBe(detail.block.entry.replace("{value}", "{path}"));
    expect(mockup.opens).toBe("file");
  });

  it("says so rather than offering a line that opens nothing, when nothing is projected", () => {
    expect(approval.mockup.empty).toBeTruthy();
    expect(approval.mockup.empty).not.toContain("/");
    expect(approval.mockup.empty).not.toBe(approval.mockup.entry);
  });

  it("declares no inline projection of the design", () => {
    expect(approval.projection).toBe("none");
    expect(approval.projects_inline).toBe(false);
    for (const banned of ["wireframe", "svg", "ascii"]) {
      expect(approval.forbidden, `${banned} is not refused`).toContain(banned);
    }
  });

  it("draws none of what it forbids: no forbidden word is a line of the page", () => {
    const lines = [...(detail.fields.assignment as string[]), ...(approval.adds as string[])];
    for (const banned of approval.forbidden as string[]) {
      expect(lines, `${banned} is drawn as well as forbidden`).not.toContain(banned);
    }
    // The mockup line carries the path only: no glyph, no box, no rendering of the picture.
    expect(approval.mockup.entry).not.toMatch(/[─│┌┐└┘█░]/);
  });
});
