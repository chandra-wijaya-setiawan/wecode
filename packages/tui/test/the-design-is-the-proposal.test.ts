/** design.yaml states the screen that was signed off, not the one screens.tsx draws.
 *
 *  The rest of the file was written by reading the drawing, so the gate over it compares
 *  the code to itself: it passes whatever the board looks like. `proposal` is the part the
 *  code did not write, and this file is what stops it being quietly trimmed back down to
 *  whatever is already on the screen — every element of the proposal is named here, so
 *  losing one is a red test and not a smaller design.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const file = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

/** The design as one renderer reads it: the shared half — what the screen is, whoever
 *  draws it — with the terminal's own half laid over it. Read through the split rather
 *  than through the compatibility names at the foot of the file, so what is declared here
 *  stays declared once those names are gone. */
const design = { ...file.shared, ...file.renderers.terminal } as Record<string, any>;

const proposal = design.proposal as Record<string, any>;

describe("the design is the proposal", () => {
  it("declares a proposal at all, and is the only place a head is declared", () => {
    expect(proposal).toBeTruthy();
    expect(proposal.head).toBeTruthy();
    // The transcript of the drawn head is gone: a retired key kept beside the signed one
    // is a second answer to what a head is, and the gate held the board to the wrong one.
    expect(design.head).toBeUndefined();
  });

  it("frames the page and gives the two rails their contents", () => {
    expect(proposal.frame.outer).toBe("border");
    expect(proposal.frame.top_rail).toEqual(["workspace", "projects", "beat"]);
    expect(proposal.frame.bottom_rail).toEqual(["keys"]);
    for (const part of proposal.frame.top_rail) {
      expect(proposal.frame.top_rail_entry).toContain(`{${part}}`);
    }
    expect(proposal.frame.bottom_rail_entry).toContain("{key}");
  });

  it("gives every project a pulse line with all eight of its parts", () => {
    const pulse = proposal.pulse;
    expect(pulse.per).toBe("project");
    expect(pulse.parts).toEqual([
      "tag",
      "name",
      "version",
      "seats",
      "throughput",
      "rate",
      "flags",
      "crosses",
    ]);
    for (const part of pulse.parts) expect(pulse.line).toContain(`{${part}}`);
  });

  it("draws the seats as dots and the throughput as ten blocks", () => {
    expect(proposal.pulse.seats.as).toBe("dots");
    expect(proposal.pulse.seats.held).not.toBe(proposal.pulse.seats.free);
    expect(proposal.pulse.throughput.as).toBe("sparkline");
    expect(proposal.pulse.throughput.blocks).toBe(10);
    expect(proposal.pulse.rate).toBeTruthy();
  });

  it("raises the key onto the flag and cross counts", () => {
    expect(proposal.pulse.flags.mark).toBeTruthy();
    expect(proposal.pulse.crosses.mark).toBeTruthy();
    expect(proposal.pulse.flags.key).toBeTruthy();
    expect(proposal.pulse.crosses.key).toBeTruthy();
    expect(proposal.pulse.count).toBe("{count}{key}");
    expect(proposal.pulse.key_as).toBe("superscript");
  });

  it("marks each of the seven sections with a glyph of its own", () => {
    const marks = proposal.marks as Record<string, string>;
    expect(Object.keys(marks)).toEqual([
      "needs_you",
      "running",
      "queue",
      "cooking",
      "planned",
      "delivered",
      "dropped",
    ]);
    expect(new Set(Object.values(marks)).size).toBe(7);
    for (const mark of Object.values(marks)) expect(mark).not.toMatch(/[-─]/);
  });

  it("opens a head with its mark at the left edge and no dashes", () => {
    const head = proposal.head;
    expect(head.opens_with).toBe("mark");
    expect(head.begins_at_column).toBe(0);
    expect(head.dashes).toBe("none");
    expect(head.line.startsWith("{mark}")).toBe(true);
    expect(head.line).not.toMatch(/[-─]/);
    expect(head.line).toContain("{title}");
  });

  it("puts the head's count at the right with its key raised", () => {
    expect(proposal.head.count_at).toBe("right");
    expect(proposal.head.count).toBe("{count}{key}");
    expect(proposal.head.key_as).toBe("superscript");
  });

  it("wraps a row's sentence under the text rather than truncating it", () => {
    const row = proposal.row;
    expect(row.leads_with).toBe("mark");
    expect(row.overflow).toBe("wrap");
    expect(row.wrap_under).toBe("text");
    expect(row.truncate).toBe(false);
  });

  it("gives a row a spend gauge of eight blocks with tokens and scope", () => {
    const spend = proposal.row.spend;
    expect(spend.as).toBe("gauge");
    expect(spend.blocks).toBe(8);
    expect(spend.shows).toEqual(["tokens", "scope"]);
    for (const part of spend.shows) expect(spend.entry).toContain(`{${part}}`);
    expect(spend.entry).toContain("{gauge}");
  });

  it("gives every section its own head, so queue and cooking share none", () => {
    expect(proposal.heads).toBe("per_section");
    expect(proposal.shared_heads).toEqual([]);
  });

  it("tallies planned, delivered, dropped, tree and all on one line", () => {
    const tally = proposal.tally;
    expect(tally.line).toBe("one");
    expect(tally.entries).toEqual(["planned", "delivered", "dropped", "tree", "all"]);
    expect(tally.entry).toContain("{count}{key}");
    expect(tally.key_as).toBe("superscript");
    for (const entry of tally.entries) expect(tally.keys[entry]).toBeTruthy();
    expect(new Set(Object.values(tally.keys)).size).toBe(tally.entries.length);
  });
});
