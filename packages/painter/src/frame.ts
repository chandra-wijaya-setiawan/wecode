/** The chrome a session's artefact is served inside.
 *
 *  The artefact is the author's page and stays the author's page: framing adds a script
 *  and a meta tag and changes not one byte of the body. That is what keeps an exported
 *  copy identical to the reviewed one — open the file with no painter running and it
 *  renders the same, because the painter only ever appended. */
import type { Session } from "./session.js";

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What the page needs to know about itself, as data rather than as interpolated script:
 *  a browser reads it from the meta tag, and a test reads it without running any. */
export const marks = (session: Session): string =>
  `<meta name="painter-session" content="${escape(session.id)}" data-revision="${session.revision}">`;

/** The one script the painter injects. It queues a prompt back to the session the page
 *  came from, and reloads the page when the revision it was served under has moved on —
 *  the browser is told to redraw by the artefact changing, never by a clock. */
const client = (session: Session): string => `<script>
(() => {
  const id = ${JSON.stringify(session.id)};
  let revision = ${JSON.stringify(session.revision)};
  window.painter = {
    send: (text, tag) =>
      fetch("/session/" + id + "/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tag === undefined ? { text } : { text, tag }),
      }),
    end: () => fetch("/session/" + id + "/end", { method: "POST" }),
  };
  const watch = async () => {
    const at = await fetch("/session/" + id + "/revision").then((r) => r.json());
    if (at.revision !== revision) location.reload();
    if (at.status === "open") setTimeout(watch, 1000);
  };
  watch();
})();
</script>`;

/** Where the chrome goes. Before `</body>` when the artefact has one, so the script runs
 *  after the page it talks about exists; appended otherwise, because an artefact is not
 *  obliged to be a whole document. */
export function frame(session: Session): string {
  const chrome = `${marks(session)}\n${client(session)}\n`;
  const close = session.body.lastIndexOf("</body>");
  if (close === -1) return `${session.body}\n${chrome}`;
  return `${session.body.slice(0, close)}${chrome}${session.body.slice(close)}`;
}
