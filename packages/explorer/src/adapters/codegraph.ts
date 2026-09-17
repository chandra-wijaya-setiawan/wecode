import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "@lzehrung/codegraph-core";
import {
  UnknownFile,
  UnknownSymbol,
  type Definition,
  type Imported,
  type Purpose,
  type Reading,
  type RepoIndex,
  type SymbolKind,
  type Use,
} from "../ports.js";

/** Codegraph, as the repository index.
 *
 *  Everything codegraph-specific is here: that it wants absolute paths, that a snapshot is
 *  built once and then queried, that an `export *` is an entry with no names on it, that
 *  its locals include a function's parameters, and that it does not record a type-only
 *  export at all. The port above knows none of that, so replacing this file with another
 *  index is a change nothing outside the package can observe.
 *
 *  Two of those are gaps rather than differences, and this file closes them by looking at
 *  the line the index already told it a declaration is on. That is the adapter's job, and
 *  the reason it is a file and not a re-export: an index that reported a type export would
 *  make `declaredExport` and `refine` dead, and nothing above would change.
 *
 *  Codegraph itself is loaded on the first question rather than on import, so the package
 *  above it can be imported — and the translation below tested — by a process that never
 *  asks one. The library is heavy and, in a workspace where its own dependencies are not
 *  all declared, not always loadable at all; neither is a reason for the port to be
 *  unreachable.
 *
 *  The snapshot is built on the first question and reused for every question after it, so
 *  every answer is about one state of the tree. Two answers that disagree because the tree
 *  moved between them are worse than one stale answer: nothing tells the reader which half
 *  to trust. An index is cheap to throw away — the caller opens another one when it wants
 *  to see the tree again. */
export class CodegraphIndex implements RepoIndex {
  constructor(readonly root: string) {}

  /** The build, kept as its promise rather than its result: two questions asked before the
   *  first build finishes must join that build, not start a second one. */
  private snapshot: Promise<Snapshot> | null = null;

  /** Source read for a declaration's own line, per file, so a reading costs one read. */
  private readonly lines = new Map<string, readonly string[]>();

  async read(file: string): Promise<Reading> {
    const { module } = await this.moduleFor(file);
    const here = this.relative(module.file);
    const exported = new Set(
      module.exports.flatMap((e) => (e.type === "local" ? [e.target.localName] : [])),
    );
    return {
      file: here,
      defines: ownDeclarations(module.locals)
        .map((local) => this.definitionOf(here, local, exported))
        .sort(byName),
      imports: module.imports.map((binding) => this.importOf(binding)).sort(byName),
    };
  }

  async usesOf(file: string, symbol: string): Promise<readonly Use[]> {
    const { lib, index, module } = await this.moduleFor(file);
    const declared = ownDeclarations(module.locals).filter((l) => l.localName === symbol);
    if (declared.length === 0) throw new UnknownSymbol(this.relative(module.file), symbol);

    const sites = new Map<string, Use>();
    for (const def of declared) {
      const found = await lib.findReferencesById(index, lib.symbolId(def));
      if (found.status !== "ok") continue; // The handle resolved to no definition after all.
      for (const reference of found.references) {
        const use = {
          file: this.relative(reference.file),
          line: reference.range.start.line,
          column: reference.range.start.column,
        };
        // A declaration is not a use of itself, and codegraph reports it among the rest.
        if (declared.some((d) => this.isAt(d, use))) continue;
        sites.set(`${use.file}:${use.line}:${use.column}`, use);
      }
    }
    return [...sites.values()].sort(byPlace);
  }

  async purposeOf(file: string): Promise<Purpose> {
    const { lib, index, module } = await this.moduleFor(file);
    const here = this.relative(module.file);
    return {
      file: here,
      doc: prose(leadingComment(join(this.root, here))),
      exports: this.exportedNames(index, module, new Set()).sort(),
      dependents: lib.getReverseDependencies(index.graph, module.file, { depth: 1 })
        .map((node) => this.relative(node.file))
        .filter((dependent) => dependent !== here)
        .sort(),
    };
  }

  /** Every name the module offers.
   *
   *  Three things have to be added to what the index lists. An `export *` carries no names
   *  of its own, so it is followed into the module it re-exports from — `seen` is what
   *  stops a cycle of them, and a module the index does not hold is reported as `*`, which
   *  says "more names, from somewhere this index cannot see" rather than quietly offering
   *  none. And a type-only export is not listed at all, so the declarations are asked
   *  whether they say `export` on their own line. */
  private exportedNames(index: ProjectIndex, module: ModuleIndex, seen: Set<string>): string[] {
    if (seen.has(module.file)) return [];
    seen.add(module.file);
    const here = this.relative(module.file);
    const names: string[] = [];
    for (const entry of module.exports) {
      if (entry.type !== "exportStar") {
        names.push(entry.exportedAs);
        continue;
      }
      const from = index.modules.get(entry.fromModule);
      names.push(...(from === undefined ? ["*"] : this.exportedNames(index, from, seen)));
    }
    for (const local of ownDeclarations(module.locals)) {
      if (this.declaredExport(here, local)) names.push(local.localName);
    }
    return [...new Set(names)];
  }

  private definitionOf(file: string, local: SymbolDef, exported: ReadonlySet<string>): Definition {
    const prefix = this.prefixOf(file, local);
    return {
      name: local.localName,
      kind: refine(KINDS[local.kind] ?? "unknown", prefix),
      line: local.range.start.line,
      exported: exported.has(local.localName) || isDeclaredExport(prefix),
      doc: prose(local.docstring),
    };
  }

  private importOf(binding: ModuleIndex["imports"][number]): Imported {
    const resolved = binding.resolved;
    return {
      name:
        binding.kind === "star"
          ? "*"
          : binding.kind === "namespace"
            ? binding.localNS
            : binding.local,
      kind: binding.kind,
      from: binding.from,
      resolved: typeof resolved === "string" ? this.relative(resolved) : null,
    };
  }

  /** Whether a declaration the index does not list as exported says so itself. Only a
   *  type-only declaration can be in that position; anything else the index would have
   *  listed, and reading the line for it would be a second opinion, not a repair. */
  private declaredExport(file: string, local: SymbolDef): boolean {
    return local.kind === "type" && isDeclaredExport(this.prefixOf(file, local));
  }

  /** What the source writes before a declaration's name, on the name's own line. */
  private prefixOf(file: string, local: SymbolDef): string {
    const lines = this.sourceOf(file);
    return lines[local.range.start.line - 1]?.slice(0, local.range.start.column - 1) ?? "";
  }

  private sourceOf(file: string): readonly string[] {
    const held = this.lines.get(file);
    if (held !== undefined) return held;
    let read: readonly string[];
    try {
      read = readFileSync(join(this.root, file), "utf8").split("\n");
    } catch {
      read = []; // Indexed but unreadable now: every prefix is empty, and nothing lies.
    }
    this.lines.set(file, read);
    return read;
  }

  private isAt(def: SymbolDef, use: Use): boolean {
    return (
      this.relative(def.file) === use.file &&
      def.range.start.line === use.line &&
      def.range.start.column === use.column
    );
  }

  /** The indexed module for a path the caller named, however it named it. */
  private async moduleFor(file: string): Promise<Snapshot & { module: ModuleIndex }> {
    const snapshot = await this.built();
    const wanted = this.relative(file);
    const module = snapshot.byPath.get(wanted);
    if (module === undefined) throw new UnknownFile(wanted, this.root);
    return { ...snapshot, module };
  }

  private async built(): Promise<Snapshot> {
    this.snapshot ??= (async () => {
      const lib = await import("@lzehrung/codegraph-core");
      const index = await lib.buildProjectIndex(this.root);
      return {
        lib,
        index,
        byPath: new Map([...index.modules.values()].map((m) => [this.relative(m.file), m])),
      };
    })();
    return this.snapshot;
  }

  /** A codegraph file id as the port promises paths: relative to the root, POSIX-separated. */
  private relative(file: string): string {
    const rooted = isAbsolute(file) ? relative(this.root, file) : file;
    return sep === "/" ? rooted : rooted.split(sep).join("/");
  }
}

/** Opens an index over `root`. Nothing is read until a question is asked, so opening one
 *  over a repository nobody goes on to ask about costs nothing. */
export function openCodegraph(root: string): RepoIndex {
  return new CodegraphIndex(root);
}

/** Codegraph itself, one build of the tree, and its modules by the path the port names
 *  them with. The library travels with the snapshot because it arrived with it. */
type Snapshot = {
  readonly lib: typeof import("@lzehrung/codegraph-core");
  readonly index: ProjectIndex;
  readonly byPath: ReadonlyMap<string, ModuleIndex>;
};

/** Codegraph's declaration kinds, as the port's. Its SQL kinds — a table, a view — have no
 *  row: they are real answers about a repository, but not ones this port asks for yet.
 *  `interface` is absent because codegraph calls one a type; `refine` puts it back. */
export const KINDS: Readonly<Record<string, SymbolKind>> = {
  function: "function",
  class: "class",
  variable: "variable",
  interface: "interface",
  type: "type",
  default: "default",
};

/** An `interface` and a `type` alias are one kind to codegraph and two to a reader, and
 *  the declaration's own line says which. */
export const refine = (kind: SymbolKind, prefix: string): SymbolKind =>
  kind === "type" && /\binterface\s+$/.test(prefix) ? "interface" : kind;

export const isDeclaredExport = (prefix: string): boolean =>
  /^\s*export\s+(?:declare\s+)?(?:interface|type)\s+$/.test(prefix);

/** The declarations a file makes in its own right.
 *
 *  Codegraph's locals include a function's parameters and the names bound inside its body,
 *  which are not what "what a file defines" asks about. A declaration whose name falls
 *  within another declaration's lines, after that declaration's own name, is one of those.
 *  A member — a field of a class — is out for the same reason and says so itself. */
export function ownDeclarations(locals: readonly SymbolDef[]): SymbolDef[] {
  const own = locals.filter((local) => local.isMember !== true);
  const inside = (local: SymbolDef, outer: SymbolDef): boolean => {
    const from = outer.range.start;
    const to = from.line + Math.max(outer.lineSpan ?? 1, 1) - 1;
    const at = local.range.start;
    if (at.line < from.line || at.line > to) return false;
    return at.line > from.line || at.column > from.column;
  };
  return own.filter((local) => !own.some((outer) => outer !== local && inside(local, outer)));
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const byPlace = (a: Use, b: Use): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column;

/** A comment's prose: the markers off every line, the hanging indent a continuation line
 *  carries off with them, and the blank edges trimmed. The indent is measured over the
 *  lines after the first, because the first shares its line with the opening marker and so
 *  never has one. */
export function prose(comment: string | null | undefined): string | null {
  if (comment === null || comment === undefined) return null;
  const [first = "", ...rest] = comment
    .replace(/^\s*\/\*+/, "")
    .replace(/\*+\/\s*$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\*+|\/\/+)/, "").trimEnd());
  const indents = rest.filter((line) => line !== "").map((line) => /^ */.exec(line)?.[0].length ?? 0);
  const hanging = indents.length === 0 ? 0 : Math.min(...indents);
  const text = [first.trimStart(), ...rest.map((line) => line.slice(hanging))].join("\n").trim();
  return text === "" ? null : text;
}

/** The comment a file opens with, when a comment is the first thing in it. A comment that
 *  follows code is documenting that code, not the module, so it is not this. */
function leadingComment(path: string): string | null {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return null; // Indexed but unreadable now: no claim about itself, which is an answer.
  }
  const found = /^(?:#![^\n]*\n)?\s*(\/\*[\s\S]*?\*\/|(?:[ \t]*\/\/[^\n]*\n?)+)/.exec(source);
  return found?.[1] ?? null;
}
