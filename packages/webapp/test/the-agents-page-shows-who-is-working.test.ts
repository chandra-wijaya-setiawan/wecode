/** The agents page against its definition: every node declared under `agents` is drawn,
 *  by its own name and in the definition's own words.
 *
 *  What the page *means* — the running box turned round, a seat read off its detail, the
 *  costliest agent first — is held in `the-agents-page-shows-who-works-at-what-cost`.
 *  This file holds only the surface against the definition: the ids, the words, the
 *  nesting, and the two nodes that are verbs and are deliberately not drawn. */
import type { Board, Row } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { agentsContents, NOTHING } from "../src/pages/agents.js";

const empty = (): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
});

const running = (id: number, what: string, detail: string, state = "running"): Row => ({
  id, what, state, detail,
});

const withRunning = (...rows: readonly Row[]): Board => ({ ...empty(), running: rows });

/** The nodes `packages/webapp/config/ui.yaml` declares under `agents`: the id each carries
 *  as its `data-ui`, and the `says` the definition gives it. Written out here rather than
 *  read off that file because the file is not in this tree — it has never landed on master
 *  and this story may not add it. When it lands, this table is what it is read against.
 *  `agents.running` and `agents.chore` are declared with a `repeats` and no `says`. */
const DECLARED: readonly (readonly [string, string | null])[] = [
  ["agents", "Agents"],
  ["agents.running", null],
  ["agents.running.elapsed", "elapsed"],
  ["agents.running.tokens", "tokens"],
  ["agents.running.last-said", "last said"],
  ["agents.chore", null],
  ["agents.chore.elapsed", "elapsed"],
  ["agents.idle", "Idle"],
  ["agents.today", "Today"],
];

/** Two agents at work, one of them on two seats, so a repeated card is repeated and a
 *  card's readings are of the agent and not of one row. */
const board = withRunning(
  running(8, "task #12 draw the agents page", "opus · 14m · 37k"),
  running(9, "task #13 mend the tree", "sonnet · 2m · 3k"),
  running(10, "task #14 land it", "opus · 40m · 5k"),
);

const body = agentsContents(board);
const where = (id: string): number => body.indexOf(`data-ui="${id}"`);

describe("every node the definition declares is drawn, by its own name", () => {
  it("draws each declared node, carrying its id and saying what the definition says", () => {
    for (const [id, says] of DECLARED) {
      expect(body, id).toContain(`data-ui="${id}"`);
      if (says !== null) expect(body.slice(where(id), where(id) + 200), id).toContain(says);
    }
  });

  it("nests them as the definition parents them", () => {
    for (const [outer, inner] of [
      ["agents", "agents.running"],
      ["agents.running", "agents.running.elapsed"],
      ["agents.running.elapsed", "agents.running.tokens"],
      ["agents.running.tokens", "agents.running.last-said"],
      ["agents", "agents.chore"],
      ["agents.chore", "agents.chore.elapsed"],
      ["agents", "agents.idle"],
      ["agents", "agents.today"],
    ] as const) {
      expect(where(outer), `${outer} before ${inner}`).toBeLessThan(where(inner));
    }
  });

  it("orders the four cards as the definition orders them: running, chore, idle, today", () => {
    const seen = [...body.matchAll(/data-ui="(agents\.(?:running|chore|idle|today))"/g)].map((m) => m[1]);
    expect(seen).toEqual(["agents.running", "agents.running", "agents.chore", "agents.idle", "agents.today"]);
  });

  it("repeats the running card once per agent at work, and the spare cards once each", () => {
    expect([...body.matchAll(/data-ui="agents\.running"/g)]).toHaveLength(2);
    for (const id of ["agents.chore", "agents.idle", "agents.today"]) {
      expect(body.split(`data-ui="${id}"`).length - 1, id).toBe(1);
    }
  });

  it("draws none of the two that are verbs, which wait on the operator", () => {
    for (const id of ["transcript", "stop"]) expect(body, id).not.toContain(`agents.running.${id}`);
    for (const says of ["read transcript", ">stop<"]) expect(body, says).not.toContain(says);
  });
});

describe("each reading is of the agent, in the board's own words", () => {
  const card = (name: string): string =>
    body.slice(body.indexOf(`id="worker-${name}"`), body.indexOf(`</li></ul></li>`, body.indexOf(`id="worker-${name}"`)));

  it("dates the running card by the agent's oldest seat and counts every seat's tokens", () => {
    expect(card("opus")).toContain(`<li data-ui="agents.running.elapsed"><span class="what">elapsed</span><span class="age">40m</span></li>`);
    expect(card("opus")).toContain(`<li data-ui="agents.running.tokens"><span class="what">tokens</span><span class="cost">42k</span></li>`);
    expect(card("sonnet")).toContain(`<span class="age">2m</span></li>`);
  });

  it("says as last said the work of the agent's youngest seat, and not its oldest", () => {
    expect(card("opus")).toContain(
      `<li data-ui="agents.running.last-said"><span class="what">last said</span>` +
        `<span class="phase">task #12 draw the agents page</span></li>`,
    );
    expect(card("opus")).not.toContain(`<span class="phase">task #14 land it</span>`);
  });

  it("writes an agent's own words as words and not as markup, in the reading too", () => {
    const said = agentsContents(withRunning(running(8, `a <script> & "quotes"`, "opus · 1m · 1k")));
    expect(said.slice(said.indexOf(`data-ui="agents.running.last-said"`))).toContain(
      `a &lt;script&gt; &amp; &quot;quotes&quot;`,
    );
    expect(said).not.toContain("<script>");
  });

  it("shows a reading the row does not carry as nothing, and never as a measured zero", () => {
    const said = agentsContents(withRunning(running(8, "task #12", "opus")));
    expect(said).toContain(`<li data-ui="agents.running.elapsed"><span class="what">elapsed</span><span class="age">${NOTHING}</span></li>`);
    expect(said).toContain(`<span class="cost">${NOTHING}</span>`);
    expect(said).not.toContain(`<span class="age">0m</span>`);
  });

  it("draws a card the board carries nothing for as a word, not as an empty list", () => {
    // The board has no chore box, no roster of who is not working and no history of the
    // day. Each card is still declared, so each is drawn — saying what it cannot say.
    expect(body).toContain(`<span class="seats">no chore box on the board</span>`);
    expect(body).toContain(`<span class="seats">the board names only who is working</span>`);
    expect(body).toContain(`<span class="seats">no day on the board — the ledger counts it</span>`);
    expect(body.slice(where("agents.chore"), where("agents.idle"))).toContain(
      `<span class="age">${NOTHING}</span>`,
    );
  });
});

describe("the page it was already stands", () => {
  it("still says so rather than coming back blank when nobody is working", () => {
    expect(agentsContents(empty())).toContain("nobody is working right now");
  });

  it("heads the page with the definition's word, under the document's one h1", () => {
    expect(body).toContain(`<section class="agents" data-ui="agents"><h2>Agents</h2>`);
    expect(body).not.toContain("<h1");
  });

  it("names every declared node inside the one shape the look scopes this page to", () => {
    const inside = body.slice(`<section class="agents" data-ui="agents">`.length, -"</section>".length);
    for (const [id] of DECLARED.slice(1)) expect(inside, id).toContain(`data-ui="${id}"`);
  });

  it("draws every element it opens, and closes each one", () => {
    const open = [...body.matchAll(/<(\w+)(?=[\s>])/g)].map((m) => m[1]);
    const shut = [...body.matchAll(/<\/(\w+)>/g)].map((m) => m[1]);
    expect(open.length).toBe(shut.length);
    for (const tag of new Set(open)) {
      expect(open.filter((t) => t === tag).length, tag).toBe(shut.filter((t) => t === tag).length);
    }
  });
});
