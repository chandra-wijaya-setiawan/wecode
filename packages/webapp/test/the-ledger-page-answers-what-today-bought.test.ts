/** The ledger page draws every node the definition declares for it, by that node's own name.
 *
 *  The page already answered the three questions; what it did not do was draw them as the
 *  definition says they are drawn. None of `ledger`, `ledger.strip`, `ledger.landed`, its
 *  `row`, `ledger.rate` or `ledger.waste` was anywhere in the markup, so nothing could check
 *  the drawing against the declaration.
 *
 *  Two of the strip's counts are the mockup's and not the board's: `green` and `refunded` are
 *  what became of an attempt, and the board carries what is *open*. Those are drawn as the
 *  dash with their word, because a node left out reads as a count of nothing — a different
 *  sentence, and a false one. The same goes for the rate: no land on the board carries an
 *  hour, so there is no lands-per-hour to divide.
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
  ["ledger.landed", null],
  ["ledger.landed.row", null],
  ["ledger.rate", "lands per hour"],
  ["ledger.waste", null],
];

/** The strip's five counts, in the definition's order, with the word each is said by. */
const COUNTS: readonly string[] = ["landed", "attempts", "green", "refunded", "decisions"];

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

describe("the strip says the five counts the definition names", () => {
  const body = ledgerSections(busy());
  const said = body.slice(body.indexOf(`data-ui="ledger.strip"`)).split("</p>")[0] ?? "";

  it("says each of them by its own word, in the definition's order", () => {
    let at = -1;
    for (const word of COUNTS) {
      const next = said.indexOf(word);
      expect(next, word).toBeGreaterThan(at);
      at = next;
    }
  });

  it("counts the lands, the attempts and the decisions off the board's own groups", () => {
    expect(said).toContain("3 landed");
    expect(said).toContain("2 attempts");
    expect(said).toContain("1 decisions");
  });

  it("counts a land that will not merge among the landed, as the section below does", () => {
    // Bought is bought; whether it banks is the row's own word and not a reason to drop it.
    expect(body).toContain("3 lands, 1 not merging");
  });

  it("draws a count the board does not carry as the dash, not as a zero", () => {
    expect(said).toContain("— green");
    expect(said).toContain("— refunded");
    expect(said).not.toContain("0 green");
    expect(body).toContain("green and refunded are what became of an attempt");
  });

  it("says nothing but dashes when the workspace is empty, and still says every word", () => {
    const bare = ledgerSections(boardOf());
    const strip = bare.slice(bare.indexOf(`data-ui="ledger.strip"`)).split("</p>")[0] ?? "";

    for (const word of COUNTS) expect(strip, word).toContain(word);
    expect(strip).toContain("0 landed");
    expect(strip).toContain("— green");
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
    // every node is a `section.ledger`, or a `p.total` or an `li` inside one.
    for (const [, drawn] of body.matchAll(/(<[a-z]+[^>]*data-ui="[^"]+"[^>]*>)/g)) {
      expect(drawn, drawn).toMatch(/^<(section class="ledger"|p class="total"|li )/);
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
