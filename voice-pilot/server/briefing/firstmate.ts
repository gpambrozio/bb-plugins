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
import { brief, cleanTitle, clip } from "./text";

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
          /** `merged 2026-11-20`, `done 2026-11-20`: when a done task landed. */
          outcome: z.string().nullable().optional(),
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
    if (card.crew.status === "error" || card.column === "failed") return { bucket: "blocked", detail: "worker failed" };
    // While a turn runs, firstmate-crew still hands back the previous turn's status line; its board files
    // such a crewmate as working, and so does this.
    if (card.crew.status !== "idle") return { bucket: "inFlight", detail: null };
    if (card.report?.state === "needs-decision") return { bucket: "blocked", detail: "worker needs a decision" };
    if (card.report?.state === "blocked") return { bucket: "blocked", detail: "worker is blocked" };
    return { bucket: "inFlight", detail: null };
  }
  if (item?.section === "in-flight") return { bucket: "inFlight", detail: null };
  return { bucket: "queued", detail: null };
}

/** Task titles longer than this are clipped, so no single task can crowd the briefing out. */
const TITLE_MAX = 160;

/** The date in a done task's outcome (`merged 2026-11-20`), or null when it names none. */
export function landedOn(outcome: string | null): string | null {
  return /\b(\d{4}-\d{2}-\d{2})\b/.exec(outcome ?? "")?.[1] ?? null;
}

/**
 * Done tasks newest first. The charter keeps Done newest first, but only asks for the latest ten, so the
 * outcome's date decides where there is one; tasks without a date keep their place in the backlog after
 * the dated ones.
 */
function newestFirst<T extends { date: string | null; index: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.date !== null && b.date !== null && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if ((a.date === null) !== (b.date === null)) return a.date === null ? 1 : -1;
    return a.index - b.index;
  });
}

/** The board grouped for the briefing. Done is newest first. */
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
  const done: { line: TaskLine; date: string | null; index: number }[] = [];
  fleet.cards.forEach((card, index) => {
    const { bucket, detail } = bucketOf(card);
    const line: TaskLine = { title: clip(cleanTitle(card.title), TITLE_MAX), detail };
    if (bucket === "done") done.push({ line, date: landedOn(card.backlog?.outcome ?? null), index });
    else out[bucket].push(line);
  });
  out.done = newestFirst(done).map((entry) => entry.line);
  return out;
}
