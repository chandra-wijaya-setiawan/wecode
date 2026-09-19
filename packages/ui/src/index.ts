/** The ports this package defines, and the adapters behind them. A caller reaches for a
 *  port by name and an adapter by name; nothing here re-exports one as the other. */
export { indexLines, type IndexedView, type ViewIndex, type ViewIndexScreen } from "./ports.js";
export { inkViewIndex, inkCapture } from "./adapters/ink.js";
export { check, type CapturedNode, type Finding, type Rule } from "./check.js";
export { wireframe, WireframeError, type Box, type Rect } from "./wireframe.js";
