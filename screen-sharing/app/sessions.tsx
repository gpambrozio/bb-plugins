/**
 * The open sessions, as the app sees them, and the two places that show them
 * whatever page is open: the sidebar entry's LIVE badge and a "Close all"
 * toast. The server publishes the list on every open and close; this asks
 * again after a reconnect, because a publish sent while disconnected is gone.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";

import { SESSIONS_CHANGED, SessionListSchema, type SessionInfo } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
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
 * The live-sessions toast's id: showing it again with the same id updates it in
 * place. It is this loaded copy's own, because a reload mounts the new copy
 * before the old one unmounts, and the old one's clean-up must not dismiss the
 * toast the new one has just shown.
 */
export const LIVE_TOAST_ID = `screen-sharing-live-sessions-${Math.random().toString(36).slice(2, 10)}`;

/**
 * A toast in bb's own toast stack, in every bb window, while any session is
 * open — from this window or another device — so a forgotten one is hard to
 * miss and one press away from closed. It is bb's toast card, through the
 * `sonner` bb hands its plugins, and it stacks with bb's own toasts.
 *
 * - It stays: no time-out, and `dismissible: false` takes away the X, the swipe
 *   and Escape, so Close all cannot be put away while a session is open.
 * - Close all calls `preventDefault()`, which keeps the toast up until the
 *   sessions have gone; a failed close leaves it there to try again.
 * - Open always dismisses the toast (sonner's cancel button does), which is
 *   right: the toast steps aside while the page is on screen, and comes back
 *   when the page goes if a session is still open.
 * - bb's stack shows the newest three toasts; a fourth newer one hides this
 *   one until it expires.
 *
 * Renders nothing itself; the toast is the whole surface.
 */
export function LiveSessionsOverlay() {
  const sessions = useSessions();
  const pageOpen = useIsPageOpen();
  const navigate = useBbNavigate();
  const { closeAll, closing } = useCloseAll();
  // The handlers read these at click time, so the toast is not re-shown for a new function.
  const latest = useRef({ closeAll, closing, navigate });
  latest.current = { closeAll, closing, navigate };
  const count = sessions.length;
  const show = count > 0 && !pageOpen;

  useEffect(() => {
    if (!show) {
      toast.dismiss(LIVE_TOAST_ID);
      return;
    }
    toast(`Screen Sharing · ${liveLabel(count)}`, {
      id: LIVE_TOAST_ID,
      duration: Infinity,
      dismissible: false,
      description: count === 1 ? "A screen is open in bb." : `${count} screens are open in bb.`,
      action: {
        label: closing ? "Closing…" : "Close all",
        onClick: (event) => {
          event.preventDefault();
          if (!latest.current.closing) latest.current.closeAll();
        },
      },
      cancel: { label: "Open", onClick: () => latest.current.navigate.toPluginPanel(PANEL_PATH) },
    });
  }, [show, count, closing]);

  // Unmounted (the plugin disabled, removed or reloaded): take the toast with it.
  useEffect(() => () => void toast.dismiss(LIVE_TOAST_ID), []);

  return null;
}
