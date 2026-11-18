/**
 * `RealtimePort` over OpenAI (`openai-call.ts`): each call gets the bearer from codex-realtime when it is
 * made and keeps it, in memory, only until it is hung up.
 */
import { createCall, eventFrom, hangup, openRealtimeSocket, redact } from "./openai-call";
import type { Log, RealtimePort, Sideband, SidebandHandlers } from "./ports";

export function openAiRealtime(options: { token: (signal?: AbortSignal) => Promise<string>; log: Log }): RealtimePort {
  const tokens = new Map<string, string>();

  return {
    async createCall({ sdp, session, signal }) {
      const token = await options.token(signal);
      const outcome = await createCall({ token, sdp, session, signal });
      if (!outcome.accepted || outcome.callId === undefined || outcome.answerSdp === undefined) {
        throw new Error(`OpenAI refused the call (${outcome.status ?? "no answer"}): ${outcome.error ?? "no SDP answer"}`);
      }
      tokens.set(outcome.callId, token);
      return { callId: outcome.callId, answerSdp: outcome.answerSdp };
    },

    async hangup(callId) {
      const token = tokens.get(callId);
      tokens.delete(callId);
      if (token === undefined) return;
      const outcome = await hangup(token, callId);
      // 404 call_id_not_found: the device closed its peer first, and the call has already ended.
      if (!outcome.accepted && outcome.status !== 404) {
        options.log.warn(`Hanging up ${callId} answered ${outcome.status ?? "nothing"}: ${outcome.error ?? ""}`);
      }
    },

    openSideband(callId, handlers: SidebandHandlers): Sideband {
      const token = tokens.get(callId);
      if (token === undefined) throw new Error(`No credential for call ${callId}; it has been hung up.`);
      let closing = false;
      const socket = openRealtimeSocket({ token, query: { call_id: callId } });
      socket.onopen = () => handlers.onOpen();
      socket.onmessage = async (message) => {
        const event = await eventFrom(message.data);
        if (event !== null) handlers.onEvent(event);
      };
      socket.onclose = (event) => {
        handlers.onClose({ code: event.code, reason: redact(event.reason ?? "", token), expected: closing });
      };
      socket.onerror = () => {
        // The close that follows says the rest; an error's text can quote a header, so nothing is logged here.
      };
      return {
        send(event) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
        },
        close() {
          closing = true;
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
        },
      };
    },
  };
}
