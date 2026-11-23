/**
 * Which bb machine this window runs on, for the voice hooks. Adapted from Herald's `app/speech-hooks.ts`.
 *
 * Only bb's desktop app runs the hooks. It runs beside a bb host daemon that answers
 * `GET http://127.0.0.1:<port>/status` with its host id — the call bb's own app makes for the native folder
 * picker, on the ports `system.config().localHelperPorts` lists. That endpoint is bb internals, not SDK, like
 * `window.bbDesktop`: if a later bb changes it, no hook runs and the settings say this machine is not found.
 * A browser tab (which would need a permission prompt to reach a local port) and the mobile app (no host
 * daemon) never look.
 */

/** What the local host daemon's `/status` answers; only what is read here. */
interface LocalHostStatus {
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
 * The bb host id of the machine this window runs on, or null when no host daemon here answers or none is
 * connected. Of several, the one connected to the server this window shows wins, as in bb's own app.
 */
export async function findLocalHostId(
  ports: readonly number[],
  origin: string | null,
  fetchStatus: (port: number) => Promise<unknown> = fetchLocalStatus,
): Promise<string | null> {
  const statuses = (await Promise.all(ports.map((port) => fetchStatus(port).then(parseStatus, () => null)))).filter(
    (status): status is LocalHostStatus => status !== null && status.connected,
  );
  const ours = origin === null ? undefined : statuses.find((status) => originOf(status.serverUrl) === origin);
  return (ours ?? statuses[0])?.hostId ?? null;
}

async function fetchLocalStatus(port: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * This window's machine, looked up once and kept; a lookup that finds none is not kept, so a host daemon
 * started later is found at the next Talk. Never rejects.
 */
export function createLocalHostLookup(
  ports: () => Promise<readonly number[]>,
  origin: () => string | null = () => (typeof window === "undefined" ? null : window.location.origin),
  fetchStatus?: (port: number) => Promise<unknown>,
): () => Promise<string | null> {
  let found: string | null = null;
  return async () => {
    if (found !== null) return found;
    try {
      found = await findLocalHostId(await ports(), origin(), fetchStatus);
    } catch {
      return null;
    }
    return found;
  };
}
