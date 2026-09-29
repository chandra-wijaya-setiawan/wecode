import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Refused, paint, type Painter, type Session, type Word } from "../src/paint.js";
import { answered, run } from "../src/run.js";
import { commandsIn, linesIn } from "../src/capabilities.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The painter server, recorded rather than run: every verb this command has is one call,
 *  so a stub that remembers the call and answers it proves the command and says nothing
 *  about the server. The server is the other side of the port and is proved where it is. */
function painter(answers: Partial<Painter> = {}): { readonly it: Painter; readonly calls: string[] } {
  const calls: string[] = [];
  const at = (what: string, file: string): string => `${what} ${file}`;
  const it: Painter = {
    open: async (file, reopen) => {
      calls.push(at(reopen ? "open --reopen" : "open", file));
      return answers.open === undefined ? { url: "http://127.0.0.1:4387/session/abc" } : answers.open(file, reopen);
    },
    poll: async (file) => {
      calls.push(at("poll", file));
      return answers.poll === undefined ? { kind: "feedback" as const, text: "the header is clipped" } : answers.poll(file);
    },
    end: async (file) => {
      calls.push(at("end", file));
      if (answers.end !== undefined) await answers.end(file);
    },
    export: async (file) => {
      calls.push(at("export", file));
      return answers.export === undefined ? "<html>the board</html>" : answers.export(file);
    },
  };
  return { it, calls };
}

let out: string[];
let err: string[];
let here: string;

const said = (): string => out.join("");
const complained = (): string => err.join("");

beforeEach(() => {
  here = tmp("wecode-paint-");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

describe("wecode paint, the four verbs", () => {
  it("opens an artifact on the server and prints the url a reviewer opens", async () => {
    const server = painter();
    expect(await paint(["open", "board.svg"], server.it)).toBe(0);
    expect(server.calls).toEqual(["open board.svg"]);
    expect(said()).toBe("opened\nhttp://127.0.0.1:4387/session/abc\n");
  });

  it("says a session was resumed rather than opened, so nobody reviews a stale drawing", async () => {
    const server = painter({ open: async (): Promise<Session> => ({ url: "http://x/s/1", reopened: true }) });
    expect(await paint(["open", "board.svg"], server.it)).toBe(0);
    expect(said()).toBe("resumed\nhttp://x/s/1\n");
  });

  it("carries --reopen through, because reopening one the reviewer ended is their decision", async () => {
    const server = painter();
    expect(await paint(["open", "board.svg", "--reopen"], server.it)).toBe(0);
    expect(server.calls).toEqual(["open --reopen board.svg"]);
  });

  it("polls, and prints what the reviewer said under the kind of thing it is", async () => {
    const server = painter();
    expect(await paint(["poll", "board.svg"], server.it)).toBe(0);
    expect(server.calls).toEqual(["poll board.svg"]);
    expect(said()).toBe("feedback\nthe header is clipped\n");
  });

  it("prints an ended poll as ended, so a caller stops asking rather than looping forever", async () => {
    const server = painter({ poll: async (): Promise<Word> => ({ kind: "ended", text: "ship it" }) });
    expect(await paint(["poll", "board.svg"], server.it)).toBe(0);
    expect(said()).toBe("ended\nship it\n");
  });

  it("ends the session, and names the artifact it ended", async () => {
    const server = painter();
    expect(await paint(["end", join(here, "board.svg")], server.it)).toBe(0);
    expect(server.calls).toEqual([`end ${join(here, "board.svg")}`]);
    expect(said()).toBe("ended board.svg\n");
  });

  it("exports a portable copy beside the artifact, and prints where it went", async () => {
    const server = painter();
    const artifact = join(here, "board.svg");
    const to = join(here, "portable.html");
    expect(await paint(["export", artifact, "--out", to], server.it)).toBe(0);
    expect(server.calls).toEqual([`export ${artifact}`]);
    expect(readFileSync(to, "utf8")).toBe("<html>the board</html>");
    expect(said()).toBe(`${to}\n`);
  });

  it("defaults the export to <artifact>.export.html, so the verb needs no flag", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(here);
    const server = painter();
    expect(await paint(["export", join(here, "board.svg")], server.it)).toBe(0);
    expect(said()).toBe(`${resolve(here, "board.export.html")}\n`);
    expect(readFileSync(join(here, "board.export.html"), "utf8")).toBe("<html>the board</html>");
  });
});

describe("wecode paint, when it cannot be done", () => {
  it("exits 1 on a refusal, and says the server's own sentence", async () => {
    const server = painter({
      poll: async (): Promise<Word> => {
        throw new Refused("no session for board.svg — open it first");
      },
    });
    expect(await paint(["poll", "board.svg"], server.it)).toBe(1);
    expect(complained()).toBe("no session for board.svg — open it first\n");
  });

  it("exits 2 when the server could not be asked at all, which is not the same thing", async () => {
    const server = painter({
      open: async (): Promise<Session> => {
        throw new Error("no painter server at http://127.0.0.1:4387: ECONNREFUSED");
      },
    });
    expect(await paint(["open", "board.svg"], server.it)).toBe(2);
    expect(complained()).toContain("ECONNREFUSED");
  });

  it("exits 2 on a verb it has not got, and prints the manual with it", async () => {
    const server = painter();
    expect(await paint(["frame", "board.svg"], server.it)).toBe(2);
    expect(complained()).toBe("no such verb: frame\n");
    expect(said()).toContain("wecode paint open <artifact>");
    expect(server.calls).toEqual([]);
  });

  it("exits 2 when no artifact was named, naming the verb that wanted one", async () => {
    const server = painter();
    expect(await paint(["poll"], server.it)).toBe(2);
    expect(complained()).toBe("wecode paint poll <artifact>\n");
  });

  it("prints the manual and exits 0 when it is asked for nothing", async () => {
    expect(await paint([], painter().it)).toBe(0);
    expect(said()).toContain("wecode paint export <artifact>");
  });
});

describe("wecode paint, as a command you can type", () => {
  const SOURCE = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8");

  it("is in the dispatch table, so `wecode paint` reaches it", () => {
    expect(commandsIn(SOURCE)).toContain("paint");
  });

  it("has a line in the manual, which is what makes it a documented command", () => {
    expect(linesIn(SOURCE).get("paint")).toContain("a drawing in front of a person");
  });

  it("settles its own exit code, because the answer is not known when dispatch returns", async () => {
    expect(run(["paint", "frame", "board.svg"])).toBe(0);
    expect(await answered()).toBe(2);
  });
});
