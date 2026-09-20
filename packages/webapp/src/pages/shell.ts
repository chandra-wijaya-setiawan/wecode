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
 *  design gives it. `style` is what the page adds to the shell's own — the design says the
 *  stylesheet is in the document, and a page's rules are still the page's. */
export function document(contents: string, style = "", shell: Shell = loadShell()): string {
  const { doctype, lang, charset, viewport, title, banner, body } = shell;
  return (
    `${doctype}\n<html lang="${lang}"><head><meta charset="${charset}">` +
    `<meta name="viewport" content="${viewport}">` +
    `<title>${title}</title><style>${SHELL_STYLE}${style}</style></head>` +
    `<body><${body}><h1>${banner}</h1>${contents}</${body}></body></html>\n`
  );
}

/** What a page says, without saying it in a document. A page is given the target so it can
 *  read its own query; what it hands back is markup for the inside of the shell. */
export type Contents = (url: URL) => string;

/** A page, wearing the shell. This is the only way a page of this package becomes a reply,
 *  so "every page is in the shell" is a fact about the code and not a habit. */
export const shelled = (contents: Contents, style = "", shell: Shell = loadShell()): Page =>
  (url: URL): Reply => html(document(contents(url), style, shell));

/** The document's own presentation — the frame, and nothing about any one page. Dark
 *  because the cockpit it mirrors is read in a terminal, and monospace for the one thing a
 *  column of ids needs. */
const SHELL_STYLE = `
  :root { color-scheme: dark }
  body { margin: 0; padding: 1.5rem; background: #111; color: #ddd;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace }
  main { display: grid; gap: 1.25rem; max-width: 60rem; margin: 0 auto }
  h1 { font-size: 1rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
       margin: 0 0 .5rem; color: #888 }
`;
