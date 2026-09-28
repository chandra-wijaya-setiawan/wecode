/** The surface's second verb: a sketch, taken out of the record.
 *
 *  It is a verb and not a sentence typed at the dock, and that is the whole point of the
 *  file. Removal used to post the words `wecode sketch drop <id>` at the terminal for the
 *  operator to press return on — the reasoning being that this page draws nothing and
 *  decides nothing. But the surface already answers approvals with a real POST, so "no
 *  verbs here" was never the rule; and typing a command at a dock that happens to be
 *  running an agent puts it in that agent's composer, where it looks sent and does nothing.
 *  Three clicks left three commands concatenated in somebody's input box and no sketch
 *  removed.
 *
 *  Taking a row out of the record is `core`'s `dropSketch`, which this calls directly. The
 *  drawing stays: the row goes and the file on disk is left alone, which is `dropSketch`'s
 *  decision and not this file's — the file is the operator's and may be linked from places
 *  the record cannot see.
 *
 *  Several sketches can be ticked, so several ids can arrive. A form with checkboxes all
 *  named the same thing posts one field per tick, which is why the list needs no script to
 *  remove more than one. */
import type { DatabaseSync } from "node:sqlite";
import { dropSketch } from "@wecode/core";
import { seeOther, text, type Handler, type Reply, type Verb } from "./server.js";

/** Where the verb answers. */
export const DROP_AT = "/sketches/drop";

/** Where a client is sent once the rows are gone: the list they were ticked on. */
export const DROPPED_TO = "/sketches";

/** What the page is told on the way back: how many rows went. A count rather than the ids,
 *  because the ids are exactly what no longer exists — a notice naming them would invite a
 *  reader to go looking for what was just removed. */
export const REMOVED = "removed";

/** How the verb is posted, said in the one place that has to be right. */
export const POSTED_AS = "post id=<number> (once per sketch) as application/x-www-form-urlencoded";

/** Every id that was ticked, in the order the form sent them. A value that is not a number
 *  is dropped here rather than refused: a form this surface did not draw is not this
 *  surface's to explain, and a tick that arrived mangled must not take a row with it. */
export const idsOf = (body: string): readonly number[] =>
  [...new URLSearchParams(body).getAll("id")]
    .filter((said) => /^[0-9]+$/.test(said))
    .map((said) => Number(said));

/** The verb, done. Nothing ticked is a refusal rather than a redirect that did nothing, so
 *  a form posted with no selection says why. */
export function dropPosted(db: DatabaseSync, body: string): Reply {
  const ids = idsOf(body);
  if (ids.length === 0) return text(400, `no sketch was named to remove — ${POSTED_AS}`);
  // Counted rather than assumed: `dropSketch` answers false for a row that was already
  // gone, and a notice claiming to have removed something it did not is worse than none.
  const gone = ids.filter((id) => dropSketch(db, id)).length;
  return seeOther(`${DROPPED_TO}?${REMOVED}=${gone}`, `${gone} of ${ids.length} removed`);
}

/** The verb, bound to a way of reaching the record. POST only, like `/answer`: a path
 *  that removed a row on a GET is a path a link, a prefetch or a crawler can fire. */
export const dropAt = (db: () => DatabaseSync): Handler => ({
  post: ((_url, body) => dropPosted(db(), body)) satisfies Verb,
});
