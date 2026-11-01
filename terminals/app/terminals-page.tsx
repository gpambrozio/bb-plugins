/**
 * The Terminals page: a strip of tabs, one shell each, with "+" at its end.
 *
 * The tab list comes from the server and is the same in every window; which
 * tab is shown is this window's own (app/selection.ts). Each tab's terminal
 * lives in app/live-terminals.ts, outside this component, so leaving the page
 * and coming back finds every shell where it was.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_useCodeTheme,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";

import type { RpcContract } from "../shared/contract";
import { plusAction } from "../shared/host-choice";
import { MAX_TAB_NAME, TABS_CHANGED, isPending, normalizeTabName, tabLabels, type HostChoice, type TabView } from "../shared/tabs";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { ConnectionStatus } from "./connection";
import { applyThemeToAll, liveTerminal, releaseClosedTerminals, type TerminalsBackend } from "./live-terminals";
import { resolveSelection, selectionAfterClose, windowSelection } from "./selection";

export const PANEL_PATH = "terminals";

/** The size a new shell starts at; the tab resizes it as soon as it is on screen. */
const INITIAL_SIZE = { cols: 100, rows: 30 };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The open tabs, kept current by the server's signal and refetched after a
 * reconnect. Reads can overlap and answer out of order, so only the latest
 * one counts, and a change this window shows before the server confirms it
 * makes every read already on its way out of date (`invalidate`).
 */
function useTabs() {
  const rpc = useRpc<RpcContract>();
  const [tabs, setTabs] = useState<TabView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current += 1;
  }, []);
  const refetch = useCallback(() => {
    const mine = ++generation.current;
    rpc.call("list", {}).then(
      (result) => {
        if (mine !== generation.current) return;
        setTabs(result.tabs);
        setError(null);
      },
      (cause: unknown) => {
        if (mine === generation.current) setError(message(cause));
      },
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(TABS_CHANGED, refetch);
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    // A signal sent while the realtime link was down is lost; read the list again.
    if (connection === "connected" && !wasConnected.current) refetch();
    wasConnected.current = connection === "connected";
  }, [connection, refetch]);
  return { rpc, tabs, setTabs, error, setError, refetch, invalidate };
}

const OPENING_STATUS: ConnectionStatus = { state: "connecting", exitCode: null };
const noSubscription = () => () => undefined;

/**
 * The tab's live connection status. A tab whose shell bb is still opening has
 * no terminal yet: attaching now would hear "not found" and end it.
 */
function useConnectionStatus(terminalId: string, opening: boolean): ConnectionStatus {
  const backend = useTerminalsBackend();
  const terminal = opening ? null : liveTerminal(terminalId, backend);
  const subscribe = useCallback(
    (notify: () => void) => (terminal === null ? noSubscription() : terminal.onStatus(notify)),
    [terminal],
  );
  return useSyncExternalStore(subscribe, () => (terminal === null ? OPENING_STATUS : terminal.status()));
}

/**
 * bb's terminal calls, for the tabs' terminals. The same object on every
 * render, so the effects that take it do not reattach the terminal.
 */
function useTerminalsBackend(): TerminalsBackend {
  const sdk = useSdk();
  const latest = useRef(sdk);
  latest.current = sdk;
  return useMemo<TerminalsBackend>(
    () => ({
      output: (args) => latest.current.terminals.output(args),
      resize: (args) => latest.current.terminals.resize(args),
    }),
    [],
  );
}

/** How often the page reads the list again while a tab's shell is still opening. */
const OPENING_POLL_MS = 2_000;

export function TerminalsPage(_props: PluginNavPanelProps) {
  const { rpc, tabs, setTabs, error, setError, refetch, invalidate } = useTabs();
  const [selected, setSelectedState] = useState<string | null>(() => windowSelection.get());
  const [opening, setOpening] = useState(false);
  const [hostMenu, setHostMenu] = useState<HostChoice[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tabIds = useMemo(() => (tabs ?? []).map((tab) => tab.terminalId), [tabs]);
  const shown = tabs === null ? null : resolveSelection(tabIds, selected);
  const labels = useMemo(() => tabLabels(tabs ?? []), [tabs]);

  const select = useCallback((terminalId: string | null) => {
    windowSelection.set(terminalId);
    setSelectedState(terminalId);
  }, []);

  // Start every open tab's terminal, so tabs out of sight keep their output, and let go of closed ones.
  const backend = useTerminalsBackend();
  useEffect(() => {
    if (tabs === null) return;
    for (const tab of tabs) if (!isPending(tab.status)) liveTerminal(tab.terminalId, backend);
    releaseClosedTerminals(new Set(tabIds));
  }, [tabs, tabIds, backend]);

  // A shell bb is still opening (here, in another window, or for a reloaded copy of the plugin):
  // look again until it runs.
  const anyOpening = tabs?.some((tab) => isPending(tab.status)) ?? false;
  useEffect(() => {
    if (!anyOpening) return;
    const timer = setTimeout(refetch, OPENING_POLL_MS);
    return () => clearTimeout(timer);
  }, [anyOpening, tabs, refetch]);

  const { mode, name } = experimental_useCodeTheme();
  useEffect(() => {
    // After bb has applied the new theme's variables, which it may do after this render.
    const frame = requestAnimationFrame(applyThemeToAll);
    return () => cancelAnimationFrame(frame);
  }, [mode, name]);

  const openOn = useCallback(
    async (hostId: string) => {
      setHostMenu(null);
      setOpening(true);
      setNotice(null);
      try {
        const tab = await rpc.call("open", { hostId, ...INITIAL_SIZE });
        setTabs((current) => (current?.some((entry) => entry.terminalId === tab.terminalId) ? current : [...(current ?? []), tab]));
        select(tab.terminalId);
        // Any read that started before the tab was stored would drop it again.
        refetch();
      } catch (cause) {
        setNotice(`Could not open a terminal: ${message(cause)}`);
      } finally {
        setOpening(false);
      }
    },
    [rpc, select, setTabs, refetch],
  );

  const plus = useCallback(async () => {
    if (opening) return;
    setNotice(null);
    let hosts: HostChoice[];
    try {
      hosts = (await rpc.call("hosts", {})).hosts;
    } catch (cause) {
      setNotice(`Could not list machines: ${message(cause)}`);
      return;
    }
    const action = plusAction(hosts);
    if (action.kind === "none") setNotice("No machine is connected to bb right now.");
    else if (action.kind === "open") await openOn(action.hostId);
    else setHostMenu(action.hosts);
  }, [opening, openOn, rpc]);

  const rename = useCallback(
    async (terminalId: string, typed: string) => {
      const name = normalizeTabName(typed);
      const current = tabs?.find((tab) => tab.terminalId === terminalId);
      if (current === undefined || current.name === name) return;
      setNotice(null);
      // Shown at once; the server's signal brings the same name to every other window.
      invalidate();
      setTabs((list) => list?.map((tab) => (tab.terminalId === terminalId ? { ...tab, name } : tab)) ?? list);
      try {
        await rpc.call("rename", { terminalId, name });
      } catch (cause) {
        setNotice(`Could not rename the terminal: ${message(cause)}`);
      }
      // A read that started while the name was on its way would bring back the old one.
      refetch();
    },
    [rpc, tabs, setTabs, refetch, invalidate],
  );

  const close = useCallback(
    async (terminalId: string) => {
      setNotice(null);
      try {
        await rpc.call("close", { terminalId });
        select(selectionAfterClose(tabIds, terminalId, shown));
        setTabs((current) => current?.filter((tab) => tab.terminalId !== terminalId) ?? current);
      } catch (cause) {
        setNotice(`Could not close the terminal: ${message(cause)}`);
      }
      // A read that started before the tab was removed would bring it (and its terminal) back.
      refetch();
    },
    [rpc, select, tabIds, shown, setTabs, refetch],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Terminals" className="flex min-h-10 items-stretch overflow-x-auto border-b border-border">
        {(tabs ?? []).map((tab) => (
          <TabButton
            key={tab.terminalId}
            tab={tab}
            label={labels.get(tab.terminalId) ?? tab.hostName}
            selected={tab.terminalId === shown}
            onSelect={() => select(tab.terminalId)}
            onRename={(name) => void rename(tab.terminalId, name)}
            onClose={() => void close(tab.terminalId)}
          />
        ))}
        <DropdownMenu
          open={hostMenu !== null}
          onOpenChange={(open) => {
            if (open) void plus();
            else setHostMenu(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="m-1 h-8 w-8 shrink-0 px-0"
              aria-label="New terminal"
              disabled={opening || tabs === null}
            >
              <Icon name={opening ? "Spinner" : "Plus"} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" mobileTitle="Open a terminal on">
            <DropdownMenuLabel>Open a terminal on</DropdownMenuLabel>
            {(hostMenu ?? []).map((host) => (
              <DropdownMenuItem key={host.id} onSelect={() => void openOn(host.id)}>
                <Icon name="Laptop" />
                {host.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {notice !== null || error !== null ? (
        <div role="alert" className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-destructive">
          <Icon name="AlertTriangle" />
          <span className="min-w-0 flex-1">{notice ?? `Could not load the terminals: ${error}`}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => {
              setNotice(null);
              setError(null);
              if (error !== null) refetch();
            }}
          >
            {error !== null && notice === null ? "Retry" : "Dismiss"}
          </Button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-sidebar">
        {shown !== null && isPending(tabs?.find((tab) => tab.terminalId === shown)?.status ?? "running") ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Icon name="Spinner" />
            Starting the shell…
          </div>
        ) : shown !== null ? (
          <TerminalView key={shown} terminalId={shown} onClose={() => void close(shown)} />
        ) : tabs === null ? null : (
          <EmptyState opening={opening} onOpen={() => void plus()} />
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  if (status.state === "live") return null;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status.state === "ended" ? "bg-muted-foreground" : "bg-warning",
      )}
    />
  );
}

function TabButton({
  tab,
  label,
  selected,
  onSelect,
  onRename,
  onClose,
}: {
  tab: TabView;
  label: string;
  selected: boolean;
  onSelect: () => void;
  /** Saves a name; an empty one brings back the default title. */
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const opening = isPending(tab.status);
  const status = useConnectionStatus(tab.terminalId, opening);
  const [editing, setEditing] = useState(false);
  const tabButton = useRef<HTMLButtonElement>(null);
  const startEditing = useCallback(() => setEditing(true), []);
  const stopEditing = useCallback((name: string | null) => {
    setEditing(false);
    // Saving the default title untouched is no rename: it would stop following the tab's number.
    const unchanged = name === null || (tab.name === null && normalizeTabName(name) === label);
    if (!unchanged) onRename(name);
    // Back to the tab when the field took focus with it (Enter, Escape), not to wherever the browser
    // would put it. A frame later focus may already be somewhere the user chose — another tab's
    // rename field, the shell — and taking it from there would close that field unsaved.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) tabButton.current?.focus({ preventScroll: true });
    });
  }, [onRename, tab.name, label]);
  const where = tab.name === null ? label : `${label} — ${tab.hostName}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-selected={selected ? "" : undefined}
          className={cn(
            "group relative flex max-w-56 shrink-0 items-center gap-1 border-r border-border pl-3 pr-1 text-sm",
            // bb's own tab pills: the selected one on the "active" fill in full-strength text, the
            // others dimmer and only tinted on hover. The bar under it marks it even at a glance.
            selected
              ? "bg-state-active font-medium text-foreground"
              : "text-subtle-foreground hover:bg-state-hover hover:text-foreground",
          )}
        >
          {selected ? (
            <span aria-hidden data-tab-indicator className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
          ) : null}
          {editing ? (
            <TabNameEditor initial={tab.name ?? label} label={label} onDone={stopEditing} />
          ) : (
            <button
              ref={tabButton}
              type="button"
              role="tab"
              aria-selected={selected}
              className="flex min-w-0 items-center gap-2 py-2 outline-none focus-visible:underline"
              onClick={onSelect}
              onDoubleClick={startEditing}
              onKeyDown={(event) => {
                // F2 renames, as it renames a file or a terminal tab elsewhere.
                if (event.key === "F2") {
                  event.preventDefault();
                  startEditing();
                }
              }}
              onAuxClick={(event) => {
                // A middle click closes the tab, as in a browser or a terminal app.
                if (event.button === 1) onClose();
              }}
              title={status.state === "ended" ? `${where} (ended)` : status.state === "offline" ? `${where} (offline)` : where}
            >
              {opening ? <Icon name="Spinner" className="size-3 shrink-0" /> : <StatusDot status={status} />}
              <span className="truncate">{label}</span>
            </button>
          )}
          <button
            type="button"
            aria-label={`Close ${label}`}
            className={cn(
              "rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground",
              selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
            onClick={onClose}
          >
            <Icon name="X" className="size-3.5" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        // The editor takes focus itself; the menu must not hand it back to the tab.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuItem onSelect={startEditing}>
          <Icon name="Edit" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={onClose}>
          <Icon name="X" />
          Close tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The tab's title as a text field: Enter or leaving the field saves, Escape
 * keeps the old name, and an empty name brings back the default title.
 */
function TabNameEditor({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = useCallback(
    (name: string | null) => {
      if (done.current) return;
      done.current = true;
      onDone(name);
    },
    [onDone],
  );
  useEffect(() => {
    // After a menu that closed in the same click has finished moving focus.
    const timer = setTimeout(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <input
      ref={input}
      aria-label={`Rename ${label}`}
      value={value}
      maxLength={MAX_TAB_NAME}
      size={Math.max(8, Math.min(28, value.length + 1))}
      className="my-1 min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        // Keep Enter and Escape from bb's own shortcuts (Escape leaves the page).
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          finish(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}

function TerminalView({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const status = useConnectionStatus(terminalId, false);
  const backend = useTerminalsBackend();

  useLayoutEffect(() => {
    const parent = container.current;
    if (parent === null) return;
    const terminal = liveTerminal(terminalId, backend);
    terminal.attach(parent);
    terminal.focus();
    const observer = new ResizeObserver(() => terminal.fit());
    observer.observe(parent);
    // Back to this window: it is the one in use, so the shell takes its size again (app/sizing.ts).
    const refit = () => {
      if (document.visibilityState === "visible") terminal.fit();
    };
    window.addEventListener("focus", refit);
    document.addEventListener("visibilitychange", refit);
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", refit);
      document.removeEventListener("visibilitychange", refit);
      terminal.detach();
    };
  }, [terminalId, backend]);

  return (
    <div className="absolute inset-0 flex flex-col">
      {status.state === "offline" ? (
        <div className="flex items-center gap-2 border-b border-warning px-3 py-1.5 text-xs text-warning-text">
          <Icon name="Spinner" />
          This machine is offline. The shell picks up where it was when it reconnects.
        </div>
      ) : null}
      {status.state === "ended" ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            {status.exitCode === null ? "This shell has ended." : `This shell exited with code ${status.exitCode}.`}
          </span>
          <Button type="button" variant="outline" size="sm" className="h-6 px-2" onClick={onClose}>
            Close tab
          </Button>
        </div>
      ) : null}
      <div ref={container} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}

function EmptyState({ opening, onOpen }: { opening: boolean; onOpen: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="Terminal" className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No terminals open. A new one starts in your home folder.</p>
      <Button type="button" variant="outline" size="sm" onClick={onOpen} disabled={opening}>
        <Icon name={opening ? "Spinner" : "Plus"} />
        New terminal
      </Button>
    </div>
  );
}
