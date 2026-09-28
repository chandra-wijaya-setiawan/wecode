/** Which project the reader is standing in, as one control over the tree rather than three
 *  rungs inside it.
 *
 *  Sketch #7 — "the tree you can read" — settles what this is. Project, release and epic are
 *  where a story *lives* rather than what anybody works on, so indenting all nine rungs put the
 *  one the reader came for two-thirds of the way across the window. They come out of the tree
 *  and go above it: which project is a question asked once, not answered again on every row.
 *  This is the first of the three drawn; release and epic would sit beside it when they are
 *  asked for.
 *
 *  It is the same shape as the `show` filter it sits beside, by the same mechanism: one select
 *  in the one `method=get` form, sent by the one control that already sends it. One form and
 *  not two, because the two narrowings are one reading — a reader who has narrowed to a project
 *  and then asks for the finished work is still in the project they were in, and a second form
 *  beside the first would have to carry the first's answer as a hidden field to say so.
 *
 *  The answers are the record's own projects, by the slug each already carries, and they are
 *  never declared: a list of projects written into a file is a list that is wrong the day a
 *  project is added. What `packages/webapp/config/ui.yaml` decides is the parameter they travel
 *  in, the name the page carries the control under, the word the reader is offered it by, and
 *  the one answer that names no project — which is how a reader gets the rest of the record
 *  back. That answer is always offered, including on a page already narrowed to one project: a
 *  control that cannot be set back is a door that shuts behind the reader.
 *
 *  A file of its own, and not `pages/tree.ts`'s: that file is on its ratchet row exactly, and a
 *  narrowing is a thing in its own right. Not under `pages/` either, because everything there
 *  is a page — `pages/discover.ts` finds them by being a directory — and this is a control on
 *  one. `rail.ts` sits here for the same reason. */
import type { Node } from "@wecode/core";
import { escape } from "./pages/board.js";

export class PickerError extends Error {}

/** One answer the picker offers: the name it is drawn under, what it puts on the query, and the
 *  word the reader is offered. */
export interface Answer {
  readonly id: string;
  readonly value: string;
  readonly says: string;
}

/** The control `tree.project` declares. Everything here is a decision about the surface; the
 *  answers themselves are the record's. */
export interface Picker {
  readonly id: string;
  readonly says: string;
  readonly param: string;
  /** The reading nobody asked for, which is the absent parameter: `/tree` and
   *  `/tree?project=all` are one page, so a narrowed tree is a link a person can send. */
  readonly default: string;
  readonly all: Answer;
}

const mapOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const wordOf = (v: unknown, at: string, path: string): string => {
  if (typeof v !== "string" || v === "") throw new PickerError(`${path}: ${at} says nothing`);
  return v;
};

/** What `ui.yaml` declares this control to be, out of the `tree:` block already parsed. A field
 *  the declaration does not hold is a refusal and never a default, for the reason every other
 *  field of that file is: a word supplied here when the file was silent is a word nobody
 *  signed. */
export function pickerOf(tree: Record<string, unknown>, path: string): Picker {
  const said = mapOf(tree["project"]);
  const all = mapOf(said["all"]);
  return {
    id: wordOf(said["id"], "tree.project.id", path),
    says: wordOf(said["says"], "tree.project.says", path),
    param: wordOf(said["param"], "tree.project.param", path),
    default: wordOf(said["default"], "tree.project.default", path),
    all: {
      id: wordOf(all["id"], "tree.project.all.id", path),
      value: wordOf(all["value"], "tree.project.all.value", path),
      says: wordOf(all["says"], "tree.project.all.says", path),
    },
  };
}

/** The record's own projects, by the slug each carries, in the order the record holds them. The
 *  roots of the record are the projects; nothing below one is another. */
export const slugsOf = (nodes: readonly Node[]): readonly string[] =>
  nodes.filter((n) => n.entity === "project").map((n) => n.label);

/** The project the query is holding. A slug the record does not have is not an answer, and
 *  neither is an absent one: both are the reading nobody asked for, which is what makes `/tree`
 *  and the all answer's own link the same page. */
export const standingIn = (url: URL, picker: Picker, slugs: readonly string[]): string => {
  const said = url.searchParams.get(picker.param);
  return said !== null && slugs.includes(said) ? said : picker.all.value;
};

/** The record as the query asks for it: one project, whole, or every one of them. A slug is
 *  matched whole — `wecode` is not `wecode-web` — because a project is picked by its own name
 *  and not by what its name begins with. */
export function narrowedToProject(
  nodes: readonly Node[], url: URL, picker: Picker, slugs: readonly string[] = slugsOf(nodes),
): readonly Node[] {
  const one = standingIn(url, picker, slugs);
  return one === picker.all.value ? nodes
    : nodes.filter((n) => n.entity === "project" && n.label === one);
}

/** The picker, drawn: the word the declaration gives it, and one select holding the answer that
 *  names no project followed by the record's own. The held one is `selected`, so the page says
 *  which project it is narrowed to without being opened, and the declared name is on the label
 *  — the control and what holds it are one thing to a reader, and the label is what names it.
 *
 *  The answers the record supplies are named after the control they are answers to, so a page
 *  can be checked against the declaration by name; the one the *file* supplies keeps the name
 *  the file gives it. */
export function pickerRow(url: URL, picker: Picker, slugs: readonly string[]): string {
  const on = standingIn(url, picker, slugs);
  const answer = (value: string, says: string, id: string): string =>
    `<option value="${escape(value)}" data-ui="${escape(id)}"` +
    `${value === on ? " selected" : ""}>${escape(says)}</option>`;
  const drawn = [
    answer(picker.all.value, picker.all.says, picker.all.id),
    ...slugs.map((slug) => answer(slug, slug, `${picker.id}.${slug}`)),
  ].join("");
  return (
    `<label data-ui="${escape(picker.id)}">${escape(picker.says)}` +
    `<select name="${escape(picker.param)}">${drawn}</select></label>`
  );
}
