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
 *  something else. */
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

/** The group headings the page came out with, in the order it wrote them. */
const headings = (body: string): readonly string[] =>
  [...body.matchAll(/<h2>.*?<\/span>([^<]*)</g)].map((m) => m[1] as string);

/** The markup of the rows, one per entry, in document order. */
const lines = (body: string): readonly string[] =>
  [...body.matchAll(/<li class="[^"]*">.*?<\/li>/g)].map((m) => m[0]);

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
    expect(cookingGroups([])).toBe(`<p class="empty">${view?.empty as string}</p>`);
  });
});

describe("a row is a person's words, not markup", () => {
  it("escapes what a row says", () => {
    const body = cookingGroups([row(1, "failed", `a <script> in the "title"`)]);
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>");
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
