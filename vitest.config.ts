import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    /** How long a test may take before vitest stops it.
     *
     *  Vitest's own default is 5 s, which is plenty for a test that calls a function and far
     *  too little for one that spawns a process — and this repository is full of the second
     *  kind: they build a package, start a binary, open a socket, drive a pty, then read what
     *  came back. Run alone those pass. Run in the full suite, with ten of them compiling at
     *  once, the slowest took 5.0 to 6.9 s and vitest stopped them at 5 — so a verdict depended
     *  on how busy the machine was, which is the one thing a verdict must never be about.
     *
     *  The number is above the longest deadline any test declares for itself, which is the
     *  20 s `PATIENCE` in `the-terminal-runs-in-the-browser.test.ts`. That matters more than the
     *  margin does: that file counts its own deadline against `Date.now()` and fails with a
     *  sentence saying what never happened — "the board never listened in 20000ms", with the
     *  board's own stdout and stderr attached. Vitest was stopping it at 5 s first, so the
     *  deadline could never fire and every one of those failures read "Test timed out in
     *  5000ms" instead, which says nothing about what broke. A test that explains its own
     *  failure has to be allowed to reach it.
     *
     *  This is a ceiling for the suite, not a licence for a test. A proof whose cost is known
     *  still declares it — `it`'s third argument, the way a dozen tests here already do — and
     *  a deadline counted inside the body is not a declaration to vitest, only to the reader.
     *  Keeping the two in step is what this line buys. */
    testTimeout: 30_000,
    /** The same, for `beforeEach`, `afterEach` and `beforeAll`. Vitest defaults these to 10 s
     *  separately, and a fixture that builds or starts something is doing the expensive part. */
    hookTimeout: 30_000,
  },
});
