/** The agents page: who is working, what on, and at what cost.
 *
 *  The board is hand-made rather than read out of a workspace, for the reason the board's,
 *  the tree's and the decisions page's rows are: what is held here is the page and the
 *  transport, and that `running` is one row per open assignment is `@wecode/core`'s and is
 *  tested where that function lives.
 *
 *  Four things this file holds. The page is the board's `running` box turned round, agent
 *  first — the same rows and never a second count. What a seat cost is read back off the
 *  row's own detail, so an unattributable seat is still shown and still counted. Nobody
 *  working is said rather than drawn blank. And the page is not registered anywhere: it is
 *  a file in `src/pages/` exporting `agentsAt`, which is the whole of what makes it answer
 *  at `/agents`.
 *
 *  Since the roster grew, an agent's card carries the `data-ui` name the definition
 *  declares it under and hangs its seats in a nested list, below the readings of the agent
 *  itself, and three cards the board carries nothing for — chore, idle and today — stand
 *  beside the agents in the same list. Held here is only what that costs this file's
 *  meaning: the card is still one per agent, the seats are still under their own agent,
 *  and the three spare cards are drawn without being counted as anybody working. The ids,
 *  the definition's words and the nesting are proved against the definition itself in
 *  `the-agents-page-shows-who-is-working`. */
import type { Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Board, Row } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, serve } from "../src/index.js";
import {
  agentsAt,
  agentsContents,
  agentsPage,
  READS,
  seatOf,
  UNNAMED,
  workers,
} from "../src/pages/agents.js";
import { discovered, mounted, pages, pathOf } from "../src/pages/discover.js";

const empty = (): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
});

/** A running row as `board()` writes one: the objective, the phase, and a detail of who is
 *  on it, how long it has been open and what it has spent. The optional settings stand for
 *  the assignment's recorded dispatch values, which the page must not replace with its own. */
type SeatSettings = {
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly harness?: string | null;
};

const running = (
  id: number,
  what: string,
  detail: string,
  state = "running",
  settings: SeatSettings = {},
): Row => ({ id, what, state, detail, ...settings }) as Row;

const withRunning = (...rows: readonly Row[]): Board => ({ ...empty(), running: rows });

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("the page is the running box, agent first", () => {
  it("reads a seat's worker, age and cost off the row's own detail", () => {
    const { worker, seat } = seatOf(running(8, "task #12", "opus · 14m · 37k"));
    expect(worker).toBe("opus");
    expect(seat).toEqual({
      id: 8,
      what: "task #12",
      phase: "running",
      model: null,
      effort: null,
      harness: null,
      minutes: 14,
      spent: 37,
    });
  });

  it("reads the model, effort and harness from the assignment row", () => {
    const row = running(8, "task #12", "opus · 14m · 37k", "running", {
      model: "claude-opus-5",
      effort: "high",
      harness: "claude-code",
    });
    expect(seatOf(row).seat).toMatchObject({
      model: "claude-opus-5",
      effort: "high",
      harness: "claude-code",
    });
    const body = agentsContents(withRunning(row));
    expect(body).toContain(`<span class="model">claude-opus-5</span>`);
    expect(body).toContain(`<span class="effort">high</span>`);
    expect(body).toContain(`<span class="harness">claude-code</span>`);
  });

  it("does not invent a model, effort or harness missing from the record", () => {
    const body = agentsContents(withRunning(running(8, "task #12", "opus · 14m · 37k")));
    for (const name of ["model", "effort", "harness"]) {
      expect(body, name).not.toContain(`<span class="${name}">`);
    }
  });

  it("gathers an agent's seats under one card, however far apart the board sorts them", () => {
    const board = withRunning(
      running(8, "task #12", "opus · 14m · 37k"),
      running(9, "task #13", "sonnet · 2m · 3k"),
      running(10, "task #14", "opus · 40m · 5k"),
    );
    const held = workers(board);
    expect(held.map((w) => w.name)).toEqual(["opus", "sonnet"]);
    expect(held[0]?.seats.map((s) => s.id)).toEqual([8, 10]);
  });

  it("counts an agent's spend across its seats and dates it by its oldest", () => {
    const held = workers(
      withRunning(
        running(8, "task #12", "opus · 14m · 37k"),
        running(10, "task #14", "opus · 40m · 5k"),
      ),
    );
    expect(held[0]?.spent).toBe(42);
    expect(held[0]?.minutes).toBe(40);
  });

  it("puts the costliest agent first, and settles a tie by name", () => {
    const held = workers(
      withRunning(
        running(8, "a", "sonnet · 1m · 2k"),
        running(9, "b", "haiku · 1m · 9k"),
        running(10, "c", "alpha · 1m · 2k"),
      ),
    );
    expect(held.map((w) => w.name)).toEqual(["haiku", "alpha", "sonnet"]);
  });

  it("counts no row the board does not put in running", () => {
    const board = { ...withRunning(running(8, "a", "opus · 1m · 2k")), queued: [running(9, "b", "opus · 1m · 9k")] };
    expect(workers(board)).toHaveLength(1);
    expect(workers(board)[0]?.spent).toBe(2);
  });

  it("draws each agent as its name, how many seats it holds and what it is spending", () => {
    const body = agentsContents(withRunning(running(8, "task #12", "opus · 14m · 37k")));
    expect(body).toContain(`<li class="worker" id="worker-opus" data-ui="agents.running">`);
    expect(body).toContain(`<span class="name">opus</span>`);
    expect(body).toContain(`<span class="seats">1 working</span>`);
    expect(body).toContain(`<span class="cost">37k</span>`);
  });

  it("hangs an agent's seats in a list of their own, under the readings of the agent", () => {
    const body = agentsContents(
      withRunning(
        running(8, "task #12", "opus · 14m · 37k"),
        running(10, "task #14", "opus · 40m · 5k"),
      ),
    );
    const card = body.slice(body.indexOf(`id="worker-opus"`));
    const seats = card.indexOf(`<ul class="seats">`);
    expect(card.slice(0, seats)).not.toContain(`id="seat-`);
    expect(card.indexOf(`data-ui="agents.running.last-said"`)).toBeGreaterThan(seats);
    expect(card.indexOf(`data-ui="agents.running.last-said"`)).toBeLessThan(card.indexOf(`id="seat-8"`));
    expect(card.indexOf(`id="seat-8"`)).toBeLessThan(card.indexOf(`id="seat-10"`));
  });

  it("draws each seat as the work, the phase it is in and what it has cost", () => {
    const body = agentsContents(withRunning(running(8, "task #12", "opus · 14m · 37k", "pending")));
    expect(body).toContain(
      `<li id="seat-8"><span class="id">#8</span>` +
        `<span class="what">task #12</span>` +
        `<span class="phase">pending</span>` +
        `<span class="age">14m</span>` +
        `<span class="cost">37k</span></li>`,
    );
  });

  it("says the whole workspace's cost above the cards", () => {
    const body = agentsContents(
      withRunning(running(8, "a", "opus · 1m · 37k"), running(9, "b", "sonnet · 2m · 3k")),
    );
    expect(body).toContain(`<p class="total">2 working · 2 seats · 40k</p>`);
  });

  /** The chore, idle and today cards are cards of the same list, so a count of cards is
   *  not a count of agents: what the total says is who the board has running. */
  it("counts the agents and not the cards, though chore, idle and today stand beside them", () => {
    const body = agentsContents(withRunning(running(8, "a", "opus · 1m · 37k")));
    expect(body).toContain(`<p class="total">1 working · 1 seats · 37k</p>`);
    for (const id of ["agents.chore", "agents.idle", "agents.today"]) {
      expect(body, id).toContain(`<li class="worker" id="${id.replace(".", "-")}" data-ui="${id}">`);
    }
    expect([...body.matchAll(/<li class="worker"/g)]).toHaveLength(4);
  });
});

describe("a seat nothing can be read off is still a seat", () => {
  it("keeps a row whose detail names no worker, under the unnamed one", () => {
    const held = workers(withRunning(running(8, "task #12", "? · 3m · 1k")));
    expect(held[0]?.name).toBe(UNNAMED);
    expect(held[0]?.spent).toBe(1);
  });

  it("dates and counts nothing rather than zero when the detail says neither", () => {
    const { seat } = seatOf(running(8, "task #12", "opus"));
    expect(seat.minutes).toBeNull();
    expect(seat.spent).toBeNull();
    const body = agentsContents(withRunning(running(8, "task #12", "opus")));
    expect(body).not.toContain(`<span class="age">0m</span>`);
    expect(body).toContain(`<span class="what">task #12</span>`);
  });

  it("says so rather than coming back blank when nobody is working", () => {
    expect(agentsContents(empty())).toContain("nobody is working right now");
    expect(agentsContents(empty())).not.toContain(`<ul class="agents">`);
    // No list, so none of the cards in it either — the word is the whole of the answer.
    for (const id of ["agents.running", "agents.chore", "agents.idle", "agents.today"]) {
      expect(agentsContents(empty()), id).not.toContain(`data-ui="${id}"`);
    }
  });

  it("writes an agent's own words as words and not as markup", () => {
    const body = agentsContents(withRunning(running(8, `a <script> & "quotes"`, "opus · 1m · 1k")));
    expect(body).not.toContain("<script>");
    expect(body).toContain(`a &lt;script&gt; &amp; &quot;quotes&quot;`);
  });
});

describe("the agents page answers at /agents through discovery", () => {
  const dir = fileURLToPath(new URL("../src/pages", import.meta.url));

  it("is a discovered page of the surface, at its own name", () => {
    expect(discovered(readdirSync(dir))).toContain("agents");
    expect(pathOf("agents")).toBe("/agents");
  });

  it("is mounted from the file alone, with no registration anywhere", async () => {
    const module = (await import("../src/pages/agents.js")) as unknown as Record<string, unknown>;
    const handler = mounted("agents", module, { board: () => withRunning(running(8, "a", "opus · 1m · 1k")) });
    expect(handler(new URL("http://localhost/agents")).body).toContain(`id="worker-opus"`);
  });

  it("asks for the board and not the record, because it is a view of what is moving", () => {
    expect(READS).toBe("board");
  });

  it("is in the routes discovery builds, without bin.ts naming it", async () => {
    const routes = await pages({
      record: () => [],
      board: () => withRunning(running(8, "task #12", "opus · 1m · 1k")),
      approvals: () => [],
    });
    expect(Object.keys(routes)).toContain("/agents");
  });

  it("answers /agents with an html document in the shell, over a socket", async () => {
    const board = withRunning(running(8, "task #12", "opus · 14m · 37k"));
    const server = await serve({ "/agents": agentsAt(() => board) });
    servers.push(server);
    const res = await fetch(`${addressOf(server)}/agents`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("<title>wecode</title>");
    expect(body.slice(body.indexOf("<main>"), body.indexOf("</main>"))).toContain(`id="worker-opus"`);
    expect(body).toBe(agentsPage(board).body);
  });

  it("reads the board again on every request", async () => {
    let board = empty();
    const server = await serve({ "/agents": agentsAt(() => board) });
    servers.push(server);
    expect(await (await fetch(`${addressOf(server)}/agents`)).text()).toContain(
      "nobody is working right now",
    );
    board = withRunning(running(8, "task #12", "opus · 1m · 1k"));
    expect(await (await fetch(`${addressOf(server)}/agents`)).text()).toContain(`id="worker-opus"`);
  });

  /** The shell's terminal dock is the one verb the document carries, so the page is left
   *  with the rule that outlives approval 1561: no script, because none is served. */
  it("offers no verb of its own, because the dock is the only way in", () => {
    const body = agentsPage(withRunning(running(8, "a", "opus · 1m · 1k"))).body;
    for (const verb of ["onclick"]) {
      expect(body, `the agents page offers ${verb}`).not.toContain(verb);
    }
  });
});

describe("the running seat look", () => {
  it("limits the work to two elided lines instead of wrapping it forever", () => {
    const design = readFileSync(
      fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url)),
      "utf8",
    );
    const what = design.match(/"section\.agents ul\.agents ul\.seats li \.what": "([^"]+)"/)?.[1] ?? "";
    expect(what).toContain("-webkit-line-clamp: 2");
    expect(what).toContain("overflow: hidden");
    expect(what).toContain("text-overflow: ellipsis");
    expect(what).not.toContain("overflow-wrap");
  });
});

describe("the component map claims the page", () => {
  it("names it among the webapp's modules", () => {
    const map = readFileSync(
      fileURLToPath(new URL("../../core/config/components.yaml", import.meta.url)),
      "utf8",
    );
    expect(map).toContain("pages/agents");
  });
});
