/**
 * The tabs the Terminals page shows, and what the server pushes when they
 * change. No SDK import, so the app can use these at run time.
 *
 * A tab is one bb terminal session (`bb.sdk.terminals`) opened in the home
 * directory of one machine. The tab list belongs to the user's bb, not to a
 * window: every client shows the same tabs and drives the same shells.
 */
import { z } from "zod";

/** Published, with no payload, whenever a tab is opened, renamed, moved or closed. */
export const TABS_CHANGED = "tabs-changed";

/** At most this many tabs at once, so a stuck "+" cannot fill a machine with shells. */
export const MAX_TABS = 24;

/** The longest name a tab takes. */
export const MAX_TAB_NAME = 80;

/**
 * A name the user typed, as stored: trimmed, at most `MAX_TAB_NAME`
 * characters, and null when empty — an empty name means the default title.
 */
export function normalizeTabName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed === "" ? null : [...trimmed].slice(0, MAX_TAB_NAME).join("");
}

/** What the server stores for a tab. The terminal id is the tab's id. */
export const TabSchema = z.object({
  terminalId: z.string().min(1),
  hostId: z.string().min(1),
  /** The machine's name when the tab was opened, so a tab on a removed machine still reads. */
  hostName: z.string(),
  createdAt: z.number(),
  /** The name the user gave the tab, or null for the default title. Tabs saved before names had none. */
  name: z.string().min(1).max(MAX_TAB_NAME).nullable().default(null),
});

export type Tab = z.infer<typeof TabSchema>;

/**
 * A tab closed while bb had not made its shell yet. The shell may still be on
 * its way, so the server keeps this until bb has it (then ends it) or it is
 * past `OPENING_GRACE_MS` (bb never made it) — across reloads.
 */
export const ClosingSchema = z.object({
  terminalId: z.string().min(1),
  /** When its tab was opened, which starts the grace. */
  createdAt: z.number(),
});

export type Closing = z.infer<typeof ClosingSchema>;

/**
 * Where the tab's shell is: `opening` while bb has not made it yet (the tab is
 * stored first, see server/service.ts); `running` (or `starting`) on its
 * machine; `disconnected` while the machine is offline, which bb resumes when
 * it comes back; `ended` once the shell has exited or bb has closed the session.
 */
export const TabStatusSchema = z.enum(["opening", "starting", "running", "disconnected", "ended"]);

/**
 * How long a stored tab may wait for bb to make its shell before it counts as
 * ended. bb gives up on opening a terminal after 10 s; this leaves room for a
 * slow machine on top.
 */
export const OPENING_GRACE_MS = 60_000;

export type TabStatus = z.infer<typeof TabStatusSchema>;

/**
 * Whether the tab's shell is not ready to attach to: bb has no session yet
 * (`opening`), or has one it is still starting on the machine (`starting`,
 * which bb answers an attach to with "not running").
 */
export function isPending(status: TabStatus): boolean {
  return status === "opening" || status === "starting";
}

export const TabViewSchema = TabSchema.extend({
  status: TabStatusSchema,
  /** The shell's exit code, once it has one. */
  exitCode: z.number().int().nullable(),
});

export type TabView = z.infer<typeof TabViewSchema>;

export const HostChoiceSchema = z.object({ id: z.string(), name: z.string() });

export type HostChoice = z.infer<typeof HostChoiceSchema>;

/** The status a tab shows for a bb terminal session's status. */
export function tabStatus(session: { status: "starting" | "running" | "disconnected" | "exited" } | null): TabStatus {
  if (session === null || session.status === "exited") return "ended";
  return session.status;
}

/**
 * Each tab's label: the name the user gave it, else its default title — its
 * machine's name, numbered in opening order when the machine has more than
 * one tab ("Mac mini", or "Mac mini 1", "Mac mini 2"). The number follows
 * when the tab was opened, not where it sits in the strip, so a tab dragged
 * elsewhere keeps it ("Mac mini 2" may sit before "Mac mini 1"). A renamed
 * tab keeps its number too, so clearing its name brings back the title it had.
 */
export function tabLabels(
  tabs: readonly (Pick<Tab, "terminalId" | "hostId" | "hostName" | "createdAt"> & { name?: string | null })[],
): Map<string, string> {
  const perHost = new Map<string, number>();
  for (const tab of tabs) perHost.set(tab.hostId, (perHost.get(tab.hostId) ?? 0) + 1);
  // Opening order: the server's clock, then the id for two tabs opened in the same millisecond, so
  // every client numbers alike whatever order the strip shows.
  const opened = [...tabs].sort(
    (a, b) => a.createdAt - b.createdAt || (a.terminalId < b.terminalId ? -1 : a.terminalId > b.terminalId ? 1 : 0),
  );
  const seen = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const tab of opened) {
    const index = (seen.get(tab.hostId) ?? 0) + 1;
    seen.set(tab.hostId, index);
    numbers.set(tab.terminalId, index);
  }
  const labels = new Map<string, string>();
  for (const tab of tabs) {
    const name = tab.hostName.trim() === "" ? "Terminal" : tab.hostName;
    const fallback = (perHost.get(tab.hostId) ?? 0) > 1 ? `${name} ${numbers.get(tab.terminalId)}` : name;
    labels.set(tab.terminalId, tab.name ?? fallback);
  }
  return labels;
}

/**
 * The list with the tab `terminalId` moved to where `toTerminalId` is, as a
 * drag in the strip drops it: after that tab when moving right, before it
 * when moving left. The list unchanged (the same array) when either tab is
 * not in it or they are the same tab.
 */
export function moveTab<T extends { terminalId: string }>(tabs: readonly T[], terminalId: string, toTerminalId: string): readonly T[] {
  const from = tabs.findIndex((tab) => tab.terminalId === terminalId);
  const to = tabs.findIndex((tab) => tab.terminalId === toTerminalId);
  if (from === -1 || to === -1 || from === to) return tabs;
  const moved = [...tabs];
  const [tab] = moved.splice(from, 1);
  moved.splice(to, 0, tab!);
  return moved;
}
