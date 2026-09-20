/** The frame every page of the web surface wears, read off the design rather than written
 *  out in each page — the word at the top, the row of ways in under it, and the look.
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
import { pathOf } from "./discover.js";

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

/** The `renderers.webapp` block of the design at `path`. */
const webappOf = (path: string): Record<string, unknown> =>
  mapOf(mapOf(mapOf(parse(readFileSync(path, "utf8")))["renderers"])["webapp"]);

/** The shell `renderers.webapp` declares. A field the design does not say is a refusal and
 *  never a default: a document drawn from a half-read design is a document nothing gates. */
export function loadShell(path: string = DESIGN): Shell {
  const block = mapOf(webappOf(path)["shell"]);
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

/** One name in the banner: the page it opens, and the word the reader is offered for it.
 *  Where it answers is not declared — that is `discover.ts`'s one answer, asked for here
 *  rather than said twice. */
export interface Tab {
  readonly page: string;
  readonly says: string;
  readonly at: string;
}

/** The order `renderers.webapp.banner` declares. As with the shell, nothing is defaulted:
 *  a banner built out of whatever this file guessed is a banner nobody signed, and the
 *  order a reader meets the surface in is a decision about the surface. */
export function loadBanner(path: string = DESIGN): readonly Tab[] {
  const said = mapOf(webappOf(path)["banner"])["order"];
  if (!Array.isArray(said)) {
    throw new ShellError(`${path}: renderers.webapp.banner declares no order`);
  }
  return said.map((row, at) => {
    const held = mapOf(row);
    for (const field of ["page", "says"]) {
      if (typeof held[field] !== "string") {
        throw new ShellError(`${path}: renderers.webapp.banner.order[${at}] declares no ${field}`);
      }
    }
    const page = held["page"] as string;
    return { page, says: held["says"] as string, at: pathOf(page) };
  });
}

/** The banner as markup: the word, and under it one row of ways in, in the declared order. */
const bannerOf = (banner: string, tabs: readonly Tab[]): string =>
  `<h1>${banner}</h1><nav>` +
  tabs.map((tab) => `<a href="${tab.at}">${tab.says}</a>`).join("") +
  `</nav>`;

/** The look `renderers.webapp` declares: the tokens every rule spends, the shape each page
 *  is allowed to name, and the rules themselves — the frame's, then one block per page. */
export interface Look {
  readonly scheme: string;
  readonly palette: Readonly<Record<string, string>>;
  readonly type: Readonly<Record<string, string>>;
  readonly roots: Readonly<Record<string, readonly string[]>>;
  readonly frame: Rules;
  readonly pages: Readonly<Record<string, Rules>>;
}

/** Selector to declarations. A value that is itself a map is a wrapper — an `@media` query
 *  — and holds selectors of its own. */
export type Rules = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

const stringsOf = (v: unknown, said: string): Record<string, string> => {
  const map = mapOf(v);
  for (const [key, held] of Object.entries(map)) {
    if (typeof held !== "string") throw new ShellError(`${said}.${key} is not a word`);
  }
  return map as Record<string, string>;
};

/** The look, read off the design. As with the shell, a block the design does not declare is
 *  a refusal: a surface styled from half a design is a surface nothing signed. */
export function loadLook(path: string = DESIGN): Look {
  const block = mapOf(webappOf(path)["look"]);
  for (const field of ["scheme", "palette", "type", "roots", "frame", "pages"]) {
    if (!(field in block)) throw new ShellError(`${path}: renderers.webapp.look declares no ${field}`);
  }
  const roots: Record<string, readonly string[]> = {};
  for (const [page, said] of Object.entries(mapOf(block["roots"]))) {
    if (!Array.isArray(said) || said.some((s) => typeof s !== "string")) {
      throw new ShellError(`${path}: renderers.webapp.look.roots.${page} is not a list of shapes`);
    }
    roots[page] = said as string[];
  }
  const pages: Record<string, Rules> = {};
  for (const [page, said] of Object.entries(mapOf(block["pages"]))) pages[page] = mapOf(said) as Rules;
  return {
    scheme: String(block["scheme"]),
    palette: stringsOf(block["palette"], "palette"),
    type: stringsOf(block["type"], "type"),
    roots,
    frame: mapOf(block["frame"]) as Rules,
    pages,
  };
}

const rule = (selector: string, declarations: string): string => `${selector} { ${declarations} }\n`;

/** The declared rules as text. A nested map is a query, and its own rules go inside it. */
const rulesOf = (rules: Rules, indent = ""): string =>
  Object.entries(rules)
    .map(([selector, held]) =>
      typeof held === "string"
        ? indent + rule(selector, held)
        : `${indent}${selector} {\n${rulesOf(held as Rules, `${indent}  `)}${indent}}\n`,
    )
    .join("");

/** The whole surface's stylesheet, built from the declared look and from nothing else.
 *
 *  Every page's block is in it, in every document. That is deliberate: a page is a fragment
 *  and the sheet is the surface's, so a page cannot be served in a look of its own — and it
 *  is safe because each block is scoped to a shape only its page draws, which the design
 *  declares as that page's `roots` and the gate holds it to. */
export function stylesheet(look: Look = loadLook()): string {
  const tokens = [
    `color-scheme: ${look.scheme}`,
    ...Object.entries(look.palette).map(([name, held]) => `--${name}: ${held}`),
    ...Object.entries(look.type).map(([name, held]) => `--${name}: ${held}`),
  ].join("; ");
  return (
    rule(":root", tokens) +
    rulesOf(look.frame) +
    Object.values(look.pages)
      .map((page) => rulesOf(page))
      .join("")
  );
}

/** The document: the declared frame, with the page's own markup inside the one element the
 *  design gives it, wearing the declared look.
 *
 *  `retired` is the stylesheet a page used to hand in. It is taken and dropped: the look is
 *  the design's now, so a page that still passes one is served the signed sheet anyway
 *  rather than its own. The parameter stays only so a page that has not yet stopped passing
 *  one still compiles; nothing it contains reaches the document. */
export function document(
  contents: string,
  retired = "",
  shell: Shell = loadShell(),
  css: string = stylesheet(),
  tabs: readonly Tab[] = loadBanner(),
): string {
  void retired;
  const { doctype, lang, charset, viewport, title, banner, body } = shell;
  return (
    `${doctype}\n<html lang="${lang}"><head><meta charset="${charset}">` +
    `<meta name="viewport" content="${viewport}">` +
    `<title>${title}</title><style>${css}</style></head>` +
    `<body><${body}>${bannerOf(banner, tabs)}${contents}</${body}></body></html>\n`
  );
}

/** What a page says, without saying it in a document. A page is given the target so it can
 *  read its own query; what it hands back is markup for the inside of the shell. */
export type Contents = (url: URL) => string;

/** A page, wearing the shell. This is the only way a page of this package becomes a reply,
 *  so "every page is in the shell" is a fact about the code and not a habit.
 *
 *  The frame and the sheet are read when the page is wired, not on every request: they are
 *  the design's, and the design does not change under a running server. What does change is
 *  the work, and that is what `contents` is asked for each time. */
export const shelled = (
  contents: Contents,
  retired = "",
  shell: Shell = loadShell(),
  css: string = stylesheet(),
  tabs: readonly Tab[] = loadBanner(),
): Page =>
  (url: URL): Reply => html(document(contents(url), retired, shell, css, tabs));
