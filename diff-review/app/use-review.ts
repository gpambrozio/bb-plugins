/**
 * The Review tab's data: the view from `getReview`, kept fresh by the workspace's realtime channel.
 * A `threads` signal re-reads the session's threads; a `diff` signal (the workspace changed by the end
 * of an agent's turn) reloads the whole view. Signals are not replayed, so a reconnect reloads too.
 *
 * The server also sends `diff` when bb sees the workspace change outside a turn and its content did
 * (`ReviewService.watchChanges`). While the tab is hidden (its panel closed, another tab chosen) bb keeps it mounted;
 * reloads then wait until it shows again, and run once however many signals came.
 *
 * Every update lands in place: whatever came back unchanged keeps its old object, so React and
 * Pierre (which redraws a file's diff whenever its annotations array is a new one) leave it alone,
 * and only the thread an agent answered or the file that changed is drawn again. A patch loaded on
 * demand stays on screen while a reload fetches it again (`stalePatches`), instead of flashing
 * "Loading the diff…".
 */
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../shared/contract";
import { environmentChannel, realtimeSignalSchema, type DiffFile, type LoadReason, type ReviewThread, type ReviewView, type Run, type Target, type TargetRequest, type Viewed } from "../shared/types";

export type ReadyView = Extract<ReviewView, { ok: true }>;

export type ReviewState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }
  /**
   * `loadId` changes with every load of the view, so the tab knows its patches were replaced.
   * `stalePatches`: on-demand files still showing the previous load's patch while it loads again.
   * `pending`: another view was picked and has not loaded yet (or could not be: `error`); `view` is
   * still the previous one, which the tab dims rather than passes off as the new one.
   */
  | { status: "ready"; view: ReadyView; refreshing: boolean; loadId: number; stalePatches: ReadonlySet<string>; pending: PendingView | null };

/** A view picked while another shows: what was asked for, and why it could not be loaded, if it could not. */
export interface PendingView {
  target: TargetRequest;
  error: string | null;
}

const NO_PATHS: ReadonlySet<string> = new Set();

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `next`, with each entry that equals the one of the same id in `previous` replaced by that one, and
 * `previous` itself when nothing changed.
 */
export function shareById<T extends { id: string }>(previous: readonly T[], next: readonly T[]): T[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  const shared = next.map((entry) => {
    const old = byId.get(entry.id);
    return old !== undefined && same(old, entry) ? old : entry;
  });
  return shared.length === previous.length && shared.every((entry, index) => entry === previous[index]) ? (previous as T[]) : shared;
}

/**
 * A reloaded view merged into the one on screen: unchanged files, threads and runs keep their objects.
 * A file whose patch the new load did not send (bb sends only some up front, "auto" files included)
 * keeps showing the patch it had, marked stale, until the loader fetches it again.
 */
export function mergeView(previous: ReadyView, previousStale: ReadonlySet<string>, next: ReadyView): { view: ReadyView; stale: ReadonlySet<string> } {
  const before = new Map(previous.files.map((file) => [file.path, file]));
  const stale = new Set<string>();
  const files = next.files.map((file): DiffFile => {
    const old = before.get(file.path);
    if (old === undefined) return file;
    if (!previousStale.has(file.path) && same(old, file)) return old;
    if (file.patch === null && old.patch !== null && !file.binary && file.loadMode !== "too_large") {
      stale.add(file.path);
      return { ...file, patch: old.patch, patchTruncated: old.patchTruncated };
    }
    return file;
  });
  const unchangedFiles = files.length === previous.files.length && files.every((file, index) => file === previous.files[index]);
  return {
    view: {
      ...next,
      files: unchangedFiles ? previous.files : files,
      threads: shareById(previous.threads, next.threads),
      runs: shareById(previous.runs, next.runs),
      commits: same(previous.commits, next.commits) ? previous.commits : next.commits,
      ignoredPaths: same(previous.ignoredPaths, next.ignoredPaths) ? previous.ignoredPaths : next.ignoredPaths,
    },
    stale,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long after GitHub answered a Viewed change a pull request's reads may still show the old mark:
 * a read GitHub serves from a replica not yet updated. Past it, a read that disagrees wins (the mark
 * changed elsewhere, on github.com say).
 */
export const GITHUB_VIEWED_LAG_MS = 10_000;

/**
 * A Viewed change the user made, kept over every load that may not have seen it: `seq` orders the
 * changes of one file, `doneAt` is when the write was answered (null while it is under way), `lag` how
 * long after that a read may still be behind.
 */
export interface ViewedToggle {
  viewed: Viewed;
  seq: number;
  doneAt: number | null;
  lag: number;
}

/**
 * What one file shows from a load that started at `startedAt` and read `read`, under the change
 * `toggle`, and whether the change still holds after it: a change still being written, or answered too
 * recently for that read to have seen it, wins; one that a load started after it settled confirms, or
 * that one started long enough after overrules, is done.
 */
function overlay(read: Viewed, toggle: ViewedToggle, startedAt: number): { viewed: Viewed; holds: boolean } {
  const settled = toggle.doneAt !== null && startedAt >= toggle.doneAt;
  // Started long enough after the write was answered: what it read is GitHub's (or bb's) word.
  if (settled && startedAt >= toggle.doneAt! + toggle.lag) return { viewed: read, holds: false };
  if (read === toggle.viewed) return { viewed: read, holds: !settled };
  return { viewed: toggle.viewed, holds: true };
}

/**
 * While a file's writes are under way, what it shows without them: the mark the server last took, and
 * the change that made it while that still holds (null: the mark is what loads read). A failed write
 * with no later change goes back to it.
 */
export interface ViewedBase {
  viewed: Viewed;
  toggle: ViewedToggle | null;
}

/**
 * `view` with the user's Viewed changes (`toggles`) over what a load that started at `startedAt` read
 * (`overlay`); the changes it ends are dropped. The same load moves each file's `bases` on, as it would
 * have without the changes under way. Files keep their object when unchanged.
 */
export function applyViewedToggles(view: ReadyView, toggles: Map<string, ViewedToggle>, startedAt: number, bases?: Map<string, ViewedBase>): ReadyView {
  let changed = false;
  const files = view.files.map((file) => {
    const key = toggleKey(view.sessionId, file.path);
    const base = bases?.get(key);
    if (base !== undefined) {
      const under = base.toggle === null ? { viewed: file.viewed, holds: false } : overlay(file.viewed, base.toggle, startedAt);
      bases!.set(key, { viewed: under.viewed, toggle: under.holds ? base.toggle : null });
    }
    const toggle = toggles.get(key);
    if (toggle === undefined) return file;
    const shown = overlay(file.viewed, toggle, startedAt);
    if (!shown.holds) toggles.delete(key);
    if (shown.viewed === file.viewed) return file;
    changed = true;
    return { ...file, viewed: shown.viewed };
  });
  return changed ? { ...view, files } : view;
}

function toggleKey(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`;
}

/** How often a showing tab renews its watch; the server lets one lapse after 90 seconds. */
const LEASE_RENEW_MS = 30_000;

/** Reasons a load waits for while the tab is hidden: the workspace may have changed. */
const DEFERRABLE: ReadonlySet<LoadReason> = new Set(["diff-signal", "reconnect"]);

export interface ReviewOptions {
  /** The thread's environment as bb gave the tab, so signals are heard from the first render. */
  environmentId?: string | null;
  /** Let the first load replace an empty uncommitted view with the branch's commits (the server decides). */
  autoTarget?: boolean;
  /** Told the view the first load landed on, so the caller's picker follows; it is not loaded again. */
  onTarget?: (target: Target) => void;
  ignoreWhitespace?: boolean;
  /** Whether the review shows (its tab selected in an open panel); a hidden one waits to reload. */
  visible?: boolean;
}

export function useReview(threadId: string, target: TargetRequest, options: ReviewOptions = {}) {
  const { autoTarget = false, onTarget, ignoreWhitespace = false, visible = true } = options;
  const rpc = useRpc<RpcContract>();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // A load a signal asked for while the tab was hidden, run when it shows.
  const deferred = useRef<LoadReason | null>(null);
  const [state, setState] = useState<ReviewState>({ status: "loading" });
  // Loads can overlap (a signal during a load); only the latest one lands.
  const generation = useRef(0);
  const targetJson = JSON.stringify(target);
  // Only the very first load may pick the view; any later one, the user's choice included, may not.
  const autoPending = useRef(autoTarget);
  // The target the server already answered for, when it picked it: adopting it needs no new load.
  const adopted = useRef<string | null>(null);
  const onTargetRef = useRef(onTarget);
  onTargetRef.current = onTarget;
  // The user's Viewed changes not yet known to be read back, by session and path, and each file's
  // writes in order: a change waits for the one before it, so GitHub gets them as they were made.
  const toggles = useRef(new Map<string, ViewedToggle>());
  const writes = useRef(new Map<string, Promise<void>>());
  // While a file's writes are under way, what it shows without them (`ViewedBase`).
  const bases = useRef(new Map<string, ViewedBase>());
  const toggleSeq = useRef(0);
  // The view request whose answer is on screen; a load of any other is a switch, shown as pending.
  const shown = useRef<string | null>(null);

  // A signal or a reconnect while a load is under way does not start a second one beside it: it waits,
  // and one more load runs when the current one ends (it may have read the workspace before the
  // change). A new view or the user's own reload replaces the current load instead.
  const inFlight = useRef(false);
  // Which tab this is, in the plugin's debug log: one signal reloads every open tab, so a pair of loads
  // from two tabs (a desktop and a remote browser) reads apart from one tab loading twice.
  const [tab] = useState(() => Math.random().toString(36).slice(2, 8));
  const queued = useRef<LoadReason | null>(null);
  const loadRef = useRef<(reason: LoadReason) => Promise<void>>(async () => undefined);

  const load = useCallback(async (reason: LoadReason) => {
    if (DEFERRABLE.has(reason) && !visibleRef.current) {
      deferred.current = reason;
      return;
    }
    if (inFlight.current && DEFERRABLE.has(reason)) {
      queued.current = reason;
      return;
    }
    inFlight.current = true;
    const mine = ++generation.current;
    const auto = autoPending.current;
    autoPending.current = false;
    const request = targetJson;
    const switching = shown.current !== null && shown.current !== request;
    const pending: PendingView | null = switching ? { target: JSON.parse(request) as TargetRequest, error: null } : null;
    setState((previous) => (previous.status === "ready" ? { ...previous, refreshing: true, pending } : { status: "loading" }));
    const startedAt = Date.now();
    try {
      const view = await rpc.call("getReview", {
        threadId,
        target: JSON.parse(targetJson) as TargetRequest,
        reason,
        tab,
        ...(auto ? { autoTarget: true } : {}),
        ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      });
      // An answer for a view no longer asked for (the user picked another meanwhile) never lands.
      if (mine !== generation.current) return;
      setState((previous) => {
        if (!view.ok) {
          // A picked view the server cannot read leaves the previous one dimmed under the message, so another can be picked.
          return previous.status === "ready" && switching ? { ...previous, refreshing: false, pending: { target: pending!.target, error: view.message } } : { status: "unavailable", message: view.message };
        }
        // A Viewed change made while this load was under way (or just before it) is not in what it read.
        const read = applyViewedToggles(view, toggles.current, startedAt, bases.current);
        if (previous.status !== "ready" || previous.view.sessionId !== view.sessionId) {
          return { status: "ready", view: read, refreshing: false, loadId: mine, stalePatches: NO_PATHS, pending: null };
        }
        const merged = mergeView(previous.view, previous.stalePatches, read);
        return { status: "ready", view: merged.view, refreshing: false, loadId: mine, stalePatches: merged.stale, pending: null };
      });
      if (view.ok) shown.current = request;
      if (view.ok && auto && JSON.stringify(view.target) !== targetJson) {
        adopted.current = JSON.stringify(view.target);
        shown.current = adopted.current;
        onTargetRef.current?.(view.target);
      }
    } catch (error) {
      if (mine !== generation.current) return;
      const message = errorMessage(error);
      setState((previous) =>
        previous.status === "ready" && switching ? { ...previous, refreshing: false, pending: { target: pending!.target, error: message } } : { status: "error", message },
      );
    } finally {
      if (mine === generation.current) {
        inFlight.current = false;
        const next = queued.current;
        queued.current = null;
        if (next !== null) void loadRef.current(next);
      }
    }
  }, [rpc, threadId, targetJson, tab, ignoreWhitespace]);
  loadRef.current = load;

  const firstLoad = useRef(true);
  const lastWhitespace = useRef(ignoreWhitespace);
  useEffect(() => {
    const whitespace = lastWhitespace.current !== ignoreWhitespace;
    lastWhitespace.current = ignoreWhitespace;
    if (adopted.current === targetJson && !whitespace) {
      adopted.current = null;
      return;
    }
    void load(firstLoad.current ? "open" : whitespace ? "whitespace" : "view");
    firstLoad.current = false;
  }, [load, targetJson, ignoreWhitespace]);

  // A reload asked for while the tab was hidden runs once it shows.
  useEffect(() => {
    if (!visible || deferred.current === null) return;
    const reason = deferred.current;
    deferred.current = null;
    void loadRef.current(reason);
  }, [visible]);

  const sessionId = state.status === "ready" ? state.view.sessionId : null;
  const viewKind = state.status === "ready" ? state.view.target.kind : null;

  // While the tab shows, it holds the server's watch on its workspace (bb's changes outside a turn are
  // checked), renewed before it lapses and given back when the tab hides or closes.
  useEffect(() => {
    if (!visible || sessionId === null || viewKind === null) return;
    const lease = (active: boolean) => void rpc.call("watchWorkspace", { threadId, tab, view: viewKind, active }).catch(() => undefined);
    lease(true);
    const renew = setInterval(() => lease(true), LEASE_RENEW_MS);
    return () => {
      clearInterval(renew);
      lease(false);
    };
  }, [visible, sessionId, viewKind, rpc, threadId, tab]);
  const environmentId = options.environmentId ?? (state.status === "ready" ? state.view.environmentId : null);

  const refreshThreads = useCallback(async () => {
    if (sessionId === null) return;
    try {
      const { threads, runs } = await rpc.call("listThreads", { sessionId });
      setState((previous) =>
        previous.status === "ready" && previous.view.sessionId === sessionId
          ? { ...previous, view: { ...previous.view, threads: shareById(previous.view.threads, threads), runs: shareById(previous.view.runs, runs) } }
          : previous,
      );
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
    }
  }, [rpc, sessionId]);

  /** Puts a thread an RPC returned in place, so the tab does not wait for the realtime signal. */
  const putThread = useCallback((thread: ReviewThread) => {
    setState((previous) => {
      if (previous.status !== "ready" || previous.view.sessionId !== thread.sessionId) return previous;
      const threads = previous.view.threads.some((row) => row.id === thread.id)
        ? previous.view.threads.map((row) => (row.id === thread.id ? thread : row))
        : [...previous.view.threads, thread];
      return { ...previous, view: { ...previous.view, threads } };
    });
  }, []);

  /** Puts a run an RPC returned in place (or first), so the tab does not wait for the signal. */
  const putRun = useCallback((run: Run) => {
    setState((previous) => {
      if (previous.status !== "ready" || previous.view.sessionId !== run.sessionId) return previous;
      const others = previous.view.runs.filter((row) => row.id !== run.id);
      const runs = run.status === "closed" ? others : [run, ...others];
      return { ...previous, view: { ...previous.view, runs } };
    });
  }, []);

  /** Sets a file's Viewed mark in place. */
  const putViewed = useCallback((sessionId: string, path: string, viewed: Viewed) => {
    setState((previous) => {
      if (previous.status !== "ready" || previous.view.sessionId !== sessionId) return previous;
      const files = previous.view.files.map((file) => (file.path === path && file.viewed !== viewed ? { ...file, viewed } : file));
      return { ...previous, view: { ...previous.view, files } };
    });
  }, []);

  /**
   * The user's Viewed change of a file: shown at once, written by `write` after the file's previous
   * change was answered, and kept over every load that cannot have read it (`applyViewedToggles`).
   * When the write fails and no later change was made, the file goes back to its `ViewedBase`: the
   * mark shown when no earlier change was under way, with the change that made it while that still
   * holds, moved on by each later write that succeeded and by each load that landed meanwhile. The
   * error is the caller's to show. `lag`: how long after its answer a read may still be behind (a pull
   * request's).
   */
  const changeViewed = useCallback((sessionId: string, path: string, viewed: Viewed, before: Viewed, lag: number, write: () => Promise<void>): Promise<void> => {
    const key = toggleKey(sessionId, path);
    const seq = ++toggleSeq.current;
    if (!writes.current.has(key)) {
      // An answered change still kept over older loads keeps protecting the mark if this one fails.
      const held = toggles.current.get(key);
      bases.current.set(key, { viewed: before, toggle: held !== undefined && held.doneAt !== null && held.viewed === before ? held : null });
    }
    toggles.current.set(key, { viewed, seq, doneAt: null, lag });
    putViewed(sessionId, path, viewed);
    const run = async () => {
      try {
        await write();
      } catch (error) {
        if (toggles.current.get(key)?.seq === seq) {
          const base = bases.current.get(key) ?? { viewed: before, toggle: null };
          if (base.toggle === null) toggles.current.delete(key);
          else toggles.current.set(key, base.toggle);
          putViewed(sessionId, path, base.viewed);
        }
        throw error;
      }
      const toggle = toggles.current.get(key);
      const done: ViewedToggle = toggle?.seq === seq ? toggle : { viewed, seq, doneAt: null, lag };
      done.doneAt = Date.now();
      bases.current.set(key, { viewed, toggle: done });
    };
    const previous = writes.current.get(key) ?? Promise.resolve();
    const mine = previous.then(run, run);
    const settled = mine.catch(() => undefined);
    writes.current.set(key, settled);
    void settled.then(() => {
      if (writes.current.get(key) !== settled) return;
      writes.current.delete(key);
      bases.current.delete(key);
    });
    return mine;
  }, [putViewed]);

  /**
   * Fills in patches loaded on demand for the load `loadId` of session `sessionId`. An answer that
   * arrives after the view changed (another view, or a reload) is dropped: same paths, other diffs.
   */
  const putPatches = useCallback((sessionId: string, loadId: number, patches: readonly { path: string; patch: string; truncated: boolean }[]) => {
    const byPath = new Map(patches.map((patch) => [patch.path, patch]));
    setState((previous) => {
      if (previous.status !== "ready" || previous.view.sessionId !== sessionId || previous.loadId !== loadId) return previous;
      const files = previous.view.files.map((file): DiffFile => {
        const patch = byPath.get(file.path);
        if (patch === undefined || (file.patch === patch.patch && file.patchTruncated === patch.truncated)) return file;
        return { ...file, patch: patch.patch, patchTruncated: patch.truncated };
      });
      const stalePatches = new Set([...previous.stalePatches].filter((path) => !byPath.has(path)));
      return { ...previous, view: { ...previous.view, files }, stalePatches };
    });
  }, []);

  useRealtime(environmentId === null ? "" : environmentChannel(environmentId), (payload) => {
    const signal = realtimeSignalSchema.safeParse(payload);
    if (!signal.success) return;
    if (signal.data.kind === "diff") void load("diff-signal");
    else if (signal.data.sessionId === sessionId) void refreshThreads();
  });

  // Reload when the connection comes back (signals sent while it was down are lost), and only then:
  // a new `load` (another view) is loaded by the effect above.
  const connection = useRealtimeConnectionState();
  const lastConnection = useRef(connection);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connection;
    if (connection === "connected" && previous !== "connected") void loadRef.current("reconnect");
  }, [connection]);

  return { state, reload: load, putThread, putRun, putPatches, changeViewed, refreshThreads };
}
