/** The web surface's transport, and nothing else. No product word appears in this file:
 *  what a page says is the page's, and which page answers a path is the caller's.
 *
 *  The routing is `answer()` — a pure function of a method and a target — so what the
 *  server decides can be proved without a socket, and `serve()` is left owning only the
 *  socket. A router that could only be exercised through a listening port is a decision
 *  nobody tests directly. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/** What a page came out with. `type` is the whole of the content negotiation there is: one
 *  page, one representation. */
export interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

/** A page: the request's target in, a reply out. The URL is given whole so a page can read
 *  its own query and the server needs to know nothing about which ones have parameters. */
export type Page = (url: URL) => Reply;

/** Which page answers which path. Exact paths — a board is not a file tree, and a pattern
 *  language is a thing to maintain for routes that do not exist yet. */
export type Routes = Readonly<Record<string, Page>>;

const UTF8 = "; charset=utf-8";

export const html = (body: string): Reply => ({
  status: 200,
  type: `text/html${UTF8}`,
  body,
});

const plain = (status: number, body: string): Reply => ({
  status,
  type: `text/plain${UTF8}`,
  body: `${body}\n`,
});

/** The origin every relative target is resolved against. It is never sent anywhere and no
 *  page may read it as where it is deployed — it exists because `new URL` needs a base to
 *  parse `/board?x=1` at all. */
const BASE = "http://localhost";

/** Everything the server decides. A reader looking for "why did I get a 404" reads this
 *  and stops.
 *
 *  GET only, and `HEAD` answered as GET with the body dropped by the caller: a board is a
 *  thing to look at, and every verb that changes wecode is the CLI's. A path nothing routes
 *  is 404 and a verb nothing serves is 405, both said in a sentence rather than left as a
 *  bare code — the reader of a 405 is a person with a curl, and the one thing they need to
 *  know is which verbs there are. */
export function answer(routes: Routes, method: string | undefined, target: string | undefined): Reply {
  if (method !== "GET" && method !== "HEAD") {
    return plain(405, `${String(method)} is not served here — GET only`);
  }
  if (target === undefined) return plain(400, "no request target");

  let url: URL;
  try {
    url = new URL(target, BASE);
  } catch {
    return plain(400, `${target} is not a request target`);
  }

  const page = routes[url.pathname];
  if (page === undefined) {
    const known = Object.keys(routes).sort().join(" ");
    return plain(404, `nothing at ${url.pathname} — ${known}`);
  }
  return page(url);
}

/** A page that threw is a 500 with the reason in it. This is a workspace's own board on a
 *  workspace's own machine, so the reason is what the reader needs; there is nothing here
 *  to withhold it from. */
const caught = (err: unknown): Reply =>
  plain(500, `the page failed: ${err instanceof Error ? err.message : String(err)}`);

/** The routes, listening. Port 0 is a port the operating system picks, which is how a test
 *  gets one that is certainly free — so the port that was actually bound is read back off
 *  the socket rather than assumed to be the one asked for. */
export async function serve(
  routes: Routes,
  port = 0,
  host = "127.0.0.1",
): Promise<Server> {
  const server = createServer((req, res) => {
    const reply = ((): Reply => {
      try {
        return answer(routes, req.method, req.url);
      } catch (err) {
        return caught(err);
      }
    })();
    res.writeHead(reply.status, { "content-type": reply.type });
    res.end(req.method === "HEAD" ? undefined : reply.body);
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
