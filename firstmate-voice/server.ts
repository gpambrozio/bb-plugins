// firstmate-voice — phase 0 spike, server entry. Not released.
//
// The spike page (app.tsx) runs two paths to OpenAI Realtime on the ChatGPT
// subscription and measures them:
// - WebRTC direct: the page makes an SDP offer, `startCall` posts it to
//   /v1/realtime/calls and opens the sideband `?call_id=` socket (server/calls.ts);
// - relayed: the page streams PCM over the `/relay` plugin WebSocket to a
//   server-side Realtime socket (server/relay.ts).
// The token never reaches the app: it comes from codex-realtime's
// `realtimeConnection` (this plugin must be on its allow list).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { CALL_EVENTS_CHANNEL, createCalls } from "./server/calls";
import { subscriptionToken } from "./server/credential";
import { DEFAULT_MODEL, REASONING_EFFORTS } from "./server/openai";
import { RELAY_ROUTE, createTickets, relayHandler } from "./server/relay";

const Json = z.any();

export const rpcContract = defineRpcContract({
  startCall: {
    input: z.object({
      sdp: z.string().min(10).max(20_000),
      model: z.string().default(DEFAULT_MODEL),
      effort: z.enum(REASONING_EFFORTS).optional(),
      label: z.string().max(80).default("page"),
    }),
    output: z.object({ accepted: z.boolean(), answerSdp: z.string().optional(), log: Json }),
  },
  announce: { input: z.object({ callId: z.string(), text: z.string().max(300) }), output: z.object({ sent: z.boolean() }) },
  note: { input: z.object({ callId: z.string(), type: z.string().max(60), info: z.string().max(300).optional() }), output: z.null() },
  endCall: { input: z.object({ callId: z.string(), reason: z.string().max(80).default("page") }), output: z.object({ log: Json }) },
  call: { input: z.object({ callId: z.string() }), output: z.object({ log: Json }) },
  report: {
    input: z.object({ label: z.string().max(80), result: Json }),
    output: z.object({ saved: z.string() }),
  },
  relayTicket: { input: z.null(), output: z.object({ ticket: z.string() }) },
  reports: { input: z.null(), output: z.object({ reports: z.array(Json), calls: z.array(Json) }) },
});

const REPORTS_KEY = "reports";
const MAX_REPORT_CHARS = 120_000;

export default async function plugin(bb: BbPluginApi) {
  const tickets = createTickets();
  const calls = createCalls({ log: bb.log, publish: (channel, payload) => bb.realtime.publish(channel, payload) });
  bb.onDispose(() => calls.dispose());

  bb.rpc.register(rpcContract, {
    async startCall(input, ctx) {
      const credential = await subscriptionToken(bb, ctx?.experimental_signal);
      const { log, answerSdp } = await calls.start({ ...input, token: credential.token, credential: credential.source });
      return { accepted: answerSdp !== undefined, answerSdp, log };
    },
    async announce({ callId, text }) {
      return { sent: calls.announce(callId, text) };
    },
    async note({ callId, type, info }) {
      calls.note(callId, type, info);
      return null;
    },
    async endCall({ callId, reason }) {
      return { log: await calls.end(callId, reason) };
    },
    async call({ callId }) {
      return { log: calls.get(callId) };
    },
    async report({ label, result }) {
      const text = JSON.stringify(result);
      if (text.length > MAX_REPORT_CHARS) throw new Error(`Report too large (${text.length} characters).`);
      const saved = new Date().toISOString();
      const reports = ((await bb.storage.kv.get<unknown[]>(REPORTS_KEY)) ?? []).slice(-19);
      reports.push({ saved, label, result });
      await bb.storage.kv.set(REPORTS_KEY, reports);
      bb.log.info(`Saved spike report "${label}" at ${saved}.`);
      return { saved };
    },
    async relayTicket() {
      return { ticket: tickets.issue() };
    },
    async reports() {
      return { reports: (await bb.storage.kv.get<unknown[]>(REPORTS_KEY)) ?? [], calls: calls.recent() };
    },
  });

  bb.http.experimental_websocket(RELAY_ROUTE, relayHandler({ token: (signal) => subscriptionToken(bb, signal), tickets, log: bb.log }), { auth: "none" });

  bb.log.info(`firstmate-voice spike loaded; sideband events on "${CALL_EVENTS_CHANNEL}".`);
}
