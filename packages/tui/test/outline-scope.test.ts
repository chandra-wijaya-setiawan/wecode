/** The outline narrowed to the work still owed, and widened back. `f o` and `f a`, and the
 *  screen saying which of the two it is in — a narrowed outline that looked like the whole
 *  one would be a screen you could read as "nothing left" when there is plenty. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open, type Node } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import {
  isOpenWork,
  NOTHING_OPEN,
  openWork,
  OUTLINE,
  SCOPE_LABEL,
  scopeTitle,
} from "../src/outline.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;

/** A story under the seed's epic, with one requirement under it. Two of them: one wholly
 *  landed, one landed at the top with an unmet requirement still under it. */
const story = (epic: number, slug: string, state: string, requirement: string): number => {
  const id = ins(
    db,
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    epic,
    slug,
    state,
    T,
    T,
  );
  ins(
    db,
    "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    `${slug}-req`,
    id,
    `${slug} requirement`,
    requirement,
    T,
    T,
  );
  return id;
};

beforeEach(() => {
  db = open(":memory:");
  const tree = seed(db);
  // Wholly landed: nothing under it is owed, so the narrowing takes the branch entire.
  story(tree.epic, "legacy-login", "delivered", "met");
  // Landed at the top with work still under it: the story row has to survive, or its open
  // requirement would have nowhere to hang.
  story(tree.epic, "billing", "delivered", "in_progress");
  app = new App(db, views, machines);
});

afterEach(cleanup);

const frame = (width = 120, height = 44): string =>
  render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "";

const openOutline = (): void => {
  app.key("v");
  app.key(OUTLINE.key);
};

const whats = (): string[] => app.lines().map((r) => r.what);

const has = (what: string): boolean => whats().some((w) => w.includes(what));

/** Put the cursor on the row naming a thing. */
const onto = (what: string): void => {
  const at = whats().findIndex((w) => w.includes(what));
  expect(at, `no row for ${what}`).toBeGreaterThanOrEqual(0);
  app.cursor = at;
};

describe("openWork", () => {
  const node = (state: string, children: readonly Node[] = []): Node => ({
    entity: "story",
    id: 1,
    label: state,
    state,
    children,
    rollup: {} as Node["rollup"],
    folded: false,
  });

  it("counts the landed terminals and dropped as settled", () => {
    for (const state of ["released", "delivered", "met", "accepted", "passed", "done", "dropped"]) {
      expect(isOpenWork(node(state)), state).toBe(false);
    }
  });

  it("counts a failed row as open, because a failed test is work still owed", () => {
    expect(isOpenWork(node("failed"))).toBe(true);
  });

  it("counts every state a machine still moves out of as open", () => {
    for (const state of ["planned", "in_progress", "on_hold", "ready"]) {
      expect(isOpenWork(node(state)), state).toBe(true);
    }
  });

  it("drops a settled leaf", () => {
    expect(openWork([node("delivered")])).toEqual([]);
  });

  it("drops a settled branch whole", () => {
    expect(openWork([node("delivered", [node("met"), node("met")])])).toEqual([]);
  });

  it("keeps a settled row that still has open work under it, and only that work", () => {
    const kept = openWork([node("delivered", [node("met"), node("in_progress")])]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.state).toBe("delivered");
    expect(kept[0]?.children.map((c) => c.state)).toEqual(["in_progress"]);
  });

  it("leaves the forest alone when everything in it is open", () => {
    const forest = [node("in_progress", [node("ready")])];
    expect(openWork(forest)).toEqual(forest);
  });
});

describe("f o narrows the outline to open work", () => {
  it("drops a branch nothing is owed in", () => {
    openOutline();
    expect(has("legacy-login")).toBe(true);
    app.key("f");
    app.key("o");
    expect(has("legacy-login")).toBe(false);
    expect(has("password reset")).toBe(true);
  });

  it("keeps a landed row that open work still hangs under", () => {
    openOutline();
    app.key("f");
    app.key("o");
    expect(has("billing")).toBe(true);
    onto("billing");
    app.key("+");
    expect(has("billing requirement")).toBe(true);
  });

  it("shows only the open work under a row it opens", () => {
    openOutline();
    app.key("f");
    app.key("o");
    onto("billing");
    app.key("+");
    expect(has("legacy-login requirement")).toBe(false);
  });

  it("counts only the rows it kept in the box's title", () => {
    openOutline();
    const all = app.lines().length;
    app.key("f");
    app.key("o");
    expect(app.lines().length).toBeLessThan(all);
    expect(plain(frame())).toContain(scopeTitle("open", app.lines().length));
  });
});

describe("f a shows all of it", () => {
  it("brings the settled work back", () => {
    openOutline();
    app.key("f");
    app.key("o");
    expect(has("legacy-login")).toBe(false);
    app.key("f");
    app.key("a");
    expect(has("legacy-login")).toBe(true);
  });
});

describe("saying which it is in", () => {
  it("titles the box when it is narrowed, so the screen still says so once the keystroke scrolls away", () => {
    openOutline();
    app.key("f");
    app.key("o");
    expect(plain(frame())).toContain(`${OUTLINE.title} — ${SCOPE_LABEL.open}`);
  });

  it("leaves the title unqualified on all work, because that is what the outline means", () => {
    openOutline();
    expect(plain(frame())).toContain(`${OUTLINE.title} (${app.lines().length})`);
    expect(plain(frame())).not.toContain(SCOPE_LABEL.open);
    app.key("f");
    app.key("o");
    app.key("f");
    app.key("a");
    expect(plain(frame())).not.toContain(SCOPE_LABEL.open);
  });

  it("names the scope in the status line as the key takes effect", () => {
    openOutline();
    app.key("f");
    app.key("o");
    expect(app.status).toBe(`${OUTLINE.title} — ${SCOPE_LABEL.open}`);
    app.key("f");
    app.key("a");
    expect(app.status).toBe(`${OUTLINE.title} — ${SCOPE_LABEL.all}`);
  });

  it("offers both scopes by their letters when f is pressed", () => {
    openOutline();
    app.key("f");
    expect(app.status).toContain(`o ${SCOPE_LABEL.open}`);
    expect(app.status).toContain(`a ${SCOPE_LABEL.all}`);
  });

  it("says the outline is narrowable when it opens, because the key bar has no room", () => {
    openOutline();
    expect(app.status).toContain("f narrows");
  });

  it("opens on all work, so the overview is never secretly a subset", () => {
    openOutline();
    expect(app.outlineScope).toBe("all");
    app.key("f");
    app.key("o");
    app.key("esc");
    openOutline();
    expect(app.outlineScope).toBe("all");
    expect(has("legacy-login")).toBe(true);
  });
});

describe("what f refuses", () => {
  it("does nothing off the outline but say how to get there", () => {
    app.key("f");
    expect(app.status).toBe(`f narrows the outline — v ${OUTLINE.key}`);
    expect(app.outlineScope).toBe("all");
  });

  it("does not arm off the outline, so the next key is still its own", () => {
    app.key("f");
    app.key("q");
    expect(app.quit).toBe(true);
  });

  it("refuses a letter that is neither scope, and leaves the outline as it was", () => {
    openOutline();
    app.key("f");
    app.key("o");
    app.key("f");
    app.key("x");
    expect(app.status).toBe("no scope on x");
    expect(app.outlineScope).toBe("open");
    expect(has("legacy-login")).toBe(false);
  });
});

describe("a narrowed outline with nothing in it", () => {
  it("says nothing is open rather than telling you to create a project", () => {
    const empty = open(":memory:");
    ins(
      empty,
      "INSERT INTO workspace (slug,name,path,created_at,updated_at) VALUES (?,?,?,?,?)",
      "acme",
      "acme",
      "/acme",
      T,
      T,
    );
    ins(
      empty,
      "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      "old",
      1,
      "old",
      "/repo",
      "dropped",
      T,
      T,
    );
    app = new App(empty, views, machines);
    openOutline();
    app.key("f");
    app.key("o");
    expect(app.lines()).toEqual([]);
    const drawn = plain(frame());
    expect(drawn).toContain(NOTHING_OPEN);
    expect(drawn).not.toContain(OUTLINE.empty);
  });
});
