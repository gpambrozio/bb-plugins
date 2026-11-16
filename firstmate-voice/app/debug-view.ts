/**
 * The debug view's state, apart from React so it is tested plainly: whether the panel is open (one per
 * window, like the controller), the entries read so far, and how they read as text.
 */
import type { DebugEntry, DebugKind, DebugPage } from "../server/debug-log";

export interface DebugState {
  sessionId: string | null;
  startedAt: number | null;
  entries: DebugEntry[];
  dropped: number;
}

export const EMPTY_DEBUG: DebugState = { sessionId: null, startedAt: null, entries: [], dropped: 0 };

/** The seq to read after: the last entry's, or 0 for a session not read yet. */
export function nextSeq(state: DebugState): number {
  return state.entries.at(-1)?.seq ?? 0;
}

/**
 * A page read after `nextSeq(state)`, merged in. A page of another session (listening started again) means
 * the page was read after the wrong seq: `reread` says to read that session from the start.
 */
export function mergePage(state: DebugState, page: DebugPage): { state: DebugState; reread: boolean } {
  if (page.sessionId !== state.sessionId) {
    const fromStart = nextSeq(state) === 0;
    const fresh: DebugState = { sessionId: page.sessionId, startedAt: page.startedAt, entries: fromStart ? page.entries : [], dropped: page.dropped };
    return { state: fresh, reread: !fromStart && page.sessionId !== null };
  }
  if (page.entries.length === 0 && page.dropped === state.dropped) return { state, reread: false };
  const last = nextSeq(state);
  const added = page.entries.filter((entry) => entry.seq > last);
  return { state: { ...state, entries: [...state.entries, ...added], dropped: page.dropped }, reread: false };
}

export const KIND_LABELS: Record<DebugKind, string> = {
  session: "Session",
  briefing: "Briefing",
  context: "Context",
  heard: "Heard",
  said: "Said",
  "tool-call": "Tool call",
  "tool-result": "Tool answer",
  "to-mate": "To first mate",
  "from-mate": "From first mate",
  announce: "Announce",
  interrupted: "Interrupted",
  turn: "Turn",
  error: "Error",
};

/** The chip's colour classes, from bb's semantic tokens. */
export function kindTone(kind: DebugKind): string {
  switch (kind) {
    case "error":
      return "border-destructive text-destructive";
    case "interrupted":
      return "border-warning text-warning-text";
    case "heard":
    case "to-mate":
      return "border-success text-success";
    case "said":
    case "from-mate":
    case "announce":
      return "border-border text-foreground";
    default:
      return "border-border text-muted-foreground";
  }
}

/** The local time of day to the millisecond. */
export function clockTime(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/** Seconds since listening started, to a tenth. */
export function sinceStart(at: number, startedAt: number | null): string {
  if (startedAt === null) return "";
  return `+${((at - startedAt) / 1000).toFixed(1)} s`;
}

/** Entries the "turns" switch hides: the speech, audio and response markers. */
export function visible(entries: readonly DebugEntry[], showTurns: boolean): DebugEntry[] {
  return showTurns ? [...entries] : entries.filter((entry) => entry.kind !== "turn");
}

/** A long text starts folded. */
export function isLong(text: string): boolean {
  return text.length > 600 || text.split("\n").length > 12;
}

/** The whole log as plain text, for the Copy button. */
export function asText(state: DebugState): string {
  const head = state.sessionId === null ? "FirstMate voice debug log: no session yet." : `FirstMate voice debug log, session ${state.sessionId}`;
  const dropped = state.dropped > 0 ? `\n(${state.dropped} older entries were dropped at the cap.)` : "";
  const lines = state.entries.map((entry) => {
    const when = `${clockTime(entry.at)} ${sinceStart(entry.at, state.startedAt)}`.trim();
    const body = entry.text === undefined ? "" : `\n${entry.text.replace(/^/gmu, "    ")}`;
    return `[${when}] ${KIND_LABELS[entry.kind]}: ${entry.title}${body}`;
  });
  return [head + dropped, ...lines].join("\n");
}

/** Whether the debug panel shows, in this window. */
class DebugToggle {
  private shown = false;
  private readonly listeners = new Set<() => void>();

  get open(): boolean {
    return this.shown;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(open: boolean): void {
    if (this.shown === open) return;
    this.shown = open;
    for (const listener of this.listeners) listener();
  }
}

export const debugView = new DebugToggle();
