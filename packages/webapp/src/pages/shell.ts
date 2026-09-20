/** The frame every page of the web surface wears, read off the design rather than written
 *  out in each page.
 *
 *  `packages/tui/config/design.yaml` is one design with three renderers on it: a terminal,
 *  a wireframe and this. Its `renderers.webapp.shell` block says what a document of this
 *  surface is — its doctype, its language, its title, the one banner it carries and the one
 *  element its markup goes inside. This file is the only thing that turns those words into
 *  markup, so a page is a fragment plus `shelled()` and never a document of its own: two
 *  pages each spelling their own `<!doctype>` are two answers to what the surface looks
 *  like, and they drift on the first rename.
 *
 *  The design file lives in `@wecode/tui` beside views.yaml, and so does the parser that
 *  reads it — this package borrows both through the dependency it already has on that
 *  package rather than declaring a second copy of either. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { html, type Page, type Reply } from "../server.js";

/** Where the design is, and what reads it. Both are resolved through `@wecode/tui`: the
 *  file is that package's, and `yaml` is the dependency that package already has for it.
 *  Resolution rather than a path up the tree, because where a dependency's files sit is the
 *  package manager's business — and `createRequire` rather than `import.meta.resolve`,
 *  which the test runner's module loader does not implement. */
const here = createRequire(fileURLToPath(import.meta.url));
const DESIGN = here.resolve("@wecode/tui/config/design.yaml");
const { parse } = createRequire(here.resolve("@wecode/tui"))("yaml") as {
  parse: (text: string) => unknown;
};

export class ShellError extends Error {}

/** The declared shell. Every field is a sentence of the document and none of them is this
 *  file's to choose. */
export interface Shell {
  readonly doctype: string;
  readonly lang: string;
  readonly charset: string;
  readonly viewport: string;
  readonly title: string;
  readonly banner: string;
  /** The element the whole of a page's markup goes inside. */
  readonly body: string;
}

const FIELDS = ["doctype", "lang", "charset", "viewport", "title", "banner", "body"] as const;

const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The shell `renderers.webapp` declares. A field the design does not say is a refusal and
 *  never a default: a document drawn from a half-read design is a document nothing gates. */
export function loadShell(path: string = DESIGN): Shell {
  const webapp = mapOf(mapOf(mapOf(parse(readFileSync(path, "utf8")))["renderers"])["webapp"]);
  const block = mapOf(webapp["shell"]);
  const shell: Record<string, string> = {};
  for (const field of FIELDS) {
    const said = block[field];
    if (typeof said !== "string") {
      throw new ShellError(`${path}: renderers.webapp.shell declares no ${field}`);
    }
    shell[field] = said;
  }
  return shell as unknown as Shell;
}

/** The document: the declared frame, with the page's own markup inside the one element the
 *  design gives it. There is no per-page argument: the surface has one stylesheet and it is
 *  here. A page that could hand in rules of its own is a page that can disagree with the
 *  frame about what a heading or a list looks like, and three pages each with a `STYLE`
 *  constant are three surfaces that only look like one until somebody edits one of them. */
export function document(contents: string, shell: Shell = loadShell()): string {
  const { doctype, lang, charset, viewport, title, banner, body } = shell;
  return (
    `${doctype}\n<html lang="${lang}"><head><meta charset="${charset}">` +
    `<meta name="viewport" content="${viewport}">` +
    `<title>${title}</title><style>${STYLE}</style></head>` +
    `<body><${body}><h1>${banner}</h1>${contents}</${body}></body></html>\n`
  );
}

/** What a page says, without saying it in a document. A page is given the target so it can
 *  read its own query; what it hands back is markup for the inside of the shell. */
export type Contents = (url: URL) => string;

/** A page, wearing the shell. This is the only way a page of this package becomes a reply,
 *  so "every page is in the shell" is a fact about the code and not a habit. */
export const shelled = (contents: Contents, shell: Shell = loadShell()): Page =>
  (url: URL): Reply => html(document(contents(url), shell));

/** The surface's presentation, whole — the frame first, then the shapes each page draws
 *  with. Dark because the cockpit it mirrors is read in a terminal, and monospace for the
 *  one thing a column of ids needs.
 *
 *  A page's rules live here and not in the page because presentation is one decision across
 *  the surface: a heading is the same size on the board as on the decisions page, and the
 *  grey a secondary column is written in is one grey. Each page's block is selected from the
 *  shape that page draws — the board's boxes are `section`s, a decision is an `article`, the
 *  tree is `ul.tree` — so the blocks are readable apart without being separable, and a rule
 *  common to all three, like what an empty page says, is written once. */
const STYLE = `
  :root { color-scheme: dark }
  body { margin: 0; padding: 1.5rem; background: #111; color: #ddd;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace }
  main { display: grid; gap: 1.25rem; max-width: 60rem; margin: 0 auto }
  h1 { font-size: 1rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
       margin: 0 0 .5rem; color: #888 }
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .4rem }
  p.empty { margin: 0; color: #666 }

  section { border-top: 1px solid #333; padding-top: .5rem }
  section h2 .mark { display: inline-block; width: 1.25rem; color: #6cf }
  section h2 kbd { float: right; color: #888; font: inherit }
  section ul { list-style: none; margin: 0; padding: 0 }
  section li { display: flex; gap: .75rem; padding: .1rem 0 }
  section li .code { flex: 0 0 9rem; color: #888 }
  section li .state { flex: 0 0 9rem; color: #6cf }
  section li .what { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere }

  article { border: 1px solid #333; border-radius: 4px; padding: .75rem 1rem }
  article h2 { margin: 0 0 .5rem; overflow-wrap: anywhere; white-space: pre-wrap }
  article h2 .id { color: #888; margin-right: .6rem }
  article dl { display: grid; grid-template-columns: 6rem 1fr; gap: .2rem .75rem; margin: 0 }
  article dt { color: #888 }
  article dd { margin: 0; min-width: 0; overflow-wrap: anywhere }
  article dd ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap;
                  gap: .4rem }
  article dd li { border: 1px solid #444; border-radius: 3px; padding: 0 .4rem; color: #6cf }
  article dd.open { color: #666 }
  article p.how { margin: .6rem 0 0; color: #666 }

  ul.tree { list-style: none; margin: 0; padding: 0 }
  ul.tree ul { list-style: none; margin: 0; padding-left: 1.25rem;
               border-left: 1px solid #333 }
  ul.tree li { padding: .1rem 0; min-width: 0; overflow-wrap: anywhere }
  ul.tree li .label { color: #ddd }
  ul.tree li .id, ul.tree li .kind, ul.tree li .rollup { color: #888 }
  ul.tree li .state { color: #6cf }
`;
