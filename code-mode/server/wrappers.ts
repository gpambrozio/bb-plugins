// Where the wrapper's launcher is on each machine. The resolver must answer within bb's five seconds
// and always the same way, so it never waits on a host call when it can help it: a path the host
// entry confirmed is kept in memory and in storage (it is the same folder on every load), and a load
// checks it again in the background, since the launcher names the daemon's Node, which can move when
// bb updates. Only a machine never checked before makes the resolver wait for its host entry.
import type { InstallResult } from "../shared/host-contract";

export const PATHS_KEY = "wrapperPaths";
/** How long the resolver waits for a machine's first check before it gives up on Code Mode there. */
export const FIRST_CHECK_TIMEOUT_MS = 3_000;

export interface WrappersDeps {
  install(hostId: string): Promise<InstallResult>;
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  log: { info(message: string): void; warn(message: string): void };
  /** A machine's check came back different from before: tell the app. */
  changed?(): void;
  timeoutMs?: number;
}

export function createWrappers(deps: WrappersDeps) {
  /** Confirmed on this load. */
  const confirmed = new Map<string, string>();
  const checking = new Map<string, Promise<InstallResult>>();
  /** Each machine's last check on this load, for the app's Send-menu row. */
  const last = new Map<string, InstallResult>();
  let stored: Promise<Record<string, string>> | null = null;

  function storedPaths(): Promise<Record<string, string>> {
    stored ??= deps.kv
      .get<Record<string, string>>(PATHS_KEY)
      .then((value) => (value && typeof value === "object" ? { ...value } : {}))
      .catch(() => ({}));
    return stored;
  }

  /** Writes the wrapper on that machine; one check per machine at a time. */
  function check(hostId: string): Promise<InstallResult> {
    const pending = checking.get(hostId);
    if (pending) return pending;
    const run = (async (): Promise<InstallResult> => {
      let result: InstallResult;
      try {
        result = await deps.install(hostId);
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const before = last.get(hostId);
      last.set(hostId, result);
      if (before?.ok !== result.ok || (!result.ok && !before?.ok && before?.reason !== result.reason)) deps.changed?.();
      if (result.ok) {
        confirmed.set(hostId, result.path);
        const paths = await storedPaths();
        if (paths[hostId] !== result.path) {
          paths[hostId] = result.path;
          await deps.kv.set(PATHS_KEY, paths).catch((error: unknown) => deps.log.warn(`Could not save the wrapper's path for ${hostId}: ${String(error)}`));
        }
      } else {
        deps.log.warn(`The Code Mode wrapper is not ready on ${hostId}: ${result.reason}`);
      }
      return result;
    })().finally(() => checking.delete(hostId));
    checking.set(hostId, run);
    return run;
  }

  /** The launcher's path on that machine, or null when there is none to give bb. */
  async function pathFor(hostId: string): Promise<string | null> {
    const now = confirmed.get(hostId);
    if (now) return now;
    const known = (await storedPaths())[hostId];
    if (known) {
      void check(hostId);
      return known;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timeoutMs ?? FIRST_CHECK_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([check(hostId), timeout]);
      return result?.ok ? result.path : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Each machine checked on this load: whether its wrapper is ready, and why not. */
  function statuses(): Record<string, { ok: boolean; message: string }> {
    return Object.fromEntries([...last].map(([hostId, result]) => [hostId, result.ok ? { ok: true, message: "Wrapper ready" } : { ok: false, message: result.reason }]));
  }

  /** Whether a thread decided now on that machine could get the wrapper, and why not. */
  async function readiness(hostId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if ((await pathFor(hostId)) !== null) return { ok: true };
    const result = last.get(hostId);
    return { ok: false, reason: result && !result.ok ? result.reason : "the wrapper could not be checked there in time" };
  }

  return { check, pathFor, statuses, readiness };
}

export type Wrappers = ReturnType<typeof createWrappers>;
