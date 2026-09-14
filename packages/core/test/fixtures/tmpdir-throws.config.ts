import { defineConfig } from "vitest/config";

/** The suite's own config only collects `*.test.ts`, which the failing fixture deliberately
 *  is not. This one collects just that fixture. */
export default defineConfig({
  test: {
    include: ["packages/core/test/fixtures/tmpdir-throws.fixture.ts"],
  },
});
