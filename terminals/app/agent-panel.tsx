/**
 * The agent panel beside a terminal: the tab's helper thread as bb's own
 * chat (`ThreadChat`), or — before it has one — bb's new-thread composer,
 * starting on what the terminal showed or the command that failed, in the
 * project whose checkout holds the shell's directory. Sending it starts the
 * thread on the server (`startAgent`), which links it to the tab: only that
 * thread can read and type into the tab.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ThreadChat,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRpc,
  type NewThreadComposerProps,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";

import type { RpcContract } from "../shared/contract";
import type { ListedTab } from "../shared/tabs";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import { useProjectPlaces } from "./add-to-chat-dialog";
import { windowAgentPanel, type AgentPanelStore } from "./agent-state";
import { defaultProject, lastProject, projectForDirectory, type ProjectPlace } from "./project-match";

type EnvironmentSeed = NonNullable<NewThreadComposerProps["defaultEnvironment"]>;

/**
 * Where a tab's new helper thread starts: the project whose checkout or
 * worktree holds the shell's directory on the tab's machine, else the one
 * picked last time, else the most recent thread's; and, when that project
 * has a checkout on the tab's machine, that checkout — so the agent reads the
 * files the user is working on. No environment seed otherwise: the composer
 * picks bb's default for the project.
 */
export function agentDefaults(options: {
  cwd: string | null;
  hostId: string;
  places: readonly ProjectPlace[];
  checkouts: readonly ProjectPlace[];
  available: readonly string[];
  lastUsed: string | null;
  mostRecentThread: string | null;
}): { projectId: string | null; environment: EnvironmentSeed | null } {
  const fromDirectory = projectForDirectory(options.cwd, options.hostId, options.places);
  const projectId = defaultProject({
    available: options.available,
    fromDirectory,
    lastUsed: options.lastUsed,
    mostRecentThread: options.mostRecentThread,
  });
  const onMachine =
    projectId !== null &&
    projectId === fromDirectory &&
    options.checkouts.some((place) => place.projectId === projectId && place.hostId === options.hostId);
  return {
    projectId,
    environment: onMachine ? { type: "host", hostId: options.hostId, workspace: { type: "unmanaged", path: null } } : null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AgentPanel({
  tab,
  label,
  cwd,
  onClose,
  onLinked,
  store = windowAgentPanel,
}: {
  tab: ListedTab;
  /** The tab's title as the strip shows it. */
  label: string;
  /** The shell's directory, when it has said. */
  cwd: string | null;
  onClose: () => void;
  /** The tab's helper thread changed (started, or let go of). */
  onLinked: (threadId: string | null) => void;
  store?: AgentPanelStore;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const threadId = tab.agentThreadId;
  useEffect(() => {
    setError(null);
    setFocus((value) => value + 1);
  }, [tab.terminalId, threadId]);

  /** "Open in bb": the chat starts hidden from the sidebar, so it is shown there for good first. */
  const openAsThread = async (id: string) => {
    setError(null);
    try {
      await rpc.call("showAgentChat", { terminalId: tab.terminalId });
    } catch (cause) {
      // bb opens a hidden thread all the same; it just stays out of the sidebar.
      setError(`Could not show the chat in the sidebar: ${message(cause)}`);
    }
    navigate.toThread(id);
  };

  const forget = async () => {
    setError(null);
    try {
      await rpc.call("forgetAgent", { terminalId: tab.terminalId });
      onLinked(null);
    } catch (cause) {
      setError(`Could not start a new chat: ${message(cause)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-agent-panel="">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <Icon name="Bot" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={`Agent for ${label}`}>
          Agent · {label}
        </span>
        {threadId === null ? null : (
          <>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" aria-label="Open the chat in bb" onClick={() => void openAsThread(threadId)}>
              <Icon name="ExternalLink" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" aria-label="New agent chat" onClick={() => void forget()}>
              <Icon name="MessageSquarePlus" />
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" aria-label="Close the agent panel" onClick={onClose}>
          <Icon name="X" />
        </Button>
      </div>
      {error === null ? null : (
        <div role="alert" className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-destructive">
          <Icon name="AlertTriangle" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {threadId !== null ? (
          <ThreadChat key={threadId} threadId={threadId} variant="compact" focusRequest={focus} />
        ) : (
          <StartAgent
            key={tab.terminalId}
            tab={tab}
            cwd={cwd}
            store={store}
            focus={focus}
            onStart={async (request) => {
              setError(null);
              try {
                const started = await rpc.call("startAgent", { terminalId: tab.terminalId, request: request as unknown as Record<string, unknown> });
                lastProject.set(request.projectId);
                store.clearSeed(tab.terminalId);
                onLinked(started.threadId);
              } catch (cause) {
                setError(`Could not start the agent: ${message(cause)}`);
                // The composer keeps the draft when this throws.
                throw cause;
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function StartAgent({
  tab,
  cwd,
  store,
  focus,
  onStart,
}: {
  tab: ListedTab;
  cwd: string | null;
  store: AgentPanelStore;
  focus: number;
  onStart: (request: NewThreadRequest) => Promise<void>;
}) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const seed = state.seeds.get(tab.terminalId) ?? null;
  const sidebar = experimental_useSidebarThreads();
  const { places, checkouts, loaded } = useProjectPlaces(true, sidebar.threads);
  const mostRecentThread = useMemo(
    () => [...sidebar.threads].filter((thread) => !thread.isArchived && !thread.isHidden).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.projectId ?? null,
    [sidebar.threads],
  );
  // Worked out once, when the checkouts are known: changing a seed later would re-seed every pick the user made.
  const [defaults, setDefaults] = useState<ReturnType<typeof agentDefaults> | null>(null);
  useEffect(() => {
    if (defaults !== null || !loaded || sidebar.status === "loading") return;
    setDefaults(
      agentDefaults({
        cwd,
        hostId: tab.hostId,
        places,
        checkouts,
        available: sidebar.projects.map((project) => project.id),
        lastUsed: lastProject.get(),
        mostRecentThread,
      }),
    );
  }, [defaults, loaded, sidebar.status, sidebar.projects, cwd, tab.hostId, places, checkouts, mostRecentThread]);

  if (defaults === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Icon name="Spinner" />
        Getting the agent ready…
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <p className="text-xs text-muted-foreground">
        The agent sees this message, and can read this terminal and run commands in it, which you will see here.
      </p>
      <div className="min-h-0 flex-1">
        <NewThreadComposer
          key={seed?.draftKey ?? "empty"}
          draftKey={seed?.draftKey ?? `terminals-agent:${tab.terminalId}`}
          initialPrompt={seed?.prompt ?? ""}
          placeholder="Ask the agent about this terminal"
          focusRequest={focus}
          {...(defaults.projectId === null ? {} : { defaultProjectId: defaults.projectId })}
          {...(defaults.environment === null ? {} : { defaultEnvironment: defaults.environment })}
          onSubmit={onStart}
        />
      </div>
    </div>
  );
}
