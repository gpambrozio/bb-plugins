/**
 * The first mate's tasks by state, from firstmate-crew's own board.
 *
 * firstmate-crew already parses its home's `data/backlog.md` and `data/suggestions.md`, finds its first
 * mate, and reads each crewmate's last status line; its `fleet.load` RPC answers all of it at once, and
 * reads nothing it writes. So this module only groups the cards that RPC returns. The schema below is a
 * copy of the fields read here from `firstmate-crew/shared/types.ts` (`FleetSchema`); zod drops the rest.
 */
import { z } from "zod";

import type { FirstMateBrief, TaskLine } from "./model";
import { brief, cleanTitle } from "./text";

export const FIRSTMATE_PLUGIN_ID = "firstmate-crew";
export const FLEET_METHOD = "fleet.load";

export const FleetSchema = z.object({
  mate: z.object({ threadId: z.string() }).nullable(),
  cards: z.array(
    z.object({
      column: z.string(),
      title: z.string(),
      kind: z.string().nullable(),
      backlog: z
        .object({
          // A string, not firstmate-crew's enum: a section it adds later is briefed as queued, not a failed read.
          section: z.string(),
          hold: z.string().nullable(),
          blockedBy: z.string().nullable(),
          kind: z.string().nullable(),
        })
        .nullable(),
      crew: z
        .object({
          threadId: z.string(),
          status: z.string(),
          pendingInteractions: z.number(),
        })
        .nullable(),
      report: z.object({ state: z.string(), text: z.string() }).nullable(),
    }),
  ),
  suggestions: z.array(z.object({ label: z.string(), prompt: z.string() })),
});
export type FleetData = z.infer<typeof FleetSchema>;
type Card = FleetData["cards"][number];

type Bucket = "needsOwner" | "blocked" | "inFlight" | "queued" | "done";

/** Where one card goes, and the few words that say why when the bucket alone does not. */
export function bucketOf(card: Card): { bucket: Bucket; detail: string | null } {
  const item = card.backlog;
  if (item?.section === "done") return { bucket: "done", detail: null };
  if (item?.hold != null) return { bucket: "needsOwner", detail: brief(item.hold, 1, 160) };
  if ((item?.kind ?? card.kind) === "captain") return { bucket: "needsOwner", detail: null };
  if (item?.blockedBy != null) return { bucket: "blocked", detail: "waits on another task" };
  if (card.crew !== null) {
    if (card.crew.pendingInteractions > 0) return { bucket: "blocked", detail: "worker is waiting for an answer" };
    if (card.report?.state === "needs-decision") return { bucket: "blocked", detail: "worker needs a decision" };
    if (card.report?.state === "blocked") return { bucket: "blocked", detail: "worker is blocked" };
    if (card.column === "failed") return { bucket: "blocked", detail: "worker failed" };
    return { bucket: "inFlight", detail: null };
  }
  if (item?.section === "in-flight") return { bucket: "inFlight", detail: null };
  return { bucket: "queued", detail: null };
}

/** The board grouped for the briefing. Done keeps the backlog's order, newest first. */
export function groupFleet(fleet: FleetData): FirstMateBrief | null {
  if (fleet.mate === null) return null;
  const out: FirstMateBrief = {
    threadId: fleet.mate.threadId,
    needsOwner: [],
    blocked: [],
    inFlight: [],
    queued: [],
    done: [],
    suggestions: fleet.suggestions.map((suggestion) => cleanTitle(suggestion.label)),
  };
  for (const card of fleet.cards) {
    const { bucket, detail } = bucketOf(card);
    const line: TaskLine = { title: cleanTitle(card.title), detail };
    out[bucket].push(line);
  }
  return out;
}
