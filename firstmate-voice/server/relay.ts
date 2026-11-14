// The relayed fallback: the page streams PCM over a plugin WebSocket, and the
// bb server forwards it to a Realtime socket of its own (`?model=`, the path
// codex-realtime proved). Events go back the same way. The page sends its own
// `session.update`; the server only adds the tool and answers it.
//
// The route is `auth: "none"` and takes a one-time ticket the page gets over
// RPC (which bb authenticates), so it works from any origin bb serves the app
// on, a Connect port share included, as screen-sharing's relay passes a token.
import { randomBytes } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { GET_TIME_TOOL, eventFrom, openRealtimeSocket, redact } from "./openai";

export const RELAY_ROUTE = "/relay";
const MAX_RELAY_MS = 90_000;
const TICKET_MS = 60_000;

export function createTickets(now: () => number = Date.now) {
  const tickets = new Map<string, number>();
  return {
    issue(): string {
      for (const [ticket, expires] of tickets) if (expires <= now()) tickets.delete(ticket);
      const ticket = randomBytes(18).toString("base64url");
      tickets.set(ticket, now() + TICKET_MS);
      return ticket;
    },
    /** True once per ticket, within its minute. */
    redeem(ticket: string | null): boolean {
      if (!ticket) return false;
      const expires = tickets.get(ticket);
      tickets.delete(ticket);
      return expires !== undefined && expires > now();
    },
  };
}

type PageSocket = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void; readonly readyState: number };

export function relayHandler(options: {
  token: (signal?: AbortSignal) => Promise<{ token: string; source: string }>;
  tickets: ReturnType<typeof createTickets>;
  log: BbPluginApi["log"];
}) {
  return ({ url }: { url: URL }) => {
    const admitted = options.tickets.redeem(url.searchParams.get("ticket"));
    const model = url.searchParams.get("model") || "gpt-realtime-2.1";
    let upstream: WebSocket | null = null;
    let token = "";
    const queued: string[] = [];
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let page: PageSocket | null = null;
    const toPage = (event: object) => {
      if (page && page.readyState === 1) page.send(JSON.stringify(event));
    };
    const closeAll = (reason: string) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close(1000);
      if (page && page.readyState <= 1) page.close(1000, reason);
    };

    return {
      async onOpen(socket: PageSocket) {
        page = socket;
        if (!admitted) {
          socket.close(4401, "missing or expired ticket");
          return;
        }
        timer = setTimeout(() => closeAll("time limit"), MAX_RELAY_MS);
        let credential;
        try {
          credential = await options.token();
        } catch (error) {
          toPage({ type: "relay.error", message: error instanceof Error ? error.message : String(error) });
          closeAll("no credential");
          return;
        }
        token = credential.token;
        try {
          upstream = openRealtimeSocket({ token, query: { model } });
        } catch (error) {
          toPage({ type: "relay.error", message: (error as Error).message });
          closeAll("upstream failed");
          return;
        }
        upstream.onopen = () => {
          toPage({ type: "relay.upstream_open", ms: Math.round(performance.now() - started), credential: credential.source });
          upstream?.send(JSON.stringify({ type: "session.update", session: { type: "realtime", tools: [GET_TIME_TOOL], tool_choice: "auto" } }));
          for (const message of queued.splice(0)) upstream?.send(message);
        };
        upstream.onmessage = async (message) => {
          const event = await eventFrom(message.data);
          if (!event) return;
          if (event.type === "error") event.error = JSON.parse(redact(JSON.stringify(event.error), token));
          toPage(event);
          if (event.type === "response.function_call_arguments.done" && event.name === GET_TIME_TOOL.name) {
            upstream?.send(JSON.stringify({
              type: "conversation.item.create",
              item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify({ time: new Date().toLocaleTimeString("en-US") }) },
            }));
            upstream?.send(JSON.stringify({ type: "response.create" }));
            toPage({ type: "relay.tool_output_sent" });
          }
        };
        upstream.onclose = (event) => {
          toPage({ type: "relay.upstream_close", code: event.code, reason: redact(event.reason ?? "", token) });
          options.log.info(`Relay upstream closed ${event.code} after ${Math.round(performance.now() - started)} ms.`);
          closeAll("upstream closed");
        };
      },
      onMessage(_socket: PageSocket, data: string | Uint8Array) {
        const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(text);
        else if (queued.length < 200) queued.push(text);
      },
      onClose() {
        page = null;
        closeAll("page closed");
      },
      onError() {
        closeAll("page error");
      },
    };
  };
}
