/** The questions wecode asks about a repository, and nothing else.
 *
 *  Four questions, because four is what the work needs: what a file defines and exports,
 *  what it imports, who references a symbol, and the evidence of what a module is for.
 *  Nothing here mentions an index, a parser or a cache — the answers are the contract, and
 *  the thing that computes them is an adapter, replaceable without a caller noticing.
 *
 *  Every path in and out of this port is repository-relative and POSIX-separated —
 *  `packages/core/src/store.ts`, never an absolute path and never a backslash. An adapter
 *  that thinks in absolute paths converts at its own edge, so a caller's expectations do
 *  not depend on where the checkout happens to live. Every line and column is 1-based, as
 *  an editor counts them. */

/** What a reader of the source would call a declaration. `variable` covers every
 *  `const`/`let`/`var`, including one whose initialiser is a function: the declaration is
 *  what is read, not the value's shape. `unknown` is for a language whose declarations do
 *  not map onto this list, and is an answer rather than a failure. */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "default"
  | "unknown";

/** One thing a file declares. `exported` says whether the rest of the repository may name
 *  it; a declaration a file keeps to itself is still reported, because "what a file
 *  defines" is a bigger question than "what it exports". */
export interface Definition {
  readonly name: string;
  readonly kind: SymbolKind;
  /** The line the declaration starts on. */
  readonly line: number;
  readonly exported: boolean;
  /** The doc comment attached to the declaration, comment markers stripped, or null. */
  readonly doc: string | null;
}

/** One name a file brings in. `name` is the name the file goes on to write — the local
 *  one, so `import { greet as hello }` is `hello`. A whole-module import has no local name
 *  to report and uses `*`. */
export interface Imported {
  readonly name: string;
  readonly kind: "default" | "named" | "namespace" | "star";
  /** The specifier exactly as the source writes it: `./greet.js`, `@wecode/core`. */
  readonly from: string;
  /** The file the specifier reaches, or null when it leaves the repository — a package in
   *  `node_modules`, a builtin, or a specifier nothing resolves. */
  readonly resolved: string | null;
}

/** What one file declares and what it brings in. Both lists are sorted by name, so two
 *  readings of the same file compare equal without a caller sorting first. */
export interface Reading {
  readonly file: string;
  readonly defines: readonly Definition[];
  readonly imports: readonly Imported[];
}

/** One place a symbol is used. The declaration itself is not a use and is never here. */
export interface Use {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** The evidence of what a module is for — what it says about itself, what it offers, and
 *  who took it up. Not a summary and not a judgement: three facts a reader can check
 *  against the tree, which is the point. A module whose doc comment claims one thing and
 *  whose dependents want another is visible here, and would not be in a sentence. */
export interface Purpose {
  readonly file: string;
  /** The module's own leading doc comment, markers stripped, or null when it has none. */
  readonly doc: string | null;
  /** Every name the module exports, including ones it re-exports from elsewhere, sorted. */
  readonly exports: readonly string[];
  /** The files that import this one, directly, sorted. */
  readonly dependents: readonly string[];
}

/** Asked about a file the index does not hold. Distinct from a file with nothing in it: an
 *  empty reading says the file was read, and this says it never was. */
export class UnknownFile extends Error {
  constructor(
    readonly file: string,
    readonly root: string,
  ) {
    super(`no reading of ${file}: the index of ${root} does not hold it`);
    this.name = "UnknownFile";
  }
}

/** Asked who references something the named file does not declare. Answering `[]` would
 *  say the symbol exists and is unused, which is a different and much more interesting
 *  fact, so the two are not allowed to look alike. */
export class UnknownSymbol extends Error {
  constructor(
    readonly file: string,
    readonly symbol: string,
  ) {
    super(`no uses of ${symbol}: ${file} does not declare it`);
    this.name = "UnknownSymbol";
  }
}

/** A repository, as the four questions. */
export interface RepoIndex {
  /** The checkout the answers are about. Every path is relative to this. */
  readonly root: string;
  /** What `file` defines and what it imports. Throws `UnknownFile` if it is not indexed. */
  read(file: string): Promise<Reading>;
  /** Every use of the symbol `file` declares, sorted by file, then line, then column.
   *  Throws `UnknownFile`, or `UnknownSymbol` when the file declares no such name. */
  usesOf(file: string, symbol: string): Promise<readonly Use[]>;
  /** The evidence of what `file` is for. Throws `UnknownFile` if it is not indexed. */
  purposeOf(file: string): Promise<Purpose>;
}
