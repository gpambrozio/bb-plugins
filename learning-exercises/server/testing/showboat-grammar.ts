/**
 * Test-only port of showboat's block rules, so the exporter is checked against the grammar that
 * `showboat verify` reads rather than against itself.
 *
 * Source: https://github.com/simonw/showboat, `markdown/parser.go` (`Parse`), Apache-2.0.
 * Ported: a fenced block opens with a line starting with three or more backticks and closes at the
 * first line that is exactly that many backticks; the info string `output` makes an output block, any
 * other info string a code block (its language); a line starting with `![` that holds `](…)` with a
 * non-empty target (`parseImageRef`) is an image output block, whatever follows it on the line;
 * everything else, outside fences, is commentary. The timestamp header is not ported: this plugin never
 * writes one as showboat does. One deliberate difference: an output block's content has no trailing
 * newline, so it compares equal to the text that was captured.
 */
export type ShowboatBlock =
  | { type: "commentary" }
  | { type: "code"; lang: string; code: string }
  | { type: "output"; content: string }
  | { type: "image"; filename: string };

/** showboat's `parseImageRef`: the target of the first `![alt](target)` on the line, or "" for none. */
function imageTarget(line: string): string {
  const start = line.indexOf("![");
  if (start === -1) return "";
  const rest = line.slice(start + 2);
  const close = rest.indexOf("](");
  if (close === -1) return "";
  const after = rest.slice(close + 2);
  const paren = after.indexOf(")");
  return paren === -1 ? "" : after.slice(0, paren);
}

const isImageLine = (line: string) => line.startsWith("![") && imageTarget(line) !== "";

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
    if (isImageLine(line)) {
      blocks.push({ type: "image", filename: imageTarget(line) });
      i++;
      continue;
    }
    // Commentary: runs until the next fence or image line.
    const text: string[] = [];
    while (i < lines.length && !lines[i].startsWith("```") && !isImageLine(lines[i])) {
      text.push(lines[i]);
      i++;
    }
    while (text.length > 0 && text[text.length - 1] === "") text.pop();
    if (text.length > 0) blocks.push({ type: "commentary" });
  }
  return blocks;
}
