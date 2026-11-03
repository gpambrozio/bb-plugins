/**
 * "Add to chat" from a terminal tab: a tab belongs to no thread, so the user
 * picks one — an open thread (searchable, most recent first, with its
 * project), or a new thread in a project, which starts on the project whose
 * checkout holds the shell's directory, else the one picked last time.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads,
  useSdk,
  type PluginSidebarProject,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { DeliveryTarget } from "./chat-delivery";
import type { SelectionSource } from "./chat-text";
import { defaultProject, lastProject, projectForDirectory, type ProjectPlace } from "./project-match";

/** At most this many threads are listed at once; searching narrows the rest. */
export const MAX_LISTED_THREADS = 100;

export interface AddToChatRequest {
  text: string;
  source: SelectionSource;
  /** The tab's machine, where its directory is. */
  hostId: string;
  /** The shell's working directory, when it has said. */
  cwd: string | null;
}

/** The threads the selector offers: open, shown in bb's list, most recently active first. */
export function listedThreads(threads: readonly PluginSidebarThread[]): PluginSidebarThread[] {
  return threads.filter((thread) => !thread.isArchived && !thread.isHidden).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The threads whose title or project matches every word of `query`. */
export function matchThreads(
  threads: readonly PluginSidebarThread[],
  projectNames: ReadonlyMap<string, string>,
  query: string,
): PluginSidebarThread[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [...threads];
  return threads.filter((thread) => {
    const haystack = `${thread.displayTitle} ${projectNames.get(thread.projectId) ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The directories bb knows for each project: its checkouts, and the worktrees its threads run in. */
function usePlaces(open: boolean, threads: readonly PluginSidebarThread[]): ProjectPlace[] {
  const sdk = useSdk();
  const [sources, setSources] = useState<ProjectPlace[]>([]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    sdk.projects.list({ includePersonal: true }).then(
      (projects) => {
        if (!current) return;
        setSources(
          projects.flatMap((project) =>
            project.sources.map((source) => ({ projectId: project.id, hostId: source.hostId, path: source.path })),
          ),
        );
      },
      (cause: unknown) => console.warn("terminals: could not list the projects' checkouts", cause),
    );
    return () => {
      current = false;
    };
  }, [open, sdk]);
  return useMemo(() => {
    const worktrees: ProjectPlace[] = [];
    for (const thread of threads) {
      const path = thread.environment?.path ?? null;
      const hostId = thread.host?.id ?? null;
      if (path !== null && hostId !== null) worktrees.push({ projectId: thread.projectId, hostId, path });
    }
    return [...sources, ...worktrees];
  }, [sources, threads]);
}

export function AddToChatDialog({
  request,
  onOpenChange,
  onSend,
}: {
  /** The selection to add; null while the dialog is closed. */
  request: AddToChatRequest | null;
  onOpenChange: (open: boolean) => void;
  onSend: (target: DeliveryTarget) => void;
}) {
  const open = request !== null;
  const sidebar = experimental_useSidebarThreads();
  const threads = useMemo(() => listedThreads(sidebar.threads), [sidebar.threads]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((project) => [project.id, project.name])), [sidebar.projects]);
  const places = usePlaces(open, sidebar.threads);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  /** The user picked the project by hand: a late answer about the checkouts must not move it. */
  const pickedProject = useRef(false);
  const search = useRef<HTMLInputElement>(null);

  const fromDirectory = request === null ? null : projectForDirectory(request.cwd, request.hostId, places);
  const suggested = defaultProject({
    available: sidebar.projects.map((project) => project.id),
    fromDirectory,
    lastUsed: lastProject.get(),
    mostRecentThread: threads[0]?.projectId ?? null,
  });

  // Each opening starts afresh: no search, the first row, the suggested project.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    pickedProject.current = false;
  }, [open]);
  useEffect(() => {
    if (open && !pickedProject.current) setProjectId(suggested);
  }, [open, suggested]);

  const matches = useMemo(() => matchThreads(threads, projectNames, query), [threads, projectNames, query]);
  const shown = matches.slice(0, MAX_LISTED_THREADS);
  // Row 0 is "New thread"; the threads follow.
  const rowCount = shown.length + 1;
  const activeRow = Math.min(active, rowCount - 1);

  const sendNew = () => {
    if (projectId === null) return;
    lastProject.set(projectId);
    onSend({ kind: "new-thread", projectId });
  };
  const sendTo = (thread: PluginSidebarThread) => onSend({ kind: "thread", threadId: thread.id });
  const choose = (row: number) => {
    if (row === 0) sendNew();
    else {
      const thread = shown[row - 1];
      if (thread !== undefined) sendTo(thread);
    }
  };

  const lineCount = request === null ? 0 : request.text.trim().split("\n").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3" onOpenAutoFocus={(event) => {
        event.preventDefault();
        search.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>Add to chat</DialogTitle>
          <DialogDescription>
            {request === null
              ? null
              : `${lineCount === 1 ? "1 line" : `${lineCount} lines`} from ${request.source.tabLabel}${
                  request.source.tabLabel.startsWith(request.source.hostName) ? "" : ` on ${request.source.hostName}`
                }. It goes into the chat's message box for you to send.`}
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={search}
          aria-label="Search threads"
          placeholder="Search threads"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive(Math.min(activeRow + 1, rowCount - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive(Math.max(activeRow - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(activeRow);
            }
          }}
        />
        <div role="listbox" aria-label="Threads" className="-mx-1 max-h-80 overflow-y-auto">
          <NewThreadRow
            active={activeRow === 0}
            projects={sidebar.projects}
            projectId={projectId}
            onProject={(id) => {
              pickedProject.current = true;
              setProjectId(id);
            }}
            onChoose={sendNew}
            onHover={() => setActive(0)}
          />
          {shown.map((thread, index) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              projectName={projectNames.get(thread.projectId) ?? null}
              active={activeRow === index + 1}
              onChoose={() => sendTo(thread)}
              onHover={() => setActive(index + 1)}
            />
          ))}
          {sidebar.status === "loading" && threads.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Loading threads…</p>
          ) : shown.length === 0 && query.trim() !== "" ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No thread matches “{query.trim()}”.</p>
          ) : null}
          {matches.length > shown.length ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {matches.length - shown.length} more — search to find them.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ROW_CLASS = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none";

function ThreadRow({
  thread,
  projectName,
  active,
  onChoose,
  onHover,
}: {
  thread: PluginSidebarThread;
  projectName: string | null;
  active: boolean;
  onChoose: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={cn(ROW_CLASS, active ? "bg-state-hover" : "hover:bg-state-hover")}
      onClick={onChoose}
      onMouseMove={onHover}
    >
      <Icon name="MessageSquare" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{thread.displayTitle}</span>
      {projectName === null ? null : <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{projectName}</span>}
    </button>
  );
}

function NewThreadRow({
  active,
  projects,
  projectId,
  onProject,
  onChoose,
  onHover,
}: {
  active: boolean;
  projects: readonly PluginSidebarProject[];
  projectId: string | null;
  onProject: (projectId: string) => void;
  onChoose: () => void;
  onHover: () => void;
}) {
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  return (
    <div className={cn(ROW_CLASS, "p-0", active ? "bg-state-hover" : "hover:bg-state-hover")} onMouseMove={onHover}>
      <button
        type="button"
        role="option"
        aria-selected={active}
        disabled={project === null}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left outline-none disabled:opacity-50"
        onClick={onChoose}
      >
        <Icon name="MessageSquarePlus" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-foreground">New thread</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={project === null ? "Choose a project" : `Project: ${project.name}`}
            className="mr-1 flex max-w-[50%] shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-active hover:text-foreground"
          >
            <Icon name="Folder" className="size-3.5 shrink-0" />
            <span className="truncate">{project?.name ?? "Choose a project"}</span>
            <Icon name="ChevronDown" className="size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" mobileTitle="Start the thread in">
          {projects.map((entry) => (
            <DropdownMenuItem key={entry.id} onSelect={() => onProject(entry.id)}>
              <Icon name={entry.id === projectId ? "Check" : "Folder"} />
              {entry.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
