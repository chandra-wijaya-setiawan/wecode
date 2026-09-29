import { basename, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** `wecode paint open|poll|end|export <artifact>` — a drawing put in front of a person.
 *
 *  `wecode design show` already writes the declared screen out as a picture, and the four
 *  screen rules already say whether a captured one is clipped. Neither of those is a
 *  review: the picture lands on disk and whoever had to sign it off saw it in whatever
 *  message it was pasted into, and what they said back is in that message too. So the
 *  design that was approved and the words that approved it are in two places, and only one
 *  of them is in the repository.
 *
 *  These four verbs are the loop, and nothing else: `open` puts an artifact on the painter
 *  server and prints the url a reviewer opens, `poll` blocks until that reviewer has said
 *  something and prints it, `end` closes the session, `export` writes a copy that opens
 *  with no server running. An agent that has drawn something can therefore ask for a
 *  human's eyes and read the answer without a person relaying either.
 *
 *  No session state lives here. The server owns the session — which artifacts are open,
 *  what has been queued against them, whether the reviewer ended one — because a second
 *  copy of that here could disagree with the page the reviewer is looking at. This turns
 *  four arguments into four calls, prints what comes back, and turns that into an exit
 *  code. That is why the port is a parameter with a default: these tests prove the
 *  command, not the server.
 *
 *  Three exit codes, the same three `wecode ui` uses and for the same reason: 0 the verb
 *  happened, 1 the server refused it — no session, or one the reviewer ended and did not
 *  invite you back into — 2 the question could not be asked at all. An agent that cannot
 *  tell "the reviewer has closed this" from "there is no painter server" will retry the
 *  wrong one of the two forever. */

/** A session, as the server reports it. `url` is what a reviewer opens; `reopened` says the
 *  session was already there, so a caller can tell a fresh surface from a resumed one. */
export interface Session {
  readonly url: string;
  readonly reopened?: boolean;
}

/** What a poll comes back with. `feedback` is the reviewer talking; `ended` is the reviewer
 *  closing the session, which is an answer and not a failure — it is the last thing a poll
 *  ever returns for that artifact. */
export interface Word {
  readonly kind: "feedback" | "ended";
  readonly text: string;
}

/** The painter server, as this command needs it. Four calls, one per verb, and no shape
 *  that is not one of their answers: a client here that knew the wire format in more
 *  detail than this would be a second opinion about what a session is. */
export interface Painter {
  open(file: string, reopen: boolean): Promise<Session>;
  poll(file: string): Promise<Word>;
  end(file: string): Promise<void>;
  export(file: string): Promise<string>;
}

/** The server saying no to a verb it understood: the artifact has no session, or the
 *  reviewer ended one and `--reopen` was not asked for. Its own sentence is the message,
 *  because the server is the side that knows why. Separate from every other error so the
 *  exit code can be, which is the whole point of telling them apart. */
export class Refused extends Error {}

/** Where the painter server is when nobody says otherwise. An environment variable rather
 *  than a flag on every verb: the address is a property of the machine the reviewer and
 *  the agent share, not of one invocation. */
const at = (): string => (process.env["WECODE_PAINTER_URL"] ?? "http://127.0.0.1:4387").replace(/\/$/, "");

/** One request to the server, and the two ways it can come back other than an answer: a
 *  refusal, which is the server's sentence and exit 1, and anything else, which is a
 *  server that is not there or not well and is exit 2. */
async function ask(path: string, init: RequestInit = {}): Promise<Response> {
  let reply: Response;
  try {
    reply = await fetch(`${at()}${path}`, init);
  } catch (err) {
    throw new Error(`no painter server at ${at()}: ${(err as Error).message}`);
  }
  if (reply.status === 404 || reply.status === 409) throw new Refused((await reply.text()).trim());
  if (!reply.ok) throw new Error(`the painter server answered ${reply.status} to ${path}`);
  return reply;
}

const said = (file: string): string => `?file=${encodeURIComponent(resolve(file))}`;

/** The server over http, which is what a caller gets when it does not pass its own. */
export const server: Painter = {
  open: async (file, reopen) =>
    (await (await ask(`/session${said(file)}${reopen ? "&reopen=1" : ""}`, { method: "POST" })).json()) as Session,
  poll: async (file) => (await (await ask(`/session/poll${said(file)}`)).json()) as Word,
  end: async (file) => void (await ask(`/session${said(file)}`, { method: "DELETE" })),
  export: async (file) => (await ask(`/session/export${said(file)}`)).text(),
};

export async function paint(args: readonly string[], painter: Painter = server): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { out: { type: "string" }, reopen: { type: "boolean" } },
  });
  const [verb, file] = positionals;
  if (verb === undefined) return usage();
  if (verb !== "open" && verb !== "poll" && verb !== "end" && verb !== "export") {
    fail(`no such verb: ${verb}`);
    return usage(2);
  }
  if (file === undefined) return fail(`wecode paint ${verb} <artifact>`, 2);

  try {
    if (verb === "open") return say(await painter.open(file, values.reopen === true));
    if (verb === "poll") return heard(await painter.poll(file));
    if (verb === "end") return told(file, await painter.end(file));
    return written(file, values.out, await painter.export(file));
  } catch (err) {
    // A refusal is the reviewer's decision or the absence of a session, and the server has
    // already said which in a sentence. Anything else is the question never having been
    // asked, and those are not the same thing to whoever retries.
    return fail((err as Error).message, err instanceof Refused ? 1 : 2);
  }
}

/** An opened session: the url on its own line, so a caller can pipe it, and what happened
 *  to it above. A reviewer who is already looking at the page needs to know that the
 *  drawing they are looking at is the one that was just put there. */
function say(session: Session): number {
  process.stdout.write(`${session.reopened === true ? "resumed" : "opened"}\n${session.url}\n`);
  return 0;
}

/** What the reviewer said. `ended` is printed as itself: a caller that keeps polling after
 *  it will wait forever, so the line has to be readable as "stop asking". */
function heard(word: Word): number {
  process.stdout.write(word.kind === "ended" ? `ended\n${word.text}\n` : `feedback\n${word.text}\n`);
  return 0;
}

const told = (file: string, _: void): number => (process.stdout.write(`ended ${basename(file)}\n`), 0);

/** The portable copy, on disk. Where it went is the whole of the output, because the next
 *  thing anyone does with it is open it. */
function written(file: string, out: string | undefined, html: string): number {
  const to = resolve(out ?? `${basename(file).replace(/\.[^.]+$/, "")}.export.html`);
  try {
    writeFileSync(to, html);
  } catch (err) {
    return fail(`cannot write ${to}: ${(err as Error).message}`, 2);
  }
  process.stdout.write(`${to}\n`);
  return 0;
}

function usage(code = 0): number {
  process.stdout.write(
    [
      "wecode paint — a drawing in front of a person, and what they said back.",
      "",
      "  wecode paint open <artifact>     put it on the painter server, and say where to look",
      "  wecode paint poll <artifact>     wait for the reviewer, and print what they said",
      "  wecode paint end <artifact>      close the session",
      "  wecode paint export <artifact>   write a copy that opens with no server",
      "",
      "  --reopen        open one the reviewer had ended",
      "  --out <file>    where export writes (default <artifact>.export.html)",
      "",
      `the server is $WECODE_PAINTER_URL (default ${at()}).`,
      "",
      "Exit: 0 done, 1 the server refused, 2 it could not be asked.",
      "",
    ].join("\n"),
  );
  return code;
}

function fail(message: string, code = 1): number {
  process.stderr.write(`${message}\n`);
  return code;
}
