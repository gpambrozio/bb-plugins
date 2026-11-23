/**
 * The debug log: everything that happened with the voice agent since the user last tapped Talk, in order
 * and timed, for the debug view (`app/debug.tsx`) the owner tunes the loop with. The standing instructions
 * and the session the call was made with, every item put in the call's conversation, what the user said
 * and what the voice said (the transcripts), tool calls and their answers, each message sent to a thread as
 * it went, each question read and answered, announcements, interruptions, errors and the session's
 * own events, and each run of the owner's voice hook on their machine (never its output).
 *
 * - **Local only.** It lives in this server's memory and is read through a client-only RPC (`debug.log`: bb's
 *   app, or its command line on this bb, never another plugin);
 *   nothing here is published, stored or logged. A new Talk starts a new log, so it holds the current
 *   session, or the last one until the next; a reload of the plugin forgets it.
 * - **No credential.** Every text passes through `scrub` (the token's patterns from `redact`, and API keys)
 *   before it is kept. The token itself never reaches the session, so it cannot reach the log.
 * - **Bounded.** At most `DEBUG_MAX_ENTRIES` entries of at most `DEBUG_MAX_TEXT` characters each; past the
 *   cap the oldest entries go, apart from the briefing at the start.
 */
import { z } from "zod";

import { redact } from "./openai-call";

export const DEBUG_MAX_ENTRIES = 2_000;
export const DEBUG_MAX_TEXT = 24_000;
/** Entries per page: the view reads again at once while `more` says there are others. */
export const DEBUG_PAGE_ENTRIES = 200;

/** What an entry is about; the view colours and filters by it. */
export const DEBUG_KINDS = [
  "session",
  "briefing",
  "context",
  "heard",
  "said",
  "tool-call",
  "tool-result",
  "to-thread",
  "question",
  "announce",
  "interrupted",
  "turn",
  "hook",
  "error",
] as const;
export type DebugKind = (typeof DEBUG_KINDS)[number];

export interface DebugEntry {
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  kind: DebugKind;
  title: string;
  text?: string;
}

export interface DebugPage {
  /** The session the log is of; null before the first Talk since the plugin loaded. */
  sessionId: string | null;
  startedAt: number | null;
  /** Entries after the `afterSeq` asked for, oldest first, at most `DEBUG_PAGE_ENTRIES`. */
  entries: DebugEntry[];
  /** More entries follow the last one here. */
  more: boolean;
  /** How many entries the cap has dropped so far. */
  dropped: number;
}

/** Removes anything credential-shaped: bearer headers, JWTs, `ek_` secrets and API keys. */
export function scrub(text: string): string {
  return redact(text).replace(/\bsk-[A-Za-z0-9_-]{12,}/gu, "sk-[redacted]");
}

export class DebugLog {
  private readonly entries: DebugEntry[] = [];
  private seq = 0;
  private dropped = 0;

  constructor(
    readonly sessionId: string,
    readonly startedAt: number,
    private readonly now: () => number,
  ) {}

  add(kind: DebugKind, title: string, text?: string): void {
    this.seq += 1;
    const entry: DebugEntry = { seq: this.seq, at: this.now(), kind, title: scrub(title).slice(0, 300) };
    if (text !== undefined && text !== "") {
      const clean = scrub(text);
      entry.text = clean.length > DEBUG_MAX_TEXT ? `${clean.slice(0, DEBUG_MAX_TEXT)}… (${clean.length - DEBUG_MAX_TEXT} more characters cut)` : clean;
    }
    this.entries.push(entry);
    if (this.entries.length > DEBUG_MAX_ENTRIES) {
      const oldest = this.entries.findIndex((item) => item.kind !== "briefing");
      this.entries.splice(oldest === -1 ? 0 : oldest, 1);
      this.dropped += 1;
    }
  }

  page(afterSeq: number): DebugPage {
    const after = this.entries.filter((entry) => entry.seq > afterSeq);
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      entries: after.slice(0, DEBUG_PAGE_ENTRIES),
      more: after.length > DEBUG_PAGE_ENTRIES,
      dropped: this.dropped,
    };
  }
}

export const DebugPageSchema = z.object({
  sessionId: z.string().nullable(),
  startedAt: z.number().nullable(),
  entries: z.array(z.object({ seq: z.number(), at: z.number(), kind: z.enum(DEBUG_KINDS), title: z.string(), text: z.string().optional() })),
  more: z.boolean(),
  dropped: z.number(),
});

/** The page before any session. */
export const EMPTY_DEBUG_PAGE: DebugPage = { sessionId: null, startedAt: null, entries: [], more: false, dropped: 0 };
