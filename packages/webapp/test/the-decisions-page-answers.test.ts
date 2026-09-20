/** The web surface's one verb: `POST /answer`, and both pages it sits between served.
 *
 *  This test wants a workspace rather than a hand-made row, which the decisions page's own
 *  test deliberately does not: what is held here is that the answer reaches the record —
 *  that the approval stops waiting, carries the words that were posted, and carries the
 *  name of the person the process was told about. A fixture that stood in for
 *  `answerApproval` would prove the webapp talks to itself.
 *
 *  Authority is the assertion this file exists for. The answerer is never read off the
 *  request: a post that names its own signatory is answered in the operator's name anyway,
 *  and a webapp that was told about nobody refuses rather than picks. */
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerApproval, approvalById, Maker, open, raiseApproval, waitingApprovals } from "@wecode/core";
import { answerAt, answerPosted, fieldsOf, POSTED_AS } from "../src/answer.js";
import { decisionsAt } from "../src/pages/decisions.js";
import { addressOf, answer, serve, type Routes } from "../src/server.js";
import { seed } from "../../core/test/helpers.js";

let db: DatabaseSync;
let task: number;
let dana: number;

beforeEach(() => {
  db = open(":memory:");
  task = seed(db).task;
  const make = new Maker(db);
  make.role("operator", { write: [], tools: [] }, "human");
  make.role("engineer", { write: ["src/**"], tools: ["bash"] }, "agent");
  dana = make.worker("dana", "operator", "human");
  make.worker("claude", "engineer", "agent");
});

afterEach(() => {
  db.close();
});

/** One question waiting on a person, and its id. */
const ask = (options?: readonly string[]): number =>
  raiseApproval(db, {
    objective_type: "task",
    objective_id: task,
    worker_id: dana,
    question: "ship the reset mail to production?",
    ...(options === undefined ? {} : { options }),
  }).id;

/** The whole surface this story serves, bound the way `bin.ts` binds it. */
const surface = (operator: () => string | null = () => "dana"): Routes => ({
  "/decisions": decisionsAt(() => waitingApprovals(db)),
  "/answer": answerAt(() => db, operator),
});

const posted = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

/** A listening copy of the surface. Port 0, so two of these can run at once. */
async function running(operator?: () => string | null): Promise<string> {
  const server = await serve(surface(operator));
  servers.push(server);
  return addressOf(server);
}

describe("the surface answers an approval", () => {
  it("writes the posted words to the record, in the operator's name", () => {
    const id = ask();
    const reply = answerPosted(db, posted({ id: String(id), answer: "ship it" }), () => "dana");
    expect(reply.status).toBe(303);
    const after = approvalById(db, id);
    expect(after).toMatchObject({ answer: "ship it", answered_by: "dana" });
  });

  it("takes the question off the page it was read on", () => {
    const id = ask();
    expect(waitingApprovals(db).map((a) => a.id)).toEqual([id]);
    answerPosted(db, posted({ id: String(id), answer: "ship it" }), () => "dana");
    expect(waitingApprovals(db)).toEqual([]);
  });

  it("sends the client back to the decisions page, and says what it did", () => {
    const id = ask();
    const reply = answerPosted(db, posted({ id: String(id), answer: "ship it" }), () => "dana");
    expect(reply.location).toBe("/decisions");
    expect(reply.body).toContain(`approval #${id} answered ship it by dana`);
  });

  it("reads the two fields it has, and nothing else", () => {
    expect(fieldsOf(posted({ id: "4", answer: "hold", by: "claude" }))).toEqual({
      id: "4",
      answer: "hold",
    });
  });
});

describe("the answerer is the operator, and is not the request's to choose", () => {
  it("records the operator however the post signs itself", () => {
    const id = ask();
    answerPosted(db, posted({ id: String(id), answer: "ship it", by: "claude" }), () => "dana");
    expect(approvalById(db, id)?.answered_by).toBe("dana");
  });

  it("refuses when the process was told about nobody, and leaves the question waiting", () => {
    const id = ask();
    const reply = answerPosted(db, posted({ id: String(id), answer: "ship it" }), () => null);
    expect(reply.status).toBe(400);
    expect(reply.body).toContain("--operator");
    expect(waitingApprovals(db).map((a) => a.id)).toEqual([id]);
  });

  it("refuses an agent's name the way core does, rather than checking it twice", () => {
    const id = ask();
    const reply = answerPosted(db, posted({ id: String(id), answer: "ship it" }), () => "claude");
    expect(reply.status).toBe(400);
    expect(reply.body).toContain("may not be answered on a person's behalf");
    expect(approvalById(db, id)?.phase).toBe("waiting");
  });
});

describe("a post that cannot be answered is refused in words", () => {
  it("says how the verb is posted when there is no id to answer", () => {
    const reply = answerPosted(db, posted({ answer: "ship it" }), () => "dana");
    expect(reply.status).toBe(400);
    expect(reply.body).toContain(POSTED_AS);
  });

  it("refuses an id that is not a number", () => {
    const reply = answerPosted(db, posted({ id: "seven", answer: "ship it" }), () => "dana");
    expect(reply.status).toBe(400);
    expect(reply.body).toContain('"seven" is not an approval to answer');
  });

  it("passes core's refusal through in core's own words", () => {
    expect(answerPosted(db, posted({ id: "99", answer: "ship it" }), () => "dana").body).toContain(
      "no approval #99",
    );
    const closed = ask(["ship", "hold"]);
    expect(answerPosted(db, posted({ id: String(closed), answer: "maybe" }), () => "dana").body).toContain(
      "offers ship, hold",
    );
    const empty = ask();
    expect(answerPosted(db, posted({ id: String(empty), answer: "" }), () => "dana").body).toContain(
      'takes an answer, and "" is not one',
    );
  });

  it("refuses one already answered, rather than overwriting it", () => {
    const id = ask();
    answerApproval(db, id, "ship it", "dana");
    const reply = answerPosted(db, posted({ id: String(id), answer: "hold" }), () => "dana");
    expect(reply.status).toBe(400);
    expect(approvalById(db, id)?.answer).toBe("ship it");
  });
});

describe("both paths are routed", () => {
  it("serves the decisions page at /decisions", async () => {
    ask();
    const res = await fetch(`${await running()}/decisions`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ship the reset mail to production?");
  });

  it("answers a form posted to /answer, and redirects to the page", async () => {
    const id = ask();
    const at = await running();
    const res = await fetch(`${at}/answer`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: posted({ id: String(id), answer: "ship it" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/decisions");
    expect(approvalById(db, id)).toMatchObject({ answer: "ship it", answered_by: "dana" });
  });

  it("leaves the answered question off the page a client is sent to", async () => {
    const id = ask();
    const at = await running();
    await fetch(`${at}/answer`, { method: "POST", body: posted({ id: String(id), answer: "ship it" }) });
    const body = await (await fetch(`${at}/decisions`)).text();
    expect(body).not.toContain(`approval-${id}"`);
    expect(body).toContain("nothing is waiting on a person");
  });

  it("does not read the verb's path, and does not post to the page's", () => {
    const routes = surface();
    expect(answer(routes, "GET", "/answer").status).toBe(405);
    expect(answer(routes, "GET", "/answer").body).toContain("POST only");
    expect(answer(routes, "POST", "/decisions").status).toBe(405);
    expect(answer(routes, "POST", "/decisions").body).toContain("GET only");
  });

  it("still says what it serves at a path nothing routes", () => {
    const reply = answer(surface(), "POST", "/nowhere");
    expect(reply.status).toBe(404);
    expect(reply.body).toContain("/answer /decisions");
  });

  it("serves no verb it was not given one for", () => {
    expect(answer(surface(), "DELETE", "/answer").status).toBe(405);
    expect(answer(surface(), "DELETE", "/answer").body).toContain("GET and POST only");
  });

  it("answers nothing when the body never arrives", async () => {
    const at = await running();
    const res = await fetch(`${at}/answer`, { method: "POST", body: "" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(POSTED_AS);
  });
});
