/** A sketch is drawn by a verb, and the drawing is a file.
 *
 *  `packages/core/src/sketch.ts` made a sketch a record. Nothing could make one: there was
 *  no way to type a drawing into the ledger, so the table was a shape with no door. These
 *  three verbs are the door — `create`, `list`, `drop` — and this proves each of them.
 *
 *  The claim worth the most here is the one about the html. `create` writes a document
 *  under the workspace's own `sketches/` directory and records its *path*; the drawing
 *  itself is never a column. That is not tidiness. An agent is who draws these, and an
 *  agent edits files: a picture kept in a column would need a verb to fetch it out, a verb
 *  to put it back, and a diff nobody could read — a second way to write a file, worse than
 *  the one every tool already has. So the tests below look at the disk, and one of them
 *  reads every column of the row to prove the drawing is not hiding in any of them. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open, sketches } from "@wecode/core";
import { run } from "../src/run.js";
import { linesIn, undocumented } from "../src/capabilities.js";
import { tmp } from "../../core/test/tmpdir.js";

const RUN = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8");

let out: string[];
let err: string[];
/** The workspace directory: `wecode.db` and `sketches/` are siblings in it. */
let home: string;

beforeEach(() => {
  home = tmp("wecode-sketch-");
  process.env["WECODE_DB"] = join(home, "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
  run(["init"]);
  out.length = 0;
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const refused = (): string => err.join("");
const drawings = (): string => join(home, "sketches");

/** One sketch, made the way the manual says to make one. */
const drew = (name: string, kind = "wireframe", says = "what a person sees first"): number =>
  run(["sketch", "create", name, "--kind", kind, "--says", says]);

/** The rows, read back through the record rather than through what the verb printed. */
const recorded = () => sketches(open(process.env["WECODE_DB"] as string));

describe("sketch create", () => {
  it("records a row carrying the name, the kind and what it says", () => {
    expect(drew("the board")).toBe(0);
    const rows = recorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("the board");
    expect(rows[0]?.kind).toBe("wireframe");
    expect(rows[0]?.says).toBe("what a person sees first");
    // Nothing above it, because a sketch is drawn before there is work to hang it on.
    expect(rows[0]?.story_id).toBeNull();
  });

  it("writes the html under the workspace's own sketches directory", () => {
    expect(drew("the board")).toBe(0);
    const html = recorded()[0]?.html as string;
    expect(html).toBe(join(drawings(), "the-board.html"));
    expect(existsSync(html)).toBe(true);
  });

  it("says which sketch it made and where the drawing is", () => {
    expect(drew("the board")).toBe(0);
    expect(said()).toContain("sketch #1 the board");
    expect(said()).toContain(join(drawings(), "the-board.html"));
  });

  it("writes a document a browser opens, naming the sketch and what it is for", () => {
    expect(drew("the board")).toBe(0);
    const html = readFileSync(recorded()[0]?.html as string, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("the board");
    expect(html).toContain("what a person sees first");
  });

  it("writes a person's own words as words, because the file is parsed as markup", () => {
    expect(drew("<script>alert(1)</script>", "wireframe", "a & b > c")).toBe(0);
    const html = readFileSync(recorded()[0]?.html as string, "utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b &gt; c");
  });

  it("keeps the drawing out of the record: no column holds the html itself", () => {
    expect(drew("the board")).toBe(0);
    const row = recorded()[0] as Record<string, unknown>;
    // The path is in the row and the document is not — in any column, under any name. A
    // drawing that had leaked into a column would be a second way to write the file.
    for (const [column, value] of Object.entries(row)) {
      if (column === "html") continue;
      expect(String(value), column).not.toContain("<!doctype html>");
    }
    expect(row["html"]).not.toContain("<!doctype html>");
  });

  it("gives the second drawing of the same idea its own file, because a name is not unique", () => {
    expect(drew("the board")).toBe(0);
    expect(drew("the board", "mockup", "in colour this time")).toBe(0);
    const rows = recorded();
    expect(rows.map((s) => s.name)).toEqual(["the board", "the board"]);
    expect(rows[0]?.html).toBe(join(drawings(), "the-board-2.html"));
    expect(rows[1]?.html).toBe(join(drawings(), "the-board.html"));
    // And the first drawing is untouched: the second did not paint over it.
    expect(readFileSync(rows[1]?.html as string, "utf8")).toContain("what a person sees first");
    expect(readFileSync(rows[0]?.html as string, "utf8")).toContain("in colour this time");
  });

  it("refuses a drawing with no name, no kind or nothing to say, and writes no file", () => {
    for (const args of [
      ["sketch", "create", "--kind", "wireframe", "--says", "a line"],
      ["sketch", "create", "the board", "--says", "a line"],
      ["sketch", "create", "the board", "--kind", "wireframe"],
      ["sketch", "create", "the board", "--kind", "  ", "--says", "a line"],
    ]) {
      err.length = 0;
      expect(run(args), args.join(" ")).toBe(1);
      expect(refused()).toContain("a sketch needs a name, a kind and a line saying what it is");
    }
    expect(recorded()).toHaveLength(0);
    expect(existsSync(drawings())).toBe(false);
  });

  it("answers an unknown flag with the usage line rather than a crash", () => {
    expect(run(["sketch", "create", "the board", "--colour", "red"])).toBe(1);
    expect(refused()).toContain("wecode sketch create");
    expect(recorded()).toHaveLength(0);
  });

  it("refuses to paint over a drawing that is already there", () => {
    // The file is made by hand, so the record does not know about it — `free` is looking at
    // the directory, not at the table, which is what makes this safe.
    expect(drew("the board")).toBe(0);
    writeFileSync(join(drawings(), "the-board-2.html"), "<p>drawn by hand</p>\n");
    expect(drew("the board", "mockup", "in colour this time")).toBe(0);
    expect(readFileSync(join(drawings(), "the-board-2.html"), "utf8")).toBe("<p>drawn by hand</p>\n");
    expect(recorded()[0]?.html).toBe(join(drawings(), "the-board-3.html"));
  });
});

describe("sketch list", () => {
  it("says so when there are none, rather than printing nothing", () => {
    expect(run(["sketch", "list"])).toBe(0);
    expect(said()).toContain("no sketches yet");
  });

  it("gives newest first, with the kind, the line and where the drawing is", () => {
    expect(drew("the board")).toBe(0);
    expect(drew("the dock", "mockup", "a terminal in the corner")).toBe(0);
    out.length = 0;

    expect(run(["sketch", "list"])).toBe(0);
    expect(said()).toContain("#  2");
    expect(said()).toContain("the dock");
    expect(said()).toContain("mockup");
    expect(said()).toContain("a terminal in the corner");
    expect(said()).toContain(join(drawings(), "the-dock.html"));
    expect(said().indexOf("the dock")).toBeLessThan(said().indexOf("the board"));
  });

  it("takes a limit, and refuses one that is not a number", () => {
    expect(drew("the board")).toBe(0);
    expect(drew("the dock", "mockup", "a terminal in the corner")).toBe(0);
    out.length = 0;
    expect(run(["sketch", "list", "--limit", "1"])).toBe(0);
    expect(said()).toContain("the dock");
    expect(said()).not.toContain("the board");

    expect(run(["sketch", "list", "--limit", "lots"])).toBe(1);
    expect(refused()).toContain("wecode sketch list [--limit <n>]");
  });
});

describe("sketch drop", () => {
  it("takes the row out of the record", () => {
    expect(drew("the board")).toBe(0);
    out.length = 0;
    expect(run(["sketch", "drop", "1"])).toBe(0);
    expect(said()).toContain("sketch #1 dropped");
    expect(recorded()).toHaveLength(0);
  });

  it("leaves the drawing on disk, and says where it still is", () => {
    expect(drew("the board")).toBe(0);
    const html = recorded()[0]?.html as string;
    out.length = 0;
    expect(run(["sketch", "drop", "1"])).toBe(0);
    // The row is ours; the file is the operator's. Dropping a record must not delete a
    // document somebody may have linked from somewhere this record cannot see.
    expect(existsSync(html)).toBe(true);
    expect(said()).toContain(html);
  });

  it("refuses an id that is not there, and one that is not an id", () => {
    expect(run(["sketch", "drop", "9"])).toBe(1);
    expect(refused()).toContain("no sketch #9");
    err.length = 0;
    expect(run(["sketch", "drop"])).toBe(1);
    expect(refused()).toContain("wecode sketch drop <id>");
  });
});

describe("the verb itself", () => {
  it("says all three when it is given no verb at all", () => {
    expect(run(["sketch"])).toBe(1);
    for (const how of ["wecode sketch create", "wecode sketch list", "wecode sketch drop"]) {
      expect(refused(), how).toContain(how);
    }
  });

  it("is in the manual, so `wecode capabilities` can describe it", () => {
    // capabilities.ts refuses to write a self-description at all while a command in the
    // dispatch table has no line in usage() — this is that check, on this command.
    expect(undocumented(RUN)).toEqual([]);
    expect(linesIn(RUN).get("sketch")).toContain("a drawing");
    expect(run([])).toBe(0);
    expect(said()).toContain("wecode sketch create|list|drop");
  });

  it("keeps run.ts a dispatch: the verb's body is in verbs/make.ts", () => {
    expect(RUN).toContain('if (head === "sketch") return make.sketch(at, rest, dirname(DB()));');
    expect(RUN).not.toContain("function draw(");
    expect(RUN).not.toContain("addSketch");
  });

  it("writes nothing anywhere but the workspace's sketches directory", () => {
    expect(drew("the board")).toBe(0);
    // The database and its own write-ahead sidecars are the workspace; `sketches` is the
    // only thing this verb is allowed to add beside them.
    const beside = readdirSync(home).filter((f) => !f.startsWith("wecode.db"));
    expect(beside).toEqual(["sketches"]);
    expect(readdirSync(drawings())).toEqual(["the-board.html"]);
  });
});
