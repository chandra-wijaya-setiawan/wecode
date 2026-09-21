/** The decisions page: one card per approval still waiting on a person, and the form that
 *  answers one.
 *
 *  The approvals are hand-made rather than read out of a workspace, for the reason the
 *  board's test makes its own rows: what is being held is the page and the transport, and
 *  a page that could only be read with a database behind it drags every assertion here
 *  through the next migration. That the rows are the *waiting* ones is `waitingApprovals`'s
 *  and is tested where that function lives.
 *
 *  This file used to assert the opposite of what it asserts now: that the page carried no
 *  form, no button and no input at all. That rule was read off a design that has since
 *  declared the form — approval #1561 answered it — and a page that printed
 *  `wecode answer <id>` at a person who was already looking at the question was the defect
 *  it protected. What is held here instead is that the form posts what `answer.ts` reads. */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { Approval } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWERED_AT, fieldsOf } from "../src/answer.js";
import { addressOf, answer, serve } from "../src/index.js";
import {
  decisionCards,
  decisionsAt,
  decisionsPage,
} from "../src/pages/decisions.js";

/** Where the form posts. The page's markup, `answer.ts`'s verb and `bin.ts`'s mount all
 *  have to be this one path, and the three are held to it below. */
const POSTS_TO = "/answer";

const approval = (id: number, over: Partial<Approval> = {}): Approval => ({
  id,
  objective_type: "task",
  objective_id: 12,
  worker_id: 1,
  phase: "waiting",
  kind: "approval",
  question: `is question ${id} settled?`,
  options: null,
  answer: null,
  answered_by: null,
  evidence: {
    type: "task",
    id: 12,
    statement: "widen the scope",
    state: "attempting",
  },
  ...over,
});

/** The card ids the document came out with, in the order it wrote them. */
const cards = (body: string): readonly string[] =>
  [...body.matchAll(/<article id="approval-([^"]+)"/g)].map(
    (m) => m[1] as string,
  );

/** The markup of one card, so an assertion about a card is not an assertion about the
 *  page. */
function cardOf(body: string, id: number): string {
  const at = body.indexOf(`<article id="approval-${id}"`);
  expect(at, `the page has no card for #${id}`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</article>", at));
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

/** A running server and what a client gets from it. Port 0, so two of these can run at
 *  once and neither depends on a port being free. */
async function fetched(
  approvals: () => readonly Approval[],
  path = "/decisions",
  init: RequestInit = {},
): Promise<Response> {
  const server = await serve({ "/decisions": decisionsAt(approvals) });
  servers.push(server);
  return fetch(`${addressOf(server)}${path}`, init);
}

describe("the decisions page", () => {
  it("answers with an html document in the shell", async () => {
    const res = await fetched(() => []);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("<main>");
  });

  it("draws one card per waiting approval, in the order they were given", () => {
    const body = decisionsPage([approval(3), approval(7), approval(9)]).body;
    expect(cards(body)).toEqual(["3", "7", "9"]);
  });

  it("writes a card as its number, its question, the work it hangs on and its answers", () => {
    const one = approval(4, {
      question: "ship the reset mail to production?",
      options: ["ship", "hold"],
    });
    const card = cardOf(decisionsPage([one]).body, 4);
    expect(card).toContain(`<span class="id">#4</span>`);
    expect(card).toContain("ship the reset mail to production?");
    expect(card).toContain("task #12 · widen the scope · attempting");
    expect(card).toContain("<li>ship</li>");
    expect(card).toContain("<li>hold</li>");
  });

  it("says an open question takes any answer, rather than listing none", () => {
    const card = cardOf(
      decisionsPage([approval(5, { options: null })]).body,
      5,
    );
    expect(card).toContain("any answer settles it");
    expect(card).not.toContain("<li>");
  });

  it("says so when the work a question hangs on is gone", () => {
    const card = cardOf(
      decisionsPage([approval(6, { evidence: null })]).body,
      6,
    );
    expect(card).toContain("the work this asked about is gone");
  });

  it("tells a reader how an approval is answered, and it is not from here", () => {
    const card = cardOf(decisionsPage([approval(8)]).body, 8);
    expect(card).toContain(`wecode answer 8 &quot;&lt;text&gt;&quot;`);
  });

  it("says nothing is waiting rather than coming back blank", async () => {
    const body = await (await fetched(() => [])).text();
    expect(cards(body)).toEqual([]);
    expect(body).toContain("nothing is waiting on a person");
  });

  it("gives every card a form that posts to the verb that answers", async () => {
    const body = await (
      await fetched(() => [
        approval(1, { options: ["yes", "no"] }),
        approval(2),
      ])
    ).text();
    for (const id of [1, 2]) {
      const card = cardOf(body, id);
      expect(card).toContain(
        `<form class="answer" method="post" action="${POSTS_TO}">`,
      );
      expect(card).toContain("</form>");
      expect(card).toContain('<button type="submit">send</button>');
    }
  });

  it("carries the approval's own id in the form, so the verb knows what was answered", () => {
    const card = cardOf(decisionsPage([approval(41)]).body, 41);
    expect(card).toContain(`<input type="hidden" name="id" value="41">`);
  });

  it("offers one radio per declared option, in the option's own words", () => {
    const one = approval(4, { options: ["ship", "hold"] });
    const card = cardOf(decisionsPage([one]).body, 4);
    for (const said of ["ship", "hold"]) {
      expect(card).toContain(
        `<input type="radio" name="answer" value="${said}">`,
      );
      expect(card).toContain(`<span>${said}</span>`);
    }
    expect([...card.matchAll(/type="radio"/g)]).toHaveLength(2);
  });

  it("offers no radio at all where the question declared no options", () => {
    const card = cardOf(
      decisionsPage([approval(5, { options: null })]).body,
      5,
    );
    expect(card).not.toContain(`type="radio"`);
    expect(card).not.toContain("choices");
    // The note is the whole answer here, and it is still there.
    expect(card).toContain(`name="answer"`);
  });

  it("offers a note for an answer nobody listed, after the options", () => {
    const card = cardOf(
      decisionsPage([approval(6, { options: ["ship"] })]).body,
      6,
    );
    const note = card.indexOf(`<label class="note">`);
    expect(note).toBeGreaterThan(card.indexOf('type="radio"'));
    expect(card.slice(note)).toContain(`<input type="text" name="answer"`);
    // A browser sends the fields in the order they are written, so a picked option is the
    // one `fieldsOf` reads and the note is the fallback.
    expect(fieldsOf("id=6&answer=ship&answer=").answer).toBe("ship");
    expect(fieldsOf("id=6&answer=a second thought").answer).toBe(
      "a second thought",
    );
  });

  it("writes an option into the value as words, not as markup", () => {
    const said = `yes, "now" & <soon>`;
    const card = cardOf(
      decisionsPage([approval(7, { options: [said] })]).body,
      7,
    );
    expect(card).toContain(`value="yes, &quot;now&quot; &amp; &lt;soon&gt;"`);
    expect(card).not.toContain("<soon>");
  });

  it("posts the two fields the verb reads, and the verb is mounted where the form posts", () => {
    const card = cardOf(
      decisionsPage([approval(8, { options: ["go"] })]).body,
      8,
    );
    const posted = new URLSearchParams(
      [...card.matchAll(/name="([^"]+)"/g)].map((m) => [m[1] as string, ""]),
    );
    expect([...new Set(posted.keys())].sort()).toEqual(["answer", "id"]);
    // `answer.ts` sends a browser back to the page it asked on once the answer is in.
    expect(ANSWERED_AT).toBe("/decisions");
  });

  it("posts to the path bin.ts mounts the verb at", () => {
    // The form spells a path and `bin.ts` mounts one; nothing makes the two agree except
    // this. Read rather than imported, because importing the binary starts a server.
    const bin = readFileSync(
      fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
      "utf8",
    );
    expect(bin).toContain(`"${POSTS_TO}": answerAt(`);
  });

  it("serves nothing but GET at the page's path", async () => {
    const routes = { "/decisions": decisionsAt(() => []) };
    expect(answer(routes, "POST", "/decisions").status).toBe(405);
    const res = await fetched(() => [], "/decisions", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("writes a person's own words as words, not as markup", async () => {
    const said = `a <script>alert("x")</script> & an 'apostrophe'`;
    const body = await (
      await fetched(() => [
        approval(2, {
          question: said,
          options: [said],
          evidence: { type: "task", id: 1, statement: said, state: said },
        }),
      ])
    ).text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(body).toContain("&amp; an &#39;apostrophe&#39;");
  });

  it("reads the waiting approvals again on every request", async () => {
    let reads = 0;
    const server = await serve({
      "/decisions": decisionsAt(() => {
        reads += 1;
        return [approval(reads, { question: `read ${reads}` })];
      }),
    });
    servers.push(server);
    const first = await (await fetch(`${addressOf(server)}/decisions`)).text();
    const second = await (await fetch(`${addressOf(server)}/decisions`)).text();
    expect(reads).toBe(2);
    expect(first).toContain("read 1");
    expect(second).toContain("read 2");
  });

  it("writes the cards without a document of their own", () => {
    const inside = decisionCards([approval(1)]);
    expect(inside).not.toContain("<!doctype");
    expect(inside).not.toContain("<html");
    expect(decisionsPage([approval(1)]).body).toContain(inside);
  });
});
