// @vitest-environment jsdom
/**
 * The place a terminal was scrolled to, kept while the page is away, against
 * the real xterm package (no layout needed for its buffer).
 */
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { rememberViewport, restoreViewport } from "./viewport";

const write = (term: Terminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `line${from + index}\r\n`).join("");
const top = (term: Terminal) => term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true);

async function fullTerminal() {
  const term = new Terminal({ rows: 3, cols: 20, scrollback: 6 });
  // More lines than the scrollback holds: the oldest are already being trimmed.
  await write(term, lines(0, 19));
  return term;
}

describe("the place a terminal was scrolled to", () => {
  it("still shows the same text after more output trims the scrollback while the page is away", async () => {
    const term = await fullTerminal();
    term.scrollToLine(4);
    const seen = top(term);
    const place = rememberViewport(term);
    await write(term, lines(20, 21));
    // A saved row number now points two lines further on.
    expect(term.buffer.active.getLine(4)?.translateToString(true)).not.toBe(seen);
    restoreViewport(term, place);
    expect(top(term)).toBe(seen);
    term.dispose();
  });

  it("goes to the oldest line left when the text it showed was trimmed away", async () => {
    const term = await fullTerminal();
    term.scrollToLine(1);
    const place = rememberViewport(term);
    await write(term, lines(20, 25));
    restoreViewport(term, place);
    expect(term.buffer.active.viewportY).toBe(0);
    term.dispose();
  });

  it("follows the output when it was at the bottom", async () => {
    const term = await fullTerminal();
    const place = rememberViewport(term);
    expect(place).toBeNull();
    await write(term, lines(20, 21));
    term.scrollToLine(0);
    restoreViewport(term, place);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
    term.dispose();
  });
});
