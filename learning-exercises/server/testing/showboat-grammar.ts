/**
 * Test-only port of showboat's block rules, so the exporter is checked against the grammar that
 * `showboat verify` reads rather than against itself.
 *
 * Source: https://github.com/simonw/showboat, `markdown/parser.go` (`Parse`), Apache-2.0.
 * Ported: a fenced block opens with a line starting with three or more backticks and closes at the
 * first line that is exactly that many backticks; the info string `output` makes an output block, any
 * other info string a code block (its language); everything else, outside fences, is commentary. The
 * title/timestamp header and image lines are not ported: this plugin never writes them as blocks.
 * One deliberate difference: an output block's content has no trailing newline, so it compares equal
 * to the text that was captured.
 */
export type ShowboatBlock =
  | { type: "commentary" }
  | { type: "code"; lang: string; code: string }
  | { type: "output"; content: string };

export function parseShowboat(markdown: string): ShowboatBlock[] {
  const lines = markdown.split("\n");
  const blocks: ShowboatBlock[] = [];
  let i = 0;
  let sawHeading = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!sawHeading && blocks.length === 0 && line.startsWith("# ")) {
      // Title line: showboat reads it as the title block, not as commentary.
      sawHeading = true;
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      let ticks = 0;
      while (line[ticks] === "`") ticks++;
      const closing = "`".repeat(ticks);
      const info = line.slice(ticks);
      i++;
      const body: string[] = [];
      while (i < lines.length && lines[i] !== closing) {
        body.push(lines[i]);
        i++;
      }
      i++; // past the closing fence
      blocks.push(info === "output" ? { type: "output", content: body.join("\n") } : { type: "code", lang: info, code: body.join("\n") });
      continue;
    }
    // Commentary: runs until the next fence.
    const text: string[] = [];
    while (i < lines.length && !lines[i].startsWith("```")) {
      text.push(lines[i]);
      i++;
    }
    while (text.length > 0 && text[text.length - 1] === "") text.pop();
    if (text.length > 0) blocks.push({ type: "commentary" });
  }
  return blocks;
}
