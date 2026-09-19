/** The ports this package defines, and the adapters behind them. A caller reaches for a
 *  port by name and an adapter by name; nothing here re-exports one as the other. */
export { indexLines, type IndexedView, type ViewIndex, type ViewIndexScreen } from "./ports.js";
export { inkViewIndex } from "./adapters/ink.js";
