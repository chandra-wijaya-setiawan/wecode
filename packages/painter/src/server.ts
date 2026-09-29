/** The painter's transport, and the routing it does — and nothing about what a review is
 *  for. Nearly every decision worth arguing about lives in the session store; this file
 *  turns a method and a path into a call on one, and a call on one into bytes. The one
 *  decision that lives here is where a comment on the artefact goes: queued for a poller
 *  to come and take, or typed into the terminal the session owns.
 *
 *  `answer()` is the whole router and takes no socket, so what a request does can be
 *  proved without listening on a port. `serve()` is left owning only the socket. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { frame } from "./frame.js";
import { Session as Terminal } from "./pty.js";
import { end, poll, prompts, reply, sessionOf, SessionError, type Store } from "./session.js";

export interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

const UTF8 = "; charset=utf-8";

const html = (body: string): Reply => ({ status: 200, type: `text/html${UTF8}`, body });

const json = (value: unknown): Reply => ({
  status: 200,
  type: `application/json${UTF8}`,
  body: JSON.stringify(value),
});

const plain = (status: number, body: string): Reply => ({
  status,
  type: `text/plain${UTF8}`,
  body: `${body}\n`,
});

/** The origin a relative target is parsed against. It is never sent anywhere and nothing
 *  may read it as where the painter is deployed. */
const BASE = "http://127.0.0.1";

/** `/session/<id>` and `/session/<id>/<verb>`, and nothing else is a painter path. */
const parse = (pathname: string): { id: string; verb: string } | undefined => {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "session") return undefined;
  return { id: parts[1] as string, verb: parts[2] ?? "" };
};

const text = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const got = (value as Record<string, unknown>)["text"];
  return typeof got === "string" && got !== "" ? got : undefined;
};

const tag = (value: unknown): string | undefined => {
  const got = (value as Record<string, unknown> | null)?.["tag"];
  return typeof got === "string" ? got : undefined;
};

/** The terminal a session owns, when the agent sits in one rather than polling for its
 *  words. Kept beside the store rather than in it: the store is the review — what was
 *  said, whether it is over — and a terminal is where the agent is sitting, which is the
 *  transport's business. Keyed weakly by the store, so two stores never share a seating
 *  and a store nobody holds anymore takes its terminals with it. */
const terminals = new WeakMap<Store, Map<string, Terminal>>();

/** Make a session own a terminal. From then on a comment on the artefact is typed into
 *  it — a line of input followed by its return — for the agent sitting there to read
 *  where the operator can watch it answer, and nothing is queued, because there is no
 *  poller to queue for.
 *
 *  Seating a second terminal replaces the first without closing it: a terminal is closed
 *  by whoever opened it, like every other way one leaves. */
export function own(store: Store, id: string, terminal: Terminal): void {
  if (sessionOf(store, id) === undefined) throw new SessionError(`no session ${id}`);
  const seated = terminals.get(store) ?? new Map<string, Terminal>();
  seated.set(id, terminal);
  terminals.set(store, seated);
}

/** The terminal a session owns, if it owns one at all. */
const terminalOf = (store: Store, id: string): Terminal | undefined =>
  terminals.get(store)?.get(id);

/** Everything the painter decides. A reader asking "why did I get that" reads this and
 *  stops.
 *
 *  A path with no session behind it is 404 and never an empty page: the agent that wrote
 *  the artefact needs to know the session is gone, not to be handed a blank. */
export async function answer(
  store: Store,
  method: string | undefined,
  target: string | undefined,
  payload = "",
): Promise<Reply> {
  if (target === undefined) return plain(400, "no request target");
  let url: URL;
  try {
    url = new URL(target, BASE);
  } catch {
    return plain(400, `${target} is not a request target`);
  }

  const route = parse(url.pathname);
  if (route === undefined) return plain(404, `nothing at ${url.pathname} — /session/<id>`);

  const session = sessionOf(store, route.id);
  if (session === undefined) return plain(404, `no session ${route.id}`);

  if (method === "GET" || method === "HEAD") {
    switch (route.verb) {
      case "":
        return html(frame(session));
      case "revision":
        return json({ revision: session.revision, status: session.status });
      case "prompts":
        return json({ prompts: prompts(store, route.id) });
      case "poll":
        return json(await poll(store, route.id));
      default:
        return plain(404, `nothing at ${url.pathname} — revision prompts poll`);
    }
  }

  if (method === "POST") {
    if (route.verb === "end") return json(end(store, route.id));
    if (route.verb !== "reply") return plain(404, `nothing at ${url.pathname} — reply end`);
    let sent: unknown;
    try {
      sent = JSON.parse(payload === "" ? "{}" : payload);
    } catch {
      return plain(400, "the prompt is not json");
    }
    const said = text(sent);
    if (said === undefined) return plain(400, "a prompt needs text");
    if (session.status === "ended") return plain(409, `session ${route.id} has ended`);

    // Where a comment goes depends on where the agent is. No terminal, and the words are
    // queued for a poller to come and take, as they always were. A terminal, and they are
    // typed into it as one line of input with the return that submits it — so a comment
    // made while the agent is mid-turn waits in the input and is read when the turn ends,
    // exactly as if the operator had typed it at a busy program.
    const terminal = terminalOf(store, route.id);
    if (terminal === undefined) return json(reply(store, route.id, said, tag(sent)));
    if (!terminal.running) {
      // Refused rather than queued: the agent that would have read the queue is the one
      // that left, and words parked where nobody will ever take them are words lost.
      return plain(409, "the agent's session has left — the comment was not sent");
    }
    terminal.prompt(said);
    const tagged = tag(sent);
    return json(tagged === undefined ? { typed: said } : { typed: said, tag: tagged });
  }

  return plain(405, `${String(method)} is not served here — GET and POST only`);
}

const bodyOf = async (req: { [Symbol.asyncIterator](): AsyncIterator<Buffer> }): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

/** The sessions in a store, listening. Port 0 is one the operating system picks, which is
 *  how a test gets a port that is certainly free — so the port actually bound is read back
 *  off the socket rather than assumed. */
export async function serve(store: Store, port = 0, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const reply = await (async (): Promise<Reply> => {
        try {
          const payload = req.method === "POST" ? await bodyOf(req) : "";
          return await answer(store, req.method, req.url, payload);
        } catch (err) {
          return plain(500, `the painter failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      res.writeHead(reply.status, { "content-type": reply.type });
      res.end(req.method === "HEAD" ? undefined : reply.body);
    })();
  });
  server.listen(port, host);
  await once(server, "listening");
  return server;
}

/** Where a listening painter is, as a URL a browser can be pointed at. */
export function addressOf(server: Server): string {
  const at = server.address();
  if (at === null || typeof at === "string") throw new Error("the painter is not on a port");
  const { address, port } = at as AddressInfo;
  return `http://${address}:${port}`;
}

/** The URL of one session, which is the thing a person is actually given. */
export const sessionUrl = (server: Server, id: string): string => `${addressOf(server)}/session/${id}`;
