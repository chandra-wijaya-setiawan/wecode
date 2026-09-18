/** Searching the outline: `/` then an id or words out of a label, enter to commit, `n` and
 *  `N` to walk the matches. The tree is the one screen a filter cannot serve — a box keeps
 *  rows by their state, and what you have in hand is a number off another screen or two
 *  words out of a title. */
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

/** A second story under the seed's epic, so a search has more than one thing to find and
 *  the order `n` walks them in is observable. */
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

/** Type a query and commit it, the way a person does. */
const search = (q: string): void => {
  app.key("/");
  for (const c of q) app.key(c);
  app.key("enter");
};

const labels = (): string[] => app.lines().map((r) => r.what);
const here = (): string => labels()[app.cursor] as string;

beforeEach(() => {
  db = open(":memory:");
  seeded = seed(db);
  story(seeded.epic, "reset-audit", "password reset audit trail");
  story(seeded.epic, "signup", "signup mail");
  app = new App(db, views, machines);
  app.key("v");
  app.key(OUTLINE.key);
});

describe("typing a search", () => {
  it("shows what has been typed so far, as it is typed", () => {
    app.key("/");
    expect(app.status).toBe("/");
    app.key("r");
    app.key("e");
    expect(app.status).toBe("/re");
  });

  it("takes back a character on backspace", () => {
    app.key("/");
    for (const c of "rex") app.key(c);
    app.key("backspace");
    expect(app.status).toBe("/re");
  });

  it("treats every printable key as a character, not a command", () => {
    // `n`, `j` and `q` are letters in labels. A search line that moved the cursor or quit
    // on one of them could not spell the word you came to type.
    app.key("/");
    for (const c of "njq") app.key(c);
    expect(app.status).toBe("/njq");
    expect(app.quit).toBe(false);
    expect(app.cursor).toBe(0);
  });

  it("abandons the search on esc, leaving nothing searched", () => {
    app.key("/");
    for (const c of "reset") app.key(c);
    app.key("esc");
    expect(app.outlineQuery).toBe("");
    // esc abandoned the line rather than the screen: the outline is still up.
    expect(app.screen.kind).toBe("outline");
    app.key("n");
    expect(app.status).toBe("nothing searched — / searches");
  });

  it("says so rather than matching everything when the query is empty", () => {
    app.key("/");
    app.key("enter");
    expect(app.status).toBe("nothing to search for");
  });
});

describe("what a query matches", () => {
  it("finds a row by a word in its label", () => {
    search("signup");
    expect(here()).toContain("signup mail");
    expect(app.status).toBe("1/1 matching signup");
  });

  it("ignores case", () => {
    search("SIGNUP");
    expect(here()).toContain("signup mail");
  });

  it("takes every word, in any order, and narrows by each", () => {
    search("reset");
    expect(app.status).toBe("1/3 matching reset");
    search("audit reset");
    expect(app.status).toBe("1/1 matching audit reset");
    expect(here()).toContain("password reset audit trail");
  });

  it("finds a row by its id", () => {
    search(String(seeded.project));
    expect(here()).toContain("storefront");
  });

  it("takes an id with a # in front of it, the way the other screens print one", () => {
    // Ids are per table, so one number names a row in each: what the # must not do is
    // change which rows a number finds.
    search(`#${seeded.story}`);
    const withHash = app.status;
    app.key("v");
    app.key(OUTLINE.key);
    search(String(seeded.story));
    expect(withHash).toBe(app.status.replace("matching ", "matching #"));
    expect(app.lines()[app.cursor]?.id).toBe(seeded.story);
  });

  it("matches an id whole, so 1 does not land on a row numbered 21", () => {
    for (let i = 0; i < 21; i += 1) story(seeded.epic, `filler-${i}`, `filler ${i}`);
    app = new App(db, views, machines);
    app.key("v");
    app.key(OUTLINE.key);
    search("2");
    const found = app.lines()[app.cursor];
    expect(found?.id).toBe(2);
  });

  it("says nothing matches, and leaves the cursor where it was", () => {
    app.key("j");
    const was = app.cursor;
    search("nothing here is called this");
    expect(app.status).toBe("nothing matches nothing here is called this");
    expect(app.cursor).toBe(was);
  });
});

describe("a match under a folded row", () => {
  it("is revealed by the search, not merely counted", () => {
    // The outline opens folded to its configured depth, so a task is not on screen.
    expect(labels().some((l) => l.includes("send the reset mail"))).toBe(false);
    search("send the reset mail");
    expect(here()).toContain("send the reset mail");
  });

  it("opens the branches its matches hang in and no others", () => {
    search("signup");
    // signup has nothing under it, so revealing it opens only the rows above it. The
    // other story's requirement stays folded away.
    expect(labels().some((l) => l.includes("one link, one change"))).toBe(false);
    expect(labels().some((l) => l.includes("signup mail"))).toBe(true);
  });
});

describe("n and N", () => {
  it("walk the matches down the tree and back up it", () => {
    search("reset");
    expect(app.status).toBe("1/3 matching reset");
    const first = app.cursor;
    app.key("n");
    expect(app.status).toBe("2/3 matching reset");
    expect(app.cursor).toBeGreaterThan(first);
    app.key("N");
    expect(app.cursor).toBe(first);
    expect(app.status).toBe("1/3 matching reset");
  });

  it("wrap round rather than stopping at the ends", () => {
    search("reset");
    for (const _ of [1, 2, 3]) app.key("n");
    expect(app.status).toBe("1/3 matching reset");
    app.key("N");
    expect(app.status).toBe("3/3 matching reset");
  });

  it("keep working after the prompt that armed them has gone", () => {
    search("reset");
    app.key("j");
    app.key("r");
    expect(app.status).toBe("refreshed");
    app.key("n");
    expect(app.status).toMatch(/\/3 matching reset$/);
  });

  it("go to the next match from wherever the cursor is now", () => {
    search("reset");
    app.key("g");
    app.key("n");
    expect(app.status).toBe("1/3 matching reset");
  });
});

describe("off the outline", () => {
  beforeEach(() => {
    app.key("esc");
  });

  it("says where a search is available rather than searching the dashboard", () => {
    app.key("/");
    expect(app.status).toBe(`/ searches the outline — v ${OUTLINE.key}`);
    expect(app.outlineQuery).toBe("");
  });

  it("says the same of n", () => {
    app.key("n");
    expect(app.status).toBe(`n walks the outline's matches — v ${OUTLINE.key}`);
  });
});

describe("reopening the outline", () => {
  it("forgets the search, because v t asks for the overview", () => {
    search("reset");
    app.key("esc");
    app.key("v");
    app.key(OUTLINE.key);
    expect(app.outlineQuery).toBe("");
    app.key("n");
    expect(app.status).toBe("nothing searched — / searches");
  });
});
