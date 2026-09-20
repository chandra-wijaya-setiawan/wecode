/** The web surface's one verb: an approval, answered.
 *
 *  Everything else here is read. This is the exception, and it is the exception for the
 *  reason the decisions page exists at all — an approval is the one row in wecode whose
 *  whole point is that a person outside the work has to say something, and a person who is
 *  already looking at the question should not have to go and find a terminal to say it in.
 *  Nothing else on this surface changes wecode, and nothing else here is a candidate to:
 *  every other verb is an agent's or the cli's.
 *
 *  Authority is not relayed, so it is not invented here either. The answer is recorded in
 *  the operator's own name, and who that is arrives from the process that opened the
 *  workspace — `bin.ts`'s — never from the request. A browser that could name its own
 *  answerer is a browser that can sign anything, and core would take the name at its word.
 *
 *  This file decides nothing about approvals. What may be answered, by whom, and what the
 *  answer does to the record is `answerApproval`'s, and its refusals are passed through in
 *  its own words: a second opinion about them here would be a second thing to keep true. */
import type { DatabaseSync } from "node:sqlite";
import { answerApproval, ApprovalError } from "@wecode/core";
import { seeOther, text, type Reply, type Verb } from "./server.js";

/** Where a client is sent once the answer is in: the page the question was read on, which
 *  no longer has it. */
export const ANSWERED_AT = "/decisions";

/** How the verb is posted, said in the one place that has to be right. It is in the refusal
 *  a malformed post gets, because the reader of that refusal is a person with a curl. */
export const POSTED_AS = "post id=<number>&answer=<text> as application/x-www-form-urlencoded";

/** Who wecode records the answer as. Null where the process was never told — a workspace
 *  with several people on it has no obvious one to sign for, and choosing would be the
 *  webapp deciding whose signature a decision carries. */
export type Operator = () => string | null;

/** What was posted, as the two fields this verb has. A field that was not sent is empty,
 *  not absent: what is missing is refused below in the same sentence as what is malformed. */
export const fieldsOf = (body: string): { readonly id: string; readonly answer: string } => {
  const form = new URLSearchParams(body);
  return { id: form.get("id") ?? "", answer: form.get("answer") ?? "" };
};

/** The verb, done. Every refusal is a 400 with the reason in it and the record untouched;
 *  the one success is a 303 back to the page, so the browser reads the decisions again and
 *  a reload does not answer twice. */
export function answerPosted(db: DatabaseSync, body: string, operator: Operator): Reply {
  const { id, answer } = fieldsOf(body);
  if (!/^[0-9]+$/.test(id)) {
    return text(400, `${JSON.stringify(id)} is not an approval to answer — ${POSTED_AS}`);
  }

  const by = operator();
  if (by === null) {
    return text(
      400,
      "this webapp was not told who is answering, and an approval may not be answered " +
        "anonymously — start it with wecode-webapp --operator <name>",
    );
  }

  try {
    const done = answerApproval(db, Number(id), answer, by);
    return seeOther(ANSWERED_AT, `approval #${done.id} answered ${done.answer ?? ""} by ${by}`);
  } catch (err) {
    if (err instanceof ApprovalError) return text(400, err.message);
    throw err;
  }
}

/** The verb, bound to a workspace and to who is answering in it.
 *
 *  The database arrives as a function for the reason the pages' rows do: what is proved
 *  here is the verb, and where a workspace is, is `bin.ts`'s. */
export const answerAt = (db: () => DatabaseSync, operator: Operator): { readonly post: Verb } => ({
  post: (_url, body) => answerPosted(db(), body, operator),
});
