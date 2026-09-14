/** chalk decides once, the first time it is imported, whether anything it is asked to
 *  colour is going to a terminal. A test that asserts colour carries state has to say so
 *  before ink pulls chalk in, so this module does that and nothing else, and every test
 *  file that looks at colour imports it first. */
process.env["FORCE_COLOR"] = "1";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Everything ansi, gone: what is left is the text a reader sees. */
export const plain = (frame: string): string => frame.replace(ANSI, "");

/** The text of every run a code opens and its partner closes — every cursor row, for
 *  inverse; every row a state has coloured, for a colour. */
function runs(frame: string, on: string, off: string): string[] {
  const out: string[] = [];
  let at = frame.indexOf(on);
  while (at >= 0) {
    const end = frame.indexOf(off, at);
    out.push(plain(frame.slice(at + on.length, end < 0 ? undefined : end)));
    at = frame.indexOf(on, at + 1);
  }
  return out;
}

export const inverted = (frame: string): string[] =>
  runs(frame, `${ESC}[7m`, `${ESC}[27m`);

export const coloured = (frame: string, code: number): string[] =>
  runs(frame, `${ESC}[${code}m`, `${ESC}[39m`);

export const RED = 31;
export const YELLOW = 33;
export const GREEN = 32;
