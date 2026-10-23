/**
 * The open sessions, as the app sees them, and the two places that show them
 * whatever page is open: the sidebar entry's LIVE badge and a floating "Close
 * all" pill. The server publishes the list on every open and close; this asks
 * again after a reconnect, because a publish sent while disconnected is gone.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";

import { SESSIONS_CHANGED, SessionListSchema, type SessionInfo } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { CLOSED_BY_USER_MESSAGE } from "./end-message";
import { screenSessions } from "./session-store";

export const PANEL_PATH = "screen";

/** Shared by every mounted reader, so the sidebar, the pill and the page agree. */
let cached: SessionInfo[] = [];

/** Counts the times the realtime connection has come back. */
export function useReconnects(): number {
  const state = useRealtimeConnectionState();
  const previous = useRef(state);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (previous.current !== "connected" && state === "connected") setCount((value) => value + 1);
    previous.current = state;
  }, [state]);
  return count;
}

export function useSessions(): SessionInfo[] {
  const rpc = useRpc<RpcContract>();
  const reconnects = useReconnects();
  const [sessions, setSessions] = useState<SessionInfo[]>(cached);
  /** Counts pushes, so an answer to an older request cannot replace a newer push. */
  const pushes = useRef(0);

  useEffect(() => {
    let live = true;
    const asked = pushes.current;
    rpc
      .call("sessions", {})
      .then((value) => {
        if (!live || pushes.current !== asked) return;
        cached = value.sessions;
        setSessions(value.sessions);
      })
      .catch((error: unknown) => {
        console.warn("[screen-sharing] could not read the open sessions", error);
      });
    return () => {
      live = false;
    };
  }, [rpc, reconnects]);

  useRealtime(SESSIONS_CHANGED, (payload) => {
    const parsed = SessionListSchema.safeParse(payload);
    if (!parsed.success) return;
    pushes.current++;
    cached = parsed.data.sessions;
    setSessions(parsed.data.sessions);
  });

  return sessions;
}

/**
 * Whether the Screen Sharing page is on screen in this window. The page has
 * its own Close all, so the floating pill steps aside while it is.
 */
let pagesOpen = 0;
const pageListeners = new Set<() => void>();

function subscribePages(listener: () => void): () => void {
  pageListeners.add(listener);
  return () => pageListeners.delete(listener);
}

export function usePageOpen(): void {
  useEffect(() => {
    pagesOpen++;
    for (const listener of pageListeners) listener();
    return () => {
      pagesOpen--;
      for (const listener of pageListeners) listener();
    };
  }, []);
}

function useIsPageOpen(): boolean {
  return useSyncExternalStore(subscribePages, () => pagesOpen > 0);
}

/**
 * Close all: this window's own sessions, to every Mac and including any still
 * connecting, end here at once; the server ends every other one and voids
 * every ticket not yet used, so nothing still on its way in another window
 * opens afterwards.
 */
export function useCloseAll(): { closeAll(): void; closing: boolean } {
  const rpc = useRpc<RpcContract>();
  const [closing, setClosing] = useState(false);
  return {
    closing,
    closeAll: () => {
      setClosing(true);
      screenSessions.disconnectAll(CLOSED_BY_USER_MESSAGE);
      rpc
        .call("closeAll", {})
        .catch((error: unknown) => console.warn("[screen-sharing] could not close the sessions", error))
        .finally(() => setClosing(false));
    },
  };
}

function liveLabel(count: number): string {
  return count === 1 ? "Live" : `${count} live`;
}

/**
 * The sidebar entry's badge while any session is open, on any device: LIVE in
 * lists, a dot on the icon-only rail, the count in the tooltip. A hook bb calls
 * in the plugin's scope (`experimental_useBadge`), not a component.
 */
export function useLiveBadge(): ExperimentalBadge | null {
  const sessions = useSessions();
  if (sessions.length === 0) return null;
  const label = sessions.length === 1 ? "1 Screen Sharing session open" : `${sessions.length} Screen Sharing sessions open`;
  return { text: "LIVE", tone: "critical", label };
}

/**
 * A pill in the corner of every bb window while any session is open — from
 * this window or another device — so a forgotten one is hard to miss and one
 * press away from closed.
 */
export function LiveSessionsOverlay() {
  const sessions = useSessions();
  const pageOpen = useIsPageOpen();
  const navigate = useBbNavigate();
  const { closeAll, closing } = useCloseAll();
  if (sessions.length === 0 || pageOpen) return null;
  return (
    <div
      role="status"
      aria-label="Screen Sharing sessions open"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full border border-border bg-card py-1 pl-3 pr-1 text-sm shadow-lg"
    >
      <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
      <button type="button" className="px-1 font-medium hover:underline" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
        Screen Sharing · {liveLabel(sessions.length)}
      </button>
      <Button type="button" size="sm" variant="ghost" className="rounded-full" disabled={closing} onClick={closeAll}>
        <Icon name="X" />
        Close all
      </Button>
    </div>
  );
}
