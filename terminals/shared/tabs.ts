/**
 * The tabs the Terminals page shows, and what the server pushes when they
 * change. No SDK import, so the app can use these at run time.
 *
 * A tab is one bb terminal session (`bb.sdk.terminals`) opened in the home
 * directory of one machine. The tab list belongs to the user's bb, not to a
 * window: every client shows the same tabs and drives the same shells.
 */
import { z } from "zod";

/** Published, with no payload, whenever a tab is opened or closed. */
export const TABS_CHANGED = "tabs-changed";

/** At most this many tabs at once, so a stuck "+" cannot fill a machine with shells. */
export const MAX_TABS = 24;

/** What the server stores for a tab. The terminal id is the tab's id. */
export const TabSchema = z.object({
  terminalId: z.string().min(1),
  hostId: z.string().min(1),
  /** The machine's name when the tab was opened, so a tab on a removed machine still reads. */
  hostName: z.string(),
  createdAt: z.number(),
});

export type Tab = z.infer<typeof TabSchema>;

/**
 * Where the tab's shell is: `running` (or `starting`) on its machine;
 * `disconnected` while the machine is offline, which bb resumes when it comes
 * back; `ended` once the shell has exited or bb has closed the session.
 */
export const TabStatusSchema = z.enum(["starting", "running", "disconnected", "ended"]);

export type TabStatus = z.infer<typeof TabStatusSchema>;

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
 * Each tab's label: its machine's name, numbered in opening order when the
 * machine has more than one tab ("Mac mini", or "Mac mini 1", "Mac mini 2").
 */
export function tabLabels(tabs: readonly Pick<Tab, "terminalId" | "hostId" | "hostName">[]): Map<string, string> {
  const perHost = new Map<string, number>();
  for (const tab of tabs) perHost.set(tab.hostId, (perHost.get(tab.hostId) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const tab of tabs) {
    const index = (seen.get(tab.hostId) ?? 0) + 1;
    seen.set(tab.hostId, index);
    const name = tab.hostName.trim() === "" ? "Terminal" : tab.hostName;
    labels.set(tab.terminalId, (perHost.get(tab.hostId) ?? 0) > 1 ? `${name} ${index}` : name);
  }
  return labels;
}
