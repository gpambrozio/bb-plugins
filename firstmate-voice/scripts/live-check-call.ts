// Phase 0: which Realtime paths does the ChatGPT subscription token open?
// In the style of codex-realtime's live check: a manual run against OpenAI,
// not part of `npm test`, that never prints the token or any part of it.
//
//   npm run live-check-call                                    # offer from about:blank
//   npm run live-check-call -- --only effort                  # one check: secrets|effort|calls|secret-call
//
// Four checks, each recorded as accepted or refused with the HTTP status and
// the redacted error body:
//  1. POST /v1/realtime/client_secrets (and, when it gives a secret, the
//     browser path: that ek_ posting an SDP offer to /v1/realtime/calls);
//  2. reasoning.effort: one ?model= socket, one session.update per value;
//  3. POST /v1/realtime/calls with a real SDP offer made in a headless
//     Chromium page (--page loads the dev bb's spike page first), the peer
//     connected with the answer;
//  4. the sideband: wss://…/v1/realtime?call_id= on that call, with a
//     session.update; then the call is hung up.
// The token is read the way codex-realtime reads it (read-only, never
// refreshed). Every call is short: no audio is sent to the model, no response
// is asked for, and each WebRTC call is hung up within seconds.
import { parseArgs } from "node:util";

import { chromium, type Page } from "playwright-core";

import { codexAuthPath, readCodexLogin } from "../../codex-realtime/server/codex-login.ts";
import { DEFAULT_MODEL, REASONING_EFFORTS, createCall, hangup, redact } from "../server/openai-call.ts";
import { callSession, createCallWithSecret, createClientSecret, probeEfforts, probeSideband } from "./probes.ts";
import { headlessChromium } from "./chromium.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_MODEL },
    page: { type: "string" },
    only: { type: "string", multiple: true },
  },
});
const model = values.model;
const wanted = (name: string) => !values.only || values.only.includes(name);

const login = await readCodexLogin(codexAuthPath());
const token = login.accessToken;
const results: Record<string, unknown> = {
  ranAt: new Date().toISOString(),
  model,
  credential: `ChatGPT subscription (Codex login, valid until ${new Date(login.expiresAt).toISOString()})`,
  offerFrom: values.page ?? "about:blank",
};

/** An offer with one audio track (an oscillator, so no microphone is needed) and the oai-events channel. */
async function makeOffer(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    const pc = new RTCPeerConnection();
    for (const track of destination.stream.getAudioTracks()) pc.addTrack(track, destination.stream);
    pc.createDataChannel("oai-events");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    (window as unknown as { spikePc: RTCPeerConnection }).spikePc = pc;
    return offer.sdp ?? "";
  });
}

async function answer(page: Page, sdp: string): Promise<{ state: string; ms: number }> {
  return page.evaluate(async (answerSdp) => {
    const pc = (window as unknown as { spikePc: RTCPeerConnection }).spikePc;
    const started = performance.now();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    while (pc.connectionState !== "connected" && pc.connectionState !== "failed" && performance.now() - started < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { state: pc.connectionState, ms: Math.round(performance.now() - started) };
  }, sdp);
}

async function closePeer(page: Page) {
  await page.evaluate(() => (window as unknown as { spikePc?: RTCPeerConnection }).spikePc?.close());
}

let secret: string | undefined;
if (wanted("secrets")) {
  results.clientSecrets = await createClientSecret({
    token,
    seconds: 60,
    session: { type: "realtime", model, reasoning: { effort: "low" }, audio: { output: { voice: "marin" } } },
    keep: (value) => {
      secret = value;
    },
  });
}

if (wanted("effort")) {
  results.reasoningEffort = await probeEfforts(token, model, [...REASONING_EFFORTS, "bogus"]);
}

if (wanted("calls") || (wanted("secret-call") && secret)) {
  const browser = await chromium.launch({ executablePath: headlessChromium(), args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    if (values.page) await page.goto(values.page, { waitUntil: "domcontentloaded" });

    if (wanted("calls")) {
      const offer = await makeOffer(page);
      const call = await createCall({ token, sdp: offer, session: callSession({ model, effort: "low" }) });
      const { answerSdp, ...summary } = call;
      results.calls = { ...summary, answerSdpBytes: answerSdp?.length };
      if (call.accepted && answerSdp && call.callId) {
        results.peer = await answer(page, answerSdp);
        results.sideband = await probeSideband(token, call.callId, {
          type: "realtime",
          instructions: "Sideband check: this instruction was set from the server.",
        });
        results.hangup = await hangup(token, call.callId);
      }
      await closePeer(page);
    }

    if (wanted("secret-call") && secret) {
      const offer = await makeOffer(page);
      const call = await createCallWithSecret(secret, offer);
      const { answerSdp, ...summary } = call;
      results.secretCall = { ...summary, answerSdpBytes: answerSdp?.length };
      if (call.accepted && answerSdp && call.callId) {
        results.secretCallPeer = await answer(page, answerSdp);
        results.secretCallHangup = await hangup(token, call.callId);
      }
      await closePeer(page);
    }
  } finally {
    await browser.close();
  }
}
secret = undefined;

// Belt and braces: nothing printed may hold the token.
console.log(redact(JSON.stringify(results, null, 2), token));
