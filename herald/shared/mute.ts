/**
 * Herald's global mute: nothing is spoken on any device while it is on. It is
 * the master switch of the host-rendered form, *Speak announcements*, read the
 * other way round — muted means that switch is off — so the form, the CLI
 * (`bb herald mute`) and the Herald page all show and change one value.
 *
 * Both halves read this module, so it imports nothing from the SDK.
 */
import { z } from "zod";

/**
 * The server publishes here whenever the switch changes, whoever changed it,
 * with the new state, so every window stops speaking at once rather than when
 * its copy of the settings is next read.
 */
export const MUTE_CHANNEL = "mute";

export const MuteStateSchema = z.object({ muted: z.boolean() });
export type MuteState = z.infer<typeof MuteStateSchema>;

/** The muted flag a `MUTE_CHANNEL` payload carries, or null for anything else. */
export function mutedOf(payload: unknown): boolean | null {
  const parsed = MuteStateSchema.safeParse(payload);
  return parsed.success ? parsed.data.muted : null;
}
