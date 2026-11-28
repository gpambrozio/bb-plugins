/**
 * Which of a thread's `client/turn/requested` events are the user's own words.
 *
 * Every message a thread receives is one: what the user typed, bb's notices about sub-threads
 * (`systemMessageKind` `child-completed` and the like), messages other threads send (`initiator`
 * `agent`), and messages plugins send for someone (firstmate-crew's watch notes carry an agent-only
 * part; `bb firstmate-crew tell` opens with a "Relayed by" line), and bb's retries of a failed turn
 * (`retryOfRequestId`), which repeat the user's message. Only the user's own new messages count.
 */
import { z } from "zod";

const InputPart = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    visibility: z.string().optional(),
  })
  .passthrough();

const RequestData = z
  .object({
    initiator: z.string().optional(),
    systemMessageKind: z.string().nullable().optional(),
    retryOfRequestId: z.string().nullable().optional(),
    input: z.array(InputPart).optional(),
  })
  .passthrough();

/** Text that marks a message as relayed or written by bb, not typed by the user. */
const NOT_THE_USERS = /^\s*(?:\[bb [^\]]*\]|Relayed by bb )/;

/** The user's own text in one `client/turn/requested` event's data, or null when it is not theirs. */
export function userText(data: unknown): string | null {
  const parsed = RequestData.safeParse(data);
  if (!parsed.success) return null;
  const request = parsed.data;
  if (request.initiator !== "user") return null;
  // bb's retry of a failed turn repeats the user's message; it is not a new one.
  if (request.retryOfRequestId != null) return null;
  const kind = request.systemMessageKind ?? "unlabeled";
  if (kind !== "unlabeled") return null;
  const parts = request.input ?? [];
  if (parts.some((part) => part.visibility === "agent-only")) return null;
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (text === "" || NOT_THE_USERS.test(text)) return null;
  return text;
}

/** One event as `threads.events.list` returns it, the fields this module reads. */
export interface RequestEvent {
  seq: number;
  data: unknown;
}

/** The user's messages among `events`, in the order given. */
export function userMessages(events: readonly RequestEvent[]): { seq: number; text: string }[] {
  const out: { seq: number; text: string }[] = [];
  for (const event of events) {
    const text = userText(event.data);
    if (text !== null) out.push({ seq: event.seq, text });
  }
  return out;
}

/**
 * A status line as crew threads end their turns with (`blocked: …`), from the last non-empty line of a
 * reply. Only the states the briefing names a child for; anything else is null.
 */
export function flaggedStatusLine(reply: string | null): { state: "blocked" | "needs a decision" | "failed"; detail: string } | null {
  if (reply === null) return null;
  const last = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  if (last === undefined) return null;
  const match = /^[*_`]*(blocked|needs-decision|failed)[*_`]*:[*_`]*\s*(.*)$/i.exec(last);
  if (match === null) return null;
  const word = (match[1] ?? "").toLowerCase();
  const state = word === "needs-decision" ? "needs a decision" : word === "failed" ? "failed" : "blocked";
  return { state, detail: (match[2] ?? "").replace(/^[*_`]+|[*_`]+$/g, "").trim() };
}

/** The last non-empty line of a reply, for the thread detail's sub-thread list. */
export function lastLine(reply: string | null): string | null {
  if (reply === null) return null;
  const last = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  return last ?? null;
}
