/**
 * Find across the diff: a plain-text search of every loaded patch's lines, folded files included, in
 * the order the tab shows them. Adapted from diffity's `src/lib/find.ts`
 * (https://github.com/nilbuild/diffity, MIT): case-insensitive unless asked, stopping at a limit.
 */
import { patchRows, type PatchRow } from "../shared/patch-lines";
import type { Side } from "../shared/types";

export const FIND_MATCH_LIMIT = 5_000;

export interface FindMatch {
  path: string;
  side: Side;
  line: number;
  kind: PatchRow["kind"];
  start: number;
  end: number;
}

export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
}

const rowsCache = new WeakMap<object, PatchRow[]>();

function rowsOf(file: { patch: string | null }): PatchRow[] {
  if (file.patch === null) return [];
  let rows = rowsCache.get(file);
  if (rows === undefined) {
    rows = patchRows(file.patch);
    rowsCache.set(file, rows);
  }
  return rows;
}

export function findInFiles(files: readonly { path: string; patch: string | null }[], query: string, caseSensitive: boolean, limit = FIND_MATCH_LIMIT): FindResult {
  const matches: FindMatch[] = [];
  if (query === "") return { matches, truncated: false };
  const needle = caseSensitive ? query : query.toLowerCase();
  for (const file of files) {
    for (const row of rowsOf(file)) {
      const haystack = caseSensitive ? row.text : row.text.toLowerCase();
      // Lowercasing can change a string's length (some Unicode letters); then offsets come from a
      // case-insensitive pattern on the original text instead.
      if (!caseSensitive && haystack.length !== row.text.length) {
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
        for (const found of row.text.matchAll(pattern)) {
          matches.push({ path: file.path, side: row.side, line: row.line, kind: row.kind, start: found.index, end: found.index + found[0].length });
          if (matches.length >= limit) return { matches, truncated: true };
        }
        continue;
      }
      let from = haystack.indexOf(needle);
      while (from >= 0) {
        matches.push({ path: file.path, side: row.side, line: row.line, kind: row.kind, start: from, end: from + needle.length });
        if (matches.length >= limit) return { matches, truncated: true };
        from = haystack.indexOf(needle, from + needle.length);
      }
    }
  }
  return { matches, truncated: false };
}

/** Where the same match sits in a new result, so a reloaded diff keeps the place; -1 when it is gone. */
export function carryCurrent(previous: FindMatch | null, matches: readonly FindMatch[]): number {
  if (previous === null) return -1;
  return matches.findIndex((match) => match.path === previous.path && match.side === previous.side && match.line === previous.line && match.start === previous.start);
}
