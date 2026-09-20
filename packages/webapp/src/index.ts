/** What a client of this package may import: the transport, and the pages it serves.
 *  Nothing is decided here and nothing is re-exported under a second name. */
export { addressOf, answer, html, serve, type Page, type Reply, type Routes } from "./server.js";
export { boardAt, boardPage, escape } from "./pages/board.js";
