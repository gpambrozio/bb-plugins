/**
 * The Terminals page: a strip of tabs, one shell each, with "+" at its end.
 * The strip is bb's own (app/bb-tab-strip/): drag a tab to move it, for every
 * window.
 *
 * The tab list comes from the server and is the same in every window; which
 * tab is shown is this window's own (app/selection.ts). Each tab's terminal
 * lives in app/live-terminals.ts, outside this component, so leaving the page
 * and coming back finds every shell where it was.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_useCodeTheme,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";

import type { RpcContract } from "../shared/contract";
import { plusAction } from "../shared/host-choice";
import { MAX_TAB_NAME, TABS_CHANGED, isPending, moveTab, normalizeTabName, tabLabels, type HostChoice, type TabView } from "../shared/tabs";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import { AddToChatDialog, type AddToChatRequest } from "./add-to-chat-dialog";
import { TabStrip, type StripTab, type TabReorderRequest } from "./bb-tab-strip/tab-strip";
import { DELIVERY_TIMEOUT_MS, windowDeliveries, type DeliveryTarget } from "./chat-delivery";
import { terminalBlock } from "./chat-text";
import type { ConnectionStatus } from "./connection";
import { CopyOnSelectSetting } from "./copy-on-select";
import { applyThemeToAll, liveTerminal, releaseClosedTerminals, type LiveTerminal, type TerminalsBackend } from "./live-terminals";
import { resolveSelection, selectionAfterClose, windowSelection } from "./selection";
import { SelectionMenu, useTerminalSelection } from "./terminal-selection";

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
 * Every tab's live connection status, for the strip, which draws the tabs
 * from data rather than one component per tab.
 */
function useConnectionStatuses(tabs: readonly TabView[] | null): ReadonlyMap<string, ConnectionStatus> {
  const backend = useTerminalsBackend();
  const terminals = useMemo(
    () =>
      (tabs ?? []).map((tab) => ({
        terminalId: tab.terminalId,
        terminal: isPending(tab.status) ? null : liveTerminal(tab.terminalId, backend),
      })),
    [tabs, backend],
  );
  const subscribe = useCallback(
    (notify: () => void) => {
      const unsubscribes = terminals.map(({ terminal }) => terminal?.onStatus(notify));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe?.();
      };
    },
    [terminals],
  );
  // A status object is replaced, never changed in place, so the list of them says when any changed.
  const key = useSyncExternalStore(subscribe, () =>
    terminals.map(({ terminal }) => (terminal === null ? "opening" : `${terminal.status().state}:${terminal.status().exitCode}`)).join("|"),
  );
  return useMemo(() => {
    void key;
    return new Map(terminals.map(({ terminalId, terminal }) => [terminalId, terminal === null ? OPENING_STATUS : terminal.status()]));
  }, [terminals, key]);
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

/**
 * bb's "Copy on select" setting, read when the page opens and again as soon
 * as bb says its settings were saved; also when the window comes back to the
 * front, after the realtime link reconnects (a change event may have been
 * missed) and as each selection starts (app/copy-on-select.ts).
 */
function useCopyOnSelect(): CopyOnSelectSetting {
  const sdk = useSdk();
  const setting = useMemo(() => new CopyOnSelectSetting({ config: () => sdk.system.config() }), [sdk]);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") void setting.refresh();
  }, [setting, connection]);
  // bb saved its settings: read again at once, not after the freshness window.
  useEffect(() => sdk.subscribe({ event: "system:config-changed", callback: () => void setting.reload() }), [sdk, setting]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void setting.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [setting]);
  return setting;
}

/** How often the page reads the list again while a tab's shell is still opening. */
const OPENING_POLL_MS = 2_000;

export function TerminalsPage(_props: PluginNavPanelProps) {
  const { rpc, tabs, setTabs, error, setError, refetch, invalidate } = useTabs();
  const [selected, setSelectedState] = useState<string | null>(() => windowSelection.get());
  const [opening, setOpening] = useState(false);
  const [hostMenu, setHostMenu] = useState<HostChoice[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const copyOnSelect = useCopyOnSelect();

  const [renaming, setRenaming] = useState<string | null>(null);
  const tabIds = useMemo(() => (tabs ?? []).map((tab) => tab.terminalId), [tabs]);
  // The list as it is now, for a close that finishes after others changed it ("Close other tabs").
  const latestTabIds = useRef(tabIds);
  latestTabIds.current = tabIds;
  const shown = tabs === null ? null : resolveSelection(tabIds, selected);
  const labels = useMemo(() => tabLabels(tabs ?? []), [tabs]);
  const shownTab = tabs?.find((tab) => tab.terminalId === shown) ?? null;

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

  const move = useCallback(
    async ({ activeTabId, overTabId }: TabReorderRequest) => {
      setNotice(null);
      // Moved at once, so the dropped tab stays where it was dropped; the server's signal moves it in
      // every other window.
      invalidate();
      setTabs((list) => (list === null ? list : [...moveTab(list, activeTabId, overTabId)]));
      try {
        await rpc.call("move", { terminalId: activeTabId, toTerminalId: overTabId });
      } catch (cause) {
        setNotice(`Could not move the terminal: ${message(cause)}`);
      }
      // A read that started while the move was on its way would put the tab back.
      refetch();
    },
    [rpc, setTabs, refetch, invalidate],
  );

  const close = useCallback(
    async (terminalId: string) => {
      setNotice(null);
      try {
        await rpc.call("close", { terminalId });
        // The selection as it is now: closing several tabs at once moves it before each one ends.
        const ids = latestTabIds.current;
        select(selectionAfterClose(ids, terminalId, resolveSelection(ids, windowSelection.get())));
        setTabs((current) => current?.filter((tab) => tab.terminalId !== terminalId) ?? current);
      } catch (cause) {
        setNotice(`Could not close the terminal: ${message(cause)}`);
      }
      // A read that started before the tab was removed would bring it (and its terminal) back.
      refetch();
    },
    [rpc, select, setTabs, refetch],
  );

  const statuses = useConnectionStatuses(tabs);
  const stopRenaming = useCallback(
    (tab: TabView, label: string, typed: string | null) => {
      setRenaming(null);
      // Saving the default title untouched is no rename: it would stop following the tab's number.
      const unchanged = typed === null || (tab.name === null && normalizeTabName(typed) === label);
      if (!unchanged) void rename(tab.terminalId, typed);
      // Back to the tab when the field took focus with it (Enter, Escape), not to wherever the browser
      // would put it. A frame later focus may already be somewhere the user chose — another tab's
      // rename field, the shell — and taking it from there would close that field unsaved.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body) return;
        document.querySelector<HTMLButtonElement>(`[data-strip-tab="${tab.terminalId}"] button`)?.focus({ preventScroll: true });
      });
    },
    [rename],
  );
  const stripTabs = useMemo<StripTab[]>(
    () =>
      (tabs ?? []).map((tab) => {
        const label = labels.get(tab.terminalId) ?? tab.hostName;
        const status = statuses.get(tab.terminalId) ?? OPENING_STATUS;
        const pending = isPending(tab.status);
        const statusLabel = pending ? null : status.state === "ended" ? "ended" : status.state === "offline" ? "offline" : null;
        const where = tab.name === null ? label : `${label} — ${tab.hostName}`;
        return {
          id: tab.terminalId,
          label,
          leadingVisual: <Icon name={pending ? "Spinner" : "Terminal"} className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS} aria-hidden />,
          statusLabel,
          title: statusLabel === null ? where : `${where} (${statusLabel})`,
          onSelect: () => select(tab.terminalId),
          onClose: () => void close(tab.terminalId),
          onRename: () => setRenaming(tab.terminalId),
          editor:
            renaming === tab.terminalId ? (
              <TabNameEditor initial={tab.name ?? label} label={label} onDone={(typed) => stopRenaming(tab, label, typed)} />
            ) : null,
        };
      }),
    [tabs, labels, statuses, renaming, select, close, stopRenaming],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="toolbar"
        aria-label="Terminals"
        className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2"
      >
        {stripTabs.length > 0 ? <TabStrip activeTabId={shown} tabs={stripTabs} onReorderTab={(request) => void move(request)} /> : null}
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
              // bb's new tab button, as its panels draw it after their tab strip.
              className={cn(
                COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                "shrink-0 text-muted-foreground/70 hover:text-foreground focus:ring-1 focus:ring-ring",
              )}
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
        {shown !== null && isPending(shownTab?.status ?? "running") ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Icon name="Spinner" />
            Starting the shell…
          </div>
        ) : shown !== null ? (
          <TerminalView
            key={shown}
            terminalId={shown}
            hostId={shownTab?.hostId ?? ""}
            hostName={shownTab?.hostName ?? ""}
            label={labels.get(shown) ?? shownTab?.hostName ?? ""}
            copyOnSelect={copyOnSelect}
            onClose={() => void close(shown)}
          />
        ) : tabs === null ? null : (
          <EmptyState opening={opening} onOpen={() => void plus()} />
        )}
      </div>
    </div>
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
      className="h-5 min-w-0 rounded-sm border border-input bg-background px-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-7 max-md:pointer-coarse:text-sm"
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

function TerminalView({
  terminalId,
  hostId,
  hostName,
  label,
  copyOnSelect,
  onClose,
}: {
  terminalId: string;
  hostId: string;
  hostName: string;
  /** The tab's title as the strip shows it. */
  label: string;
  copyOnSelect: CopyOnSelectSetting;
  onClose: () => void;
}) {
  const view = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const status = useConnectionStatus(terminalId, false);
  const backend = useTerminalsBackend();
  const navigate = useBbNavigate();
  const [terminal, setTerminal] = useState<LiveTerminal | null>(null);
  const { selection, dismiss, onPointerDown } = useTerminalSelection(terminal, view, copyOnSelect);
  const [request, setRequest] = useState<AddToChatRequest | null>(null);

  useLayoutEffect(() => {
    const parent = container.current;
    if (parent === null) return;
    const terminal = liveTerminal(terminalId, backend);
    terminal.attach(parent);
    terminal.focus();
    setTerminal(terminal);
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
      setTerminal(null);
    };
  }, [terminalId, backend]);

  const addToChat = useCallback(() => {
    if (selection === null || terminal === null) return;
    setRequest({ text: selection.text, source: { tabLabel: label, hostName }, hostId, cwd: terminal.cwd() });
    dismiss();
    terminal.clearSelection();
  }, [selection, terminal, label, hostName, hostId, dismiss]);

  const send = useCallback(
    (target: DeliveryTarget) => {
      if (request === null) return;
      const block = terminalBlock(request.text, request.source);
      setRequest(null);
      if (block === null) return;
      // The composer is not on screen yet: app/chat-delivery.tsx writes the block once it is.
      windowDeliveries.request({ target, block, deadline: Date.now() + DELIVERY_TIMEOUT_MS });
      if (target.kind === "thread") navigate.toThread(target.threadId);
      else navigate.toCompose({ projectId: target.projectId, focusPrompt: true });
    },
    [request, navigate],
  );

  return (
    <div ref={view} className="absolute inset-0 flex flex-col">
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
      <div ref={container} data-terminal-view="" className="min-h-0 flex-1 overflow-hidden p-1" onPointerDown={onPointerDown} />
      {selection === null ? null : <SelectionMenu anchor={selection.anchor} onAddToChat={addToChat} />}
      <AddToChatDialog
        request={request}
        onOpenChange={(open) => {
          if (open) return;
          setRequest(null);
          terminal?.focus();
        }}
        onSend={send}
      />
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
