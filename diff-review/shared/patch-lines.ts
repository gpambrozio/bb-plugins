/**
 * The lines a unified patch shows, by side and line number. Comments can only be made on lines the
 * diff shows, so this is all the Review tab needs to snapshot a thread's anchor and to find it again
 * after the code moves (`anchors.ts`).
 */
import type { Side } from "./types";

export interface PatchLines {
  old: ReadonlyMap<number, string>;
  new: ReadonlyMap<number, string>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reads every hunk of `patch` (one file's patch, or several: the line numbers of a later file would
 * overwrite an earlier one's, so pass one). A hunk ends when both of its header's counts are used up,
 * so a removed line that itself starts with `--` is not taken for a header.
 */
export function parsePatchLines(patch: string): PatchLines {
  const oldLines = new Map<number, string>();
  const newLines = new Map<number, string>();
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || (marker === undefined && line === "")) {
        oldLines.set(oldLine++, text);
        newLines.set(newLine++, text);
        oldLeft--;
        newLeft--;
        continue;
      }
      if (marker === "-") {
        oldLines.set(oldLine++, text);
        oldLeft--;
        continue;
      }
      if (marker === "+") {
        newLines.set(newLine++, text);
        newLeft--;
        continue;
      }
      if (marker === "\\") continue; // "\ No newline at end of file"
      // Anything else means the counts were off; stop reading this hunk.
      oldLeft = 0;
      newLeft = 0;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    oldLine = Number(header[1]);
    oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    newLine = Number(header[3]);
    newLeft = header[4] === undefined ? 1 : Number(header[4]);
  }
  return { old: oldLines, new: newLines };
}

/** The text of lines `start`..`end` on `side`, joined with newlines; null if any of them is not shown. */
export function linesText(lines: PatchLines, side: Side, start: number, end: number): string | null {
  const map = side === "old" ? lines.old : lines.new;
  const parts: string[] = [];
  for (let line = start; line <= end; line++) {
    const text = map.get(line);
    if (text === undefined) return null;
    parts.push(text);
  }
  return parts.join("\n");
}
