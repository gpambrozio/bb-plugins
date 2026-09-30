/**
 * What the captain sees of a watch message. The first mate still reads the whole message; the chat shows
 * one line naming the watches, and a chip to the whole message, saved as a file in the home's
 * `.firstmate/watch-notes/` — the newest `KEPT_NOTES` of them.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { QueuedNote } from "./watches";

export const KEPT_NOTES = 50;

/** A saved note's file name: its time in UTC, a counter when two land in one second. */
const NOTE_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?\.md$/;

/** The line the captain sees for a batch: how many notes, from which watches, and how many were dropped. */
export function watchNoteLine(notes: readonly Pick<QueuedNote, "name" | "kind">[], dropped: number): string {
  if (notes.length === 0) return `${dropped} older watch ${dropped === 1 ? "note" : "notes"} dropped`;
  const names = [...new Set(notes.map((note) => note.name))].map((name) =>
    notes.some((note) => note.name === name && note.kind === "failed") ? `${name} (failed)` : name,
  );
  const head = notes.length === 1 ? "Watch note" : `${notes.length} watch notes`;
  const tail = dropped > 0 ? ` · ${dropped} older dropped` : "";
  return `${head} from ${names.join(", ")}${tail}`;
}

/** Saves the whole message in `directory`, prunes the oldest beyond `KEPT_NOTES`, and returns its file name. */
export async function saveWatchNote(directory: string, text: string, at: Date): Promise<string> {
  await mkdir(directory, { recursive: true });
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  let name = "";
  for (let copy = 1; name === ""; copy += 1) {
    const candidate = copy === 1 ? `${stamp}.md` : `${stamp}-${copy}.md`;
    try {
      await writeFile(join(directory, candidate), text, { flag: "wx" });
      name = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  await prune(directory);
  return name;
}

async function prune(directory: string): Promise<void> {
  // The names sort by time to the second; notes within one second may prune in either order.
  const notes = (await readdir(directory)).filter((file) => NOTE_FILE.test(file)).sort();
  const excess = notes.slice(0, Math.max(0, notes.length - KEPT_NOTES));
  await Promise.all(excess.map((file) => rm(join(directory, file), { force: true })));
}
