import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, onTestFinished } from "vitest";

/** Every directory this module has made and not yet removed, in creation order. */
const live: string[] = [];

const drop = (dir: string): void => {
  const i = live.indexOf(dir);
  if (i >= 0) live.splice(i, 1);
  rmSync(dir, { recursive: true, force: true });
};

/** The one way a test makes a temp directory. The tree is removed when the test that made
 *  it finishes — passed, failed or threw — and a directory made outside a test, at the top
 *  of a file or in a beforeAll, is removed when the file finishes. Nothing a test writes
 *  under here outlives the run, which is what keeps /tmp from filling up. */
export function tmp(prefix = "wecode-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  live.push(dir);
  try {
    onTestFinished(() => drop(dir));
  } catch {
    // Not inside a test: the file-scoped afterAll below is the one that removes it.
  }
  return dir;
}

/** Registered against the suite of whichever test file imports this module. */
afterAll(() => {
  for (const dir of [...live]) drop(dir);
});
