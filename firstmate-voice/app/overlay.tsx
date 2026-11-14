/**
 * The pill: while a session is connecting or live, a small bar at the bottom right with what is happening
 * (connecting, listening, the captain speaking, the voice speaking, muted) and Mute and End. When a session
 * ends or Talk fails it says why, with Talk again. Otherwise it draws nothing. It is an app overlay, mounted
 * once per window, so it also hands the controller its RPC client and the server's session signals.
 */
import { useEffect, useSyncExternalStore } from "react";
import { experimental_Icon as Icon, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import type { rpcContract } from "../server";
import type { SessionSignal } from "../server/session";
import { SESSION_CHANNEL } from "../shared/channel";
import { voice, type VoiceState } from "./controller";

export function useVoiceState(): VoiceState {
  return useSyncExternalStore(voice.subscribe, () => voice.snapshot);
}

export function statusText(state: VoiceState): string {
  if (state.phase === "connecting") return "Connecting…";
  if (state.phase === "ending") return "Ending…";
  if (state.muted) return "Muted";
  if (state.speaking.voice) return "Speaking";
  if (state.speaking.captain) return "Hearing you";
  return "Listening";
}

export function VoicePill() {
  const rpc = useRpc<typeof rpcContract>();
  const state = useVoiceState();

  useEffect(() => voice.attach(rpc), [rpc]);
  useRealtime(SESSION_CHANNEL, (payload) => voice.onSignal(payload as SessionSignal));

  if (state.phase === "idle" && state.note === null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-24 right-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-card-foreground shadow-lg sm:bottom-4 sm:right-4"
    >
      <Icon name="Mic" className={state.phase === "live" && !state.muted ? "text-success" : "text-muted-foreground"} />
      {state.phase === "idle" ? (
        <>
          <span className="min-w-0 truncate text-muted-foreground">{state.note}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => voice.talk()}>
            Talk
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Dismiss" onClick={() => voice.dismiss()}>
            <Icon name="X" />
          </Button>
        </>
      ) : (
        <>
          <span className="whitespace-nowrap font-medium">FirstMate voice · {statusText(state)}</span>
          <Button type="button" size="sm" variant="outline" disabled={state.phase !== "live"} aria-pressed={state.muted} onClick={() => voice.toggleMute()}>
            {state.muted ? "Unmute" : "Mute"}
          </Button>
          <Button type="button" size="sm" variant="destructive" disabled={state.phase === "ending"} onClick={() => void voice.end("ended by the captain")}>
            End
          </Button>
        </>
      )}
    </div>
  );
}
