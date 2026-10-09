/**
 * The Mac picker, in the page's title bar: a dot and the picked Mac's name,
 * opening a menu of every machine with its state (On, Live, Screen Sharing
 * off, Offline…). bb's menu turns into a sheet on a compact viewport, and the
 * name truncates, so it fits a narrow window.
 */
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { currentHost, hostDirectory, hostNote, useHostDirectory, type Tone } from "./hosts";
import { useSessions } from "./sessions";
import { screenSessions } from "./session-store";

const DOT: Record<Tone, string> = {
  live: "bg-destructive",
  on: "bg-success",
  warning: "bg-warning",
  neutral: "bg-muted-foreground/50",
};

const TEXT: Record<Tone, string> = {
  live: "text-destructive",
  on: "text-success",
  warning: "text-warning-text",
  neutral: "text-muted-foreground",
};

function Dot({ tone }: { tone: Tone }) {
  return <span className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />;
}

/** The Macs with a live session in this window, read again whenever one starts or ends. */
export function useLiveHere(): string[] {
  useSyncExternalStore(screenSessions.subscribe, screenSessions.getVersion);
  return screenSessions.liveHostIds();
}

/** Macs with a session open here or anywhere else. */
export function useLiveHosts(): Set<string> {
  const liveHere = useLiveHere();
  const sessions = useSessions();
  return new Set([...liveHere, ...sessions.map((session) => session.hostId)]);
}

export function HostPicker() {
  const directory = useHostDirectory();
  const liveHere = useLiveHere();
  const live = useLiveHosts();
  const picked = currentHost(directory, liveHere);
  if (directory.hosts === null || picked === undefined) return null;
  const note = hostNote(picked, directory.checks[picked.id], live.has(picked.id));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="ghost" aria-label={`Mac: ${picked.name}, ${note.text}`} className="min-w-0 max-w-56">
          <Dot tone={note.tone} />
          <span className="min-w-0 truncate">{picked.name}</span>
          <Icon name="ChevronDown" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 max-w-80">
        {directory.hosts.map((host) => {
          const entry = hostNote(host, directory.checks[host.id], live.has(host.id));
          return (
            <DropdownMenuItem key={host.id} onSelect={() => hostDirectory.pick(host.id)}>
              <Dot tone={entry.tone} />
              <span className="min-w-0 flex-1 truncate">{host.name}</span>
              <span className={`shrink-0 text-xs ${TEXT[entry.tone]}`}>{entry.text}</span>
              <span className="flex w-4 shrink-0 justify-end">{host.id === picked.id ? <Icon name="Check" /> : null}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
