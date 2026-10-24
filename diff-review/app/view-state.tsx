/**
 * What the Review tab keeps of a view, per thread and view, across leaving the tab, a reload and an
 * app restart: unsent comments (restored with their editors open), the files folded or unfolded by
 * hand, and where it was scrolled.
 *
 * The plugin's own database holds it (`saveViewState`, read back with `getReview`), so it follows the
 * user to another device too. Writes are batched; leaving the tab or the page writes at once. A copy
 * also stays in this window, so coming back is instant and never loses to a save still in flight:
 * of the two, the one saved last wins.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import { VIEW_STATE_MAX_DRAFTS, VIEW_STATE_MAX_FOLDS, type Draft, type ScrollAnchor, type ViewState } from "../shared/types";
import { errorMessage } from "./use-review";

const SAVE_DELAY_MS = 400;

/** The latest copy this window holds, by `<thread id> <session id>`. */
const windowCopies = new Map<string, ViewState>();

/** Forgets this window's copies; for tests. */
export function forgetViewStates(): void {
  windowCopies.clear();
}

export const draftKeys = {
  general: "general",
  file: (path: string) => `file:${path}`,
  line: (path: string) => `line:${path}`,
  reply: (threadId: string) => `reply:${threadId}`,
  edit: (commentId: string) => `edit:${commentId}`,
};

export interface ViewStateStore {
  draft(key: string): Draft | undefined;
  /** The keys of every draft kept, oldest first. */
  draftKeyList(): string[];
  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  setDraft(key: string, draft: Draft | null): void;
  collapsed(path: string): boolean | undefined;
  setCollapsed(path: string, collapsed: boolean): void;
  scroll(): ScrollAnchor | null;
  setScroll(anchor: ScrollAnchor): void;
}

function emptyState(): ViewState {
  return { drafts: {}, collapsed: {}, scroll: null, savedAt: 0 };
}

/** The newest entries of a record, at most `max` (insertion order is age). */
function newest<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length <= max ? record : Object.fromEntries(entries.slice(entries.length - max));
}

/** A store over `state` that hands every change to `changed`. */
export function createViewStateStore(initial: ViewState, changed: (state: ViewState) => void): ViewStateStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const update = (next: Omit<ViewState, "savedAt">) => {
    state = {
      drafts: newest(next.drafts, VIEW_STATE_MAX_DRAFTS),
      collapsed: newest(next.collapsed, VIEW_STATE_MAX_FOLDS),
      scroll: next.scroll,
      savedAt: Date.now(),
    };
    changed(state);
    for (const listener of listeners) listener();
  };
  return {
    draft: (key) => state.drafts[key],
    draftKeyList: () => Object.keys(state.drafts),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft: (key, draft) => {
      const { [key]: _old, ...rest } = state.drafts;
      // Re-inserted, so the draft touched last is the newest.
      update({ ...state, drafts: draft === null ? rest : { ...rest, [key]: draft } });
    },
    collapsed: (path) => state.collapsed[path],
    setCollapsed: (path, collapsed) => {
      const { [path]: _old, ...rest } = state.collapsed;
      update({ ...state, collapsed: { ...rest, [path]: collapsed } });
    },
    scroll: () => state.scroll,
    setScroll: (anchor) => {
      const current = state.scroll;
      if (current !== null && current.path === anchor.path && current.index === anchor.index && Math.abs(current.offset - anchor.offset) < 1) return;
      update({ ...state, scroll: anchor });
    },
  };
}

/** Outside a provider (a part rendered on its own), nothing is kept. */
const ViewStateContext = createContext<ViewStateStore>(createViewStateStore(emptyState(), () => undefined));

export function useViewState(): ViewStateStore {
  return useContext(ViewStateContext);
}

/** The keys of the drafts kept, re-rendering when one is opened or closed (not on every key typed). */
export function useDraftKeys(): string[] {
  const store = useViewState();
  const json = useSyncExternalStore(store.subscribe, () => JSON.stringify(store.draftKeyList()));
  return JSON.parse(json) as string[];
}

export function ViewStateProvider({ threadId, sessionId, saved, children }: { threadId: string; sessionId: string; saved: ViewState | null; children: ReactNode }) {
  const rpc = useRpc<RpcContract>();
  const key = `${threadId} ${sessionId}`;
  const pending = useRef<ViewState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warned = useRef(false);

  const flush = useRef(() => {});
  flush.current = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const state = pending.current;
    pending.current = null;
    if (state === null) return;
    rpc.call("saveViewState", { threadId, sessionId, state }).catch((error: unknown) => {
      if (warned.current) return;
      warned.current = true;
      toast.error(`Could not keep this tab's drafts and place: ${errorMessage(error)}`);
    });
  };

  const [store] = useState(() => {
    const copy = windowCopies.get(key);
    const initial = copy !== undefined && (saved === null || copy.savedAt >= saved.savedAt) ? copy : (saved ?? emptyState());
    return createViewStateStore(initial, (state) => {
      windowCopies.set(key, state);
      pending.current = state;
      if (timer.current === null) timer.current = setTimeout(() => flush.current(), SAVE_DELAY_MS);
    });
  });

  useEffect(() => {
    const leave = () => flush.current();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      flush.current();
    };
  }, []);

  return <ViewStateContext.Provider value={store}>{children}</ViewStateContext.Provider>;
}

const EMPTY_DRAFT: Draft = { body: "", severity: null, range: null };

/**
 * One unsent comment's place in the store. `active` is the draft as it was opened (or restored), for
 * where its editor goes; `latest()` is the text as typed, for an editor that mounts again.
 */
export function useDraft(key: string) {
  const store = useViewState();
  const [active, setActive] = useState<Draft | null>(() => store.draft(key) ?? null);
  return {
    active,
    latest: (): Draft => store.draft(key) ?? active ?? EMPTY_DRAFT,
    /**
     * Opens the editor. A draft already kept stays as typed (a second click on "Comment on file", or
     * Edit on a comment being edited); a new `range` only moves it to the lines just picked.
     */
    open(initial: Partial<Draft> = {}) {
      const kept = store.draft(key);
      const draft = kept === undefined ? { ...EMPTY_DRAFT, ...initial } : initial.range === undefined ? kept : { ...kept, range: initial.range };
      store.setDraft(key, draft);
      setActive(draft);
    },
    change(value: { body: string; severity: Draft["severity"] }) {
      store.setDraft(key, { ...(store.draft(key) ?? active ?? EMPTY_DRAFT), ...value });
    },
    close() {
      store.setDraft(key, null);
      setActive(null);
    },
  };
}
