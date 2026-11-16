/**
 * The pill: while a session is connecting or live, a small bar at the bottom right with what is happening
 * (connecting, listening, the captain speaking, the voice speaking, muted) and Mute and End. When a session
 * ends or Talk fails it says why, with Talk again. Otherwise it draws nothing. Both carry a Debug button that
 * opens the debug tab (`app/debug.tsx`) in the side panel of the thread in view, or of the first mate's thread,
 * which it navigates to. It is an app overlay, mounted once per window, so it also hands the controller its RPC
 * client and the server's session signals.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { experimental_Icon as Icon, useBbContext, useBbNavigate, useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import type { rpcContract } from "../server";
import type { SessionSignal } from "../server/session";
import { SESSION_CHANNEL } from "../shared/channel";
import { voice, type VoiceState } from "./controller";
import { DEBUG_OPEN_WAIT_MS, debugOpen } from "./debug-view";
import { createLocalHostLookup } from "./machine";

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

function DebugButton() {
  const { threadId } = useBbContext();
  return (
    <Button type="button" size="sm" variant="ghost" aria-label="Open the voice debug log" onClick={() => debugOpen.ask(threadId)}>
      <Icon name="Bug" />
    </Button>
  );
}

/** A request to open the debug tab with no thread named goes to the first mate's thread: look it up and go there. */
function useDebugRouting(): void {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { threadId } = useBbContext();
  const wanted = useSyncExternalStore(debugOpen.subscribe, () => debugOpen.wanted);

  useEffect(() => {
    if (wanted === null || wanted.threadId !== null || Date.now() - wanted.at > DEBUG_OPEN_WAIT_MS) return;
    let live = true;
    rpc
      .call("mate.thread", {})
      .then(({ threadId: mate }) => {
        if (!live || debugOpen.wanted !== wanted) return;
        if (mate === null) return debugOpen.done();
        debugOpen.ask(mate);
        if (threadId !== mate) navigate.toThread(mate);
      })
      .catch(() => {
        if (live && debugOpen.wanted === wanted) debugOpen.done();
      });
    return () => {
      live = false;
    };
  }, [rpc, wanted, threadId, navigate]);
}

export function VoicePill() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const state = useVoiceState();
  const machine = useMemo(() => createLocalHostLookup(async () => (await sdk.system.config()).localHelperPorts ?? []), [sdk]);

  useEffect(() => voice.attach(rpc, machine), [rpc, machine]);
  useRealtime(SESSION_CHANNEL, (payload) => voice.onSignal(payload as SessionSignal));
  useDebugRouting();

  return state.phase === "idle" && state.note === null ? null : <Pill state={state} />;
}

function Pill({ state }: { state: VoiceState }) {
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
          <DebugButton />
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
          <DebugButton />
        </>
      )}
    </div>
  );
}
