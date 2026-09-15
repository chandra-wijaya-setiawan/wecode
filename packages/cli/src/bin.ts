#!/usr/bin/env node
import { register } from "node:module";

// node:sqlite is experimental and says so on every invocation. The operator is not the one
// who chose it; the warning is noise on a tool they run all day.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.emitWarning(w);
});

// dist is a build artefact, and an artefact can be stale — the operator who edits the cli and
// re-runs the command should see their edit, not yesterday's compile. So this entry is the only
// compiled file of the cli that runs: it registers a resolve hook that sends every further import
// within this package to the TypeScript beside it, and node strips the types. Where a module has
// no source (a published tree with dist alone) the hook stands aside and the artefact serves.
//
// The hook stops at the package boundary. Node's stripper is strip-only — it refuses a parameter
// property, which @wecode/core uses — so the dependencies keep arriving as their compiled selves.
const LOADER = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE = ${JSON.stringify(new URL("../", import.meta.url).href)};

/** The .ts in this package that a resolved .js url was compiled from, if it is still on disk. */
const source = (url) => {
  if (!url.startsWith(PACKAGE) || !url.endsWith(".js")) return null;
  if (url.includes("/node_modules/")) return null;
  const ts = url.slice(0, -3) + ".ts";
  const cut = ts.lastIndexOf("/dist/");
  const candidates = cut === -1 ? [ts] : [ts.slice(0, cut) + "/src/" + ts.slice(cut + 6), ts];
  return candidates.find((c) => existsSync(fileURLToPath(c))) ?? null;
};

export async function resolve(specifier, context, next) {
  try {
    const resolved = await next(specifier, context);
    const from = source(resolved.url);
    return from ? { ...resolved, url: from, format: undefined } : resolved;
  } catch (failed) {
    // A source file spells its siblings as ".js" — those exist only once compiled, so from
    // inside src the default resolver finds nothing and we answer with the sibling itself.
    if (context.parentURL && specifier.startsWith(".") && specifier.endsWith(".js")) {
      const sibling = new URL(specifier.slice(0, -3) + ".ts", context.parentURL).href;
      if (existsSync(fileURLToPath(sibling))) return { url: sibling, shortCircuit: true };
    }
    throw failed;
  }
}
`;

register(`data:text/javascript,${encodeURIComponent(LOADER)}`);

// Dynamic, so that it is resolved after the hook is registered — a static import of "./run.js"
// would be resolved while this module is still linking, and would find dist.
const { run } = (await import("./run.js")) as typeof import("./run.js");

process.exitCode = run(process.argv.slice(2));
