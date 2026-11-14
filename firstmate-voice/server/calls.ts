// The WebRTC-direct path, server side: the SDP exchange with OpenAI and the
// sideband socket on the same call, which configures a tool, answers it, and
// can speak an out-of-band announcement into the call. Every event the
// sideband sees is logged with its time since the SDP exchange started, so
// the page and the scripts can read what happened.
import {
  GET_TIME_TOOL,
  callSession,
  createCall,
  eventFrom,
  hangup,
  openRealtimeSocket,
  redact,
  type CallOutcome,
  type HttpOutcome,
} from "./openai";

/** A call ends by itself after this, whatever the page does: voice time counts against the plan. */
export const MAX_CALL_MS = 90_000;

export type LoggedEvent = { t: number; type: string; info?: string };

export type CallLog = {
  callId: string;
  label: string;
  model: string;
  effort?: string;
  credential: string;
  createdAt: string;
  sdpExchange: Omit<CallOutcome, "answerSdp">;
  sideband: { opened: boolean; openedAt?: number; firstEvent?: string; firstEventAt?: number; updated?: boolean; close?: string; error?: string };
  tools: { name: string; argumentsDoneAt: number; outputSentAt: number; nextResponseAt?: number }[];
  announcements: { text: string; sentAt: number; responseCreatedAt?: number; doneAt?: number; status?: string }[];
  events: LoggedEvent[];
  hangup?: HttpOutcome;
  endedAt?: number;
};

type Live = {
  log: CallLog;
  token: string;
  socket: WebSocket | null;
  started: number;
  timer: ReturnType<typeof setTimeout>;
};

export type CallsOptions = {
  log: { info(message: string): void; warn(message: string): void };
  publish(channel: string, payload: unknown): void;
};

export const CALL_EVENTS_CHANNEL = "spike-call";

/** Text worth keeping beside an event's type; transcripts are the test's own words. */
function infoFor(event: Record<string, unknown>, token: string): string | undefined {
  switch (event.type) {
    case "conversation.item.input_audio_transcription.completed":
    case "response.output_audio_transcript.done":
      return String(event.transcript ?? "");
    case "response.function_call_arguments.done":
      return String(event.name ?? "");
    case "response.done": {
      const response = event.response as { status?: string; status_details?: unknown; metadata?: unknown } | undefined;
      return `${response?.status ?? "?"}${response?.metadata ? ` ${JSON.stringify(response.metadata)}` : ""}${response?.status_details ? ` ${JSON.stringify(response.status_details)}` : ""}`;
    }
    case "session.updated": {
      const session = event.session as { reasoning?: { effort?: string }; tools?: unknown[]; model?: string } | undefined;
      return `model ${session?.model ?? "?"}, effort ${session?.reasoning?.effort ?? "?"}, tools ${session?.tools?.length ?? 0}`;
    }
    case "error":
      return redact(JSON.stringify(event.error), token);
    default:
      return undefined;
  }
}

export function createCalls(options: CallsOptions) {
  const live = new Map<string, Live>();
  const finished: CallLog[] = [];

  const since = (call: Live) => Math.round(performance.now() - call.started);

  function record(call: Live, type: string, info?: string) {
    const entry: LoggedEvent = { t: since(call), type, ...(info ? { info } : {}) };
    call.log.events.push(entry);
    options.publish(CALL_EVENTS_CHANNEL, { callId: call.log.callId, ...entry });
  }

  function send(call: Live, event: object) {
    if (call.socket?.readyState === WebSocket.OPEN) call.socket.send(JSON.stringify(event));
  }

  async function onSidebandEvent(call: Live, event: Record<string, unknown> & { type: string }) {
    const sideband = call.log.sideband;
    if (sideband.firstEvent === undefined) {
      sideband.firstEvent = event.type;
      sideband.firstEventAt = since(call);
    }
    record(call, event.type, infoFor(event, call.token));
    if (event.type === "session.updated") sideband.updated = true;
    if (event.type === "response.created") {
      const pending = call.log.tools.find((tool) => tool.nextResponseAt === undefined);
      if (pending) pending.nextResponseAt = since(call);
      const response = event.response as { metadata?: { kind?: string } } | undefined;
      if (response?.metadata?.kind === "announce") {
        const announcement = call.log.announcements.find((item) => item.responseCreatedAt === undefined);
        if (announcement) announcement.responseCreatedAt = since(call);
      }
    }
    if (event.type === "response.done") {
      const response = event.response as { status?: string; metadata?: { kind?: string } } | undefined;
      if (response?.metadata?.kind === "announce") {
        const announcement = call.log.announcements.find((item) => item.doneAt === undefined);
        if (announcement) {
          announcement.doneAt = since(call);
          announcement.status = response.status;
        }
      }
    }
    if (event.type === "response.function_call_arguments.done" && event.name === GET_TIME_TOOL.name) {
      const argumentsDoneAt = since(call);
      send(call, {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify({ time: new Date().toLocaleTimeString("en-US") }) },
      });
      send(call, { type: "response.create" });
      call.log.tools.push({ name: GET_TIME_TOOL.name, argumentsDoneAt, outputSentAt: since(call) });
    }
  }

  function openSideband(call: Live) {
    const socket = openRealtimeSocket({ token: call.token, query: { call_id: call.log.callId } });
    call.socket = socket;
    socket.onopen = () => {
      call.log.sideband.opened = true;
      call.log.sideband.openedAt = since(call);
      record(call, "sideband.open");
      // A sideband change the page cannot make: the tool lives on the server.
      send(call, { type: "session.update", session: { type: "realtime", tools: [GET_TIME_TOOL], tool_choice: "auto" } });
    };
    socket.onmessage = async (message) => {
      const event = await eventFrom(message.data);
      if (event) await onSidebandEvent(call, event);
    };
    socket.onerror = () => {
      call.log.sideband.error ??= "socket error";
    };
    socket.onclose = (event) => {
      call.log.sideband.close = `${event.code}${event.reason ? ` ${redact(event.reason, call.token)}` : ""}`;
      record(call, "sideband.close", call.log.sideband.close);
    };
  }

  return {
    async start(input: { sdp: string; model: string; effort?: string; label: string; token: string; credential: string }): Promise<{ log: CallLog; answerSdp?: string }> {
      const started = performance.now();
      const outcome = await createCall({ token: input.token, sdp: input.sdp, session: callSession({ model: input.model, effort: input.effort }) });
      const { answerSdp, ...sdpExchange } = outcome;
      const log: CallLog = {
        callId: outcome.callId ?? `refused-${Date.now()}`,
        label: input.label,
        model: input.model,
        effort: input.effort,
        credential: input.credential,
        createdAt: new Date().toISOString(),
        sdpExchange,
        sideband: { opened: false },
        tools: [],
        announcements: [],
        events: [],
      };
      options.log.info(`WebRTC call ${log.callId} (${input.label}): /v1/realtime/calls ${outcome.status} in ${outcome.ms} ms via ${input.credential}.`);
      if (!outcome.accepted || !outcome.callId) {
        finished.push(log);
        return { log };
      }
      const call: Live = { log, token: input.token, socket: null, started, timer: setTimeout(() => void this.end(log.callId, "time limit"), MAX_CALL_MS) };
      live.set(log.callId, call);
      try {
        openSideband(call);
      } catch (error) {
        log.sideband.error = String((error as Error).message);
      }
      return { log, answerSdp };
    },

    announce(callId: string, text: string): boolean {
      const call = live.get(callId);
      if (!call?.socket || call.socket.readyState !== WebSocket.OPEN) return false;
      call.log.announcements.push({ text, sentAt: since(call) });
      record(call, "announce.sent", text);
      send(call, {
        type: "response.create",
        response: {
          conversation: "none",
          metadata: { kind: "announce" },
          output_modalities: ["audio"],
          instructions: `Say exactly this sentence and nothing else: "${text}"`,
          input: [],
        },
      });
      return true;
    },

    /** The page tells the server what it measured, so one log holds both sides. */
    note(callId: string, type: string, info?: string) {
      const call = live.get(callId);
      if (call) record(call, `page.${type}`, info);
    },

    async end(callId: string, reason: string): Promise<CallLog | null> {
      const call = live.get(callId);
      if (!call) return finished.find((log) => log.callId === callId) ?? null;
      live.delete(callId);
      clearTimeout(call.timer);
      record(call, "end", reason);
      call.log.hangup = await hangup(call.token, callId);
      call.socket?.close(1000);
      call.log.endedAt = since(call);
      finished.push(call.log);
      if (finished.length > 20) finished.shift();
      options.log.info(`WebRTC call ${callId} ended (${reason}); hangup ${call.log.hangup.status}.`);
      return call.log;
    },

    get(callId: string): CallLog | null {
      return live.get(callId)?.log ?? finished.find((log) => log.callId === callId) ?? null;
    },

    recent(): CallLog[] {
      return [...finished, ...[...live.values()].map((call) => call.log)].slice(-10);
    },

    async dispose() {
      await Promise.all([...live.keys()].map((callId) => this.end(callId, "plugin disposed")));
    },
  };
}
