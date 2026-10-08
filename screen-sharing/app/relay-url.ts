/**
 * Where noVNC opens its WebSocket: the plugin's relay route on the bb server
 * the app was loaded from. bb serves the app from the server's own origin —
 * http://127.0.0.1 on this Mac, https://<handle>.getbb.app remotely — so the
 * page's origin is the server's, and the socket is same-origin.
 */
import { PLUGIN_ID, VNC_ROUTE } from "../shared/channels";

export function relayUrl(origin: string, hostId: string, token: string): string {
  const url = new URL(`/api/v1/plugins/${PLUGIN_ID}/http${VNC_ROUTE}`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("host", hostId);
  url.searchParams.set("token", token);
  return url.toString();
}
