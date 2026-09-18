import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { CreateError, loadRoles, Maker, type RoleConfig } from "../src/index.js";
import { freshDb } from "./helpers.js";

/** The real config, not a fixture: what counts as declared is what the install declares,
 *  and a test that invents its own roles proves nothing about the refusal an operator meets. */
const roles: RoleConfig = loadRoles(fileURLToPath(new URL("../../../config/roles.yaml", import.meta.url)));

const workers = (db: ReturnType<typeof freshDb>): string[] =>
  (db.prepare("SELECT role FROM worker").all() as { role: string }[]).map((r) => r.role);

describe("a worker's role must be one some configuration declares", () => {
  let db: ReturnType<typeof freshDb>;
  let make: Maker;

  beforeEach(() => {
    db = freshDb();
    make = new Maker(db, undefined, roles);
  });

  it("writes a worker whose role the configuration declares", () => {
    const id = make.worker("claude-1", "engineer", "agent");

    expect(id).toBeGreaterThan(0);
    expect(workers(db)).toEqual(["engineer"]);
  });

  it("refuses a role no configuration declares, and writes no row", () => {
    expect(() => make.worker("dana", "operator", "human")).toThrow(CreateError);
    expect(workers(db)).toEqual([]);
  });

  it("names the role it refused and the roles that are declared", () => {
    expect(() => make.worker("dana", "operator", "human")).toThrow(
      /^worker: no role named "operator"\. Declared roles: .*\bengineer\b/,
    );
  });

  /** `wecode worker add` with no `--role` reaches here with the empty string. Quoting
   *  nothing reads as a missing message rather than a missing role. */
  it("calls an empty role none rather than quoting it", () => {
    expect(() => make.worker("nameless", "", "agent")).toThrow(/no role named \(none\)\./);
  });

  /** The refusal is the configuration's, so a Maker that was handed no configuration has
   *  nothing to refuse by — and every fixture and older caller keeps working. */
  it("checks nothing when no configuration was handed over", () => {
    const plain = new Maker(db);

    expect(plain.worker("dana", "operator", "human")).toBeGreaterThan(0);
    expect(workers(db)).toEqual(["operator"]);
  });

  it("refuses every role when the configuration declares none", () => {
    const empty = new Maker(db, undefined, { invariants: roles.invariants, roles: {} });

    expect(() => empty.worker("claude-1", "engineer", "agent")).toThrow(
      /no role named "engineer"\. No configuration declares any role\./,
    );
  });

  /** A role row in the database is not a declaration: config/roles.yaml is the one
   *  definition of a role's ceiling, and a row written beside it would be a second. */
  it("is unmoved by a role row written into the database", () => {
    make.role("operator", { write: [], tools: [] }, "human");

    expect(() => make.worker("dana", "operator", "human")).toThrow(CreateError);
  });
});
