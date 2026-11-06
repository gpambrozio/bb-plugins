/**
 * bb's thread event list as the tests serve it: newest first, paged by `beforeSeq`, and refusing a page
 * larger than bb takes, with bb's own message, so a read that asks for more fails here as it does live.
 */

/** bb 0.48.1's `THREAD_EVENT_LIST_PAGE_SIZE`: a larger `limit` is an HTTP 400. */
export const BB_EVENT_PAGE_MAX = 100;

export interface LogRow {
  seq: number;
  createdAt: number;
  /** The turn the row belongs to; "t" when the test does not care. */
  turnId?: string;
  type?: string;
  data: Record<string, unknown>;
}

export interface EventListInput {
  threadId: string;
  types?: readonly string[];
  order?: "asc" | "desc";
  limit?: string;
  beforeSeq?: string;
}

/** One `threads.events.list` call over `rows`, as bb answers it. */
export function listEvents(rows: readonly LogRow[], input: EventListInput) {
  const limit = input.limit === undefined ? BB_EVENT_PAGE_MAX : Number(input.limit);
  if (!(limit <= BB_EVENT_PAGE_MAX)) throw new Error(`HTTP 400: Thread event limit cannot exceed ${BB_EVENT_PAGE_MAX}`);
  if (input.order !== "desc") throw new Error("the fake event log serves newest first only");
  const before = input.beforeSeq === undefined ? Infinity : Number(input.beforeSeq);
  return rows
    .filter((row) => input.types === undefined || input.types.includes(row.type ?? "item/completed"))
    .filter((row) => row.seq < before)
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit)
    .map((row) => ({
      id: `evt_${row.seq}`,
      scope: { kind: "turn", turnId: row.turnId ?? "t" },
      threadId: input.threadId,
      type: row.type ?? "item/completed",
      seq: row.seq,
      createdAt: row.createdAt,
      data: row.data,
    }));
}
