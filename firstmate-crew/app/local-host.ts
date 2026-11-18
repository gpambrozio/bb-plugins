/**
 * Which bb machine this window runs on, for the first-run guide's Browse button: bb's native folder
 * picker opens on the machine the window runs on, so it can pick the first mate's home only when that is
 * the machine bb runs on.
 *
 * bb's desktop app runs beside a host daemon that answers `GET http://127.0.0.1:<port>/status` with its
 * host id, on the ports `system.config().localHelperPorts` lists — the call bb's own app makes before it
 * offers its folder picker. That endpoint is bb internals, not SDK (as in Herald's `speech-hooks.ts`):
 * if a later bb changes it, the guide shows no Browse button and the folder is typed.
 */

/** What the local host daemon's `/status` answers; only what this reads. */
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

async function fetchLocalStatus(port: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

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

/** Whether this window is bb's desktop app, the only client with a host daemon beside it to ask. */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "bbDesktop" in window && (window as { bbDesktop?: unknown }).bbDesktop != null;
}
