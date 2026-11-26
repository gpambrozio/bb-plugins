/**
 * The debug log: everything that happened with the voice agent since you last tapped Talk, read from
 * the server's debug log (`server/debug-log.ts`) through the app-only `debug.log` RPC, every 1.5 s while it
 * shows: what you said and what the voice said, tool calls and answers, questions answered, hooks. It is a tab
 * in a thread's side panel (`DEBUG_TAB`), so it stays open beside the chat, and the lower half of the Voice
 * page. It says plainly that it is a debug view. Nothing leaves this window but a Copy the owner taps.
 *
 * `DebugOpener` sits in each thread's composer, inside the thread view, where bb's panel controller is the
 * thread's: it opens the tab when the toast (outside every thread view) or a declined command asked for it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  experimental_copyToClipboard as copyToClipboard,
  experimental_Icon as Icon,
  experimental_useAppPanel as useAppPanel,
  experimental_useTabVisible as useTabVisible,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import type { rpcContract } from "../server";
import type { DebugEntry } from "../server/debug-log";
import { SETTINGS_WHERE, openPluginSettings } from "./open-settings";
import { EMPTY_DEBUG, KIND_LABELS, asText, clockTime, debugOpen, isLong, kindTone, mergePage, nextSeq, openDebugTab, sinceStart, visible, type DebugState } from "./debug-view";

const POLL_MS = 1_500;

/** Reads the log while `active`: new entries after the last seq, all pages of them, and a new session from its start. */
function useDebugLog(active: boolean): { state: DebugState; failed: string | null } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<DebugState>(EMPTY_DEBUG);
  const [failed, setFailed] = useState<string | null>(null);
  const current = useRef(EMPTY_DEBUG);

  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        for (let pages = 0; pages < 50 && live; pages += 1) {
          const page = await rpc.call("debug.log", { afterSeq: nextSeq(current.current) });
          if (!live) return;
          const merged = mergePage(current.current, page);
          current.current = merged.state;
          if (!merged.reread && !page.more) break;
        }
        setState(current.current);
        setFailed(null);
      } catch (error) {
        if (live) setFailed(error instanceof Error ? error.message : String(error));
      }
      if (live) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [rpc, active]);

  return { state, failed };
}

function Entry({ entry, startedAt }: { entry: DebugEntry; startedAt: number | null }) {
  const long = entry.text !== undefined && isLong(entry.text);
  const [unfolded, setUnfolded] = useState(false);
  const text = entry.text === undefined ? null : long && !unfolded ? `${entry.text.slice(0, 400)}…` : entry.text;
  return (
    <li className="border-b border-border py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">
          {clockTime(entry.at)} <span className="opacity-70">{sinceStart(entry.at, startedAt)}</span>
        </span>
        <span className={`rounded border px-1.5 text-[11px] font-medium uppercase tracking-wide ${kindTone(entry.kind)}`}>{KIND_LABELS[entry.kind]}</span>
        <span className={`min-w-0 break-words text-sm ${entry.kind === "turn" ? "text-muted-foreground" : "font-medium"}`}>{entry.title}</span>
      </div>
      {text !== null && <pre className="mt-1 max-w-full whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground">{text}</pre>}
      {long && (
        <button type="button" className="mt-1 text-xs text-muted-foreground underline" onClick={() => setUnfolded(!unfolded)}>
          {unfolded ? "Fold" : `Show all (${entry.text?.length ?? 0} characters)`}
        </button>
      )}
    </li>
  );
}

/** Opens Voice Pilot's settings page, and says where it is when it does not show. */
function openSettings(): void {
  openPluginSettings({ win: window, onMissing: () => toast.info(SETTINGS_WHERE) });
}

/** The debug tab in a thread's side panel: the log, read while the tab shows. */
export function DebugTab() {
  return <DebugLogView active={useTabVisible()} />;
}

/** The log itself, read every 1.5 s while `active`; the Voice page shows it under the session's controls. */
export function DebugLogView({ active }: { active: boolean }) {
  const showing = active;
  const { state, failed } = useDebugLog(showing);
  const [showTurns, setShowTurns] = useState(true);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const shown = visible(state.entries, showTurns);

  // Keep to the newest entry while the reader is at the bottom; scrolling up stops that until they come back.
  useEffect(() => {
    const box = scroller.current;
    if (box !== null && following.current) box.scrollTop = box.scrollHeight;
  }, [shown.length, showing]);

  const copy = async () => {
    setCopied(await copyToClipboard({ text: asText(state) }).catch(() => false));
    setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div aria-label="Voice Pilot debug log" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-warning bg-card px-3 py-2">
        {/* The title keeps a line of its own in a narrow panel; the buttons wrap below it. */}
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <Icon name="Bug" className="text-warning-text" />
          <span className="rounded border border-warning px-1.5 text-xs font-semibold uppercase tracking-wide text-warning-text">Debug</span>
          <span className="min-w-0 truncate text-sm font-medium">Voice Pilot, this session</span>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" aria-pressed={showTurns} onClick={() => setShowTurns(!showTurns)}>
            {showTurns ? "Hide turns" : "Show turns"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
            <Icon name={copied ? "Check" : "Copy"} />
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={openSettings}>
            <Icon name="Settings" />
            Settings
          </Button>
        </div>
      </div>
      <div className="px-3 py-1.5 text-xs text-muted-foreground">
        {state.sessionId === null
          ? "No voice session since Voice Pilot loaded. Tap Talk, and this fills as it goes."
          : `Session ${state.sessionId} · ${state.entries.length} entries${state.dropped > 0 ? `, ${state.dropped} older dropped` : ""} · kept on this bb only, until listening starts again`}
        {failed !== null && <span className="text-destructive"> · Could not read the log: {failed}</span>}
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3"
        onScroll={(event) => {
          const box = event.currentTarget;
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        }}
      >
        <ol className="m-0 list-none p-0 pb-6">
          {shown.map((entry) => (
            <Entry key={`${state.sessionId}-${entry.seq}`} entry={entry} startedAt={state.startedAt} />
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Opens the debug tab in this thread's side panel when a request names this thread. Renders nothing. */
export function DebugOpener() {
  const composer = useComposer();
  const panel = useAppPanel();
  const wanted = useSyncExternalStore(debugOpen.subscribe, () => debugOpen.wanted);
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;

  useEffect(() => {
    if (wanted === null || !debugOpen.isFor(threadId)) return;
    if (openDebugTab(panel)) debugOpen.done();
  }, [wanted, threadId, panel]);

  return null;
}
