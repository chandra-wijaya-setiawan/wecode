/** The ledger page draws every node the definition declares for it, by that node's own name.
 *
 *  The page already answered the three questions; what it did not do was draw them as the
 *  definition says they are drawn. None of `ledger`, `ledger.strip`, `ledger.landed`, its
 *  `row`, `ledger.rate` or `ledger.waste` was anywhere in the markup, so nothing could check
 *  the drawing against the declaration.
 *
 *  The strip is the part this file was written for a second time. It was there, and the five
 *  counts the definition hangs under it — `ledger.strip.landed`, `.attempts`, `.green`,
 *  `.refunded`, `.decisions` — were not: the words were the page's own and no cell carried a
 *  name, so nothing could be checked against the declaration. Each is now drawn under its own
 *  name, in the definition's words, and every number in it is a group of the board counted
 *  here and now. The mockup's `54 / 135 / 128 / 21 / 6` are its sample data: a page that
 *  spelled one of them would say the same thing on every workspace forever, so the proof
 *  below is that the counts move when the board does, and that an empty board says no digit
 *  but nought.
 *
 *  Three of the five are the mockup's and not the board's. `green` and `refunded` are what
 *  became of an attempt and `decisions answered` is what became of a question; the board
 *  carries what is still *open*, so it holds none of the three. They are drawn as the dash
 *  with their word, because a node left out reads as a count of nothing — a different
 *  sentence, and a false one. `needs_human` is not `decisions answered` under another name:
 *  it is the decisions nobody has answered, and drawing it there would be a lie with a true
 *  number in it. The same goes for the rate: no land on the board carries an hour, so there
 *  is no lands-per-hour to divide.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Board, Row } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { ledgerPage, ledgerSections } from "../src/pages/ledger.js";

const row = (id: number, what: string, state: string, detail: string): Row => ({
  id,
  what,
  state,
  detail,
});

const boardOf = (groups: Partial<Board> = {}): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
  ...groups,
});

/** A workspace with something under every declared node. */
const busy = (): Board =>
  boardOf({
    delivered: [
      row(7, "the outline colours nothing", "delivered", "story"),
      row(8, "the strip is drawn", "delivered", "story"),
    ],
    unmergeable: [row(9, "the pulse line", "delivered", "story/pulse · conflict in screens.tsx")],
    running: [
      row(41, "draw the ledger", "running", "ada · 12m · 34k"),
      row(42, "widen the strip", "running", "grace · 48m · 6k"),
    ],
    needs_human: [row(60, "approve the mockup", "needs_human", "waiting on you")],
    failed: [row(50, "teach the gate to read", "failed", "3/3 attempts · tests never went green")],
  });

/** The nodes `packages/webapp/config/ui.yaml` declares under `ledger`: the id each carries as
 *  its `data-ui`, and the words the definition gives it. Written out here rather than read
 *  off that file because the file is not in this tree — it has never landed on master and
 *  this story may not add it. When it lands, this table is what it is read against. */
const DECLARED: readonly (readonly [string, string | null])[] = [
  ["ledger", "What did today buy?"],
  ["ledger.strip", null],
  ["ledger.strip.landed", "stories landed"],
  ["ledger.strip.attempts", "attempts"],
  ["ledger.strip.green", "green"],
  ["ledger.strip.refunded", "refunded (no commit)"],
  ["ledger.strip.decisions", "decisions answered"],
  ["ledger.landed", null],
  ["ledger.landed.row", null],
  ["ledger.rate", "lands per hour"],
  ["ledger.waste", null],
];

/** The strip's five counts, in the definition's order: the last word of each id — the whole
 *  id is `ledger.strip.` and this — and the words the definition gives that count. */
const COUNTS: readonly (readonly [string, string])[] = [
  ["landed", "stories landed"],
  ["attempts", "attempts"],
  ["green", "green"],
  ["refunded", "refunded (no commit)"],
  ["decisions", "decisions answered"],
];

/** The counts the board holds nothing for, and which therefore say the dash. */
const UNHELD: readonly string[] = ["green", "refunded", "decisions"];

describe("every node the definition declares is drawn, by its own name", () => {
  const body = ledgerSections(busy());
  const where = (id: string): number => body.indexOf(`data-ui="${id}"`);

  it("draws each declared node, carrying its id and saying what the definition says", () => {
    for (const [id, says] of DECLARED) {
      expect(body, id).toContain(`data-ui="${id}"`);
      if (says !== null) expect(body.slice(where(id), where(id) + 200), id).toContain(says);
    }
  });

  it("nests them as the definition parents them", () => {
    for (const [outer, inner] of [
      ["ledger", "ledger.strip"],
      ["ledger.strip", "ledger.strip.landed"],
      ["ledger.strip", "ledger.strip.attempts"],
      ["ledger.strip", "ledger.strip.green"],
      ["ledger.strip", "ledger.strip.refunded"],
      ["ledger.strip", "ledger.strip.decisions"],
      ["ledger", "ledger.landed"],
      ["ledger.landed", "ledger.landed.row"],
      ["ledger", "ledger.rate"],
      ["ledger", "ledger.waste"],
    ] as const) {
      expect(where(outer), `${outer} before ${inner}`).toBeLessThan(where(inner));
    }
    // One element holds the whole page, so the outer node closes after the last of them.
    expect(body.startsWith(`<section class="ledger" id="ledger" data-ui="ledger">`)).toBe(true);
    expect(body.endsWith("</section>")).toBe(true);
  });

  it("draws the page's node once, and the land's row once per land", () => {
    expect([...body.matchAll(/data-ui="ledger"/g)]).toHaveLength(1);
    expect([...body.matchAll(/data-ui="ledger\.landed\.row"/g)]).toHaveLength(3);
    expect([...ledgerSections(boardOf()).matchAll(/data-ui="ledger\.landed\.row"/g)]).toHaveLength(0);
  });

  it("draws every node on a workspace with nothing in it, because a node is not its content", () => {
    const bare = ledgerSections(boardOf());

    for (const [id] of DECLARED) {
      if (id !== "ledger.landed.row") expect(bare, id).toContain(`data-ui="${id}"`);
    }
  });
});

/** The strip as drawn for one board: everything up to the `</p>` that closes it, which is
 *  every cell and nothing after them. */
const stripOf = (board: Board): string => {
  const drawn = ledgerSections(board);
  return drawn.slice(drawn.indexOf(`data-ui="ledger.strip"`)).split("</p>")[0] ?? "";
};

/** One cell of a drawn strip, by the last word of its id. */
const cellOf = (strip: string, id: string): string =>
  strip.slice(strip.indexOf(`<span data-ui="ledger.strip.${id}">`)).split("</span>")[0] ?? "";

describe("the strip draws the five counts the definition names, each under its own name", () => {
  const body = ledgerSections(busy());
  const said = stripOf(busy());

  it("carries every one of the five names, inside the strip and not beside it", () => {
    for (const [id] of COUNTS) {
      expect(body, id).toContain(`data-ui="ledger.strip.${id}"`);
      // `said` stops at the strip's own `</p>`, so a cell found here is a cell inside it.
      expect(said, id).toContain(`data-ui="ledger.strip.${id}"`);
      expect([...body.matchAll(new RegExp(`data-ui="ledger\\.strip\\.${id}"`, "g"))], id)
        .toHaveLength(1);
    }
  });

  it("says each of them in the definition's words, in the definition's order", () => {
    let at = -1;
    for (const [id, says] of COUNTS) {
      const next = said.indexOf(`data-ui="ledger.strip.${id}"`);
      expect(next, id).toBeGreaterThan(at);
      expect(cellOf(said, id), id).toContain(says);
      at = next;
    }
  });

  it("counts the lands and the attempts off the board's own groups", () => {
    expect(cellOf(said, "landed")).toContain("3 stories landed");
    expect(cellOf(said, "attempts")).toContain("2 attempts");
  });

  it("counts what this board holds and not a number written into the page", () => {
    // The same page, a different workspace: a count that is drawn rather than spelled moves
    // with the record. The mockup's own 54 and 135 are its sample data and are nowhere.
    const other = stripOf(
      boardOf({
        delivered: [row(1, "one land", "delivered", "story")],
        running: [
          row(2, "a go", "running", "ada · 1m · 1k"),
          row(3, "another", "running", "grace · 2m · 2k"),
          row(4, "a third", "running", "hedy · 3m · 3k"),
        ],
      }),
    );

    expect(cellOf(other, "landed")).toContain("1 stories landed");
    expect(cellOf(other, "attempts")).toContain("3 attempts");
    expect(body).not.toContain("54 stories landed");
    expect(body).not.toContain("135 attempts");
  });

  it("counts a land that will not merge among the landed, as the section below does", () => {
    // Bought is bought; whether it banks is the row's own word and not a reason to drop it.
    expect(body).toContain("3 lands, 1 not merging");
  });

  it("draws a count the board does not carry as the dash, not as a zero", () => {
    for (const id of UNHELD) {
      expect(cellOf(said, id), id).toContain("—");
      expect(cellOf(said, id), id).not.toMatch(/\d/);
    }
    expect(said).not.toContain("0 green");
    expect(body).toContain("green, refunded and decisions answered are what became of");
    expect(body).toContain("the board carries what is still open");
  });

  it("does not say the decisions still waiting under the word answered", () => {
    // `needs_human` is a question nobody has answered. The busy board holds one, and the
    // count that would be a lie with a true number in it is the dash instead.
    expect(busy().needs_human).toHaveLength(1);
    expect(cellOf(said, "decisions")).not.toContain("1");
    expect(said).not.toContain("1 decisions answered");
  });

  it("says nought and dashes when the workspace is empty, and still says every word", () => {
    const bare = stripOf(boardOf());

    for (const [id, says] of COUNTS) expect(cellOf(bare, id), id).toContain(says);
    expect(cellOf(bare, "landed")).toContain("0 stories landed");
    expect(cellOf(bare, "attempts")).toContain("0 attempts");
    // Nothing has happened, so no count can honestly be anything but nought or the dash —
    // any other digit in the strip is a number the page brought with it.
    expect(bare).not.toMatch(/[1-9]/);
  });
});

describe("the rate is a dash and a reason, not a number the board cannot prove", () => {
  it("says the words the definition gives it and no rate of its own", () => {
    const body = ledgerSections(busy());
    const rate = body.slice(body.indexOf(`data-ui="ledger.rate"`)).split("</p>")[0] ?? "";

    expect(rate).toContain("lands per hour");
    expect(rate).toContain("—");
    expect(rate).not.toMatch(/\d/);
  });

  it("says why, so a reader is not left wondering whether the rate is nothing", () => {
    expect(ledgerSections(busy())).toContain("no land on the board carries the hour it landed");
  });

  it("is drawn whether or not anything is being attempted", () => {
    expect(ledgerSections(boardOf())).toContain(`data-ui="ledger.rate"`);
  });
});

describe("the nodes are drawn on the markup the page already had", () => {
  const body = ledgerSections(busy());

  it("names the landed section and the waste section rather than adding two more", () => {
    expect(body).toContain(`<section class="ledger" id="lands" data-ui="ledger.landed">`);
    expect(body).toContain(`<section class="ledger" id="waste" data-ui="ledger.waste">`);
  });

  it("leaves every one of them inside a shape the look already styles", () => {
    // `ledger`'s only root is `section.ledger`, and this page may not edit the design. So
    // every node is a `section.ledger`, or a `p.total` or an `li` inside one — or one of
    // the strip's cells, which are the children of a `p.total` the look lays out as a row
    // and so carry no class of their own: a class the design does not name would be this
    // page inventing a look, and an unnamed one would be a rule that reaches nothing.
    for (const [, drawn] of body.matchAll(/(<[a-z]+[^>]*data-ui="[^"]+"[^>]*>)/g)) {
      expect(drawn, drawn).toMatch(
        /^<(section class="ledger"|p class="total"|li |span data-ui="ledger\.strip\.)/,
      );
    }
  });

  it("still answers its three questions, in the order they are readable in", () => {
    const at = (id: string): number => body.indexOf(`id="${id}"`);

    expect(at("lands")).toBeLessThan(at("cost"));
    expect(at("cost")).toBeLessThan(at("waste"));
    expect(body).toContain("2 attempts · 40k · 1h 0m");
    expect(body).toContain("1 attempt bought nothing");
  });

  it("wears the shell, with the banner above the page's own node", () => {
    const page = ledgerPage(busy()).body;

    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page.indexOf("<h1>")).toBeLessThan(page.indexOf(`data-ui="ledger"`));
  });

  it("spells no colour and no typeface of its own", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/pages/ledger.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/);
    expect(source).not.toContain("monospace");
  });
});
