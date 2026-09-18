/** The outline lands on the work still owed, and says so — and the choice of which scope it
 *  lands on is a line in views.yaml rather than a literal in the App. The screen you reach
 *  for to ask "what is left" should not first have to be narrowed by a keystroke, and the
 *  person who decides that should not have to open a .ts to change it. */
import { plain } from "./force-color.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App, loadOutlineScope, outlineOpensOn } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { OutlineError, OUTLINE, SCOPE_LABEL, scopeTitle } from "../src/outline.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;

/** A story wholly landed under the seed's epic: nothing is owed in it, so a narrowed
 *  outline has no reason to keep the branch and an unnarrowed one has to. */
const landed = (epic: number, slug: string): void => {
  const id = ins(
    db,
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    epic,
    slug,
    "delivered",
    T,
    T,
  );
  ins(
    db,
    "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    `${slug}-req`,
    id,
    `${slug} requirement`,
    "met",
    T,
    T,
  );
};

beforeEach(() => {
  db = open(":memory:");
  const tree = seed(db);
  landed(tree.epic, "legacy-login");
  app = new App(db, views, machines);
});

afterEach(cleanup);

const frame = (width = 120, height = 44): string =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "");

const openOutline = (): void => {
  app.key("v");
  app.key(OUTLINE.key);
};

const has = (what: string): boolean => app.lines().some((r) => r.what.includes(what));

/** A views.yaml holding only what the scope loader reads, so a bad value can be proved to
 *  be refused without a bad value being committed. */
const yaml = (body: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "views-")), "views.yaml");
  writeFileSync(path, body);
  return path;
};

describe("where the opening scope comes from", () => {
  it("reads it from views.yaml, so changing which screen you land on is a config edit", () => {
    expect(loadOutlineScope(yaml("outline:\n  scope: open\n"))).toBe("open");
    expect(loadOutlineScope(yaml("outline:\n  scope: all\n"))).toBe("all");
  });

  it("refuses a scope no key offers, rather than starting on a screen of the wrong rows", () => {
    expect(() => loadOutlineScope(yaml("outline:\n  scope: owed\n"))).toThrow(OutlineError);
    expect(() => loadOutlineScope(yaml("outline:\n  depth: story\n"))).toThrow(
      /outline\.scope must be one of/,
    );
  });

  it("is declared in the config this repo ships, and it is open work", () => {
    expect(loadOutlineScope()).toBe("open");
    expect(outlineOpensOn()).toBe("open");
  });
});

describe("the outline opens on open work", () => {
  it("stands in the configured scope the moment it opens, with no keystroke", () => {
    openOutline();
    expect(app.outlineScope).toBe(outlineOpensOn());
    expect(app.outlineScope).toBe("open");
  });

  it("holds the work still owed and not the branch that landed", () => {
    openOutline();
    expect(has("password reset")).toBe(true);
    expect(has("legacy-login")).toBe(false);
  });

  it("says which scope it is in on the screen, because a subset must not look whole", () => {
    openOutline();
    const drawn = frame();
    expect(drawn).toContain(scopeTitle("open", app.lines().length));
    expect(drawn).toContain(SCOPE_LABEL.open);
  });

  it("names the scope in the status line it opens with, beside how to widen it", () => {
    openOutline();
    expect(app.status).toContain(SCOPE_LABEL.open);
    expect(app.status).toContain("f narrows");
  });
});

describe("f still moves, and reopening comes back to the config", () => {
  it("widens to all of it on f a", () => {
    openOutline();
    app.key("f");
    app.key("a");
    expect(app.outlineScope).toBe("all");
    expect(has("legacy-login")).toBe(true);
  });

  it("returns to the configured scope when it is reopened, not to where f left it", () => {
    openOutline();
    app.key("f");
    app.key("a");
    app.key("esc");
    openOutline();
    expect(app.outlineScope).toBe(outlineOpensOn());
    expect(has("legacy-login")).toBe(false);
  });
});
