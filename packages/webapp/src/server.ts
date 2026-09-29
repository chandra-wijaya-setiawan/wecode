/** The web surface's transport, and nothing else. No product word appears in this file:
 *  what a page says is the page's, and which page answers a path is the caller's.
 *
 *  The routing is `answer()` — a pure function of a method and a target — so what the
 *  server decides can be proved without a socket, and `serve()` is left owning only the
 *  socket. A router that could only be exercised through a listening port is a decision
 *  nobody tests directly. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/** What a page came out with. `type` is the whole of the content negotiation there is: one
 *  page, one representation. */
export interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
  /** Where the client is sent next, on a reply whose status says it is going somewhere. A
   *  verb answers with what it did and the page to read it on, rather than with a document
   *  that a reload would post twice. */
  readonly location?: string;
}

/** A page: the request's target in, a reply out. The URL is given whole so a page can read
 *  its own query and the server needs to know nothing about which ones have parameters. */
export type Page = (url: URL) => Reply;

/** A verb: the same, with what was posted. The body arrives as it was sent, because what a
 *  verb's fields are is the verb's and not the transport's. */
export type Verb = (url: URL, body: string) => Reply;

/** What answers at a path. A bare function is a path that is only read; the object form
 *  says which verbs there are, and a path missing one answers 405 rather than pretending. */
export type Handler = Page | { readonly get?: Page; readonly post?: Verb };

/** Which handler answers which path. Exact paths — a board is not a file tree, and a pattern
 *  language is a thing to maintain for routes that do not exist yet. */
export type Routes = Readonly<Record<string, Handler>>;

const UTF8 = "; charset=utf-8";

export const html = (body: string): Reply => ({
  status: 200,
  type: `text/html${UTF8}`,
  body,
});

/** A sentence, at a status. Exported because a verb says what it did in words, and words at
 *  a status is the whole of what a non-page reply is. */
export const text = (status: number, body: string): Reply => ({
  status,
  type: `text/plain${UTF8}`,
  body: `${body}\n`,
});

/** What a verb answers with: what it did, and the page it is now readable on. 303 rather
 *  than 302, so the browser follows it with a GET and a reload does not post again. */
export const seeOther = (to: string, said: string): Reply => ({ ...text(303, said), location: to });

/** The origin every relative target is resolved against. It is never sent anywhere and no
 *  page may read it as where it is deployed — it exists because `new URL` needs a base to
 *  parse `/board?x=1` at all. */
const BASE = "http://localhost";

/** Everything the server decides. A reader looking for "why did I get a 404" reads this
 *  and stops.
 *
 *  GET, `HEAD` answered as GET with the body dropped by the caller, and POST where a path
 *  carries a verb. Which paths those are is the caller's: most of the surface is a thing to
 *  look at, and a path with no verb on it answers a POST the way a path with no page
 *  answers a GET. A path nothing routes is 404 and a verb nothing serves is 405, both said
 *  in a sentence rather than left as a bare code — the reader of a 405 is a person with a
 *  curl, and the one thing they need to know is which verbs there are. */
export function answer(
  routes: Routes,
  method: string | undefined,
  target: string | undefined,
  body = "",
): Reply {
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return text(405, `${String(method)} is not served here — GET and POST only`);
  }
  if (target === undefined) return text(400, "no request target");

  let url: URL;
  try {
    url = new URL(target, BASE);
  } catch {
    return text(400, `${target} is not a request target`);
  }

  const at = routes[url.pathname];
  if (at === undefined) {
    const known = Object.keys(routes).sort().join(" ");
    return text(404, `nothing at ${url.pathname} — ${known}`);
  }

  const handler = typeof at === "function" ? { get: at, post: undefined } : at;
  const served = handler.post === undefined ? "GET" : handler.get === undefined ? "POST" : "GET and POST";
  if (method === "POST") {
    if (handler.post === undefined) return text(405, `POST is not served at ${url.pathname} — ${served} only`);
    return handler.post(url, body);
  }
  if (handler.get === undefined) return text(405, `${method} is not served at ${url.pathname} — ${served} only`);
  return handler.get(url);
}

/** A page that threw is a 500 with the reason in it. This is a workspace's own board on a
 *  workspace's own machine, so the reason is what the reader needs; there is nothing here
 *  to withhold it from. */
const caught = (err: unknown): Reply =>
  text(500, `the page failed: ${err instanceof Error ? err.message : String(err)}`);

/** What was posted, whole. A verb's fields are read from this string by the verb itself. */
async function posted(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The routes, listening. Port 0 is a port the operating system picks, which is how a test
 *  gets one that is certainly free — so the port that was actually bound is read back off
 *  the socket rather than assumed to be the one asked for. */
export async function serve(
  routes: Routes,
  port = 0,
  host = "127.0.0.1",
): Promise<Server> {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const reply = await (async (): Promise<Reply> => {
        try {
          return answer(routes, req.method, req.url, req.method === "POST" ? await posted(req) : "");
        } catch (err) {
          return caught(err);
        }
      })();
      const headers: Record<string, string> = { "content-type": reply.type };
      if (reply.location !== undefined) headers["location"] = reply.location;
      res.writeHead(reply.status, headers);
      res.end(req.method === "HEAD" ? undefined : reply.body);
    })();
  });
  server.listen(port, host);
  await once(server, "listening");
  return server;
}

/** Where a listening server is, as a URL a client can be pointed at. */
export function addressOf(server: Server): string {
  const at = server.address();
  if (at === null || typeof at === "string") throw new Error("the server is not on a port");
  const { address, port } = at as AddressInfo;
  return `http://${address}:${port}`;
}
