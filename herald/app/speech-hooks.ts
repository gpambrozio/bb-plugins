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
import { SPEECH_HOOK_TIMEOUT_MS, type SpeechHookKind } from "../shared/speech-hooks";
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

export interface HookRunnerDeps {
  platform(): SpeechPlatform;
  /** This window's machine, or null when it has none bb knows; see `findLocalHostId`. */
  localHostId(): Promise<string | null>;
  /** The server runs the hook stored for `hostId`; see the `hooks.run` RPC. */
  run(hostId: string, kind: SpeechHookKind): Promise<{ ran: boolean; error: string | null }>;
  report(level: "info" | "warn", message: string, error?: unknown): void;
  /** How long to wait for the run before speaking anyway. */
  timeoutMs?: number;
}

export type HookRunner = (kind: SpeechHookKind) => Promise<void>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a hook for this window, and resolves once it has finished, failed, or
 * taken too long — never rejects, so a hook never stands between Herald and
 * its voice. Off the desktop app it resolves at once without a single read.
 * A failure is reported to the plugin's log, with why.
 */
export function createHookRunner(deps: HookRunnerDeps): HookRunner {
  const timeoutMs = deps.timeoutMs ?? SPEECH_HOOK_TIMEOUT_MS + 2_000;
  return async (kind) => {
    if (deps.platform() !== "desktop") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), timeoutMs);
    });
    const attempt = (async () => {
      const hostId = await deps.localHostId();
      if (hostId === null) return;
      // A hook that failed is in the plugin's log already: the server writes
      // it there with the machine and the reason, so it is not echoed here.
      await deps.run(hostId, kind);
    })().catch((error: unknown) => deps.report("warn", `Could not run the ${kind}-speaking hook: ${describe(error)}`, error));
    try {
      if ((await Promise.race([attempt, late])) === "late") {
        const next = kind === "before" ? "speaking" : "going on";
        deps.report("warn", `The ${kind}-speaking hook took longer than ${Math.round(timeoutMs / 1000)} seconds; ${next} without waiting for it.`);
      }
    } finally {
      clearTimeout(timer);
    }
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
