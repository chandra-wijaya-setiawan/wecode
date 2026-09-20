/** Which pages the web surface has, read off `src/pages/` rather than written down.
 *
 *  A route table is a second declaration of the surface: the file exists, and then a list
 *  somewhere else has to agree that it exists. The two drift the first time somebody adds a
 *  page and forgets the list — and the failure is a page that is simply not there, with
 *  nothing red to say so. So the directory is the list. A page is a file in this directory;
 *  adding one is adding a file.
 *
 *  What a page must hold up its end of is three conventions and no registration:
 *    - it is `<name>.ts`, and it answers at `/<name>` — except `board.ts`, which answers at
 *      `/`, because the board is what the surface opens on;
 *    - it exports `<name>At`, a factory taking one way of reading the workspace and
 *      returning what answers at a path;
 *    - it reads the record unless it says otherwise, in an exported `READS`. Most pages are
 *      a view of the tree, so the common case declares nothing.
 *
 *  A file here that is not a page is infrastructure and must say so by being in `NOT_PAGES`
 *  — the one list in this file, and it is a list of what is *not* a page, so forgetting it
 *  is loud rather than silent: an undeclared file with no `<name>At` is a refusal to route
 *  anything at all.
 *
 *  Nothing here knows what a workspace is. The readings arrive from `bin.ts`, which owns
 *  the database, so this file can be exercised against readings of nothing at all. */
import { readdirSync } from "node:fs";
import type { Handler, Routes } from "../server.js";

/** A file in this directory that is not a page. `shell.ts` is the frame every page wears
 *  and this file is the discovery itself; neither answers at a path. */
export const NOT_PAGES: readonly string[] = ["discover", "shell"];

/** What a page reads unless it names something else. */
export const READS_BY_DEFAULT = "record";

/** The page the surface opens on, and the only path that is not its file's name. */
export const HOME = "board";

export class PageError extends Error {}

/** Ways of reading the workspace, by the name a page asks for one under. What is in here is
 *  a question about the work — the record, the board, the approvals waiting — and never a
 *  page: two pages asking the same question share one reading. */
export type Readings = Readonly<Record<string, () => unknown>>;

/** A page's factory: one reading in, what answers at a path out. */
type Mount = (read: () => never) => Handler;

const isPage = (file: string): boolean =>
  (file.endsWith(".ts") || file.endsWith(".js")) && !file.endsWith(".d.ts");

/** The page files in a directory, by name, in the order they will be routed in. Sorted, so
 *  that what the surface is does not depend on what order a filesystem hands its entries
 *  back in. */
export function discovered(files: readonly string[]): readonly string[] {
  return files
    .filter(isPage)
    .map((file) => file.slice(0, file.lastIndexOf(".")))
    .filter((name) => !NOT_PAGES.includes(name))
    .sort();
}

/** Where a page answers. */
export const pathOf = (name: string): string => (name === HOME ? "/" : `/${name}`);

const mountOf = (name: string, module: Record<string, unknown>): Mount => {
  const mount = module[`${name}At`];
  if (typeof mount !== "function") {
    throw new PageError(`pages/${name} exports no ${name}At — a page is a factory, or it is not a page`);
  }
  return mount as Mount;
};

const readingOf = (name: string, module: Record<string, unknown>, readings: Readings): () => never => {
  const said = module["READS"];
  if (said !== undefined && typeof said !== "string") {
    throw new PageError(`pages/${name} declares a READS that is not a name`);
  }
  const reads = said ?? READS_BY_DEFAULT;
  const reading = readings[reads];
  if (reading === undefined) {
    const known = Object.keys(readings).sort().join(" ");
    throw new PageError(`pages/${name} reads ${reads}, which is not a reading of the workspace — ${known}`);
  }
  return reading as () => never;
};

/** One discovered page, bound to what it reads. Separate from the import so that the
 *  conventions can be proved against a module object rather than against the filesystem. */
export function mounted(name: string, module: Record<string, unknown>, readings: Readings): Handler {
  return mountOf(name, module)(readingOf(name, module, readings));
}

/** The whole surface: every page in this directory, at its path, bound to what it reads.
 *
 *  The modules are imported by absolute URL rather than by a specifier built out of a name,
 *  because this file runs both from `src/` under the test runner and from `dist/` in a
 *  release, and only the directory it is itself in knows which. */
export async function pages(
  readings: Readings,
  dir = new URL(".", import.meta.url),
  files: readonly string[] = readdirSync(dir),
): Promise<Routes> {
  const routes: Record<string, Handler> = {};
  for (const name of discovered(files)) {
    const file = files.find((f) => isPage(f) && f.slice(0, f.lastIndexOf(".")) === name) as string;
    const module = (await import(new URL(file, dir).href)) as Record<string, unknown>;
    routes[pathOf(name)] = mounted(name, module, readings);
  }
  return routes;
}
