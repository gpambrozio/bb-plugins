/** Wording the server, the CLI and the app share. No SDK import. */
import type { Changes, DanglingLinkInfo } from "./types";

/** "Updated 2, added 1 memory files", or with `conditional` "update 2, add 1 memory files". */
export function changeText(changes: Changes, conditional = false): string {
  const parts: string[] = [];
  if (changes.changed.length > 0) parts.push(`${conditional ? "update" : "updated"} ${changes.changed.length}`);
  if (changes.added.length > 0) parts.push(`${conditional ? "add" : "added"} ${changes.added.length}`);
  if (changes.deleted.length > 0) parts.push(`${conditional ? "remove" : "removed"} ${changes.deleted.length}`);
  const total = changes.changed.length + changes.added.length + changes.deleted.length;
  if (parts.length === 0) return "No memory files changed";
  const text = `${parts.join(", ")} memory ${total === 1 ? "file" : "files"}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "2 links point at memory files that are gone", or null for none. */
export function linksText(links: readonly DanglingLinkInfo[] | undefined): string | null {
  if (links === undefined || links.length === 0) return null;
  return `${links.length} ${links.length === 1 ? "link points" : "links point"} at memory files that are gone`;
}

export function totalChanges(changes: Changes | null): number {
  return changes === null ? 0 : changes.added.length + changes.changed.length + changes.deleted.length;
}

/** A local date and time as "2026-11-17 01:05". */
export function when(ms: number | null): string {
  if (ms === null) return "never";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
