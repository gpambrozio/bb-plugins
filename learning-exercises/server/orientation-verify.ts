/**
 * Listing verification for an orientation (spec §6.3). Pure: it takes the file's text (or null
 * when it could not be read) and a captured listing and says whether the listing is still
 * current, has moved, has changed, or its file is missing. Line endings are normalised to LF
 * on both sides, so a CRLF checkout compares equal to the LF text that was captured.
 */
import { createHash } from "node:crypto";
import type { ListingState } from "../shared/orientation";

export interface ListingCheck {
  state: ListingState;
  startLine: number | null;
  endLine: number | null;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Split on `\n`, strip a trailing `\r` from each line, and drop the empty element a final newline leaves. */
function toLines(text: string): string[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Lines `start`..`end` (1-based, inclusive) joined with `\n`; null when `end` exceeds the
 * number of lines or the range is empty or inverted. Used for capture and for verification.
 */
export function sliceLines(text: string, start: number, end: number): string | null {
  const lines = toLines(text);
  if (start < 1 || end < start || end > lines.length) return null;
  return lines.slice(start - 1, end).join("\n");
}

export function checkListing(
  fileText: string | null,
  listing: { startLine: number; endLine: number; text: string; sha256: string },
): ListingCheck {
  if (fileText === null) return { state: "missing", startLine: null, endLine: null };
  const same = sliceLines(fileText, listing.startLine, listing.endLine);
  if (same !== null && sha256(same) === listing.sha256) {
    return { state: "current", startLine: listing.startLine, endLine: listing.endLine };
  }
  const lines = toLines(fileText);
  const wanted = toLines(listing.text);
  let best: number | null = null;
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (!wanted.every((line, j) => lines[i + j] === line)) continue;
    const start = i + 1;
    if (best === null || Math.abs(start - listing.startLine) < Math.abs(best - listing.startLine)) best = start;
  }
  if (best === null) return { state: "changed", startLine: null, endLine: null };
  return { state: "moved", startLine: best, endLine: best + wanted.length - 1 };
}
