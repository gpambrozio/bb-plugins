/**
 * The app's data: the board, the display preferences and the prompt templates,
 * each with the realtime signal that keeps every open window in step.
 *
 * The board is also kept at module scope. bb unmounts the page whenever the
 * user opens a thread, and coming back should repaint at once rather than
 * wait on three searches; a non-forced load then runs underneath, answered
 * from the server's cache while that is fresh.
 */
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let cachedBoard: Board | null = null;
/** The mounted board's setter, so an edit's answer reaches whichever board is on screen now. */
let setMountedBoard: ((update: (current: Board | null) => Board | null) => void) | null = null;

/** Adopts an edit to one card, in the module cache and on screen. */
export function patchBoardItem(itemId: string, patch: Partial<BoardItem>): void {
  if (cachedBoard !== null) cachedBoard = patchBoard(cachedBoard, itemId, patch);
  setMountedBoard?.((current) => (current === null ? null : patchBoard(current, itemId, patch)));
}

export function useBoard() {
  const rpc = useBoardRpc();
  const [board, setBoard] = useState<Board | null>(cachedBoard);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMountedBoard = setBoard;
    return () => {
      if (setMountedBoard === setBoard) setMountedBoard = null;
    };
  }, []);

  const refresh = useCallback(
    (force: boolean) => {
      setLoading(true);
      rpc.call("loadBoard", { limit: 30, force }).then(
        (next) => {
          cachedBoard = next;
          setBoard(next);
          setError(null);
          setLoading(false);
        },
        (cause: unknown) => {
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
  }, [refresh]);

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
  const [prefs, setPrefs] = useState<DisplayPrefs | null>(null);

  useEffect(() => {
    let live = true;
    rpc.call("getDisplayPrefs", {}).then(
      (value) => {
        if (live) setPrefs(value);
      },
      () => {
        if (live) setPrefs(DEFAULT_DISPLAY);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  useRealtime(DISPLAY_PREFS_CHANGED, (payload) => {
    const parsed = DisplayPrefsSchema.safeParse(payload);
    if (parsed.success) setPrefs(parsed.data);
  });

  /** Applied on screen at once; the server's answer, and every other window, follow. */
  const update = useCallback(
    (patch: Partial<DisplayPrefs>) => {
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
  const [prompts, setPrompts] = useState<PromptSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    rpc.call("getPrompts", {}).then(
      (value) => {
        if (live) setPrompts(value);
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  useRealtime(PROMPTS_CHANGED, (payload) => {
    const parsed = PromptSettingsSchema.safeParse(payload);
    if (parsed.success) setPrompts(parsed.data);
  });

  const save = useCallback(
    async (value: PromptSettings) => {
      const stored = await rpc.call("savePrompts", value);
      setPrompts(stored);
      return stored;
    },
    [rpc],
  );

  return { prompts, error, save };
}
