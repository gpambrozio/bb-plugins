/**
 * A job's log in the detail pane: the tail on demand, and Follow.
 *
 * Follow asks the job's Mac to watch the log (`follow`, renewed while it
 * lasts) and reads only what was appended each time the server relays a
 * change. A slow poll backs the relay up, since realtime messages are not
 * persisted and a reconnect can drop one. Nothing runs in a terminal and no
 * workspace is borrowed: the watch lives in the plugin's own host worker and
 * ends by itself when renewals stop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

import { LOG_CHANGED, LogChangedSchema } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import type { Job, LogChunk } from "../shared/jobs";
import { errorText } from "./format";

/** How much of a followed log the pane keeps; older lines fall off the top. */
export const MAX_LOG_CHARS = 256 * 1024;
/** The backstop for a change relay that never arrived. */
const FOLLOW_POLL_MS = 5_000;
const MAX_RENEW_MS = 15_000;

export interface LogState {
  text: string;
  /** The line still being written; replaced, not appended, by the next read. */
  pending: string;
  next: number;
  /** Older output exists that the pane does not show. */
  truncated: boolean;
  path: string;
}

/** Folds a read into what the pane shows: replacing it, or extending it when following. */
export function applyChunk(state: LogState | null, chunk: LogChunk, extend: boolean): LogState {
  if (!extend || chunk.reset || state === null) {
    return { text: chunk.text, pending: chunk.pending, next: chunk.next, truncated: chunk.truncated, path: chunk.path };
  }
  let text = state.text + chunk.text;
  let truncated = state.truncated;
  if (text.length > MAX_LOG_CHARS) {
    const cut = text.slice(text.length - MAX_LOG_CHARS);
    const newline = cut.indexOf("\n");
    text = newline === -1 ? cut : cut.slice(newline + 1);
    truncated = true;
  }
  return { text, pending: chunk.pending, next: chunk.next, truncated, path: chunk.path };
}

export interface JobLog {
  log: LogState | null;
  loading: boolean;
  following: boolean;
  refresh(): void;
  startFollowing(): void;
  stopFollowing(): void;
}

export function useJobLog(hostId: string, job: Job, onError: (message: string) => void): JobLog {
  const rpc = useRpc<RpcContract>();
  const [log, setLog] = useState<LogState | null>(null);
  const [loading, setLoading] = useState(false);
  const [following, setFollowing] = useState(false);
  const latest = useRef<LogState | null>(null);
  latest.current = log;
  /** Bumped by every stop, start and job change; an answer from an older one is dropped. */
  const generation = useRef(0);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  const reading = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false });
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearInterval(timer);
    timers.current = [];
  }, []);

  const refresh = useCallback(() => {
    const mine = generation.current;
    setLoading(true);
    rpc
      .call("log", { hostId, id: job.id })
      .then((chunk) => {
        if (mine === generation.current) setLog(applyChunk(null, chunk, false));
      })
      .catch((error: unknown) => {
        if (mine === generation.current) errorRef.current(`Could not read the log: ${errorText(error)}`);
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
  }, [rpc, hostId, job.id]);

  /** Reads what was appended; one read at a time, and one more if asked meanwhile. */
  const readMore = useCallback(
    (mine: number) => {
      if (reading.current.busy) {
        reading.current.again = true;
        return;
      }
      reading.current = { busy: true, again: false };
      const from = latest.current?.next;
      rpc
        .call("log", from === undefined ? { hostId, id: job.id } : { hostId, id: job.id, from })
        .then((chunk) => {
          if (mine !== generation.current) return;
          const next = applyChunk(latest.current, chunk, true);
          latest.current = next;
          setLog(next);
        })
        .catch((error: unknown) => {
          if (mine === generation.current) errorRef.current(`Could not read the log: ${errorText(error)}`);
        })
        .finally(() => {
          const again = reading.current.again;
          reading.current = { busy: false, again: false };
          if (again && mine === generation.current) readMore(mine);
        });
    },
    [rpc, hostId, job.id],
  );

  const stopFollowing = useCallback(() => {
    generation.current += 1;
    clearTimers();
    setFollowing(false);
    void rpc.call("unfollow", { hostId, id: job.id }).catch(() => {
      // It ends by itself once renewals stop; nothing to tell the user.
    });
  }, [clearTimers, rpc, hostId, job.id]);

  const startFollowing = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    clearTimers();
    setFollowing(true);
    rpc
      .call("follow", { hostId, id: job.id })
      .then(({ expiresInMs }) => {
        if (mine !== generation.current) return;
        readMore(mine);
        const renewEvery = Math.min(MAX_RENEW_MS, Math.floor(expiresInMs / 3));
        timers.current.push(
          setInterval(() => {
            void rpc.call("follow", { hostId, id: job.id }).catch((error: unknown) => {
              if (mine === generation.current) errorRef.current(`Could not keep following the log: ${errorText(error)}`);
            });
          }, renewEvery),
          setInterval(() => readMore(mine), FOLLOW_POLL_MS),
        );
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        setFollowing(false);
        errorRef.current(`Could not follow the log: ${errorText(error)}`);
      });
  }, [clearTimers, rpc, hostId, job.id, readMore]);

  useRealtime(LOG_CHANGED, (payload) => {
    const parsed = LogChangedSchema.safeParse(payload);
    if (!following || !parsed.success || parsed.data.hostId !== hostId || parsed.data.id !== job.id) return;
    readMore(generation.current);
  });

  // A job swapped underneath a follow is a follow on the wrong file, and an
  // unmounted pane is a watch nobody can see.
  useEffect(() => {
    return () => {
      generation.current += 1;
      clearTimers();
    };
  }, [hostId, job.id, clearTimers]);

  useEffect(() => {
    setFollowing(false);
    setLog(null);
  }, [hostId, job.id]);

  // A fresh job, or a run that just finished, is the moment to look again.
  // Not while following: the follow is already ahead of anything a re-read
  // would find.
  const lastFinished = job.recentRuns[0]?.finishedAt ?? null;
  useEffect(() => {
    if (!following) refresh();
  }, [following, refresh, lastFinished]);

  // Leaving while following tells the Mac now, rather than at the expiry.
  const followingRef = useRef(following);
  followingRef.current = following;
  useEffect(() => {
    return () => {
      if (followingRef.current) void rpc.call("unfollow", { hostId, id: job.id }).catch(() => {});
    };
  }, [rpc, hostId, job.id]);

  return { log, loading, following, refresh, startFollowing, stopFollowing };
}
