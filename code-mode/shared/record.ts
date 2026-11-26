// The choice a thread made, stored on the thread as this plugin's metadata. It is written once, when
// the thread's first message is sent (or when bb first starts it), and never changed: a Claude Code
// session started in Code Mode can only resume in Code Mode, and one started without it only without.
import { z } from "zod";

/** The metadata key on the thread. */
export const RECORD_KEY = "codeMode";

export const recordSchema = z.object({
  codeMode: z.enum(["on", "off"]),
  /** Why, in a few words, for the log and the menu's tooltip. */
  reason: z.string(),
  decidedAt: z.number(),
});
export type CodeModeRecord = z.infer<typeof recordSchema>;

/** What the app shows for a thread: its record, or "none" for a thread the plugin never decided. */
export type ThreadState = "on" | "off" | "none";
