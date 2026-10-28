import { joinLines, splitLines } from "./suggestion";

/**
 * Reverting hunks of an uncommitted change in the working copy, as `git apply -R` would, from the
 * file's patch alone: each hunk's new-side lines must still read as the patch says at its place, and
 * are put back to its old-side lines. Done from the last hunk up, so earlier line numbers hold.
 */

export interface PatchHunk {
  header: string;
  oldStart: number;
  newStart: number;
  /** The hunk's lines on each side: unchanged and removed on the old, unchanged and added on the new. */
  oldLines: string[];
  newLines: string[];
  /** Whether that side's last line has no newline after it ("\ No newline at end of file"). */
  oldNoNewline: boolean;
  newNoNewline: boolean;
  /** Whether the hunk has every line its header counts (a patch cut short has not). */
  complete: boolean;
  /** Its lines in order: unchanged (" "), removed ("-") and added ("+"). */
  rows: { marker: " " | "-" | "+"; text: string }[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let lastSide: "old" | "new" | "both" | null = null;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (hunk !== null && line.startsWith("\\")) {
      if (lastSide === "old" || lastSide === "both") hunk.oldNoNewline = true;
      if (lastSide === "new" || lastSide === "both") hunk.newNoNewline = true;
      continue;
    }
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || (marker === undefined && line === "")) {
        hunk.oldLines.push(text);
        hunk.newLines.push(text);
        hunk.rows.push({ marker: " ", text });
        oldLeft--;
        newLeft--;
        lastSide = "both";
        continue;
      }
      if (marker === "-") {
        hunk.oldLines.push(text);
        hunk.rows.push({ marker: "-", text });
        oldLeft--;
        lastSide = "old";
        continue;
      }
      if (marker === "+") {
        hunk.newLines.push(text);
        hunk.rows.push({ marker: "+", text });
        newLeft--;
        lastSide = "new";
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    if (hunk !== null) hunk.complete = oldLeft === 0 && newLeft === 0;
    hunk = { header: line, oldStart: Number(header[1]), newStart: Number(header[3]), oldLines: [], newLines: [], oldNoNewline: false, newNoNewline: false, complete: false, rows: [] };
    oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    newLeft = header[4] === undefined ? 1 : Number(header[4]);
    lastSide = null;
    hunks.push(hunk);
  }
  if (hunk !== null) hunk.complete = oldLeft === 0 && newLeft === 0;
  return hunks;
}

/**
 * `content` with the hunks at `indexes` of `patch` reverted, or null when one no longer matches the
 * file (it changed since the view was loaded) or an index is not a hunk.
 */
export function revertHunks(content: string, patch: string, indexes: readonly number[]): string | null {
  const hunks = parseHunks(patch);
  const lines = splitLines(content);
  const usual = lines.find((line) => line.eol !== "")?.eol ?? "\n";
  const chosen = [...new Set(indexes)].sort((a, b) => b - a);
  for (const index of chosen) {
    const hunk = hunks[index];
    if (hunk === undefined || !hunk.complete) return null;
    // A hunk adding to an empty file starts at 0; so does one that only adds, with no context
    // (`+N,0` means after line N).
    const at = hunk.newLines.length === 0 ? hunk.newStart : Math.max(hunk.newStart, 1) - 1;
    const current = lines.slice(at, at + hunk.newLines.length);
    if (current.length !== hunk.newLines.length || current.some((line, offset) => line.text !== hunk.newLines[offset])) return null;
    const reachesEnd = at + hunk.newLines.length === lines.length;
    // Unchanged lines keep their own ending; a removed line put back takes the ending of the line it
    // stands next to.
    const restored: { text: string; eol: string }[] = [];
    let next = 0;
    for (const row of hunk.rows) {
      if (row.marker === " ") restored.push(current[next++]!);
      else if (row.marker === "+") next++;
      else restored.push({ text: row.text, eol: (current[next] ?? current[next - 1])?.eol || restored.at(-1)?.eol || usual });
    }
    // A hunk that reaches the end of the file also says whether the file ends with a newline.
    if (reachesEnd && restored.length > 0) restored[restored.length - 1] = { ...restored.at(-1)!, eol: hunk.oldNoNewline ? "" : (current.at(-1)?.eol || usual) };
    lines.splice(at, hunk.newLines.length, ...restored);
  }
  return joinLines(lines);
}
