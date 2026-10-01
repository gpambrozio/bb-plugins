/**
 * The table itself, in two layouts: a ten-column grid for a wide panel and a
 * card per model for a narrow one. Ten columns do not fit a phone, and a
 * horizontally scrolling table is a poor way to read one, so a narrow panel
 * gets the same rows laid out to be read rather than scanned across.
 *
 * Every colour but the provider accents comes from bb's semantic classes. The
 * accents are a deliberate palette (`shared/providers.ts`), picked for bb's
 * light/dark mode and applied as inline styles.
 */
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

import {
  formatFlag,
  formatPrice,
  formatPricePair,
  formatRelative,
  formatTokens,
  rowKey,
  UNKNOWN,
} from "../shared/format";
import { modelPageUrl } from "../shared/model-links";
import type { PriceRow } from "../shared/pricing";
import { pickAccent, providerById, providerLabel, type ColorMode } from "../shared/providers";
import type { Sort, SortKey, TableRow } from "../shared/sort";

interface Column {
  label: string;
  /** Pressable when set; the columns with nothing to order by are not. */
  sort: SortKey | null;
  /** A `fr` weight: MODEL takes roughly a third, since only a name's length is unbounded. */
  weight: number;
  right?: boolean;
}

const COLUMNS: readonly Column[] = [
  { label: "Model", sort: "name", weight: 3.2 },
  { label: "Context", sort: "context", weight: 1.1 },
  { label: "Output", sort: "output", weight: 1.1 },
  { label: "Price", sort: "price", weight: 1.8 },
  { label: "Reasoning", sort: null, weight: 1.3 },
  { label: "Tool call", sort: null, weight: 1.3 },
  { label: "Structured", sort: null, weight: 1.3 },
  { label: "Temperature", sort: null, weight: 1.5 },
  // Wide enough for the four-digit multiples a full catalog produces: with
  // every provider on, the dearest model runs to "11320.8×".
  { label: "Relative", sort: "relative", weight: 1.6, right: true },
  { label: "Platform", sort: "provider", weight: 1.8 },
];

/**
 * The accent strip, then the columns. The strip is wide enough to judge a hue
 * by: at 3–4px every colour reads as "a dark sliver".
 */
const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `6px ${COLUMNS.map((column) => `minmax(0, ${column.weight}fr)`).join(" ")}`,
  columnGap: "1rem",
  alignItems: "center",
};

/** A grid row is narrower than this and the cards take over. */
export const COMPACT_BELOW_PX = 860;

export function accentOf(providerId: string, mode: ColorMode): string | undefined {
  const provider = providerById(providerId);
  return provider === null ? undefined : pickAccent(provider.accent, mode);
}

/**
 * A row is a link to the vendor's own page for that model, and the *whole* row
 * is the target rather than the name alone — neither layout has room for a
 * link affordance that earns its space. `UrlLink` opens it the way bb opens
 * every other web link, following the user's in-app/external browser choice.
 *
 * When `modelPageUrl` has no rule for an id, the row is a plain `div` and
 * presses nowhere: a row that looks pressable and opens a 404 is worse than a
 * row that does not look pressable.
 */
function ModelLink({ row, className, children }: { row: PriceRow; className: string; children: ReactNode }) {
  const url = modelPageUrl(row);
  if (url === null) return <div className={className}>{children}</div>;
  return (
    <UrlLink
      href={url}
      aria-label={`${row.name} on ${providerLabel(row.providerId)}`}
      title={`Open ${row.name}'s page`}
      className={cn(className, "cursor-pointer text-inherit no-underline hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
    >
      {children}
    </UrlLink>
  );
}

/** The column headings, sticky above the rows so a price 300 rows down still reads as one. */
export function TableHeader({ sort, onSort }: { sort: Sort; onSort: (key: SortKey) => void }) {
  return (
    <div
      style={GRID}
      className="sticky top-0 z-10 border-b border-border bg-card py-2.5 pr-4 pl-4 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
    >
      <span aria-hidden />
      {COLUMNS.map((column) => {
        const active = column.sort !== null && column.sort === sort.key;
        const label = (
          <>
            <span className="truncate">{column.label}</span>
            {/* The button's label already says the direction. */}
            {active ? <span aria-hidden>{sort.descending ? "↓" : "↑"}</span> : null}
          </>
        );
        const align = column.right === true ? "justify-end" : "justify-start";
        if (column.sort === null) {
          return (
            <span key={column.label} className={cn("flex min-w-0 items-center gap-1", align)}>
              {label}
            </span>
          );
        }
        const key = column.sort;
        return (
          <button
            key={column.label}
            type="button"
            aria-label={active ? `${column.label}, sorted ${sort.descending ? "descending" : "ascending"}` : `Sort by ${column.label}`}
            onClick={() => onSort(key)}
            className={cn(
              "flex min-w-0 cursor-pointer items-center gap-1 uppercase hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              align,
              active ? "text-foreground" : null,
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One cell. An em dash is dimmed even where its column is not: everything else
 * is a stated fact and gets full contrast, and "nothing was published here" is
 * the one thing that should recede.
 */
function Cell({ value, className, style }: { value: string; className?: string; style?: CSSProperties }) {
  return (
    <span
      style={value === UNKNOWN ? undefined : style}
      className={cn("min-w-0 truncate", className, value === UNKNOWN ? "font-normal text-muted-foreground" : null)}
    >
      {value}
    </span>
  );
}

export function TableBodyRow({ entry, mode }: { entry: TableRow; mode: ColorMode }) {
  const { row } = entry;
  const accent = accentOf(row.providerId, mode);
  return (
    <ModelLink row={row} className="block border-b border-border/60">
      <div style={GRID} className="pr-4 pl-4 text-sm text-foreground">
        <span aria-hidden className="self-stretch" style={{ backgroundColor: accent }} />
        <Cell value={row.name} className="py-3 font-semibold" />
        <Cell value={formatTokens(row.contextTokens)} className="font-mono tabular-nums" />
        <Cell value={formatTokens(row.outputTokens)} className="font-mono tabular-nums" />
        <Cell value={formatPricePair(row.inputCost, row.outputCost)} className="font-mono font-semibold tabular-nums" />
        <Cell value={formatFlag(row.reasoning)} />
        <Cell value={formatFlag(row.toolCall)} />
        <Cell value={formatFlag(row.structuredOutput)} />
        <Cell value={formatFlag(row.temperature)} />
        <Cell value={formatRelative(entry.relative)} className="text-right font-mono font-bold tabular-nums" />
        {/*
         * Coloured, because the palette has a variant picked to be legible as
         * text in this mode. This is the largest coloured thing in a row and
         * so the one that actually tells two providers apart; the strip only
         * reinforces it.
         */}
        <Cell value={providerLabel(row.providerId)} className="font-semibold" style={{ color: accent }} />
      </div>
    </ModelLink>
  );
}

export function PricingCard({ entry, mode }: { entry: TableRow; mode: ColorMode }) {
  const { row } = entry;
  const accent = accentOf(row.providerId, mode);
  const flags = [
    row.reasoning === true ? "Reasoning" : null,
    row.toolCall === true ? "Tool call" : null,
    row.structuredOutput === true ? "Structured" : null,
    row.temperature === true ? "Temperature" : null,
  ].filter((flag): flag is string => flag !== null);

  return (
    <ModelLink row={row} className="flex border-b border-border/60">
      <span aria-hidden className="ml-3 w-1.5 shrink-0" style={{ backgroundColor: accent }} />
      <div className="min-w-0 flex-1 space-y-1 py-3 pr-3 pl-3">
        <div className="flex items-center gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-foreground">{row.name}</span>
          <span className="shrink-0 font-mono text-sm font-bold text-foreground tabular-nums">{formatRelative(entry.relative)}</span>
        </div>
        <p className="truncate text-xs font-semibold" style={{ color: accent }}>
          {providerLabel(row.providerId)}
        </p>
        <p className="truncate font-mono text-sm font-semibold text-foreground tabular-nums">
          {formatPrice(row.inputCost)} in · {formatPrice(row.outputCost)} out · per 1M
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {formatTokens(row.contextTokens)} context · {formatTokens(row.outputTokens)} output
        </p>
        {flags.length === 0 ? null : (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {flags.map((flag) => (
              <span key={flag} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {flag}
              </span>
            ))}
          </div>
        )}
      </div>
    </ModelLink>
  );
}

/** Stable list key. A model id is unique only within its provider. */
export function tableRowKey(entry: TableRow): string {
  return rowKey(entry.row);
}
