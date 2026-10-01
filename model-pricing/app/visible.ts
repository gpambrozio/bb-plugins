/**
 * The panel's pipeline from the last `load` answer to the rows on screen, and
 * the lines around the table. Pure, so `visible.test.ts` covers it without a
 * renderer.
 */
import { relativeCosts, relativeTime, rowKey } from "../shared/format";
import type { PriceRow, SourceStatus } from "../shared/pricing";
import { providerLabel } from "../shared/providers";
import { inputShare, type InputWeight } from "../shared/settings";
import { compareRows, type Sort, type TableRow } from "../shared/sort";

export interface Filters {
  /** Provider ids switched on in settings. */
  enabled: readonly string[];
  /** Provider ids hidden by their legend dot. */
  hidden: ReadonlySet<string>;
  toolCallOnly: boolean;
  search: string;
  inputWeight: InputWeight;
  sort: Sort;
}

export function visibleRows(rows: readonly PriceRow[] | null, filters: Filters): TableRow[] {
  if (rows === null) return [];
  const terms = filters.search.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const shown = new Set(filters.enabled);
  const filtered = rows.filter((row) => {
    // Belt as well as braces: the server is asked only for enabled providers,
    // but `rows` is whatever the last answer carried, and that answer can be
    // older than the switch the user just flipped. Rows for a provider that is
    // off have no legend dot to hide them and would drag the relative baseline,
    // so they are dropped here regardless of which reply landed.
    if (!shown.has(row.providerId)) return false;
    if (filters.hidden.has(row.providerId)) return false;
    // Unknown is not hidden. `null` means the upstream did not say whether the
    // model calls tools, and dropping it would lose models whose catalogue
    // entry is merely quiet rather than negative.
    if (filters.toolCallOnly && row.toolCall === false) return false;
    if (terms.length === 0) return true;
    const haystack = `${row.name} ${row.modelId} ${providerLabel(row.providerId)}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  // Ranked against what is on screen, not the whole catalog: "1.0×" has to mean
  // the cheapest row the user can actually see.
  const relatives = relativeCosts(filtered, inputShare(filters.inputWeight));
  const entries = filtered.map((row) => ({ row, relative: relatives.get(rowKey(row)) ?? 1 }));
  return entries.sort((a, b) => compareRows(a, b, filters.sort));
}

/**
 * A new column starts on the order that reads as "most interesting first" for
 * that kind of value; the same column again flips it.
 */
export function nextSort(current: Sort, key: Sort["key"]): Sort {
  if (current.key === key) return { key, descending: !current.descending };
  return { key, descending: key !== "name" && key !== "provider" };
}

/**
 * When the prices on screen were actually fetched — the *oldest* source, since
 * that is the one the "updated" line is really about.
 *
 * Not the clock when the RPC returned. A cached answer comes back in
 * milliseconds and its rows can be twelve hours old, so stamping the reply
 * would have the header say "just now" over half-day-old prices. Sources that
 * never loaded report 0 and are ignored; if none has a stamp, the reply time is
 * all there is.
 */
export function stampOf(sources: readonly SourceStatus[], now: number = Date.now()): number {
  const stamps = sources.map((source) => source.fetchedAt).filter((stamp) => stamp > 0);
  return stamps.length === 0 ? now : Math.min(...stamps);
}

/**
 * The line under the title, which is where the table says what it is
 * measuring. The weighting belongs here because the relative column is
 * meaningless without it, and the fetch time because a stale cache and a live
 * fetch look identical.
 */
export function subtitle(
  inputWeight: InputWeight,
  toolCallOnly: boolean,
  fetchedAt: number,
  loaded: boolean,
  now: number = Date.now(),
): string {
  const parts = [
    toolCallOnly ? "Agent-capable models" : "All models",
    `${inputWeight.replace("/", ":")} input:output blend`,
    "cheapest = 1.0×",
    "USD per 1M tokens",
  ];
  if (loaded && fetchedAt > 0) parts.push(`updated ${relativeTime(fetchedAt, now)}`);
  return parts.join(" · ");
}

/** Why the table is empty, said outright so it does not read as a failed fetch. */
export function emptyMessage(state: {
  enabled: number;
  hidden: number;
  busy: boolean;
  loaded: boolean;
}): string {
  if (state.enabled === 0) return "No providers are switched on. Pick some in settings.";
  if (state.busy && !state.loaded) return "Loading prices…";
  if (!state.loaded) return "No prices loaded yet.";
  if (state.hidden >= state.enabled) return "Every provider is hidden. Press a dot to bring one back.";
  return "Nothing matches.";
}

/** Sorted, so two orders of the same providers are the same request. */
export function providerKeyOf(providerIds: readonly string[]): string {
  return [...providerIds].sort().join(",");
}
