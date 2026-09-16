import ts from "typescript";

/** What a module exports, named the way a reader of the source would name it. `variable`
 *  covers every `export const/let/var`, including one whose initialiser is a function —
 *  the declaration is what is read, not the value's shape. */
export type ExportKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "namespace"
  | "unknown";

/** One exported symbol of a module. `name` is the name the importer writes; a default
 *  export is called `default`. */
export interface ExportedSymbol {
  readonly name: string;
  readonly kind: ExportKind;
}

/** The flag that decides a symbol's kind, in the order the flags are tried. A symbol can
 *  carry several (`interface` merged with a `const` of the same name); the first match
 *  wins, so the declaration a reader names the symbol by is the one reported. */
const KINDS: ReadonlyArray<readonly [ts.SymbolFlags, ExportKind]> = [
  [ts.SymbolFlags.Class, "class"],
  [ts.SymbolFlags.Function, "function"],
  [ts.SymbolFlags.Enum | ts.SymbolFlags.ConstEnum, "enum"],
  [ts.SymbolFlags.Interface, "interface"],
  [ts.SymbolFlags.TypeAlias, "type"],
  [ts.SymbolFlags.Variable, "variable"],
  [ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule, "namespace"],
];

const kindOf = (flags: ts.SymbolFlags): ExportKind => {
  for (const [flag, kind] of KINDS) if (flags & flag) return kind;
  return "unknown";
};

/** Reads `file` with the TypeScript compiler and answers what it exports, sorted by name.
 *
 *  JavaScript is read the same way TypeScript is: `.js`, `.mjs`, `.cjs` and their `x`
 *  variants go through the same compiler, so a JavaScript module's exports are named by
 *  the same rules. A kind a reader can only tell from a type annotation — `interface`,
 *  `type` — simply does not arise there.
 *
 *  The compiler is what does the reading, so the forms that are hard to see by hand are
 *  covered: `export { a as b }`, `export default`, and `export * from "./other"` — a
 *  re-export is reported under the name this module exports it by, with the kind of the
 *  declaration it ultimately points at.
 *
 *  A file the compiler cannot parse is refused by throwing. Its recovered exports are a
 *  guess at what the author meant, and a guess reported as a reading is worse than no
 *  reading: the caller cannot tell the two apart. A file that does not exist has no
 *  exports, which is not the same thing — nothing was misread. */
export function readExports(file: string): ExportedSymbol[] {
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    noResolve: false,
    noEmit: true,
    skipLibCheck: true,
  });
  const source = program.getSourceFile(file);
  if (!source) return [];
  refuseIfUnparsed(program, source);

  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(source);
  if (!module) return []; // Not a module: no import, no export, so nothing is exported.

  return checker
    .getExportsOfModule(module)
    .map((symbol) => ({ name: symbol.getName(), kind: kindOf(flagsOf(checker, symbol)) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Throws when the compiler hit a syntax error in `source`, quoting the first one with the
 *  line it is on. Only syntax is grounds for refusal: a type error means the file was read,
 *  and what it exports is still plain. */
function refuseIfUnparsed(program: ts.Program, source: ts.SourceFile): void {
  const [first] = program.getSyntacticDiagnostics(source);
  if (!first) return;
  const line =
    first.start === undefined
      ? "?"
      : String(source.getLineAndCharacterOfPosition(first.start).line + 1);
  const what = ts.flattenDiagnosticMessageText(first.messageText, " ");
  throw new Error(`cannot read ${source.fileName}: it does not parse — line ${line}: ${what}`);
}

/** An `export { x }` or a re-export is an alias, whose own flags say only `Alias`. The
 *  kind a reader wants is the target's, so the alias is followed. */
function flagsOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.SymbolFlags {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol.flags;
  try {
    return checker.getAliasedSymbol(symbol).flags;
  } catch {
    return symbol.flags; // The target is unresolvable — a missing file, say.
  }
}
