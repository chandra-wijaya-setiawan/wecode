import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** A loader whose only job is to write down every url the cli actually loads. It is registered
 *  before the cli's own hook, so the cli's hook is the outer link of the resolve chain and what
 *  reaches this `load` is the url finally settled on — dist or source. */
const SPY = `
import { appendFileSync } from "node:fs";
export async function load(url, context, next) {
  appendFileSync(process.env.WECODE_LOADED, url + "\\n");
  return next(url, context);
}
`;

/** Runs the built cli entry under the spy and returns what it said and what it loaded. */
const invoke = (...argv: string[]): { code: number; out: string; loaded: string } => {
  const dir = tmp("wecode-loader-");
  const log = join(dir, "loaded.txt");
  writeFileSync(join(dir, "spy.mjs"), SPY);
  writeFileSync(
    join(dir, "probe.mjs"),
    `import { register } from "node:module";\nregister("./spy.mjs", import.meta.url);\n`,
  );
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--import", join(dir, "probe.mjs"), bin, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      WECODE_LOADED: log,
      WECODE_DB: join(dir, "wecode.db"),
    },
  });
  return { code: r.status ?? -1, out: r.stdout + r.stderr, loaded: readFileSync(log, "utf8") };
};

let run: { code: number; out: string; loaded: string };

beforeAll(() => {
  run = invoke("init");
});

describe("the cli entry", () => {
  it("still does the work it is asked for", () => {
    expect(run.out).toContain("workspace at");
    expect(run.code).toBe(0);
  });

  it("loads its own modules from src, so an unbuilt edit is what runs", () => {
    expect(run.loaded).toMatch(/packages\/cli\/src\/run\.ts$/m);
    expect(run.loaded).toMatch(/packages\/cli\/src\/plan\.ts$/m);
  });

  it("never loads a compiled cli module other than the entry itself", () => {
    const dist = run.loaded
      .split("\n")
      .filter((url) => /\/packages\/cli\/dist\/.+\.js$/.test(url))
      .map((url) => url.replace(/.*\/dist\//, ""));
    expect(dist).toEqual(["bin.js"]);
  });

  it("stops at the package boundary, where node's stripper cannot go", () => {
    // @wecode/core declares parameter properties, which strip-only mode refuses; the hook must
    // leave a dependency alone and let its build serve.
    expect(run.loaded).toMatch(/packages\/core\/dist\/index\.js$/m);
    expect(run.loaded).not.toMatch(/packages\/core\/src\//);
  });
});
