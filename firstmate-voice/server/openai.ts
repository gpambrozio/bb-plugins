// OpenAI Realtime calls used by the phase 0 spike: the WebRTC SDP exchange
// (`POST /v1/realtime/calls`), the sideband socket (`?call_id=`), ephemeral
// client secrets, and a `reasoning.effort` probe over the plain WebSocket.
//
// Plain Node (global fetch, FormData and WebSocket), shared by the plugin
// server and the scripts in scripts/. Every error body passes through
// `redact` before it is returned, so no bearer token or `ek_` secret leaves
// this module in a result.

export const OPENAI_API = "https://api.openai.com/v1";
export const OPENAI_REALTIME_WSS = "wss://api.openai.com/v1/realtime";
export const DEFAULT_MODEL = "gpt-realtime-2.1";
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Replaces the token, any bearer header, JWT-shaped strings and `ek_` secrets. */
export function redact(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join("[token]");
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\bek_[A-Za-z0-9_-]+/gu, "ek_[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu, "[jwt]");
}

/** The config a WebRTC call is created with: the shape OpenAI's unified-interface example posts. */
export function callSession(options: { model: string; effort?: string; instructions?: string }) {
  return {
    type: "realtime",
    model: options.model,
    instructions: options.instructions ?? SPIKE_INSTRUCTIONS,
    ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
      },
      output: { voice: "marin" },
    },
  };
}

export const SPIKE_INSTRUCTIONS =
  "You are a voice assistant in a short connection test. Answer in one short sentence. " +
  "When asked for the time, call the get_time tool and read its answer.";

export const GET_TIME_TOOL = {
  type: "function",
  name: "get_time",
  description: "The current local time on the bb server.",
  parameters: { type: "object", properties: {} },
} as const;

export type HttpOutcome = {
  accepted: boolean;
  status: number | null;
  ms: number;
  /** The redacted error body, cut to 600 characters, when refused. */
  error?: string;
};

export type CallOutcome = HttpOutcome & {
  answerSdp?: string;
  callId?: string;
  location?: string;
};

function cut(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

async function errorText(response: Response, token: string): Promise<string> {
  return cut(redact(await response.text().catch(() => ""), token));
}

/** The unified interface: the server posts the browser's offer and the session; OpenAI answers with SDP and a call id. */
export async function createCall(options: {
  token: string;
  sdp: string;
  session: object;
  signal?: AbortSignal;
}): Promise<CallOutcome> {
  const started = performance.now();
  const form = new FormData();
  form.set("sdp", options.sdp);
  form.set("session", JSON.stringify(options.session));
  let response: Response;
  try {
    response = await fetch(`${OPENAI_API}/realtime/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}` },
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    return { accepted: false, status: null, ms: elapsed(started), error: redact(String(error), options.token) };
  }
  const ms = elapsed(started);
  if (!response.ok) return { accepted: false, status: response.status, ms, error: await errorText(response, options.token) };
  const location = response.headers.get("location") ?? undefined;
  return {
    accepted: true,
    status: response.status,
    ms,
    answerSdp: await response.text(),
    location,
    callId: location?.split("/").pop(),
  };
}

/** Ends a WebRTC call from the server. */
export async function hangup(token: string, callId: string): Promise<HttpOutcome> {
  const started = performance.now();
  try {
    const response = await fetch(`${OPENAI_API}/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const ms = elapsed(started);
    return response.ok
      ? { accepted: true, status: response.status, ms }
      : { accepted: false, status: response.status, ms, error: await errorText(response, token) };
  } catch (error) {
    return { accepted: false, status: null, ms: elapsed(started), error: redact(String(error), token) };
  }
}

export type ClientSecretOutcome = HttpOutcome & {
  /** Seconds the secret is valid for, from `expires_at`. Never the secret itself. */
  validForSeconds?: number;
  secretPrefix?: string;
  /** The effective session OpenAI echoed, when it did. */
  sessionModel?: string;
  sessionEffort?: string;
};

/**
 * `POST /v1/realtime/client_secrets`. The secret is not returned: only that
 * one came back and how long it lives. Pass `keep` to get it for one more
 * check, which the caller must not log.
 */
export async function createClientSecret(options: {
  token: string;
  session: object;
  seconds?: number;
  keep?: (secret: string) => void;
}): Promise<ClientSecretOutcome> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${OPENAI_API}/realtime/client_secrets`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: options.seconds ?? 60 },
        session: options.session,
      }),
    });
  } catch (error) {
    return { accepted: false, status: null, ms: elapsed(started), error: redact(String(error), options.token) };
  }
  const ms = elapsed(started);
  if (!response.ok) return { accepted: false, status: response.status, ms, error: await errorText(response, options.token) };
  const body = (await response.json()) as {
    value?: unknown;
    expires_at?: unknown;
    session?: { model?: unknown; reasoning?: { effort?: unknown } };
  };
  const secret = typeof body.value === "string" ? body.value : "";
  if (secret) options.keep?.(secret);
  return {
    accepted: secret !== "",
    status: response.status,
    ms,
    secretPrefix: secret ? `${secret.slice(0, 3)}…` : undefined,
    validForSeconds: typeof body.expires_at === "number" ? Math.round(body.expires_at - Date.now() / 1000) : undefined,
    sessionModel: typeof body.session?.model === "string" ? body.session.model : undefined,
    sessionEffort: typeof body.session?.reasoning?.effort === "string" ? body.session.reasoning.effort : undefined,
    ...(secret ? {} : { error: "200 without a value" }),
  };
}

/** The browser path for an ephemeral key: the raw offer posted with `Content-Type: application/sdp`. */
export async function createCallWithSecret(secret: string, sdp: string): Promise<CallOutcome> {
  const started = performance.now();
  try {
    const response = await fetch(`${OPENAI_API}/realtime/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/sdp" },
      body: sdp,
    });
    const ms = elapsed(started);
    if (!response.ok) return { accepted: false, status: response.status, ms, error: await errorText(response, secret) };
    const location = response.headers.get("location") ?? undefined;
    return { accepted: true, status: response.status, ms, answerSdp: await response.text(), location, callId: location?.split("/").pop() };
  } catch (error) {
    return { accepted: false, status: null, ms: elapsed(started), error: redact(String(error), secret) };
  }
}

export type RealtimeEvent = Record<string, unknown> & { type: string };

/**
 * A server-side Realtime socket: `?call_id=` (the sideband of a WebRTC call)
 * or `?model=` (a session of its own, for the relay and the effort probe).
 * Node's WebSocket takes headers in its init object; an error it throws can
 * quote the header, so only its name leaves here.
 */
export function openRealtimeSocket(options: {
  token: string;
  query: { call_id: string } | { model: string };
}): WebSocket {
  const url = new URL(OPENAI_REALTIME_WSS);
  for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
  try {
    return new WebSocket(url, { headers: { authorization: `Bearer ${options.token}` } } as unknown as string[]);
  } catch (error) {
    throw new Error(`Could not open the Realtime socket (${error instanceof Error ? error.name : "unknown error"}).`);
  }
}

export async function eventFrom(data: unknown): Promise<RealtimeEvent | null> {
  const raw = typeof data === "string" ? data : data instanceof Blob ? await data.text() : Buffer.from(data as ArrayBuffer).toString("utf8");
  try {
    const event = JSON.parse(raw) as RealtimeEvent;
    return typeof event?.type === "string" ? event : null;
  } catch {
    return null;
  }
}

export type SocketProbe = {
  opened: boolean;
  /** The first event's type, `session.created` when the socket was accepted. */
  firstEvent?: string;
  /** HTTP status of a refused upgrade is not visible to a WebSocket; the close code and reason are. */
  close?: string;
  error?: string;
  ms: number;
};

/**
 * Opens a sideband on a call, waits for its first event, optionally sends a
 * `session.update`, and closes. Used by the live check; the plugin keeps its
 * sideband open instead.
 */
export function probeSideband(token: string, callId: string, update?: object, timeoutMs = 10_000): Promise<SocketProbe & { updated?: boolean }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const result: SocketProbe & { updated?: boolean } = { opened: false, ms: 0 };
    let socket: WebSocket;
    try {
      socket = openRealtimeSocket({ token, query: { call_id: callId } });
    } catch (error) {
      resolve({ ...result, error: String((error as Error).message), ms: elapsed(started) });
      return;
    }
    const timer = setTimeout(() => {
      result.error = `no event within ${timeoutMs / 1000} s`;
      socket.close(1000);
    }, timeoutMs);
    socket.onopen = () => {
      result.opened = true;
      if (update) socket.send(JSON.stringify({ type: "session.update", session: update }));
    };
    socket.onmessage = async (message) => {
      const event = await eventFrom(message.data);
      if (!event) return;
      result.firstEvent ??= event.type;
      if (event.type === "error") {
        result.error = redact(JSON.stringify(event.error), token);
        socket.close(1000);
      }
      if (event.type === "session.updated" || (!update && event.type === "session.created")) {
        if (event.type === "session.updated") result.updated = true;
        socket.close(1000);
      }
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      result.close = `${event.code}${event.reason ? ` ${redact(event.reason, token)}` : ""}`;
      result.ms = elapsed(started);
      resolve(result);
    };
  });
}

export type EffortProbe = {
  effort: string;
  accepted: boolean;
  /** What `session.updated` echoed back for `reasoning.effort`. */
  echoed?: string;
  error?: string;
};

/**
 * Opens one `?model=` socket and sends a `session.update` per effort value,
 * one at a time, recording `session.updated` or `error`. No audio is sent and
 * no response is created, so the session costs nothing but its opening.
 */
export function probeEfforts(token: string, model: string, efforts: readonly string[], timeoutMs = 20_000): Promise<{ opened: boolean; close?: string; error?: string; results: EffortProbe[] }> {
  return new Promise((resolve) => {
    const results: EffortProbe[] = [];
    let opened = false;
    let failure: string | undefined;
    let socket: WebSocket;
    try {
      socket = openRealtimeSocket({ token, query: { model } });
    } catch (error) {
      resolve({ opened, error: String((error as Error).message), results });
      return;
    }
    let index = -1;
    const next = () => {
      index += 1;
      if (index >= efforts.length) {
        socket.close(1000);
        return;
      }
      socket.send(JSON.stringify({ type: "session.update", event_id: `effort_${index}`, session: { type: "realtime", reasoning: { effort: efforts[index] } } }));
    };
    const timer = setTimeout(() => {
      failure = `timed out after ${timeoutMs / 1000} s`;
      socket.close(1000);
    }, timeoutMs);
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = async (message) => {
      const event = await eventFrom(message.data);
      if (!event) return;
      if (event.type === "session.created") {
        next();
        return;
      }
      if (index < 0 || index >= efforts.length) return;
      if (event.type === "session.updated") {
        const session = event.session as { reasoning?: { effort?: unknown } } | undefined;
        results.push({ effort: efforts[index], accepted: true, echoed: typeof session?.reasoning?.effort === "string" ? session.reasoning.effort : undefined });
        next();
      } else if (event.type === "error") {
        results.push({ effort: efforts[index], accepted: false, error: redact(JSON.stringify(event.error), token) });
        next();
      }
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve({ opened, close: `${event.code}${event.reason ? ` ${redact(event.reason, token)}` : ""}`, error: failure, results });
    };
  });
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
