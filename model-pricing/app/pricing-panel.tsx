/**
 * The Model pricing page: one table of what every model on the enabled
 * providers costs, ranked against the cheapest one on screen.
 *
 * **The last answer, the sort, the search and the hidden set live at module
 * scope.** The panel is a route, so opening a thread unmounts it and component
 * state goes with it. Keeping them here means a return visit paints at once,
 * keeps the user's place, and refetches only once the rows have aged out. None
 * of it is worth persisting: the rows are cached on the server already, and
 * the rest is this session's business.
 */
import {
  experimental_useCodeTheme,
  experimental_usePluginId,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { RpcContract } from "../shared/contract";
import { relativeTime } from "../shared/format";
import type { PriceRow, SourceStatus } from "../shared/pricing";
import { PROVIDERS } from "../shared/providers";
import { displayFrom } from "../shared/settings";
import type { Sort, SortKey } from "../shared/sort";
import { openPluginSettings } from "./open-settings";
import { accentOf, COMPACT_BELOW_PX, PricingCard, TableBodyRow, TableHeader, tableRowKey } from "./table";
import { TipButton } from "./tip-button";
import { emptyMessage, nextSort, providerKeyOf, stampOf, subtitle, visibleRows } from "./visible";

export const PANEL_PATH = "pricing";

/** Past this, a mount refetches — underneath the table already on screen. */
const STALE_AFTER_MS = 30 * 60_000;

/** Survives the panel being unmounted; dies with the window. */
const session: {
  rows: PriceRow[] | null;
  sources: SourceStatus[];
  fetchedAt: number;
  /** Which providers `rows` were fetched for, so a switch refetches. */
  providerKey: string;
  sort: Sort;
  search: string;
  /**
   * Providers hidden by pressing their legend dot. Deliberately *not* the
   * provider switches in settings: those decide what is fetched, and a
   * provider switched off there also leaves the legend — taking with it the
   * dot that would bring it back. This is the cheap view filter over the
   * fetched set.
   */
  hidden: ReadonlySet<string>;
} = {
  rows: null,
  sources: [],
  fetchedAt: 0,
  providerKey: "",
  sort: { key: "relative", descending: true },
  search: "",
  hidden: new Set(),
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the panel is narrower than the grid needs, measured on the panel itself rather than the window. */
function useIsCompact(): [boolean, (node: HTMLDivElement | null) => void] {
  const [compact, setCompact] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    const measure = (width: number) => setCompact(width < COMPACT_BELOW_PX);
    measure(node.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) measure(width);
    });
    observer.current.observe(node);
  }, []);
  return [compact, ref];
}

export function PricingPanel() {
  const pluginId = experimental_usePluginId();
  const { mode } = experimental_useCodeTheme();
  const settings = useSettings();
  const rpc = useRpc<RpcContract>();
  // The client is not promised to be stable between renders; a fetch callback
  // that depended on it could re-run the fetch effect on every render.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [compact, measureRef] = useIsCompact();

  // Everything downstream is keyed on primitives pulled out of the settings,
  // never on the values object, whose identity is not promised either.
  const settingsReady = !settings.isLoading;
  const display = displayFrom(settings.values);
  const providerKey = providerKeyOf(display.providers);
  const { toolCallOnly, inputWeight } = display;
  const enabled = useMemo(() => {
    const chosen = new Set(providerKey.split(",").filter((id) => id !== ""));
    return PROVIDERS.filter((provider) => chosen.has(provider.id));
  }, [providerKey]);
  const enabledIds = useMemo(() => enabled.map((provider) => provider.id), [enabled]);

  const [rows, setRows] = useState<PriceRow[] | null>(session.rows);
  const [sources, setSources] = useState<SourceStatus[]>(session.sources);
  const [fetchedAt, setFetchedAt] = useState(session.fetchedAt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearchState] = useState(session.search);
  const [sort, setSortState] = useState<Sort>(session.sort);
  const [hidden, setHiddenState] = useState<ReadonlySet<string>>(session.hidden);

  const toggleHidden = useCallback((providerId: string) => {
    setHiddenState((current) => {
      const next = new Set(current);
      if (!next.delete(providerId)) next.add(providerId);
      session.hidden = next;
      return next;
    });
  }, []);

  const setSearch = useCallback((next: string) => {
    session.search = next;
    setSearchState(next);
  }, []);

  const onSort = useCallback((key: SortKey) => {
    setSortState((current) => {
      const next = nextSort(current, key);
      session.sort = next;
      return next;
    });
  }, []);

  /**
   * Which request is the current one. Two loads overlap whenever a provider is
   * switched while the first is still in flight, and the 4.7 MB models.dev
   * fetch makes that window real — without this, the older answer could land
   * last and put back rows for a provider the user has just switched off.
   */
  const latestRequest = useRef(0);

  const refresh = useCallback(async (providerIds: readonly string[], force: boolean) => {
    const request = latestRequest.current + 1;
    latestRequest.current = request;
    setBusy(true);
    setError(null);
    try {
      const result = await rpcRef.current.call("load", { providers: [...providerIds], refresh: force });
      if (latestRequest.current !== request) return;
      session.rows = result.rows;
      session.sources = result.sources;
      session.fetchedAt = stampOf(result.sources);
      session.providerKey = providerKeyOf(providerIds);
      setRows(result.rows);
      setSources(result.sources);
      setFetchedAt(session.fetchedAt);
    } catch (cause) {
      if (latestRequest.current !== request) return;
      setError(errorText(cause));
    } finally {
      if (latestRequest.current === request) setBusy(false);
    }
  }, []);

  /**
   * The provider set this mount has already asked the server about. Without
   * it, a fetch that fails — or simply the re-render its own `busy` flag
   * causes — would look like a fresh set of providers and start another fetch.
   */
  const requestedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!settingsReady) return;
    if (providerKey === "") {
      // Nothing to ask the server for. Clear rather than leave another
      // provider's rows on screen under an empty legend.
      if (requestedKey.current === "") return;
      requestedKey.current = "";
      session.rows = [];
      session.providerKey = "";
      setRows([]);
      setSources([]);
      return;
    }
    // A warm answer for the same providers repaints on its own; refetching is
    // only worth the round trips once it has aged out.
    const warm =
      session.rows !== null && session.providerKey === providerKey && Date.now() - session.fetchedAt < STALE_AFTER_MS;
    if (warm || requestedKey.current === providerKey) {
      requestedKey.current = providerKey;
      return;
    }
    requestedKey.current = providerKey;
    void refresh(enabledIds, false);
  }, [settingsReady, providerKey, enabledIds, refresh]);

  useEffect(() => {
    // Not before the settings are in, so the hidden set is pruned against the
    // user's real switches rather than the defaults shown while they load.
    if (!settingsReady) return;
    // Forget a provider since switched off in settings, so switching it back
    // on does not bring it back still hidden — which would read as the switch
    // not working.
    setHiddenState((current) => {
      const allowed = new Set(providerKey.split(",").filter((id) => id !== ""));
      const next = new Set([...current].filter((id) => allowed.has(id)));
      if (next.size === current.size) return current;
      session.hidden = next;
      return next;
    });
  }, [settingsReady, providerKey]);

  const visible = useMemo(
    () => visibleRows(rows, { enabled: enabledIds, hidden, toolCallOnly, search, inputWeight, sort }),
    [rows, enabledIds, hidden, toolCallOnly, search, inputWeight, sort],
  );

  const failures = sources.filter((source) => source.error !== null);

  function onSettings() {
    if (!openPluginSettings(window, pluginId)) toast.info("Model Pricing's settings are in Settings → Plugins → Model Pricing.");
  }

  return (
    <div ref={measureRef} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="ChartColumn" className="size-4" aria-hidden />
        <h1 className="text-sm font-semibold">Model pricing</h1>
        <div className="flex-1" />
        <TipButton
          variant="ghost"
          size="icon"
          className="size-8"
          label={busy ? "Loading prices" : "Refresh prices"}
          disabled={busy || enabledIds.length === 0}
          onClick={() => void refresh(enabledIds, true)}
        >
          <Icon name={busy ? "Spinner" : "ArrowReloadHorizontal"} className={busy ? "animate-spin" : undefined} />
        </TipButton>
        <TipButton variant="ghost" size="icon" className="size-8" label="Model pricing settings" onClick={onSettings}>
          <Icon name="Settings" />
        </TipButton>
      </div>

      <div className="space-y-2 px-3 pt-2 pb-3">
        <p className="text-xs text-muted-foreground">{subtitle(inputWeight, toolCallOnly, fetchedAt, rows !== null)}</p>

        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {enabled.map((provider) => {
            const off = hidden.has(provider.id);
            const color = accentOf(provider.id, mode);
            return (
              <button
                key={provider.id}
                type="button"
                role="checkbox"
                aria-checked={!off}
                aria-label={off ? `Show ${provider.label} models` : `Hide ${provider.label} models`}
                onClick={() => toggleHidden(provider.id)}
                className="flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {/*
                 * Hollow when hidden. The provider keeps its colour either
                 * way, so the dot still says which provider it is and only
                 * the fill reports the state; the ring keeps the dot's size so
                 * the legend does not reflow.
                 */}
                <span
                  aria-hidden
                  className="size-2.5 rounded-full border-2"
                  style={{ borderColor: color, backgroundColor: off ? "transparent" : color }}
                />
                <span className={cn("text-xs", off ? "text-muted-foreground" : "text-foreground")}>{provider.label}</span>
              </button>
            );
          })}
        </div>

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search models and providers"
          aria-label="Search models and providers"
          spellCheck={false}
          className="h-8 text-sm"
        />

        {error === null ? null : (
          <p className="rounded-md border border-destructive p-2 text-xs text-destructive">{error}</p>
        )}
        {failures.length === 0 ? null : (
          <div className="space-y-0.5 rounded-md border border-warning p-2">
            {failures.map((source) => (
              <p key={source.id} className="text-xs text-warning-text">
                {source.error}
                {source.fetchedAt > 0 ? ` Showing prices from ${relativeTime(source.fetchedAt)}.` : ""}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        {compact ? null : <TableHeader sort={sort} onSort={onSort} />}
        {visible.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {emptyMessage({ enabled: enabledIds.length, hidden: hidden.size, busy, loaded: rows !== null })}
          </p>
        ) : (
          visible.map((entry) =>
            compact ? (
              <PricingCard key={tableRowKey(entry)} entry={entry} mode={mode} />
            ) : (
              <TableBodyRow key={tableRowKey(entry)} entry={entry} mode={mode} />
            ),
          )
        )}
        <div className="h-6" />
      </div>
    </div>
  );
}
