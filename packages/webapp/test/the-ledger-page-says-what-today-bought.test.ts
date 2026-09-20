/** The ledger page: what the work bought, what it is taking, and what bought nothing.
 *
 *  It is a *discovered* page, which is the whole of its wiring. An earlier go at this page
 *  added a route to a table in `bin.ts`; that table is gone, and the branch that edited it
 *  cannot merge. So this file proves the page the way the surface now works: a file under
 *  `src/pages/` called `ledger.ts`, exporting `ledgerAt`, answering at `/ledger`, with
 *  nothing anywhere else naming it.
 *
 *  Four things:
 *    - the file alone routes it, and `bin.ts` does not mention it;
 *    - it is served from the board, because that is the only reading that carries spend;
 *    - the numbers it says are the rows it lists, and no others;
 *    - waste is the record's word — a failed attempt — and not an inference about a running
 *      one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Board, Row } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { answer } from "../src/index.js";
import { discovered, mounted, pathOf } from "../src/pages/discover.js";
import {
  ledgerAt,
  ledgerPage,
  ledgerSections,
  READS,
  reckon,
  span,
  spend,
} from "../src/pages/ledger.js";

const PAGES = fileURLToPath(new URL("../src/pages", import.meta.url));
const BIN = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");

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

/** A workspace with something in every one of the three sections. */
const busy = (): Board =>
  boardOf({
    delivered: [row(7, "the outline colours nothing", "delivered", "story")],
    unmergeable: [row(9, "the pulse line", "delivered", "story/pulse · conflict in screens.tsx")],
    running: [
      row(41, "draw the ledger", "running", "ada · 12m · 34k"),
      row(42, "widen the strip", "running", "grace · 48m · 6k"),
    ],
    failed: [row(50, "teach the gate to read", "failed", "3/3 attempts · tests never went green")],
  });

describe("the file is the routing", () => {
  it("is a page of this surface because it is a file under pages/", () => {
    expect(discovered(readdirSync(PAGES))).toContain("ledger");
    expect(pathOf("ledger")).toBe("/ledger");
  });

  it("the ledger page answers at /ledger through discovery", () => {
    const routes = { [pathOf("ledger")]: ledgerAt(busy) };
    const reply = answer(routes, "GET", "/ledger");

    expect(reply.status).toBe(200);
    expect(reply.type).toContain("text/html");
    expect(reply.body).toContain("2 attempts · 40k");
  });

  it("is named nowhere else — not in bin.ts, and not in a route table", () => {
    expect(BIN).not.toContain("ledger");
    expect(BIN).not.toContain(`"/ledger"`);
  });

  it("holds up the conventions discovery asks of a page", () => {
    // Mounted the way `pages()` mounts it: by name, off the module, with the readings.
    const module = { READS, ledgerAt } as unknown as Record<string, unknown>;
    const handler = mounted("ledger", module, {
      record: () => null,
      board: busy,
      approvals: () => [],
    }) as (url: URL) => { body: string };

    // The board's spend, not the record's shape — proof it was handed the reading it named.
    expect(handler(new URL("http://x/ledger")).body).toContain("2 attempts · 40k");
  });
});

describe("it is served from the board, because that is what carries spend", () => {
  it("says so, rather than reading the record every other page reads", () => {
    expect(READS).toBe("board");
  });

  it("reads a running row's cost back off the row the board already wrote", () => {
    expect(spend("ada · 12m · 34k")).toEqual({ worker: "ada", minutes: 12, thousands: 34 });
  });

  it("prices a row it cannot read at nothing rather than dropping it", () => {
    // A dropped attempt is an attempt the reader is never told about.
    expect(spend("waiting on you")).toEqual({ worker: "waiting on you", minutes: 0, thousands: 0 });
    const body = ledgerSections(boardOf({ running: [row(3, "an odd row", "running", "?")] }));
    expect(body).toContain("1 attempt");
    expect(body).toContain("0k");
  });
});

describe("the numbers are the rows, and no others", () => {
  it("adds up what the running attempts are spending between them", () => {
    const r = reckon(busy());

    expect(r.thousands).toBe(40);
    expect(r.minutes).toBe(60);
    expect(r.running).toHaveLength(2);
  });

  it("says the total, the span and what an attempt costs on average", () => {
    const body = ledgerSections(busy());

    expect(body).toContain("2 attempts · 40k · 1h 0m");
    expect(body).toContain("20k apiece");
  });

  it("counts a delivered story once, whether or not its branch merges", () => {
    const r = reckon(busy());

    expect(r.lands.map((l) => l.id)).toEqual([7]);
    expect(r.stuck.map((l) => l.id)).toEqual([9]);
    expect(ledgerSections(busy())).toContain("2 lands, 1 not merging");
  });

  it("names every land by the row it is, so a reader can go and read it", () => {
    const body = ledgerSections(busy());

    expect(body).toContain(`id="land-7"`);
    expect(body).toContain("story #7");
    expect(body).toContain("the outline colours nothing");
    expect(body).toContain("conflict in screens.tsx");
  });

  it("says the hours only when there are hours", () => {
    expect(span(12)).toBe("12m");
    expect(span(60)).toBe("1h 0m");
    expect(span(192)).toBe("3h 12m");
    expect(span(-5)).toBe("0m");
  });
});

describe("waste is the record's word, not an inference", () => {
  it("counts a failed attempt and not a running one", () => {
    const r = reckon(busy());

    expect(r.waste.map((w) => w.id)).toEqual([50]);
  });

  it("names the waste rather than totalling it", () => {
    const body = ledgerSections(busy());

    expect(body).toContain(`id="waste-50"`);
    expect(body).toContain("teach the gate to read");
    expect(body).toContain("tests never went green");
    expect(body).toContain("1 attempt bought nothing");
  });

  it("counts nothing wasted when the record has failed nothing", () => {
    const body = ledgerSections(boardOf({ running: [row(1, "a go", "running", "ada · 1m · 1k")] }));

    expect(body).toContain("nothing has been spent for nothing");
    expect(body).not.toContain("bought nothing</p>");
  });
});

describe("an empty workspace is a page, not a blank", () => {
  it("says each of the three things it has nothing to say", () => {
    const body = ledgerSections(boardOf());

    expect(body).toContain("nothing is waiting to land");
    expect(body).toContain("nothing is being attempted");
    expect(body).toContain("nothing has been spent for nothing");
  });

  it("asks its three questions in the order they are readable in", () => {
    const body = ledgerSections(busy());
    const at = (id: string): number => body.indexOf(`id="${id}"`);

    expect(at("lands")).toBeGreaterThanOrEqual(0);
    expect(at("lands")).toBeLessThan(at("cost"));
    expect(at("cost")).toBeLessThan(at("waste"));
  });
});

describe("it wears the shell and writes no look of its own", () => {
  it("is a fragment in the declared document, with the banner above it", () => {
    const body = ledgerPage(busy());

    expect(body.body.startsWith("<!doctype html>")).toBe(true);
    expect(body.body).toContain("<h1>");
    expect(body.body.indexOf("<h1>")).toBeLessThan(body.body.indexOf(`id="lands"`));
  });

  it("spells no colour and no typeface anywhere in the page", () => {
    const source = readFileSync(`${PAGES}/ledger.ts`, "utf8");

    expect(source).not.toContain("const STYLE");
    expect(source, "ledger.ts spells a colour").not.toMatch(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/);
    expect(source, "ledger.ts spells a typeface").not.toContain("monospace");
  });
});
