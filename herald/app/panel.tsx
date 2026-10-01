/**
 * The Herald page: every thread waiting on the user, each with the sentence
 * Herald wrote for it. A tap opens the thread; the speaker beside the title
 * says the sentence again.
 */
import { experimental_useSidebarThreads, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { AttentionEntry } from "../shared/herald";
import { getAnnouncer, isMutedHere, onMuteChange, setMutedHere } from "./announcer";
import { refreshEntries, useEntries } from "./entries";
import { joinRows, type Row, type RowReason } from "./rows";
import { canPlaySpeech, speechPlatform } from "./speech";

export const PANEL_PATH = "waiting";

const TEST_SENTENCE = "This is Herald. Your agents will be announced like this.";

/** How often relative times and the fresh-entry grace are re-evaluated. */
const TICK_MS = 15_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

interface ReasonLook {
  icon: string;
  label: string;
  className: string;
}

function lookOf(reason: RowReason): ReasonLook {
  switch (reason) {
    case "question":
      return { icon: "MessageCircle", label: "Question", className: "text-foreground" };
    case "plan":
      return { icon: "ClipboardList", label: "Plan to approve", className: "text-foreground" };
    case "permission":
      return { icon: "Shield", label: "Permission", className: "text-warning-text" };
    case "input":
      return { icon: "MessageCircle", label: "Waiting for input", className: "text-foreground" };
    case "finished":
      return { icon: "Check", label: "Finished", className: "text-success" };
    case "error":
      return { icon: "X", label: "Error", className: "text-destructive" };
    case "attention":
      return { icon: "Megaphone", label: "Needs you", className: "text-foreground" };
  }
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The rows the panel and the sidebar badge both count. */
export function useRows(): { rows: Row[] | null; error: string | null } {
  const { entries, error } = useEntries();
  const sidebar = experimental_useSidebarThreads();
  const now = useNow();
  const rows = useMemo(
    () => (entries === null ? null : joinRows(entries, sidebar.status === "ready" ? sidebar.threads : null, now)),
    [entries, sidebar.status, sidebar.threads, now],
  );
  return { rows, error };
}

function useMutedHere(): boolean {
  return useSyncExternalStore(onMuteChange, isMutedHere);
}

/** Says an entry, or a plain line for a thread Herald has no entry for, and shows why a press stayed quiet. */
export async function speakRow(entry: AttentionEntry | null, title: string): Promise<void> {
  const announcer = getAnnouncer();
  if (announcer === null) return;
  try {
    const blocked =
      entry === null
        ? await announcer.speakText(`${title} is waiting for you.`)
        : await announcer.speakEntry(entry, `${title}: ${entry.headline}`);
    if (blocked !== null) toast.info(blocked);
  } catch (error) {
    toast.error(errorText(error));
  }
}

function Summary({ entry }: { entry: AttentionEntry | null }): ReactNode {
  if (entry === null) return <p className="text-sm text-muted-foreground">No summary from Herald for this one.</p>;
  switch (entry.summary.status) {
    case "pending":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name="Loader2" className="size-3.5 animate-spin" aria-hidden />
          Writing the summary…
        </p>
      );
    case "ready":
      return <p className="text-sm italic text-foreground">{entry.summary.text}</p>;
    case "failed":
      return (
        <div className="space-y-0.5">
          <p className="text-sm italic text-muted-foreground">{entry.summary.fallback}</p>
          <p className="text-xs text-muted-foreground">Summary failed: {entry.summary.error}</p>
        </div>
      );
    case "off":
      return (
        <p className="text-xs text-muted-foreground">
          Not announced: this kind of event is switched off, or the thread that started this one speaks for it.
        </p>
      );
  }
}

function RowCard({ row, now, onOpen }: { row: Row; now: number; onOpen: (threadId: string) => void }) {
  const look = lookOf(row.reason);
  const entry = row.entry;
  const speakable = canPlaySpeech() && (entry === null || entry.summary.status === "ready" || entry.summary.status === "failed");
  const open = () => onOpen(row.threadId);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open ${row.title}`}
      onClick={open}
      onKeyDown={onKeyDown}
      className="cursor-pointer space-y-2 rounded-lg border border-border bg-card p-3 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-semibold", look.className)}>
          <Icon name={look.icon} className="size-3.5" aria-hidden />
          {look.label}
        </span>
        <span className="min-w-0 truncate text-sm font-semibold">{row.title}</span>
        {speakable ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={`Speak the summary for ${row.title}`}
            onClick={(event) => {
              event.stopPropagation();
              void speakRow(entry, row.title);
            }}
          >
            <Icon name="Volume2" />
          </Button>
        ) : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(row.at, now)}</span>
      </div>
      {entry?.lastRequest ? <p className="truncate text-xs text-muted-foreground">{entry.lastRequest}</p> : null}
      {entry === null ? null : (
        <div className="space-y-0.5">
          <p className="text-sm">{entry.headline}</p>
          {entry.detail === null ? null : <p className="line-clamp-4 text-xs text-muted-foreground">{entry.detail}</p>}
        </div>
      )}
      <Summary entry={entry} />
    </div>
  );
}

function hintFor(): string | null {
  if (!canPlaySpeech()) return "This device can neither play audio nor speak, so summaries can only be read here.";
  switch (speechPlatform()) {
    case "desktop":
      return null;
    case "browser":
      return "In a browser tab, press Test voice once so the page is allowed to speak.";
    case "mobile":
      return "The mobile app speaks only while it is open on screen, after one press of Test voice, and only when Speak in the mobile app is on in Herald's settings.";
  }
}

export function HeraldPanel() {
  const { rows, error } = useRows();
  const navigate = useBbNavigate();
  const muted = useMutedHere();
  const now = useNow();
  const [testing, setTesting] = useState(false);
  const playable = canPlaySpeech();
  const hint = hintFor();

  async function onTest() {
    const announcer = getAnnouncer();
    if (announcer === null) return;
    setTesting(true);
    try {
      await announcer.speakText(TEST_SENTENCE, { force: true });
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="Megaphone" className="size-4" aria-hidden />
        <h1 className="text-sm font-semibold">Herald</h1>
        {rows !== null && rows.length > 0 ? <Badge variant="secondary">{rows.length}</Badge> : null}
        <div className="flex-1" />
        {playable ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={muted}
              aria-label={muted ? "Unmute on this device" : "Mute on this device"}
              onClick={() => setMutedHere(!muted)}
            >
              <Icon name={muted ? "VolumeX" : "Volume2"} />
              <span className="hidden sm:inline">{muted ? "Muted here" : "Mute here"}</span>
            </Button>
            <Button variant="ghost" size="sm" aria-label="Test voice" disabled={testing} onClick={() => void onTest()}>
              <Icon name="Play" />
              <span className="hidden sm:inline">Test voice</span>
            </Button>
          </>
        ) : null}
        <Button variant="ghost" size="icon" className="size-8" aria-label="Refresh" onClick={refreshEntries}>
          <Icon name="RefreshCw" />
        </Button>
      </div>
      {hint === null ? null : <p className="px-3 pt-2 text-xs text-muted-foreground">{hint}</p>}
      {error === null ? null : (
        <p className="mx-3 mt-2 rounded-md border border-destructive p-2 text-xs text-destructive">{error}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {rows === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="space-y-1 p-6 text-center">
              <p className="text-sm font-semibold">Nothing needs you right now</p>
              <p className="text-sm text-muted-foreground">
                When an agent asks a question, waits for an approval, finishes or fails, it shows up here with a one-sentence
                summary. Herald's settings are in Settings → Plugins → Herald.
              </p>
            </div>
          ) : (
            rows.map((row) => <RowCard key={row.threadId} row={row} now={now} onOpen={(id) => navigate.toThread(id)} />)
          )}
        </div>
      </div>
    </div>
  );
}

/** The count beside the panel's sidebar entry. */
export function WaitingCount() {
  const { rows } = useRows();
  if (rows === null || rows.length === 0) return null;
  return <span className="text-xs text-muted-foreground">{rows.length}</span>;
}
