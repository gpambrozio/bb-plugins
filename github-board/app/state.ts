/**
 * The app's data: the board, the display preferences and the prompt templates,
 * each with the realtime signal that keeps every open window in step.
 *
 * The board is also kept at module scope. bb unmounts the page whenever the
 * user opens a thread, and coming back should repaint at once rather than
 * wait on three searches; a non-forced load then runs underneath, answered
 * from the server's cache while that is fresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";

import type { Board, BoardItem, PromptSettings } from "../shared/board";
import type { RpcContract } from "../shared/contract";
import {
  DISPLAY_PREFS_CHANGED,
  DisplayPrefsSchema,
  ITEM_PATCHED,
  ItemPatchSchema,
  PROMPTS_CHANGED,
  type DisplayPrefs,
} from "../shared/schemas";
import { PromptSettingsSchema } from "../shared/board";
import { patchBoard } from "./board-logic";

export function useBoardRpc() {
  return useRpc<RpcContract>();
}

/**
 * Counts the times the realtime connection has come back. Signals are
 * broadcast and not persisted, so a window that was disconnected missed
 * whatever was published meanwhile; each hook below refetches its state when
 * this changes.
 */
export function useReconnects(): number {
  const state = useRealtimeConnectionState();
  const previous = useRef(state);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (previous.current !== "connected" && state === "connected") setCount((value) => value + 1);
    previous.current = state;
  }, [state]);
  return count;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let cachedBoard: Board | null = null;
/** The mounted board's setter, so an edit's answer reaches whichever board is on screen now. */
let setMountedBoard: ((update: (current: Board | null) => Board | null) => void) | null = null;

/**
 * Board loads in flight can answer out of order — a reconnect or a Refresh
 * starts one while another is still running. Only the newest load may write
 * the board; an older answer is dropped, whichever arrives last.
 */
let latestLoad = 0;

/**
 * Edits adopted while a load was in flight. Its answer may have been built
 * before them, so they are applied to it again rather than undone by it.
 * Re-applying one the server already included changes nothing.
 */
let patchCount = 0;
const recentPatches: { seq: number; itemId: string; patch: Partial<BoardItem> }[] = [];
const RECENT_PATCH_LIMIT = 100;

/** Adopts an edit to one card, in the module cache and on screen. */
export function patchBoardItem(itemId: string, patch: Partial<BoardItem>): void {
  patchCount += 1;
  recentPatches.push({ seq: patchCount, itemId, patch });
  if (recentPatches.length > RECENT_PATCH_LIMIT) recentPatches.shift();
  if (cachedBoard !== null) cachedBoard = patchBoard(cachedBoard, itemId, patch);
  setMountedBoard?.((current) => (current === null ? null : patchBoard(current, itemId, patch)));
}

function withPatchesSince(board: Board, seq: number): Board {
  return recentPatches
    .filter((entry) => entry.seq > seq)
    .reduce((current, entry) => patchBoard(current, entry.itemId, entry.patch), board);
}

export function useBoard() {
  const rpc = useBoardRpc();
  const reconnects = useReconnects();
  const [board, setBoard] = useState<Board | null>(cachedBoard);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setMountedBoard = setBoard;
    return () => {
      mounted.current = false;
      if (setMountedBoard === setBoard) setMountedBoard = null;
    };
  }, []);

  const refresh = useCallback(
    (force: boolean) => {
      latestLoad += 1;
      const load = latestLoad;
      const patchesBefore = patchCount;
      setLoading(true);
      rpc.call("loadBoard", { limit: 30, force }).then(
        (next) => {
          if (load !== latestLoad) return;
          const adopted = withPatchesSince(next, patchesBefore);
          cachedBoard = adopted;
          if (!mounted.current) return;
          setBoard(adopted);
          setError(null);
          setLoading(false);
        },
        (cause: unknown) => {
          if (load !== latestLoad || !mounted.current) return;
          setError(errorText(cause));
          setLoading(false);
        },
      );
    },
    [rpc],
  );

  useEffect(() => {
    // The remembered board paints at once and this runs underneath it. It is
    // not forced, so within the server's cache window it costs no GitHub
    // requests — and it catches anything this window missed while away,
    // including edits made while the realtime connection was down.
    refresh(false);
  }, [refresh, reconnects]);

  return { board, loading, error, refresh };
}

/**
 * Applies every `item-patched` signal to the remembered board, mounted or not.
 * Rendered once per window by the app overlay, so a label changed in another
 * window while this one shows a thread is already on the board when it comes
 * back.
 */
export function BoardPatchListener() {
  useRealtime(ITEM_PATCHED, (payload) => {
    const parsed = ItemPatchSchema.safeParse(payload);
    if (parsed.success) patchBoardItem(parsed.data.itemId, parsed.data.patch);
  });
  return null;
}

const DEFAULT_DISPLAY: DisplayPrefs = { hiddenRepositories: [], detailWidthFraction: null };

export function useDisplayPrefs() {
  const rpc = useBoardRpc();
  const reconnects = useReconnects();
  const [prefs, setPrefs] = useState<DisplayPrefs | null>(null);
  // Bumped by every newer source of truth — a local change, a pushed one — so
  // a fetch that started before it cannot put the older value back.
  const version = useRef(0);

  useEffect(() => {
    let live = true;
    const started = version.current;
    rpc.call("getDisplayPrefs", {}).then(
      (value) => {
        if (live && version.current === started) setPrefs(value);
      },
      () => {
        if (live) setPrefs((current) => current ?? DEFAULT_DISPLAY);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, reconnects]);

  useRealtime(DISPLAY_PREFS_CHANGED, (payload) => {
    const parsed = DisplayPrefsSchema.safeParse(payload);
    if (!parsed.success) return;
    version.current += 1;
    setPrefs(parsed.data);
  });

  /** Applied on screen at once; the server's answer, and every other window, follow. */
  const update = useCallback(
    (patch: Partial<DisplayPrefs>) => {
      version.current += 1;
      setPrefs((current) => ({ ...(current ?? DEFAULT_DISPLAY), ...patch }));
      rpc.call("setDisplayPrefs", patch).catch(() => {
        // The next load shows what was actually stored.
      });
    },
    [rpc],
  );

  return { prefs, update };
}

export function usePrompts() {
  const rpc = useBoardRpc();
  const reconnects = useReconnects();
  const [prompts, setPrompts] = useState<PromptSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // As in `useDisplayPrefs`: a save or a pushed change outranks a fetch that
  // started before it.
  const version = useRef(0);

  useEffect(() => {
    let live = true;
    const started = version.current;
    // The editor adopts what this answers only while it holds no unsaved
    // edit, so a refetch after a reconnect never overwrites one.
    rpc.call("getPrompts", {}).then(
      (value) => {
        if (live && version.current === started) {
          setPrompts(value);
          setError(null);
        }
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, reconnects]);

  useRealtime(PROMPTS_CHANGED, (payload) => {
    const parsed = PromptSettingsSchema.safeParse(payload);
    if (!parsed.success) return;
    version.current += 1;
    setPrompts(parsed.data);
  });

  const save = useCallback(
    async (value: PromptSettings) => {
      version.current += 1;
      const stored = await rpc.call("savePrompts", value);
      version.current += 1;
      setPrompts(stored);
      return stored;
    },
    [rpc],
  );

  return { prompts, error, save };
}
