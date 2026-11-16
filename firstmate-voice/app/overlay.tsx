/**
 * The pill: a bb toast, in bb's own toast stack, while a session is connecting or live, with what is happening
 * (connecting, listening, the captain speaking, the voice speaking, muted), Mute or Unmute and End. When a
 * session ends or Talk fails it says why, with Talk again and Close. Otherwise there is no toast. It is an app
 * overlay, mounted once per window and drawing nothing itself, so it also hands the controller its RPC client
 * and the server's session signals, and sends a debug-tab request with no thread named to the first mate's thread.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useBbContext, useBbNavigate, useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";

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

type ActionKind = "mute" | "unmute" | "talk";
type CancelKind = "end" | "close";

/** What the toast says and offers in a state, or null for no toast. */
export interface VoiceToast {
  title: string;
  description: string | undefined;
  action: ActionKind | null;
  cancel: CancelKind | null;
}

export function voiceToast(state: VoiceState): VoiceToast | null {
  if (state.phase === "idle") {
    return state.note === null ? null : { title: "FirstMate voice", description: state.note, action: "talk", cancel: "close" };
  }
  const title = `FirstMate voice · ${statusText(state)}`;
  if (state.phase === "connecting") return { title, description: undefined, action: null, cancel: "end" };
  if (state.phase === "ending") return { title, description: undefined, action: null, cancel: null };
  return { title, description: undefined, action: state.muted ? "unmute" : "mute", cancel: "end" };
}

const ACTION_LABELS: Record<ActionKind, string> = { mute: "Mute", unmute: "Unmute", talk: "Talk" };
const CANCEL_LABELS: Record<CancelKind, string> = { end: "End", close: "Close" };

function runAction(kind: ActionKind): void {
  if (kind === "talk") voice.talk();
  else voice.toggleMute();
}

function runCancel(kind: CancelKind): void {
  if (kind === "end") void voice.end("ended by the captain");
  else voice.dismiss();
}

/**
 * The toast's id: showing it again with the same id updates it in place. It is this loaded copy's own, since a
 * reload mounts the new copy before the old one unmounts and the old one's clean-up must not dismiss the new
 * one's toast. Each toast that goes (End and Close dismiss theirs at once, as sonner's cancel button does) takes
 * its id with it, and the next one gets a new id, so a toast shown again at once is not merged into the one
 * still fading out.
 */
export const VOICE_TOAST_ID = `firstmate-voice-session-${Math.random().toString(36).slice(2, 10)}`;

function useVoiceToast(state: VoiceState): void {
  const shown = voiceToast(state);
  // The buttons read these at click time, so the toast is not shown again for a new function.
  const latest = useRef(shown);
  latest.current = shown;
  const toastRef = useRef({ count: 0, up: false });
  const id = () => `${VOICE_TOAST_ID}-${toastRef.current.count}`;
  /**
   * The card `which` has gone: the next toast gets a new id. Only the current card's going counts, once, so a
   * second press on a card already fading out leaves the card that replaced it tracked.
   */
  const current = (which: string) => which === id() && toastRef.current.up;
  const gone = (which: string) => {
    if (current(which)) toastRef.current = { count: toastRef.current.count + 1, up: false };
  };

  const title = shown?.title ?? null;
  const description = shown?.description;
  const action = shown?.action ?? null;
  const cancel = shown?.cancel ?? null;

  useEffect(() => {
    if (title === null) {
      if (toastRef.current.up) {
        toast.dismiss(id());
        gone(id());
      }
      return;
    }
    const shownId = id();
    toast(title, {
      id: shownId,
      duration: Infinity,
      dismissible: false,
      description,
      // An action that calls preventDefault keeps the toast up; it changes in place as the state does.
      action:
        action === null
          ? undefined
          : {
              label: ACTION_LABELS[action],
              onClick: (event) => {
                event.preventDefault();
                // A press on a card that is no longer the one on screen, or for a state already past, does nothing.
                if (current(shownId) && latest.current?.action === action) runAction(action);
              },
            },
      // A cancel always dismisses its toast; End's ended state and the next Talk come in a new one.
      cancel:
        cancel === null
          ? undefined
          : {
              label: CANCEL_LABELS[cancel],
              onClick: () => {
                const now = current(shownId);
                gone(shownId);
                if (now && latest.current?.cancel === cancel) runCancel(cancel);
              },
            },
    });
    toastRef.current.up = true;
  }, [title, description, action, cancel]);

  // Unmounted (the plugin disabled, removed or reloaded): take the toast with it.
  useEffect(
    () => () => {
      if (!toastRef.current.up) return;
      toast.dismiss(id());
      gone(id());
    },
    [],
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
  useVoiceToast(state);

  return null;
}
