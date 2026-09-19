import { describe, expect, it } from "vitest";
import { all, ALLOW, EMPTY_GUARDS, GUARD_NAMES, refuse, type Guard } from "../src/index.js";

const ctx = { entity: "task", id: 1 };

describe("the guard vocabulary", () => {
  it("names each guard once", () => {
    expect(new Set(GUARD_NAMES).size).toBe(GUARD_NAMES.length);
  });

  it("implements nothing by default, so an unimplemented check blocks", () => {
    expect(Object.keys(EMPTY_GUARDS)).toEqual([]);
  });
});

describe("all", () => {
  const yes: Guard = () => ALLOW;
  const no = (why: string): Guard => () => refuse(why);

  it("allows when every guard allows", () => {
    expect(all(yes, yes)(ctx)).toEqual({ ok: true });
  });

  it("allows when there is nothing to ask", () => {
    expect(all()(ctx)).toEqual({ ok: true });
  });

  it("answers with the first refusal, not a list of complaints", () => {
    const r = all(yes, no("no task_test is ready"), no("and nothing was written"))(ctx);
    expect(r).toEqual({ ok: false, why: "no task_test is ready" });
  });

  it("does not ask a later guard once one has refused", () => {
    const asked: string[] = [];
    const record = (name: string, result = ALLOW): Guard => () => (asked.push(name), result);
    all(record("first", refuse("stop")), record("second"))(ctx);
    expect(asked).toEqual(["first"]);
  });

  it("passes the same context to each guard", () => {
    const seen: unknown[] = [];
    all((c) => (seen.push(c), ALLOW), (c) => (seen.push(c), ALLOW))(ctx);
    expect(seen).toEqual([ctx, ctx]);
  });
});
