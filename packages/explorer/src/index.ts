/** wecode:repo-explorer — the questions wecode asks about a repository, and nothing else.
 *
 *  A client gets the port and one way to open the index behind it. Which index that is —
 *  codegraph today — is not part of the surface, so swapping it is not a change any caller
 *  sees. */
export {
  UnknownFile,
  UnknownSymbol,
  type Definition,
  type Imported,
  type Purpose,
  type Reading,
  type RepoIndex,
  type SymbolKind,
  type Use,
} from "./ports.js";
export { openCodegraph } from "./adapters/codegraph.js";
export {
  ArchitectureError,
  loadArchitecture,
  nodeAt,
  nodes,
  unclaimed,
  type ArchNode,
  type Architecture,
  type NodeKind,
} from "./architecture.js";
