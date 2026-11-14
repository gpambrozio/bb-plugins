// OpenAI Realtime over HTTP and WebSocket: the WebRTC SDP exchange (`POST /v1/realtime/calls`), hangup,
// and the sideband socket on the same call (`?call_id=`), from the phase 0 spike.
//
// Plain Node (global fetch, FormData and WebSocket), shared by the plugin server and the scripts in
// scripts/. Every error body passes through `redact` before it is returned, so no bearer token or `ek_`
// secret leaves this module in a result.

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

export function cut(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export async function errorText(response: Response, token: string): Promise<string> {
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

export function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
