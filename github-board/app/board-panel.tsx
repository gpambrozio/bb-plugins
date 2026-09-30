/**
 * The board page: four columns side by side on a wide layout, or a tab per
 * column on a compact one, with the repository filter, Refresh and the prompt
 * templates in a toolbar above. Pressing a card opens the detail panel over the
 * board; Send to chat opens the composer dialog.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { BoardColumn, BoardItem, ColumnId } from "../shared/board";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { findItem, notUpdatedReason, relativeTime, repositoriesOf, visibleColumns } from "./board-logic";
import { Card, type CardActions } from "./card";
import { DetailPanel } from "./detail-panel";
import { PromptSettingsEditor } from "./prompt-settings";
import { SendDialog } from "./send-dialog";
import { errorText, patchBoardItem, useBoard, useBoardRpc, useDisplayPrefs } from "./state";

export const PANEL_PATH = "board";
export const PROMPTS_SUBPATH = "prompts";

/** The compact tab survives the page unmounting, so coming back does not snap to Issues. */
let selectedColumn: ColumnId | null = null;

function RepoFilter({
  repositories,
  hidden,
  onChange,
}: {
  repositories: readonly string[];
  hidden: ReadonlySet<string>;
  onChange(hidden: string[]): void;
}) {
  const shown = repositories.filter((repository) => !hidden.has(repository)).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" disabled={repositories.length === 0}>
          <Icon name="Filter" />
          {shown === repositories.length ? "All repos" : `${shown}/${repositories.length} repos`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onChange([])}>Show all</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange([...repositories])}>Hide all</DropdownMenuItem>
        <DropdownMenuSeparator />
        {repositories.map((repository) => {
          const checked = !hidden.has(repository);
          return (
            <DropdownMenuCheckboxItem
              key={repository}
              checked={checked}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) => {
                const set = new Set(hidden);
                if (next === true) set.delete(repository);
                else set.add(repository);
                onChange([...set]);
              }}
            >
              {repository}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnBody({
  column,
  viewerLogin,
  selectedId,
  updating,
  updateErrors,
  compact,
  actions,
}: {
  column: BoardColumn;
  viewerLogin: string;
  selectedId: string | null;
  updating: ReadonlySet<string>;
  updateErrors: ReadonlyMap<string, string>;
  compact: boolean;
  actions: CardActions;
}) {
  return (
    <div className="space-y-2">
      {column.error !== null ? (
        <p className="rounded-md border border-destructive p-2 text-xs text-destructive">{column.error}</p>
      ) : null}
      {column.items.length === 0 && column.error === null ? (
        <p className="p-2 text-sm text-muted-foreground">Nothing here.</p>
      ) : null}
      {column.items.map((item) => (
        <Card
          key={item.id}
          item={item}
          column={column.id}
          viewerLogin={viewerLogin}
          selected={item.id === selectedId}
          updating={updating.has(item.id)}
          updateError={updateErrors.get(item.id) ?? null}
          compact={compact}
          actions={actions}
        />
      ))}
    </div>
  );
}

function Board() {
  const compact = useIsCompactViewport();
  const navigate = useBbNavigate();
  const rpc = useBoardRpc();
  const { board, loading, error, refresh } = useBoard();
  const { prefs, update: updatePrefs } = useDisplayPrefs();
  const hidden = useMemo(() => new Set(prefs?.hiddenRepositories ?? []), [prefs]);
  const repositories = useMemo(() => repositoriesOf(board), [board]);
  const columns = useMemo(() => visibleColumns(board, hidden), [board, hidden]);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<{ item: BoardItem; column: ColumnId } | null>(null);
  // On the board, not a card, so the card and the panel show the same
  // "Updating…" and a second press from either is ignored.
  const [updating, setUpdating] = useState<ReadonlySet<string>>(new Set());
  // Why the last update of a card failed, shown on the card and in the panel
  // until the next attempt — the button can be offered where GitHub's own
  // page does not, so a refusal must say what GitHub answered.
  const [updateErrors, setUpdateErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [tab, setTab] = useState<ColumnId | null>(selectedColumn);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const observer = new ResizeObserver(([entry]) => setBodyWidth(entry?.contentRect.width ?? 0));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  // The panel shows the card as it is on the board now, so a label edited
  // while it is open repaints in it.
  const detail = detailId === null ? null : findItem(board, detailId);
  useEffect(() => {
    if (detailId !== null && board !== null && detail === null) setDetailId(null);
  }, [detailId, board, detail]);

  const actions: CardActions = {
    onOpen: (item) => setDetailId(item.id),
    onSend: (item, column) => setSendTarget({ item, column }),
    onUpdateBranch: (item) => {
      if (updating.has(item.id)) return;
      setUpdating((current) => new Set(current).add(item.id));
      setUpdateErrors((current) => {
        if (!current.has(item.id)) return current;
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
      rpc
        .call("updateBranch", { id: item.id })
        .then(
          (result) => {
            patchBoardItem(item.id, { branch: result.branch });
            if (result.updated) toast.success(`Updating ${item.repository}#${item.number} from its base branch`);
            else toast.info(notUpdatedReason(result.branch));
          },
          (cause: unknown) =>
            setUpdateErrors((current) => new Map(current).set(item.id, `Update failed: ${errorText(cause)}`)),
        )
        .finally(() =>
          setUpdating((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          }),
        );
    },
  };

  const activeColumn = columns.find((column) => column.id === tab) ?? columns[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <RepoFilter
          repositories={repositories}
          hidden={hidden}
          onChange={(next) => updatePrefs({ hiddenRepositories: next })}
        />
        <div className="flex-1" />
        {board !== null ? (
          <span className="truncate text-xs text-muted-foreground">
            {board.login} · updated {relativeTime(board.fetchedAt)}
          </span>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Refresh"
          disabled={loading}
          onClick={() => refresh(true)}
        >
          <Icon name="RefreshCw" className={cn(loading && "animate-spin")} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Prompt templates"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: PROMPTS_SUBPATH })}
        >
          <Icon name="Settings" />
        </Button>
      </div>

      {error !== null ? (
        <div className="flex items-center gap-2 border-b border-destructive px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <Button size="sm" variant="outline" onClick={() => refresh(true)}>
            Retry
          </Button>
        </div>
      ) : null}

      <div ref={bodyRef} className="relative min-h-0 flex-1">
        {board === null ? (
          <p className="p-4 text-sm text-muted-foreground">{loading ? "Loading the board…" : null}</p>
        ) : compact ? (
          <div className="flex h-full flex-col">
            <Tabs
              value={activeColumn?.id}
              onValueChange={(value) => {
                selectedColumn = value as ColumnId;
                setTab(value as ColumnId);
              }}
              className="px-3 pt-2"
            >
              <TabsList className="w-full">
                {columns.map((column) => (
                  <TabsTrigger key={column.id} value={column.id} className="flex-1 text-xs">
                    {column.title} {column.error !== null ? "!" : column.items.length}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {activeColumn !== undefined ? (
                <ColumnBody
                  key={activeColumn.id}
                  column={activeColumn}
                  viewerLogin={board.login}
                  selectedId={detailId}
                  updating={updating}
                  updateErrors={updateErrors}
                  compact
                  actions={actions}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex h-full min-w-0 gap-3 overflow-x-auto p-3">
            {columns.map((column) => (
              <section key={column.id} className="flex min-w-[240px] flex-1 flex-col">
                <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
                  {column.title}
                  <span className="font-normal">{column.error !== null ? "!" : column.items.length}</span>
                </h2>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <ColumnBody
                    column={column}
                    viewerLogin={board.login}
                    selectedId={detailId}
                    updating={updating}
                    updateErrors={updateErrors}
                    compact={false}
                    actions={actions}
                  />
                </div>
              </section>
            ))}
          </div>
        )}

        {detail !== null ? (
          <DetailPanel
            key={detail.item.id}
            item={detail.item}
            column={detail.column}
            compact={compact}
            bodyWidth={bodyWidth}
            widthFraction={prefs?.detailWidthFraction ?? null}
            updating={updating.has(detail.item.id)}
            updateError={updateErrors.get(detail.item.id) ?? null}
            onWidthCommitted={(fraction) => updatePrefs({ detailWidthFraction: fraction })}
            onClose={() => setDetailId(null)}
            onSend={() => setSendTarget({ item: detail.item, column: detail.column })}
            onUpdateBranch={() => actions.onUpdateBranch(detail.item)}
          />
        ) : null}
      </div>

      <SendDialog
        target={sendTarget}
        onOpenChange={(open) => {
          if (!open) setSendTarget(null);
        }}
      />
    </div>
  );
}

function PromptsPage() {
  const navigate = useBbNavigate();
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          <Icon name="ArrowLeft" />
          Board
        </Button>
        <h2 className="text-base font-semibold">Prompt templates</h2>
        <PromptSettingsEditor />
      </div>
    </div>
  );
}

export function BoardPanel({ subPath }: PluginNavPanelProps) {
  return subPath === PROMPTS_SUBPATH ? <PromptsPage /> : <Board />;
}
