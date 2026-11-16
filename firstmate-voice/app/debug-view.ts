/**
 * The debug view's state, apart from React so it is tested plainly: the entries read so far, how they read
 * as text, the side-panel tab they show in, and a request to open it (one per window, like the controller).
 */
import type { ExperimentalPanelController, ExperimentalTabReference } from "@get-bb/plugin-sdk/app";

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
  hook: "Hook",
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

/** The debug tab as bb addresses it: an action tab in a thread's side panel, beside the chat. */
export const DEBUG_TAB = { id: "debug", context: { kind: "thread" }, availability: "action" } as const satisfies ExperimentalTabReference;

/** Opens (or focuses) the debug tab in `panel`; false when that surface has no thread side panel. */
export function openDebugTab(panel: Pick<ExperimentalPanelController, "openTab">): boolean {
  return panel.openTab({ tab: DEBUG_TAB });
}

/** How long a request to open the tab waits for its thread to show. */
export const DEBUG_OPEN_WAIT_MS = 10_000;

export interface DebugOpenWanted {
  /** The thread whose side panel should show the tab; null for the first mate's, which the overlay looks up. */
  threadId: string | null;
  at: number;
}

/**
 * A request to open the debug tab where no panel controller of a thread is at hand: the pill (an app overlay,
 * outside every thread view) and the palette or the header menu when the focused surface declines. A
 * component inside the thread view (`DebugOpener`, in the thread's composer) opens it, and the overlay turns
 * a request for the first mate's thread into a navigation there. One per window.
 */
class DebugOpenRequest {
  private current: DebugOpenWanted | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  get wanted(): DebugOpenWanted | null {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ask(threadId: string | null): void {
    this.current = { threadId, at: this.now() };
    this.changed();
  }

  /** Whether the tab should open in `threadId`'s panel now. */
  isFor(threadId: string | null): boolean {
    const wanted = this.current;
    return wanted !== null && threadId !== null && wanted.threadId === threadId && this.now() - wanted.at <= DEBUG_OPEN_WAIT_MS;
  }

  done(): void {
    if (this.current === null) return;
    this.current = null;
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

export function makeDebugOpenRequest(now?: () => number): DebugOpenRequest {
  return new DebugOpenRequest(now);
}

export const debugOpen = makeDebugOpenRequest();

/**
 * Opens the debug tab from a palette command or a menu: in the focused surface's panel when it takes the tab,
 * else in `threadId`'s once it shows, else in the first mate's thread.
 */
export function openDebugLog(panel: Pick<ExperimentalPanelController, "openTab">, threadId: string | null, request = debugOpen): void {
  if (openDebugTab(panel)) return;
  request.ask(threadId);
}
