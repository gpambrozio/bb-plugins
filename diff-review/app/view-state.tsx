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
import { aliasedKey, remapThreadKeys, withoutSent, type ThreadAliases } from "../shared/thread-aliases";
import { VIEW_STATE_MAX_DRAFTS, VIEW_STATE_MAX_FOLDS, type Draft, type ScrollAnchor, type ViewState } from "../shared/types";
import { errorMessage } from "./use-review";

const SAVE_DELAY_MS = 400;

/**
 * The store this window holds for each view, by `<thread id> <session id>`, kept across the tab's
 * remounts: its state, and the submissions under way (`beginSend`), which a remount must not forget
 * or a reply still being posted would show as unsent. `save` is the mounted provider's, or the last
 * one's, so a submission ending after the tab left still saves what it left.
 */
const windowStores = new Map<string, { store: ViewStateStore; save: { current: (state: ViewState) => void } }>();

/** Forgets this window's copies; for tests. */
export function forgetViewStates(): void {
  windowStores.clear();
}

export const draftKeys = {
  general: "general",
  file: (path: string) => `file:${path}`,
  line: (path: string) => `line:${path}`,
  reply: (threadId: string) => `reply:${threadId}`,
  edit: (commentId: string) => `edit:${commentId}`,
};

/** A draft's text on its way to the server (`beginSend`); its `key` follows a fold (`remap`). */
export interface SendTicket {
  key: string;
  readonly body: string;
}

export interface ViewStateStore {
  draft(key: string): Draft | undefined;
  /** The keys of every draft kept, oldest first. */
  draftKeyList(): string[];
  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  setDraft(key: string, draft: Draft | null): void;
  collapsed(path: string): boolean | undefined;
  setCollapsed(path: string, collapsed: boolean): void;
  /** Whether the user left a comment thread open (true) or folded (false); undefined if never touched. */
  threadExpanded(threadId: string): boolean | undefined;
  setThreadExpanded(threadId: string, expanded: boolean): void;
  scroll(): ScrollAnchor | null;
  setScroll(anchor: ScrollAnchor): void;
  /**
   * Moves the reply drafts and folds of threads folded into another to the thread kept, as the server
   * does (`remapThreadKeys`), so this tab's next save cannot bring the old id back.
   */
  remap(aliases: ThreadAliases): void;
  /** How often `remap` or `endSend` wrote the draft `key`: its editor shows the text again when this changes. */
  revision(key: string): number;
  /**
   * Marks `body`, the text of the draft `key`, as being submitted. Kept apart from any editor, so the
   * draft stays busy in whichever editor shows it (a fold may move it to another thread's card).
   */
  beginSend(key: string, body: string): SendTicket;
  /**
   * Ends a submission. Once posted, only the text sent leaves the draft, wherever it is now: what a
   * fold joined to it stays, unsent.
   */
  endSend(ticket: SendTicket, posted: boolean): void;
  /** Whether a submission of the draft `key` is under way. */
  sending(key: string): boolean;
  /** The whole state, as last changed. */
  state(): ViewState;
  /** Takes `next` (a newer copy from the server) in place of what the store holds; nothing is saved. */
  replace(next: ViewState): void;
}

function emptyState(): ViewState {
  return { drafts: {}, collapsed: {}, expandedThreads: {}, scroll: null, savedAt: 0 };
}

/** The newest entries of a record, at most `max` (insertion order is age). */
function newest<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length <= max ? record : Object.fromEntries(entries.slice(entries.length - max));
}

/** A store over `state` that hands every change to `changed`. */
export function createViewStateStore(initial: ViewState, changed: (state: ViewState) => void): ViewStateStore {
  let state = initial;
  const revisions = new Map<string, number>();
  const sends = new Set<SendTicket>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const bump = (key: string) => revisions.set(key, (revisions.get(key) ?? 0) + 1);
  const update = (next: Omit<ViewState, "savedAt">) => {
    state = {
      drafts: newest(next.drafts, VIEW_STATE_MAX_DRAFTS),
      collapsed: newest(next.collapsed, VIEW_STATE_MAX_FOLDS),
      expandedThreads: newest(next.expandedThreads ?? {}, VIEW_STATE_MAX_FOLDS),
      scroll: next.scroll,
      savedAt: Date.now(),
    };
    changed(state);
    notify();
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
    threadExpanded: (threadId) => state.expandedThreads?.[threadId],
    setThreadExpanded: (threadId, expanded) => {
      const { [threadId]: _old, ...rest } = state.expandedThreads ?? {};
      update({ ...state, expandedThreads: { ...rest, [threadId]: expanded } });
    },
    scroll: () => state.scroll,
    setScroll: (anchor) => {
      const current = state.scroll;
      if (current !== null && current.path === anchor.path && current.index === anchor.index && Math.abs(current.offset - anchor.offset) < 1) return;
      update({ ...state, scroll: anchor });
    },
    remap: (aliases) => {
      let movedSends = false;
      for (const ticket of sends) {
        const to = aliasedKey(ticket.key, aliases);
        if (to === undefined) continue;
        ticket.key = to;
        movedSends = true;
      }
      const remapped = remapThreadKeys(state, aliases);
      if (remapped === null) {
        if (movedSends) notify();
        return;
      }
      for (const key of remapped.changedDrafts) bump(key);
      update(remapped.state);
    },
    revision: (key) => revisions.get(key) ?? 0,
    beginSend: (key, body) => {
      const ticket = { key, body };
      sends.add(ticket);
      notify();
      return ticket;
    },
    endSend: (ticket, posted) => {
      if (!sends.delete(ticket)) return;
      const draft = state.drafts[ticket.key];
      if (!posted || draft === undefined) {
        notify();
        return;
      }
      const left = withoutSent(draft.body, ticket.body);
      const { [ticket.key]: _sent, ...rest } = state.drafts;
      bump(ticket.key);
      update({ ...state, drafts: left === null ? rest : { ...state.drafts, [ticket.key]: { ...draft, body: left } } });
    },
    sending: (key) => [...sends].some((ticket) => ticket.key === key),
    state: () => state,
    replace: (next) => {
      state = next;
      for (const key of Object.keys(next.drafts)) bump(key);
      notify();
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

export function ViewStateProvider({
  threadId,
  sessionId,
  saved,
  aliases,
  children,
}: {
  threadId: string;
  sessionId: string;
  saved: ViewState | null;
  /** The session's folded thread ids, as the latest load or thread list gave them. */
  aliases: ThreadAliases;
  children: ReactNode;
}) {
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
    let held = windowStores.get(key);
    if (held === undefined) {
      const save = { current: (_state: ViewState) => undefined as void };
      const initial = saved ?? emptyState();
      // The server's copy may predate a fold it has seen since (an existing store is remapped by the effect below).
      held = { store: createViewStateStore(remapThreadKeys(initial, aliases ?? {})?.state ?? initial, (state) => save.current(state)), save };
      windowStores.set(key, held);
    } else if (saved !== null && saved.savedAt > held.store.state().savedAt) {
      // Of this window's copy and the server's, the one saved last wins.
      held.store.replace(saved);
    }
    held.save.current = (state) => {
      pending.current = state;
      if (timer.current === null) timer.current = setTimeout(() => flush.current(), SAVE_DELAY_MS);
    };
    return held.store;
  });

  // A fold this window's store has not seen (one after the tab mounted, or while it was away): the
  // live drafts move, and with them the save still pending.
  const aliasesJson = JSON.stringify(aliases ?? {});
  useEffect(() => {
    store.remap(JSON.parse(aliasesJson) as ThreadAliases);
  }, [store, aliasesJson]);

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
  // A draft moved here from a folded thread (`remap`) opens, or shows its new text; one posted closes.
  const revision = useSyncExternalStore(store.subscribe, () => store.revision(key));
  const sending = useSyncExternalStore(store.subscribe, () => store.sending(key));
  useEffect(() => {
    if (revision > 0) setActive(store.draft(key) ?? null);
  }, [store, key, revision]);
  return {
    active,
    /** Changes when the draft's text was replaced from outside its editor; remount the editor on it. */
    revision,
    /** A submission of this draft is under way (`send`), whichever editor started it. */
    sending,
    /**
     * Submits the draft's text with `post`; once posted, only that text leaves the draft (what a fold
     * joined to it meanwhile stays). The draft is busy until `post` settles.
     */
    async send(body: string, post: () => Promise<void>) {
      const ticket = store.beginSend(key, body);
      let posted = false;
      try {
        await post();
        posted = true;
      } finally {
        store.endSend(ticket, posted);
      }
    },
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
