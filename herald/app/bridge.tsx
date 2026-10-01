/**
 * The app-wide overlay, mounted once per window and rendering nothing. It owns
 * the two things that must run whether or not the Herald panel is open: the
 * entry list, re-read on every nudge from the server and on every reconnect
 * (a realtime signal is never replayed), and the announcer that speaks it.
 */
import {
  experimental_usePluginId,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef } from "react";

import type { RpcContract } from "../shared/contract";
import { ENTRIES_CHANNEL } from "../shared/herald";
import { speechSettingsOf, type SpeechSettings } from "../shared/settings";
import { Announcer, setAnnouncer } from "./announcer";
import { setEntries, setEntriesError, setRefresher } from "./entries";
import * as speech from "./speech";

/** A slow backstop: the nudges and the reconnect re-read are what keep the list current. */
const SAFETY_REFRESH_MS = 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this window is the one that speaks. Windows of one app share an
 * origin, so a Web Lock elects one of them; the lock passes on when that
 * window closes. Where the browser has no Web Locks, every window speaks.
 */
function useLeadership(lockName: string): React.RefObject<boolean> {
  const leading = useRef(false);
  useEffect(() => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks === undefined) {
      leading.current = true;
      return;
    }
    const controller = new AbortController();
    locks
      .request(lockName, { signal: controller.signal }, () => {
        leading.current = true;
        return new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      })
      .catch(() => {
        // Aborted while still waiting for the lock: this window unmounted.
      });
    return () => {
      leading.current = false;
      controller.abort();
    };
  }, [lockName]);
  return leading;
}

export function HeraldBridge() {
  const rpc = useRpc<RpcContract>();
  const pluginId = experimental_usePluginId();
  const values = useSettings().values;
  const connection = useRealtimeConnectionState();
  const settings = useRef<SpeechSettings>(speechSettingsOf(values));
  settings.current = speechSettingsOf(values);
  const leading = useLeadership(`${pluginId}:announcer`);
  const announcer = useRef<Announcer | null>(null);

  useEffect(() => {
    const next = new Announcer({
      render: (text, voice, rate) => rpc.call("speech.render", { text, voice, rate }),
      voices: async () => (await rpc.call("config.get", {})).voices,
      settings: () => settings.current,
      platform: speech.speechPlatform,
      audio: speech,
      warn: (message, error) => console.warn(`[herald] ${message}`, error),
    });
    announcer.current = next;
    setAnnouncer(next);
    return () => {
      next.stop();
      setAnnouncer(null);
      announcer.current = null;
    };
  }, [rpc]);

  /** One read at a time; a nudge during a read asks for one more afterwards. */
  const reading = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false });
  const refresh = useCallback(() => {
    const flags = reading.current;
    if (flags.busy) {
      flags.again = true;
      return;
    }
    flags.busy = true;
    rpc
      .call("list", {})
      .then(
        ({ entries }) => {
          setEntries(entries);
          announcer.current?.onEntries(entries, leading.current);
        },
        (error: unknown) => setEntriesError(errorText(error)),
      )
      .finally(() => {
        flags.busy = false;
        if (flags.again) {
          flags.again = false;
          refresh();
        }
      });
  }, [rpc, leading]);

  useEffect(() => {
    setRefresher(refresh);
    refresh();
    const timer = setInterval(refresh, SAFETY_REFRESH_MS);
    return () => {
      clearInterval(timer);
      setRefresher(null);
    };
  }, [refresh]);

  useRealtime(ENTRIES_CHANNEL, refresh);

  // Whatever changed while the connection was down never arrives as a signal.
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") refresh();
    previous.current = connection;
  }, [connection, refresh]);

  return null;
}
