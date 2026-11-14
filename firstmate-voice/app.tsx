// firstmate-voice — phase 0 spike page. One nav panel with Talk buttons for
// the two paths (WebRTC direct, relayed), the client checks (a beep after a
// tap, Wake Lock), and "Run all checks", which runs everything in order and
// saves the results on the bb server so they can be read back from there.
import { useCallback, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";

import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { beepAfterTap, capabilities, wakeLockCheck } from "./app/probes";
import { runRelay } from "./app/relay";
import { runWebRtc, type RunResult } from "./app/webrtc";

type Line = { at: string; text: string };

declare global {
  interface Window {
    __firstmateVoiceSpike?: { running: boolean; results: unknown[]; saved: string | null };
  }
}

function SpikePage() {
  const rpc = useRpc<typeof rpcContract>();
  const [model, setModel] = useState("gpt-realtime-2.1");
  const [effort, setEffort] = useState("low");
  const [seconds, setSeconds] = useState(25);
  const [status, setStatus] = useState("Idle. Tap a button; the first tap also unlocks audio.");
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [results, setResults] = useState<unknown[]>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const say = useCallback((text: string) => {
    setLines((current) => [...current.slice(-199), { at: new Date().toLocaleTimeString(), text }]);
  }, []);

  /** Created and resumed inside the tap, before any await, so audio is unlocked. */
  const audioContext = () => {
    contextRef.current ??= new AudioContext();
    void contextRef.current.resume();
    return contextRef.current;
  };

  const publish = (next: unknown[], saved: string | null, isRunning: boolean) => {
    window.__firstmateVoiceSpike = { running: isRunning, results: next, saved };
  };

  async function run(label: string, steps: ("beep" | "wakelock" | "webrtc" | "relay")[]) {
    const context = audioContext();
    const beep = steps.includes("beep") ? beepAfterTap(context) : null;
    setRunning(true);
    publish([], null, true);
    const collected: Record<string, unknown> = { label, startedAt: new Date().toISOString(), capabilities: capabilities(), model, effort, seconds };
    try {
      if (beep) {
        collected.beep = await beep;
        say(`beep: ${JSON.stringify(collected.beep)}`);
      }
      if (steps.includes("wakelock")) {
        collected.wakeLock = await wakeLockCheck();
        say(`wake lock: ${collected.wakeLock}`);
      }
      for (const path of steps.filter((step) => step === "webrtc" || step === "relay")) {
        let stop!: () => void;
        const stopped = new Promise<void>((resolve) => {
          stop = resolve;
        });
        stopRef.current = stop;
        say(`— ${path} —`);
        const options = {
          rpc,
          context,
          label,
          model,
          effort: effort === "default" ? undefined : effort,
          seconds,
          onStatus: setStatus,
          onEvent: (t: number, type: string, info?: string) => say(`${(t / 1000).toFixed(2)} s ${type}${info ? ` · ${info}` : ""}`),
          stopped,
          onCallId: setCallId,
        };
        const outcome: RunResult = path === "webrtc" ? await runWebRtc(options) : await runRelay(options);
        collected[path] = outcome;
        say(`${path}: turns ${JSON.stringify(outcome.turns ?? [])}${outcome.error ? ` · error ${String(outcome.error)}` : ""}`);
      }
    } catch (error) {
      collected.error = `${(error as Error).name}: ${(error as Error).message}`;
    } finally {
      stopRef.current = null;
    }
    const next = [...results, collected];
    setResults(next);
    let saved: string | null = null;
    try {
      saved = (await rpc.call("report", { label, result: collected })).saved;
      setStatus(`Done. Results saved on the bb server at ${saved}.`);
    } catch (error) {
      setStatus(`Done, but saving failed: ${(error as Error).message}`);
    }
    publish(next, saved, false);
    setRunning(false);
    if (steps.includes("webrtc") || steps.includes("relay")) setAsked(label);
  }

  /** The meter cannot tell loud from faint (an iPhone may route to the earpiece), so the person says. */
  const heard = async (answer: string) => {
    const label = asked ?? "run";
    setAsked(null);
    try {
      await rpc.call("report", { label: `heard-${label}`, result: { heard: answer, capabilities: capabilities() } });
      setStatus(`Thanks. Saved "${answer}". You can close this page.`);
    } catch (error) {
      setStatus(`Saving the answer failed: ${(error as Error).message}`);
    }
  };

  const announce = async () => {
    if (!callId) return;
    const { sent } = await rpc.call("announce", { callId, text: "This is an announcement from the bb server." });
    say(`announce sent: ${sent}`);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 text-sm">
      <div>
        <h1 className="text-lg font-semibold">FirstMate voice: phase 0 spike</h1>
        <p className="text-muted-foreground">Talks to OpenAI Realtime on the ChatGPT subscription. Each run ends by itself after the set time.</p>
      </div>
      <div className="rounded-md border border-border p-3 text-xs" data-testid="device">
        <div className="font-medium">This device ({capabilities().platform}), saved with every result:</div>
        <div className="break-all font-mono text-muted-foreground">{navigator.userAgent}</div>
      </div>
      <div className="rounded-md border border-border bg-card p-3 text-base font-medium" data-testid="status">
        {status}
      </div>
      {asked && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning p-3">
          <span className="font-medium">Did you hear the spoken replies?</span>
          {["Yes, clearly", "Yes, but faint", "No"].map((answer) => (
            <Button key={answer} variant="outline" onClick={() => void heard(answer)}>
              {answer}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={running} onClick={() => void run(`all-${capabilities().platform}`, ["beep", "wakelock", "webrtc", "relay"])}>
          Run all checks
        </Button>
        <Button variant="outline" disabled={running} onClick={() => void run("webrtc", ["webrtc"])}>
          Talk: WebRTC
        </Button>
        <Button variant="outline" disabled={running} onClick={() => void run("relay", ["relay"])}>
          Talk: relayed
        </Button>
        <Button variant="outline" disabled={!callId} onClick={() => void announce()}>
          Announce
        </Button>
        <Button variant="outline" disabled={!running} onClick={() => stopRef.current?.()}>
          End
        </Button>
        <Button variant="outline" disabled={running} onClick={() => void run("beep", ["beep", "wakelock"])}>
          Beep + Wake Lock
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
        <label className="flex items-center gap-1">
          Model
          <select className="rounded border border-border bg-background px-1 py-0.5" value={model} onChange={(event) => setModel(event.target.value)}>
            <option>gpt-realtime-2.1</option>
            <option>gpt-realtime-2.1-mini</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          Reasoning
          <select className="rounded border border-border bg-background px-1 py-0.5" value={effort} onChange={(event) => setEffort(event.target.value)}>
            {["default", "minimal", "low", "medium", "high", "xhigh"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Seconds
          <input
            className="w-16 rounded border border-border bg-background px-1 py-0.5"
            type="number"
            min={5}
            max={80}
            value={seconds}
            onChange={(event) => setSeconds(Math.min(80, Math.max(5, Number(event.target.value) || 25)))}
          />
        </label>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-xs" data-testid="log">
        {lines.map((line) => `${line.at}  ${line.text}`).join("\n")}
      </pre>
      {results.length > 0 && (
        <details>
          <summary className="cursor-pointer">Results ({results.length})</summary>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{JSON.stringify(results, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "spike", title: "Voice spike", icon: "Mic", path: "spike", component: SpikePage });
});
