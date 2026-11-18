/**
 * The phone layout as the app sees it: loaded from the server, kept current by
 * the server's announcements, saved one write at a time, and remembered in
 * this browser so a phone does not flash bb's full rail before the server
 * answers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod";

import type { RpcContract } from "../shared/contract";
import { LAYOUT_CHANGED_CHANNEL, NavigationLayoutSchema, type NavigationLayout } from "../shared/layout";

/** The browser cache's key. A convenience only: the server's copy wins. */
export const CACHE_KEY = "phone-rail.layout";

const AnnouncementSchema = z.object({ layout: NavigationLayoutSchema.nullable() });

/** What the phone layout is: not known yet, none (bb's shared preferences), or one. */
export type PhoneLayoutState = { status: "loading" } | { status: "ready"; layout: NavigationLayout | null };

export function readCachedLayout(): PhoneLayoutState {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw === null) return { status: "loading" };
    const parsed = NavigationLayoutSchema.nullable().safeParse(JSON.parse(raw));
    return parsed.success ? { status: "ready", layout: parsed.data } : { status: "loading" };
  } catch {
    return { status: "loading" };
  }
}

function writeCachedLayout(layout: NavigationLayout | null): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(layout));
  } catch {
    // Storage blocked or full: the next load asks the server, as it always does.
  }
}

/**
 * Runs `write` for the latest value only, one at a time, so two quick edits
 * cannot reach the server in the wrong order. `onIdle` runs once the last
 * write has finished, with the error of the last one that failed, if any.
 */
export function createSerialWriter<T>(
  write: (value: T) => Promise<void>,
  onIdle: (error: unknown) => void,
): { save(value: T): void; readonly busy: boolean } {
  let busy = false;
  let pending: { value: T } | null = null;
  async function pump() {
    busy = true;
    let failure: unknown = null;
    while (pending !== null) {
      const { value } = pending;
      pending = null;
      try {
        await write(value);
      } catch (error) {
        failure = error;
      }
    }
    busy = false;
    onIdle(failure);
  }
  return {
    save(value) {
      pending = { value };
      if (!busy) void pump();
    },
    get busy() {
      return busy;
    },
  };
}

/** How long to wait before asking again after the first load failed. */
export const RETRY_DELAY_MS = 5000;

export function usePhoneLayout(): {
  state: PhoneLayoutState;
  /**
   * True once this mount has the server's layout, from a load or an
   * announcement. Until then the state is this browser's cache or bb's shared
   * preferences: fine to draw, not safe to edit and save over the server's.
   */
  isSynced: boolean;
  save(layout: NavigationLayout | null): void;
} {
  const rpc = useRpc<RpcContract>();
  const [state, setState] = useState<PhoneLayoutState>(readCachedLayout);
  const [isSynced, setSynced] = useState(false);
  const [failedLoads, setFailedLoads] = useState(0);
  const writerRef = useRef<ReturnType<typeof createSerialWriter<NavigationLayout | null>> | null>(null);
  // Bumped by every announcement applied and every save started: a load that
  // began before either answers with an older layout than the one on screen.
  const generationRef = useRef(0);
  const latestLoadRef = useRef(0);

  const apply = useCallback((layout: NavigationLayout | null) => {
    setState({ status: "ready", layout });
    writeCachedLayout(layout);
  }, []);

  const refetch = useCallback(() => {
    const load = ++latestLoadRef.current;
    const generation = generationRef.current;
    rpc.call("getPhoneLayout", {}).then(
      ({ layout }) => {
        // A newer load, an announcement or a save since this one began knows better.
        if (load !== latestLoadRef.current || generation !== generationRef.current) return;
        if (writerRef.current?.busy) return;
        apply(layout);
        setSynced(true);
      },
      (error: unknown) => {
        console.warn("[phone-rail] could not load the phone layout", error);
        if (load === latestLoadRef.current) setFailedLoads((count) => count + 1);
      },
    );
  }, [rpc, apply]);

  if (writerRef.current === null) {
    writerRef.current = createSerialWriter(
      async (layout) => {
        await rpc.call("setPhoneLayout", { layout });
      },
      (error) => {
        if (error !== null) {
          toast.error("Could not save the phone navigation", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
        refetch();
      },
    );
  }

  useEffect(refetch, [refetch]);

  // Until the first load succeeds, edits stay off; keep asking.
  useEffect(() => {
    if (failedLoads === 0 || isSynced) return;
    const timer = setTimeout(refetch, RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [failedLoads, isSynced, refetch]);

  // Another window or phone changed it. Our own saves are announced too; while
  // one is still going, the refetch after it brings the final value.
  useRealtime(LAYOUT_CHANGED_CHANNEL, (payload) => {
    if (writerRef.current?.busy) return;
    const parsed = AnnouncementSchema.safeParse(payload);
    if (!parsed.success) {
      refetch();
      return;
    }
    generationRef.current += 1;
    apply(parsed.data.layout);
    setSynced(true);
  });

  // Announcements are lost while the connection is down.
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current !== "connected" && connection === "connected") refetch();
    previousConnection.current = connection;
  }, [connection, refetch]);

  const save = useCallback(
    (layout: NavigationLayout | null) => {
      generationRef.current += 1;
      apply(layout);
      writerRef.current!.save(layout);
    },
    [apply],
  );

  return { state, isSynced, save };
}
