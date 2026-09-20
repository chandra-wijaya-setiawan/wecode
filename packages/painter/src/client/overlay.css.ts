/** The painter overlay's stylesheet, and the class names it styles.
 *
 *  The overlay draws itself into a shadow root on top of somebody else's page, so it may
 *  not assume a single rule of that page's CSS and may not leak one back. `:host{all:
 *  initial}` is what buys both: the shadow root starts from nothing, and the tokens below
 *  are declared on it rather than on `:root`, so the page's own palette is neither read
 *  nor overwritten.
 *
 *  The class names live here, in `CLASS`, and not as string literals in overlay.ts. A
 *  name in two files that must agree is the defect this module exists to prevent — the
 *  stylesheet is generated from the same record the markup is built from, so a rename is
 *  one edit and a rule can never be left pointing at a class nobody writes any more.
 *
 *  There is no whiteboard here. Lavish styles an embedded Excalidraw canvas and the
 *  diagram viewport that hosts it; the painter overlay picks, annotates, queues and sends,
 *  so none of those rules are ported. */

/** Every class the overlay writes. The single definition: overlay.ts builds markup from
 *  these and `overlayCss` builds the rules from them. */
export const CLASS = {
  /** The shadow host, and the attribute that marks a node as the overlay's own. */
  root: "painter-root",
  /** The annotation card: heading, field, hint, buttons. */
  card: "painter-card",
  heading: "painter-heading",
  field: "painter-field",
  hint: "painter-hint",
  row: "painter-row",
  /** The queue of things said but not yet sent, one pill each. */
  queue: "painter-queue",
  pill: "painter-pill",
  pillText: "painter-pill-text",
  pillClose: "painter-pill-close",
  /** The strip along the bottom: what the agent said back, and a box to say more. */
  strip: "painter-strip",
  log: "painter-log",
  logLine: "painter-log-line",
  reply: "painter-reply",
  /** Buttons, shared by the card and the strip. */
  send: "painter-send",
  sendAndEnd: "painter-send-end",
  cancel: "painter-cancel",
  /** What marks the thing under the pointer, and the thing being annotated. */
  highlight: "painter-highlight",
} as const;

export type ClassName = (typeof CLASS)[keyof typeof CLASS];

/** The attribute that says "this node is the overlay, not the page". pick.ts refuses to
 *  pick anything wearing it, so the overlay can never annotate itself. */
export const CHROME_ATTRIBUTE = "data-painter";

/** The overlay's palette and metrics, as custom properties on the shadow host.
 *
 *  Declared as data rather than baked into the rules so that the one accent colour the
 *  overlay uses — for the outline on the page, the card's border and the send button — is
 *  set once. The page-side outline in `pickingCss` reads the same value. */
export const TOKENS: Readonly<Record<string, string>> = {
  "--painter-bg": "#11141a",
  "--painter-bg-deep": "#0f1115",
  "--painter-fg": "#f7f3ea",
  "--painter-fg-faint": "#aeb6c6",
  "--painter-border": "#303745",
  "--painter-muted": "#2a2f3a",
  "--painter-accent": "#f4c95d",
  "--painter-accent-hover": "#ffd877",
  "--painter-accent-ink": "#17130a",
  "--painter-radius": "10px",
  "--painter-radius-lg": "14px",
  "--painter-shadow": "0 20px 70px rgba(0,0,0,.35)",
  "--painter-font": 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
};

const tokenBlock = (): string =>
  Object.entries(TOKENS)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");

/** The stylesheet for the shadow root, as one string ready for a `<style>`.
 *
 *  Built from `CLASS` and `TOKENS` rather than written out, so neither can drift from what
 *  the overlay actually draws. */
export function overlayCss(): string {
  return [
    `:host{all:initial;position:fixed;inset:0 auto auto 0;z-index:2147483647;`,
    `color-scheme:dark;${tokenBlock()};font-family:var(--painter-font)}`,
    `*{box-sizing:border-box}`,
    `:focus-visible{outline:2px solid var(--painter-accent);outline-offset:2px}`,
    `button{border:0;border-radius:var(--painter-radius);padding:8px 10px;`,
    `font-family:inherit;font-size:13px;font-weight:700;cursor:pointer}`,
    `button:active{opacity:.85}`,
    `button[disabled]{opacity:.45;cursor:default}`,
    `.${CLASS.send},.${CLASS.sendAndEnd}{background:var(--painter-accent);`,
    `color:var(--painter-accent-ink)}`,
    `.${CLASS.send}:hover:not([disabled]),.${CLASS.sendAndEnd}:hover:not([disabled])`,
    `{background:var(--painter-accent-hover)}`,
    `.${CLASS.cancel}{background:var(--painter-muted);color:var(--painter-fg)}`,

    // The card. Positioned by overlay.ts against the picked node's rectangle, so it only
    // needs its own size and skin here.
    `.${CLASS.card}{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;`,
    `border-radius:var(--painter-radius-lg);background:var(--painter-bg);`,
    `color:var(--painter-fg);border:1px solid var(--painter-accent);`,
    `box-shadow:var(--painter-shadow);font:14px/1.4 var(--painter-font)}`,
    `.${CLASS.heading}{font-weight:700;margin-bottom:6px}`,
    `.${CLASS.field}{width:100%;min-height:86px;resize:vertical;`,
    `border-radius:var(--painter-radius);border:1px solid var(--painter-border);`,
    `background:var(--painter-bg-deep);color:var(--painter-fg);padding:9px;font:inherit}`,
    `.${CLASS.field}::placeholder{color:var(--painter-fg-faint)}`,
    `.${CLASS.hint}{margin-top:6px;font-size:11px;color:var(--painter-fg-faint)}`,
    `.${CLASS.row}{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}`,

    // The queue. Pills wrap rather than scroll: a queue long enough to need a scrollbar is
    // a queue the reviewer has lost track of, and wrapping keeps all of it in view.
    `.${CLASS.queue}{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}`,
    `.${CLASS.pill}{display:inline-flex;align-items:center;gap:6px;max-width:100%;`,
    `padding:4px 6px 4px 9px;border-radius:999px;background:var(--painter-muted);`,
    `color:var(--painter-fg);font-size:12px}`,
    `.${CLASS.pillText}{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.${CLASS.pillClose}{padding:0 4px;background:none;color:var(--painter-fg-faint);`,
    `font-size:14px;line-height:1}`,
    `.${CLASS.pillClose}:hover{color:var(--painter-fg)}`,

    // The reply strip, pinned to the bottom of the viewport.
    `.${CLASS.strip}{position:fixed;left:12px;right:12px;bottom:12px;padding:10px;`,
    `border-radius:var(--painter-radius-lg);background:var(--painter-bg);`,
    `color:var(--painter-fg);border:1px solid var(--painter-border);`,
    `box-shadow:var(--painter-shadow);font:14px/1.4 var(--painter-font)}`,
    `.${CLASS.log}{max-height:30vh;overflow-y:auto;margin-bottom:8px}`,
    `.${CLASS.logLine}{margin:0 0 4px;font-size:13px;color:var(--painter-fg-faint)}`,
    `.${CLASS.reply}{flex:1;min-width:0;border-radius:var(--painter-radius);`,
    `border:1px solid var(--painter-border);background:var(--painter-bg-deep);`,
    `color:var(--painter-fg);padding:9px;font:inherit}`,

    // The mark on the page's own node. Fixed and pointer-transparent so it can sit over
    // the picked element without stealing the next click from it.
    `.${CLASS.highlight}{position:fixed;pointer-events:none;border-radius:2px;`,
    `background:rgba(244,201,93,.18);box-shadow:0 0 0 2px var(--painter-accent)}`,
  ].join("");
}

/** The one rule the overlay puts in the *page's* document rather than its shadow root.
 *
 *  While picking, every cursor is an arrow: a pointer over a link would promise a
 *  navigation that the overlay is about to swallow. Text inputs keep their I-beam because
 *  the reviewer selects prose to annotate it, and the overlay's own chrome keeps its
 *  pointer because its buttons really are pressable. */
export function pickingCss(): string {
  return [
    `*{cursor:default!important}`,
    `[${CHROME_ATTRIBUTE}],[${CHROME_ATTRIBUTE}] *{cursor:auto!important}`,
    `input,textarea,[contenteditable]:not([contenteditable='false'])`,
    `{cursor:text!important}`,
  ].join("");
}
