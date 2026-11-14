/**
 * The speech hooks on the speaking window's side: which machine this window
 * runs on, and asking the server to run that machine's hook there.
 *
 * Only bb's desktop app runs them. It runs on a machine with a bb host daemon,
 * and that daemon answers `GET http://127.0.0.1:<port>/status` with its host
 * id — the same call bb's own app makes to offer the native folder picker,
 * on the ports `system.config().localHelperPorts` lists. That endpoint is bb
 * internals, not SDK, like `window.bbDesktop`; if a later bb changes it, the
 * hooks stop running and the settings say this machine is not found.
 *
 * A browser tab (which may be on any machine, and needs a permission prompt
 * to reach a local port) and the mobile app (no host daemon) skip the hooks.
 */
import { SPEECH_HOOK_RENEW_MS, SPEECH_HOOK_TIMEOUT_MS } from "../shared/speech-hooks";
import type { SpeechPlatform } from "../shared/settings";

/** What the local host daemon's `/status` answers; only what Herald reads. */
export interface LocalHostStatus {
  hostId: string;
  connected: boolean;
  serverUrl: string;
}

function parseStatus(value: unknown): LocalHostStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const { hostId, connected, serverUrl } = value as Record<string, unknown>;
  if (typeof hostId !== "string" || hostId === "" || typeof connected !== "boolean") return null;
  return { hostId, connected, serverUrl: typeof serverUrl === "string" ? serverUrl : "" };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** How long one status read may take; the daemon is on this machine. */
const STATUS_TIMEOUT_MS = 1_500;

/**
 * The bb host id of the machine this window runs on, or null when no host
 * daemon here answers, or none is connected to a bb server. Of several, the
 * one connected to the server this window shows wins, as in bb's own app.
 */
export async function findLocalHostId(
  ports: readonly number[],
  origin: string | null,
  fetchStatus: (port: number) => Promise<unknown> = fetchLocalStatus,
): Promise<string | null> {
  const statuses = (
    await Promise.all(ports.map((port) => fetchStatus(port).then(parseStatus, () => null)))
  ).filter((status): status is LocalHostStatus => status !== null && status.connected);
  const ours = origin === null ? undefined : statuses.find((status) => originOf(status.serverUrl) === origin);
  return (ours ?? statuses[0])?.hostId ?? null;
}

async function fetchLocalStatus(port: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export interface SpeechRunDeps {
  platform(): SpeechPlatform;
  /** This window's machine, or null when it has none bb knows; see `findLocalHostId`. */
  localHostId(): Promise<string | null>;
  /** The `hooks.begin`, `hooks.renew` and `hooks.end` RPCs. */
  begin(hostId: string, runId: string): Promise<{ open: boolean | null; error: string | null }>;
  /** `open` false: the machine has closed the run. Null, or a failed call: unknown, so renewing goes on. */
  renew(hostId: string, runId: string): Promise<{ open: boolean | null }>;
  end(hostId: string, runId: string): Promise<{ error: string | null }>;
  report(level: "info" | "warn", message: string, error?: unknown): void;
  /** How long speech waits for the run to start (the machine's before hook) before going on. */
  timeoutMs?: number;
  renewMs?: number;
  newRunId?: () => string;
}

/** One run of speech in this window: the before hook around its start, the after hook at its end. */
export interface SpeechRun {
  /**
   * Resolves when the run has started on the machine — its before hook has
   * finished — or failed, or took longer than the deadline. Never rejects.
   */
  ready: Promise<void>;
  /**
   * Ends the run: the machine runs the after hook once no other run is open
   * there. Safe to call more than once and at any point, also before `ready`.
   * Never rejects.
   */
  end(): Promise<void>;
}

export type SpeechRunStarter = () => SpeechRun;

const NO_RUN: SpeechRun = { ready: Promise.resolve(), end: async () => {} };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts runs of speech for this window. Off bb's desktop app every run is
 * empty and reads nothing.
 *
 * A run is bound to one machine and one run id from its start. Its deadline
 * only ends the wait for speech: a lookup still pending at the deadline is
 * never sent on, so a late answer cannot start a before hook after the speech
 * it was for; a `begin` already sent is left to finish, and `end` still goes —
 * the machine runs that run's after hook after its before, in that order,
 * whichever of the two calls arrives first. While the run is open the window
 * renews it, so a window that disappears stops renewing and the machine ends
 * the run itself.
 */
export function createSpeechRunStarter(deps: SpeechRunDeps): SpeechRunStarter {
  const timeoutMs = deps.timeoutMs ?? SPEECH_HOOK_TIMEOUT_MS + 2_000;
  const renewMs = deps.renewMs ?? SPEECH_HOOK_RENEW_MS;
  const newRunId = deps.newRunId ?? (() => crypto.randomUUID());
  return () => {
    if (deps.platform() !== "desktop") return NO_RUN;
    const runId = newRunId();
    /** The deadline passed or the run ended before `begin` was sent: it is never sent. */
    let closed = false;
    let hostId: string | null = null;
    /** Null until the machine answers, or when it never does. */
    let open: boolean | null = null;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let ending: Promise<void> | null = null;

    const started = (async () => {
      const found = await deps.localHostId();
      if (found === null || closed) return;
      hostId = found;
      const result = await deps.begin(found, runId);
      open = result.open;
      // A before hook that failed is in the plugin's log already, with the machine.
      if (open !== false && ending === null) {
        // Only the machine saying the run is closed stops the renewals: a renewal that failed, or
        // that the machine could not be asked about, is tried again at the next one, while the
        // lease (three renewals long) still holds.
        renewal = setInterval(() => {
          deps.renew(found, runId).then(
            (renewed) => {
              if (renewed.open === false) clearInterval(renewal);
            },
            () => {},
          );
        }, renewMs);
      }
    })().catch((error: unknown) => deps.report("warn", `Could not start the before-speaking hook: ${describe(error)}`, error));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), timeoutMs);
    });
    const ready = Promise.race([started, late]).then((outcome) => {
      clearTimeout(timer);
      if (outcome !== "late") return;
      if (hostId === null) closed = true;
      deps.report("warn", `The before-speaking hook took longer than ${Math.round(timeoutMs / 1000)} seconds; speaking without waiting for it.`);
    });

    const end = async () => {
      closed = true;
      clearInterval(renewal);
      clearTimeout(timer);
      const machine = hostId;
      // Never sent, or the machine opened nothing: nothing is owed.
      if (machine === null || open === false) return;
      try {
        await deps.end(machine, runId);
      } catch (error) {
        deps.report("warn", `Could not end the run of speech; the machine ends it by itself shortly: ${describe(error)}`, error);
      }
    };
    return {
      ready,
      end: () => {
        ending ??= end();
        return ending;
      },
    };
  };
}

/**
 * This window's machine, looked up once and kept; a lookup that finds none is
 * not kept, so a host daemon started later is found on the next run.
 */
export function createLocalHostLookup(
  ports: () => Promise<readonly number[]>,
  origin: () => string | null = () => (typeof window === "undefined" ? null : window.location.origin),
  fetchStatus?: (port: number) => Promise<unknown>,
): () => Promise<string | null> {
  let found: string | null = null;
  return async () => {
    if (found !== null) return found;
    found = await findLocalHostId(await ports(), origin(), fetchStatus);
    return found;
  };
}
