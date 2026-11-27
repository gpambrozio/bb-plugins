/**
 * The Voice page: Voice Pilot's entry in bb's sidebar. Talk (or End) and Mute, what the session is doing
 * (connecting, listening, hearing you, speaking), why the last one ended, and below it the session's log: what
 * you said and what the voice said, tool calls, questions answered and hooks run. It works the same on a phone,
 * where it is the easiest way in: the thread header folds its Talk button into a menu there.
 */
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { voice, type VoiceState } from "./controller";
import { DebugLogView } from "./debug";
import { hookOpen, hookOpenFailed, openHookEditor } from "./hook-file";
import { PromptEditCard } from "./prompt-edit";
import { PAUSED_NOTE, statusText, useVoiceState } from "./overlay";

/** The words under the buttons, for a state. */
export function pageNote(state: VoiceState): string {
  if (state.phase === "idle") return state.note ?? "Tap Talk. It says hi, names the running threads, then listens. Say goodbye to end.";
  if (state.phase === "connecting") return "Connecting to OpenAI…";
  if (state.phase === "ending") return "Ending…";
  if (state.phase === "paused") return state.note ?? PAUSED_NOTE;
  if (state.phase === "resuming") return "Picking the session up again…";
  return state.muted ? "Your microphone is muted. Tap Unmute to talk again." : "Ask what's going on, what a thread said, or what waits on you.";
}

/** The dot beside the state: idle, live, the voice speaking. */
function dotClass(state: VoiceState): string {
  if (state.phase === "idle" || state.phase === "paused") return "bg-muted-foreground";
  if (state.phase !== "live") return "bg-warning-text animate-pulse";
  if (state.speaking.voice) return "bg-success animate-pulse";
  return state.muted ? "bg-muted-foreground" : "bg-success";
}

/** Opens a hook script the settings page asked for, in this page's file panel. Renders nothing. */
export function HookFileOpener() {
  const navigate = useBbNavigate();
  const wanted = useSyncExternalStore(hookOpen.subscribe, () => hookOpen.wanted);
  useEffect(() => {
    if (wanted === null) return;
    const taken = hookOpen.take();
    if (taken !== null && !openHookEditor((options) => navigate.experimental_openFilePreview(options), taken.target, taken.machine)) toast.info(hookOpenFailed(taken));
  }, [wanted, navigate]);
  return null;
}

export function VoicePage() {
  const state = useVoiceState();
  const active = state.phase !== "idle" && state.phase !== "ending";
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <HookFileOpener />
      <section className="flex flex-col gap-3 border-b border-border px-4 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
            <Icon name="Mic" />
            <h1 className="m-0 text-base font-semibold">Voice Pilot</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" aria-live="polite">
              <span className={`inline-block h-2 w-2 rounded-full ${dotClass(state)}`} />
              {state.phase === "idle" ? "Not listening" : statusText(state)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {state.phase === "paused" && (
              <Button type="button" variant="outline" onClick={() => void voice.resume()}>
                Resume
              </Button>
            )}
            {state.phase === "live" && (
              <Button type="button" variant="outline" onClick={() => voice.toggleMute()}>
                {state.muted ? "Unmute" : "Mute"}
              </Button>
            )}
            <Button type="button" variant={active ? "destructive" : "default"} disabled={state.phase === "ending"} onClick={() => voice.toggle()}>
              <Icon name="Mic" />
              {active ? "End" : "Talk"}
            </Button>
          </div>
        </div>
        <p className="m-0 text-sm text-muted-foreground">{pageNote(state)}</p>
      </section>
      <PromptEditCard />
      <div className="min-h-0 flex-1">
        <DebugLogView active />
      </div>
    </div>
  );
}
