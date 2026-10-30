/**
 * The app-wide overlay, mounted once per window and rendering nothing. It owns
 * the two things that must run whether or not the Herald page is open: the
 * entry list, re-read on every nudge from the server and on every reconnect
 * (a realtime signal is never replayed), and the announcer that speaks it.
 * It also hears, once for the window, which thread has a new sentence for
 * its timeline (`app/timeline-store.ts`). Nothing here depends on which page
 * the window shows.
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
import { ENTRIES_CHANNEL, SENTENCES_CHANNEL } from "../shared/herald";
import { speechSettingsOf, type SpeechSettings } from "../shared/settings";
import { Announcer, setAnnouncer } from "./announcer";
import { claimAnnouncement, onClaimReleased } from "./claims";
import { setEntries, setEntriesError } from "./entries";
import * as speech from "./speech";
import { usePlacedLoader } from "./timeline";
import { timelineSentences } from "./timeline-store";

/** A slow backstop: the nudges and the reconnect re-read are what keep the list current. */
const SAFETY_REFRESH_MS = 60_000;

/** The thread a sentences nudge names; anything else is ignored. */
function nudgedThread(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const threadId = (payload as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId !== "" ? threadId : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function HeraldBridge() {
  const rpc = useRpc<RpcContract>();
  const pluginId = experimental_usePluginId();
  const values = useSettings().values;
  const connection = useRealtimeConnectionState();
  const settings = useRef<SpeechSettings>(speechSettingsOf(values));
  settings.current = speechSettingsOf(values);
  const announcer = useRef<Announcer | null>(null);

  useEffect(() => {
    const next = new Announcer({
      render: (text, voice, rate) => rpc.call("speech.render", { text, voice, rate }),
      voices: async () => (await rpc.call("config.get", {})).voices,
      settings: () => settings.current,
      platform: speech.speechPlatform,
      claim: (eventId) => claimAnnouncement(`${pluginId}:said:`, eventId),
      audio: speech,
      report: (level, message, error) => {
        if (level === "warn") console.warn(`[herald] ${message}`, error ?? "");
        else console.info(`[herald] ${message}`);
        rpc.call("log", { level, message }).catch(() => {});
      },
    });
    announcer.current = next;
    setAnnouncer(next);
    const stopHearing = onClaimReleased(`${pluginId}:said:`, (eventId) => next.claimReleased(eventId));
    return () => {
      stopHearing();
      next.stop();
      setAnnouncer(null);
      announcer.current = null;
    };
  }, [rpc, pluginId]);

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
          announcer.current?.onEntries(entries);
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
  }, [rpc]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, SAFETY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useRealtime(ENTRIES_CHANNEL, refresh);

  const loadPlaced = usePlacedLoader();
  const onSentence = useCallback(
    (payload: unknown) => {
      const threadId = nudgedThread(payload);
      if (threadId !== null) timelineSentences.nudge(threadId, loadPlaced);
    },
    [loadPlaced],
  );
  useRealtime(SENTENCES_CHANNEL, onSentence);

  // Whatever changed while the connection was down never arrives as a signal.
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") {
      refresh();
      timelineSentences.refreshAll(loadPlaced);
    }
    previous.current = connection;
  }, [connection, refresh, loadPlaced]);

  return null;
}
