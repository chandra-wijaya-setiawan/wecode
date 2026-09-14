import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { tmp } from "../tmpdir.js";

/** Run by tmpdir.test.ts in a nested vitest, never by the suite itself — a failing test is
 *  the whole point of it. It records the directory it made so the parent can look for it
 *  once this run is over. */
it("makes a temp directory and then fails", () => {
  const dir = tmp("wecode-throws-");
  writeFileSync(process.env["WECODE_TMPDIR_RECORD"] as string, dir);
  expect("the test").toBe("failing on purpose");
});
