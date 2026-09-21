/** The cooking page: every ticket that is moving, and the exact refusal for each one that
 *  is not — and a page that nothing had to be told about.
 *
 *  The rows are hand-made rather than read out of a workspace, for the reason the board's
 *  test makes its own: what is held here is the page and the transport. That these rows
 *  are the *cooking* ones is `board()`'s and is held where that function lives.
 *
 *  Three things are asserted that no other test on this surface can be. That the page is
 *  discovered — it answers at `/cooking` through `pages()` reading the real `pages/`
 *  directory, and `bin.ts` does not name it, which is the whole of the wiring this story
 *  is about. That the whole list is served — the cockpit's box stops at ten and this page
 *  does not, which is the reason the page exists. And that the wording of every refusal
 *  comes out of views.yaml, read through the same loader the terminal reads it through: a
 *  page that spelled *gave up* itself would go on saying it after the config said
 *  something else.
 *
 *  And that the page is drawn as the definition declares it. None of `cooking`,
 *  `cooking.task`, `cooking.seats` or `cooking.red-at-base` was anywhere in the markup, so
 *  nothing could check the drawing against the declaration. The two cards ask the board
 *  something the board does not hold — it has no roster of seats and no test run — so each
 *  is drawn as the dash and the reason, because a node left out reads as a node whose
 *  answer is nothing, which is a different sentence and a false one.
 *
 *  `cooking.task.retry` and `cooking.task.drop` are held undrawn here, and that is asserted
 *  rather than assumed: they are verbs, this surface offers none, and they are the same two
 *  the task detail withholds in `the-task-detail-offers-its-actions.test.ts`. */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Board, Row } from "@wecode/core";
import { cooking, forgetCooking, loadViews } from "@wecode/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressOf, answer, serve } from "../src/server.js";
import { pages } from "../src/pages/discover.js";
import { cookingAt, cookingGroups, cookingPage, moving, READS } from "../src/pages/cooking.js";

const row = (id: number, state: string, what = `thing ${id}`, detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

/** A board carrying nothing but the rows in flight. Every other group is empty, because
 *  this page reads one of them and a test that filled the rest would be asserting that it
 *  ignores them twice. */
const boardOf = (rows: readonly Row[]): Board =>
  ({
    projects: [],
    stale: [],
    running: [],
    needs_human: [],
    queued: [],
    failed: [],
    dropped: [],
    unproven: [],
    open: [],
    planned: [],
    delivered: [],
    unmergeable: [],
    cooking: rows,
  }) satisfies Board;

/** The group headings the page came out with, in the order it wrote them. A group's head
 *  is the marked one; the page's own `<h2>Cooking</h2>` is not a group and is held below. */
const headings = (body: string): readonly string[] =>
  [...body.matchAll(/<h2><span class="mark">[^<]*<\/span>([^<]*)</g)].map((m) => m[1] as string);

/** The markup of the rows, one per entry, in document order. A row is the one `li` that
 *  carries a class — the page's two cards are `li`s of their own and are held elsewhere. */
const lines = (body: string): readonly string[] =>
  [...body.matchAll(/<li class="[^"]*"[^>]*>.*?<\/li>/g)].map((m) => m[0]);

/** What one row's why column says. */
const whyOf = (line: string): string => /<span class="why">([^<]*)</.exec(line)?.[1] ?? "no why";

const servers: Server[] = [];
beforeEach(forgetCooking);
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
  forgetCooking();
});

async function fetched(board: () => Board, path = "/cooking"): Promise<Response> {
  const server = await serve({ "/cooking": cookingAt(board) });
  servers.push(server);
  return await fetch(`${addressOf(server)}${path}`);
}

describe("the page is found, not registered", () => {
  it("answers at /cooking off the pages directory alone", async () => {
    const routes = await pages(
      { record: () => [], board: () => boardOf([row(1, "failed")]), approvals: () => [] },
      new URL("../src/pages/", import.meta.url),
    );

    expect(Object.keys(routes)).toContain("/cooking");
    const reply = answer(routes, "GET", "/cooking");
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("gave up");
  });

  it("is served the same board the index page reads", () => {
    expect(READS).toBe("board");
  });

  it("is not named in bin.ts — nothing was told about it", () => {
    const bin = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");

    expect(bin).not.toContain("cooking");
  });
});

describe("every row says why it is where it is", () => {
  it("gives the moving rows the one why that is not a refusal", () => {
    const body = cookingGroups([row(1, "running"), row(2, "attempting")]);
    expect(lines(body).map(whyOf)).toEqual(["a worker has it", "a worker has it"]);
    expect(moving(row(1, "running"))).toBe(true);
  });

  it("says the exact refusal views.yaml declares for every state it claims", () => {
    for (const group of cooking().groups) {
      for (const state of group.states) {
        const said = whyOf(lines(cookingGroups([row(1, state)]))[0] as string);
        expect(said, `${state} should read ${group.why}`).toBe(group.why);
        expect(moving(row(1, state))).toBe(group.name === "in_hand");
      }
    }
  });

  it("falls back to the state's own word where no group claims it", () => {
    expect(whyOf(lines(cookingGroups([row(4, "in_review")]))[0] as string)).toBe("in review");
  });

  it("says the why on the row and not only on the head", () => {
    const body = cookingGroups([row(1, "failed"), row(2, "failed")]);
    expect(lines(body).map(whyOf)).toEqual(["gave up", "gave up"]);
  });

  it("marks the row as refused or moving, so a reader can tell them apart", () => {
    const body = cookingGroups([row(1, "running"), row(2, "waiting")]);
    expect(lines(body).map((l) => [whyOf(l), /class="(moving|refused)"/.exec(l)?.[1]])).toEqual([
      ["waits on you", "refused"],
      ["a worker has it", "moving"],
    ]);
  });
});

describe("the rows are gathered under the why they share", () => {
  it("heads each group with the mark and the why views.yaml declares", () => {
    const body = cookingGroups([row(1, "running"), row(2, "failed"), row(3, "approval")]);
    expect(headings(body)).toEqual(["wants you", "gave up", "a worker has it"]);
    expect(body).toContain(`<span class="mark">?</span>wants you`);
    expect(body).toContain(`<span class="mark">x</span>gave up`);
  });

  it("puts equal whys together even when they arrived apart", () => {
    const body = cookingGroups([row(1, "running"), row(2, "failed"), row(3, "running")]);
    expect(lines(body).map(whyOf)).toEqual(["gave up", "a worker has it", "a worker has it"]);
  });

  it("counts the rows a group has, so the size of a problem is readable", () => {
    const body = cookingGroups([row(1, "failed"), row(2, "dropped"), row(3, "running")]);
    expect(body).toContain(`<span class="count">2</span>`);
    expect(body).toContain(`<span class="count">1</span>`);
  });

  it("keeps two runs of one why apart from a third group", () => {
    const body = cookingGroups([row(1, "waiting"), row(2, "delivered"), row(3, "blocked")]);
    expect(headings(body)).toEqual(["waits on you", "nothing left to do"]);
  });
});

describe("the page is the whole list", () => {
  it("shows every row, where the cockpit's box stops at its height", () => {
    const view = loadViews().find((v) => v.filter === "cooking");
    expect(view, "views.yaml declares no cooking box").toBeDefined();
    const many = Array.from({ length: (view?.rows ?? 10) + 7 }, (_, i) => row(i + 1, "failed"));
    const body = cookingGroups(many);
    expect(lines(body)).toHaveLength(many.length);
    expect(body).not.toContain("more");
  });

  it("says views.yaml's own sentence when nothing is stuck", () => {
    const view = loadViews().find((v) => v.filter === "cooking");
    const body = cookingGroups([]);
    expect(body).toContain(`<p class="empty">${view?.empty as string}</p>`);
    expect(lines(body)).toEqual([]);
  });
});

describe("a row is a person's words, not markup", () => {
  it("escapes what a row says", () => {
    const body = cookingGroups([row(1, "failed", `a <script> in the "title"`)]);
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>");
  });
});

/** The nodes `packages/webapp/config/ui.yaml` declares under `cooking`: the id each carries
 *  as its `data-ui`, and the words the definition gives it. Written out here rather than
 *  read off that file because the file is not in this tree — it has never landed on master
 *  and this story may not add it. When it lands, this table is what it is read against. */
const DECLARED: readonly (readonly [string, string | null])[] = [
  ["cooking", "Cooking"],
  ["cooking.task", null],
  ["cooking.seats", "Seats"],
  ["cooking.red-at-base", "Red at base"],
];

/** The two the definition declares and this page deliberately does not draw. Both are
 *  buttons offered on a ticket that is out of attempts, and this surface has no verb. */
const WITHHELD: readonly string[] = ["cooking.task.retry", "cooking.task.drop"];

/** A page with something under every declared node. */
const busy = (): string =>
  cookingGroups([row(1, "running"), row(2, "failed"), row(3, "approval"), row(4, "running")]);

describe("every node the definition declares is drawn, by its own name", () => {
  const body = busy();
  const where = (id: string): number => body.indexOf(`data-ui="${id}"`);

  it("draws each declared node, carrying its id and saying what the definition says", () => {
    for (const [id, says] of DECLARED) {
      expect(body, id).toContain(`data-ui="${id}"`);
      if (says !== null) expect(body.slice(where(id), where(id) + 200), id).toContain(says);
    }
  });

  it("says the lead the definition gives the page, in the definition's words", () => {
    expect(body).toContain("Tickets that are moving — the wecode workers move them for you.");
  });

  it("nests them as the definition parents them", () => {
    for (const inner of ["cooking.task", "cooking.seats", "cooking.red-at-base"]) {
      expect(where("cooking"), `cooking before ${inner}`).toBeLessThan(where(inner));
    }
    // One element holds the whole page, so the outer node closes after the last of them.
    expect(body.startsWith(`<section class="cooking" data-ui="cooking">`)).toBe(true);
    expect(body.endsWith("</section>")).toBe(true);
  });

  it("orders the row, the seats and the red at base as the definition orders them", () => {
    expect(where("cooking.task")).toBeLessThan(where("cooking.seats"));
    expect(where("cooking.seats")).toBeLessThan(where("cooking.red-at-base"));
  });

  it("draws the page's node once, and the ticket's row once per ticket", () => {
    expect([...body.matchAll(/data-ui="cooking"/g)]).toHaveLength(1);
    expect([...body.matchAll(/data-ui="cooking\.task"/g)]).toHaveLength(4);
    expect([...cookingGroups([]).matchAll(/data-ui="cooking\.task"/g)]).toHaveLength(0);
  });

  it("draws every node on a board with nothing in it, because a node is not its content", () => {
    const bare = cookingGroups([]);

    for (const [id] of DECLARED) {
      if (id !== "cooking.task") expect(bare, id).toContain(`data-ui="${id}"`);
    }
  });

  it("leaves every one of them inside a shape the look already styles", () => {
    // `cooking`'s only root is `section.cooking`, and this page may not edit the design. So
    // every node is a `section.cooking`, or an `li` inside one.
    for (const [, drawn] of body.matchAll(/(<[a-z0-9]+[^>]*data-ui="[^"]+"[^>]*>)/g)) {
      expect(drawn, drawn).toMatch(/^<(section class="cooking"|li )/);
    }
  });
});

describe("a card the board cannot answer says the dash and why, not a number it made up", () => {
  const said = (body: string, id: string): string =>
    body.slice(body.indexOf(`data-ui="${id}"`)).split("</li>")[0] ?? "";

  it("counts the seats it can — a moving row is a worker holding one", () => {
    expect(said(busy(), "cooking.seats")).toContain("2 busy");
    expect(said(cookingGroups([row(1, "failed")]), "cooking.seats")).toContain("0 busy");
  });

  it("draws the idle seats as the dash, because the board holds no roster", () => {
    const seats = said(busy(), "cooking.seats");

    expect(seats).toContain("— idle");
    expect(seats).not.toContain("0 idle");
    expect(seats).toContain("the board names only who is working");
  });

  it("draws red at base as the dash and a reason, with no test run of its own", () => {
    const red = said(busy(), "cooking.red-at-base");

    expect(red).toContain("—");
    expect(red).toContain("red at base lives on the acceptance test in the record");
    expect(red).toContain("the board carries no test run");
    expect(red).not.toMatch(/\d/);
  });

  it("draws both cards whether or not anything is cooking", () => {
    for (const id of ["cooking.seats", "cooking.red-at-base"]) {
      expect(cookingGroups([]), id).toContain(`data-ui="${id}"`);
    }
  });
});

describe("the two verbs the definition declares on a row are not drawn", () => {
  it("names neither of them anywhere in the markup", () => {
    const body = busy();

    for (const id of WITHHELD) expect(body, id).not.toContain(id);
    expect(body).not.toContain("retry with reason");
    expect(body).not.toMatch(/<button|<form|<input/);
  });

  it("says in the page's own words why they are held back", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/pages/cooking.ts", import.meta.url)),
      "utf8",
    );

    for (const id of WITHHELD) expect(source, id).toContain(id);
    expect(source).toContain("this surface offers none");
  });
});

describe("served", () => {
  it("answers /cooking with the page in the shell", async () => {
    const reply = await fetched(() => boardOf([row(1, "failed")]));
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await reply.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("gave up");
  });

  it("reads the board fresh on every request", async () => {
    let rows: readonly Row[] = [row(1, "failed")];
    const server = await serve({ "/cooking": cookingAt(() => boardOf(rows)) });
    servers.push(server);
    expect(await (await fetch(`${addressOf(server)}/cooking`)).text()).toContain("gave up");
    rows = [row(2, "running")];
    const second = await (await fetch(`${addressOf(server)}/cooking`)).text();
    expect(second).toContain("a worker has it");
    expect(second).not.toContain("gave up");
  });

  /** The shell's terminal dock is the one verb the document carries, so the page is left
   *  with what is still true of it: no script, and nothing to POST to. */
  it("offers no verb of its own — the page is a thing to read", async () => {
    const body = await (await fetched(() => boardOf([row(1, "approval")]))).text();
    expect(body).not.toMatch(/onclick/);
    expect(
      answer({ "/cooking": cookingAt(() => boardOf([])) }, "POST", "/cooking").status,
    ).toBe(405);
  });

  it("is a document of its own only through the shell", () => {
    const reply = cookingPage([row(1, "failed")]);
    expect(reply.status).toBe(200);
    expect([...reply.body.matchAll(/<html/g)]).toHaveLength(1);
  });
});
