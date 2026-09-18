/** A committed search filters the outline: the rows left are the ones that answer the query
 *  and the ones above them. Moving the cursor was not enough — the row you came for was on
 *  screen, but so were the hundred you did not, and reading past them is the work a search
 *  was supposed to do for you. */
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { loadViews } from "../src/views.js";
import { OUTLINE } from "../src/outline.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;
let seeded: ReturnType<typeof seed>;
let signup: number;

const story = (epic: number, slug: string, title: string): number =>
  ins(
    db,
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    epic,
    title,
    "in_progress",
    T,
    T,
  );

const search = (q: string): void => {
  app.key("/");
  for (const c of q) app.key(c);
  app.key("enter");
};

const labels = (): string[] => app.lines().map((r) => r.what);
const shows = (text: string): boolean => labels().some((l) => l.includes(text));

beforeEach(() => {
  db = open(":memory:");
  seeded = seed(db);
  signup = story(seeded.epic, "signup", "signup mail");
  story(seeded.epic, "invoices", "monthly invoices");
  story(seeded.epic, "exports", "csv exports");
  app = new App(db, views, machines);
  app.key("v");
  app.key(OUTLINE.key);
});

describe("a committed search", () => {
  it("leaves only the matching rows and the rows above them", () => {
    const before = labels().length;
    search("signup");
    expect(shows("signup mail")).toBe(true);
    // The rows above it say where it hangs, so they stay.
    expect(shows("storefront")).toBe(true);
    expect(shows("account recovery")).toBe(true);
    // Its siblings answered nothing, so they are gone.
    expect(shows("monthly invoices")).toBe(false);
    expect(shows("csv exports")).toBe(false);
    expect(shows("password reset")).toBe(false);
    expect(labels().length).toBeLessThan(before);
  });

  it("keeps a match that was folded away, with its branch opened to it", () => {
    expect(shows("send the reset mail")).toBe(false);
    search("send the reset mail");
    expect(shows("send the reset mail")).toBe(true);
    expect(shows("password reset")).toBe(true);
    expect(shows("signup mail")).toBe(false);
  });

  it("keeps every match when a query answers more than one row", () => {
    search("mail");
    expect(shows("signup mail")).toBe(true);
    expect(shows("send the reset mail")).toBe(true);
    expect(shows("the mail arrives")).toBe(true);
    expect(shows("monthly invoices")).toBe(false);
  });

  it("narrows further on each word, because a word can only mean fewer rows", () => {
    search("mail");
    const wide = labels().length;
    search("signup mail");
    expect(labels().length).toBeLessThan(wide);
    expect(shows("signup mail")).toBe(true);
    expect(shows("send the reset mail")).toBe(false);
  });

  it("filters to the row an id names", () => {
    search(`#${signup}`);
    expect(shows("signup mail")).toBe(true);
    expect(shows("monthly invoices")).toBe(false);
    expect(shows("csv exports")).toBe(false);
  });

  it("keeps what hangs under a match, leaving folding to say how much is drawn", () => {
    search("password reset");
    expect(shows("password reset")).toBe(true);
    expect(shows("signup mail")).toBe(false);
    // The match's own subtree answered nothing, so it is folded rather than filtered out:
    // opening the row still shows it, which is what you came to the tree for.
    expect(shows("one link, one change")).toBe(false);
    app.key("+");
    expect(shows("one link, one change")).toBe(true);
  });

  it("lands the cursor on a row that is still on screen", () => {
    search("signup");
    expect(app.cursor).toBeLessThan(app.lines().length);
    expect(labels()[app.cursor]).toContain("signup mail");
  });
});

describe("a query nothing answers", () => {
  it("leaves the outline as it was rather than emptying it", () => {
    const before = labels();
    search("nothing here is called this");
    expect(app.status).toBe("nothing matches nothing here is called this");
    expect(labels()).toEqual(before);
  });
});

describe("the filter after the search line has gone", () => {
  it("survives a refresh, so r does not widen the tree back out", () => {
    search("signup");
    app.key("r");
    expect(app.status).toBe("refreshed");
    expect(shows("signup mail")).toBe(true);
    expect(shows("monthly invoices")).toBe(false);
  });

  it("is lifted by reopening the outline, because v t asks for the overview", () => {
    search("signup");
    app.key("esc");
    app.key("v");
    app.key(OUTLINE.key);
    expect(app.outlineQuery).toBe("");
    expect(shows("monthly invoices")).toBe(true);
    expect(shows("password reset")).toBe(true);
  });

  it("is lifted by abandoning the next search on esc, not narrowed by what was typed", () => {
    search("signup");
    app.key("/");
    for (const c of "invoices") app.key(c);
    app.key("esc");
    // esc abandoned the line only: the committed query still holds.
    expect(app.outlineQuery).toBe("signup");
    expect(shows("signup mail")).toBe(true);
    expect(shows("monthly invoices")).toBe(false);
  });
});
