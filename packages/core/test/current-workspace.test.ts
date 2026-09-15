import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentDatabase,
  currentWorkspace,
  databaseOf,
  listWorkspaces,
  namedWorkspace,
  sweepTempHome,
  wecodeHome,
  workspaceDir,
  writePointer,
} from "../src/home.js";
import { tmp } from "./tmpdir.js";

/** Every way the current workspace can be decided, and the two things that must hold for
 *  each: the database the commands open is the one the name resolves to, and the list a
 *  command prints contains the name. `wecode workspaces` stars a row by comparing paths;
 *  a name missing from the list, or a name that does not match the path, prints a list
 *  with no star on it and gives the operator no way to see which board they are on. */

const KEYS = ["WECODE_HOME", "WECODE_WORKSPACE", "WECODE_DB"] as const;
let previous: (string | undefined)[] = [];
let home = "";

/** A workspace that exists on disk: the listing counts a directory with a database in it. */
const make = (name: string): string => {
  const path = databaseOf(name);
  mkdirSync(join(home, "workspaces", name), { recursive: true });
  writeFileSync(path, "");
  return path;
};

beforeEach(() => {
  previous = KEYS.map((k) => process.env[k]);
  home = tmp("wecode-home-");
  process.env["WECODE_HOME"] = home;
  delete process.env["WECODE_WORKSPACE"];
  delete process.env["WECODE_DB"];
});

afterEach(() => {
  KEYS.forEach((k, i) => {
    const was = previous[i];
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  });
});

describe("the current workspace is read from one place", () => {
  it("nobody said, so nobody is named and the default is what opens", () => {
    const cwd = tmp("wecode-repo-");
    expect(namedWorkspace(cwd)).toBeNull();
    expect(currentWorkspace(cwd)).toBe("default");
    expect(currentDatabase(cwd)).toBe(databaseOf("default"));
  });

  it("the repository's pointer names it", () => {
    const cwd = tmp("wecode-repo-");
    writePointer(cwd, "cws");
    expect(namedWorkspace(cwd)).toBe("cws");
    expect(currentDatabase(cwd)).toBe(databaseOf("cws"));
  });

  it("the environment outranks the pointer", () => {
    const cwd = tmp("wecode-repo-");
    writePointer(cwd, "cws");
    process.env["WECODE_WORKSPACE"] = "other";
    expect(currentWorkspace(cwd)).toBe("other");
    expect(currentDatabase(cwd)).toBe(databaseOf("other"));
  });

  /** The rank that was wrong: the name came from the pointer while the path came from
   *  WECODE_DB, so the two disagreed and the starred row was not the board in use. */
  it("an explicit database under the home outranks both, and the name follows it", () => {
    const cwd = tmp("wecode-repo-");
    writePointer(cwd, "cws");
    process.env["WECODE_WORKSPACE"] = "other";
    process.env["WECODE_DB"] = databaseOf("named-by-path");
    expect(currentWorkspace(cwd)).toBe("named-by-path");
    expect(currentDatabase(cwd)).toBe(databaseOf(currentWorkspace(cwd)));
  });

  it("a database outside the home has no name, so the name below it still decides", () => {
    const cwd = tmp("wecode-repo-");
    writePointer(cwd, "cws");
    process.env["WECODE_DB"] = join(tmp("wecode-elsewhere-"), "wecode.db");
    expect(currentWorkspace(cwd)).toBe("cws");
  });

  it("a database elsewhere under the home, not at a workspace's own path, has no name", () => {
    const cwd = tmp("wecode-repo-");
    process.env["WECODE_DB"] = join(home, "workspaces", "cws", "spare.db");
    expect(namedWorkspace(cwd)).toBeNull();
  });
});

describe("the list agrees with the current workspace", () => {
  it("every workspace with a database in it is listed, sorted", () => {
    make("b");
    make("a");
    expect(listWorkspaces()).toEqual(["a", "b"]);
  });

  it("a directory without a database is not a workspace", () => {
    mkdirSync(join(home, "workspaces", "half-made"), { recursive: true });
    expect(listWorkspaces()).toEqual([]);
  });

  /** The proof, over every way of asking for one *now*: the name the commands resolve is in
   *  the list the commands print, whether or not it has been created yet. */
  for (const [how, ask] of [
    ["the environment", () => (process.env["WECODE_WORKSPACE"] = "environed")],
    ["an explicit database", () => (process.env["WECODE_DB"] = databaseOf("by-path"))],
  ] as const) {
    it(`the workspace asked for by ${how} is in the list even before it exists`, () => {
      const cwd = tmp("wecode-repo-");
      make("already-there");
      ask();
      const here = currentWorkspace(cwd);
      expect(listWorkspaces()).toContain(here);
      expect(listWorkspaces()).toContain("already-there");
    });

    it(`the workspace asked for by ${how} is listed once when it does exist`, () => {
      const cwd = tmp("wecode-repo-");
      ask();
      const here = currentWorkspace(cwd);
      make(here);
      expect(listWorkspaces().filter((w) => w === here)).toEqual([here]);
    });
  }

  /** Onboarding asks which workspace to join when there are some and none is `default`.
   *  Listing an unasked-for `default` would answer that question by itself and put a
   *  project on a board nobody was looking at. */
  it("the default is not listed when nobody named it", () => {
    make("cws");
    expect(listWorkspaces()).toEqual(["cws"]);
  });
});

/** The pointer is not an ask. It was written the day this repository was onboarded, against
 *  whatever home was current then, and it travels with a clone into homes that never held
 *  that workspace. Pushing it into the list invented a row with no database behind it:
 *  `wecode workspaces` printed a name it could not count projects for, and `wecode onboard`
 *  offered `--workspace <that name>` among the existing ones to join. */
describe("the repository's pointer does not put a workspace in the list", () => {
  it("a pointer to a workspace this home does not hold adds nothing", () => {
    const cwd = tmp("wecode-repo-");
    make("here");
    writePointer(cwd, "from-another-home");
    expect(currentWorkspace(cwd)).toBe("from-another-home");
    expect(listWorkspaces()).toEqual(["here"]);
  });

  it("a pointer is not enough to make a list out of an empty home", () => {
    writePointer(tmp("wecode-repo-"), "from-another-home");
    expect(listWorkspaces()).toEqual([]);
  });

  /** A pointer to one this home does hold needs no pushing: the directory is already there,
   *  so the list and the workspace in use still agree. */
  it("a pointer to a workspace this home does hold is listed, once, on its own account", () => {
    const cwd = tmp("wecode-repo-");
    make("mine");
    writePointer(cwd, "mine");
    expect(currentWorkspace(cwd)).toBe("mine");
    expect(listWorkspaces()).toEqual(["mine"]);
  });

  /** The environment still outranks the pointer for the name, and still puts that name in
   *  the list — so the pointer cannot smuggle a row in behind an explicit ask either. */
  it("an explicit ask over a pointer lists the ask and not the pointer", () => {
    const cwd = tmp("wecode-repo-");
    writePointer(cwd, "pointed");
    process.env["WECODE_WORKSPACE"] = "asked";
    expect(currentWorkspace(cwd)).toBe("asked");
    expect(listWorkspaces()).toEqual(["asked"]);
  });
});

/** The reader is one place, and under test that one place may not be the operator's own
 *  `~/.wecode`. `store.open` already refuses a live *database*, but every other path this
 *  module hands out came from the same fallback: `listWorkspaces` read the operator's real
 *  workspace names, and `workspaceDir` named a directory in the home they work in. */
describe("with no home of its own, a test run does not get the operator's", () => {
  const live = join(homedir(), ".wecode");
  const under = (path: string): boolean =>
    resolve(path) === live || resolve(path).startsWith(live + sep);

  beforeEach(() => {
    delete process.env["WECODE_HOME"];
  });

  afterEach(() => {
    sweepTempHome();
  });

  it("resolves a home under the system temp directory, not the real one", () => {
    const got = wecodeHome();
    expect(under(got)).toBe(false);
    expect(got.startsWith(resolve(tmpdir()) + sep) || got.startsWith(tmpdir() + sep)).toBe(true);
  });

  it("answers with the same home every time, so two readers agree", () => {
    expect(wecodeHome()).toBe(wecodeHome());
  });

  /** Every path this module hands out, not just the database one that was already guarded. */
  it("keeps every path it derives out of the operator's home", () => {
    const cwd = tmp("wecode-repo-");
    writePointer(cwd, "cws");
    for (const path of [workspaceDir("cws"), databaseOf("cws"), currentDatabase(cwd)]) {
      expect(under(path)).toBe(false);
    }
    expect(currentWorkspace(cwd)).toBe("cws");
  });

  it("lists the run's own workspaces, not whatever the operator has", () => {
    expect(listWorkspaces()).toEqual([]);
    mkdirSync(join(wecodeHome(), "workspaces", "mine"), { recursive: true });
    writeFileSync(join(wecodeHome(), "workspaces", "mine", "wecode.db"), "");
    expect(listWorkspaces()).toEqual(["mine"]);
  });

  it("makes nothing until something writes, and sweeps what it made", () => {
    const got = wecodeHome();
    mkdirSync(join(got, "workspaces", "gone"), { recursive: true });
    sweepTempHome();
    expect(existsSync(got)).toBe(false);
  });

  /** An explicit home is still obeyed: the temp one is the fallback, not an override. */
  it("still obeys WECODE_HOME when it is set", () => {
    process.env["WECODE_HOME"] = home;
    expect(wecodeHome()).toBe(home);
  });
});
