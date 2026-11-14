import { describe, expect, it } from "vitest";

import { fromPcm16Base64, toPcm16Base64 } from "../app/relay";
import { TurnMeter } from "../app/meter";
import { redact } from "./openai";
import { createTickets } from "./relay";

describe("redact", () => {
  it("removes the token, bearer headers, JWTs and ek_ secrets", () => {
    const token = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2lnbmF0dXJl";
    const text = `Bearer ${token} then ${token} and ek_abc123DEF and eyJabcdefghijkl.eyJmno.pqr`;
    const out = redact(text, token);
    expect(out).not.toContain(token);
    expect(out).not.toContain("ek_abc123DEF");
    expect(out).not.toContain("eyJabcdefghijkl");
  });
});

describe("relay tickets", () => {
  it("admits a ticket once, within its minute", () => {
    let now = 0;
    const tickets = createTickets(() => now);
    const ticket = tickets.issue();
    expect(tickets.redeem(ticket)).toBe(true);
    expect(tickets.redeem(ticket)).toBe(false);
    const late = tickets.issue();
    now = 61_000;
    expect(tickets.redeem(late)).toBe(false);
    expect(tickets.redeem(null)).toBe(false);
  });
});

describe("PCM16 at 24 kHz", () => {
  it("round-trips a block that is already at 24 kHz", () => {
    const input = new Float32Array([0, 0.5, -0.5, 0.25]);
    const back = fromPcm16Base64(toPcm16Base64(input, 24_000));
    expect([...back].map((value) => Math.round(value * 100) / 100)).toEqual([0, 0.5, -0.5, 0.25]);
  });

  it("halves a 48 kHz block", () => {
    expect(fromPcm16Base64(toPcm16Base64(new Float32Array(4096), 48_000))).toHaveLength(2048);
  });
});

describe("TurnMeter", () => {
  function meter() {
    let t = 0;
    const turnMeter = new TurnMeter({} as AnalyserNode, {} as AnalyserNode, () => t);
    const step = (local: number, remote: number, ms = 20) => {
      t += ms;
      turnMeter.sample(local, remote);
    };
    return { turnMeter, step };
  }

  it("measures last speech to the first reply sound", () => {
    const { turnMeter, step } = meter();
    for (let i = 0; i < 50; i += 1) step(0.2, 0); // 1 s of speech, ends at 1000 ms
    for (let i = 0; i < 75; i += 1) step(0, 0); // 1.5 s of quiet
    step(0, 0.1); // reply at 2520 ms
    expect(turnMeter.turns).toEqual([{ speechEndAt: 1000, replyOnsetAt: 2520, latencyMs: 1520 }]);
  });

  it("does not count an echo of the reply as speech", () => {
    const { turnMeter, step } = meter();
    for (let i = 0; i < 30; i += 1) step(0, 0);
    for (let i = 0; i < 20; i += 1) step(0.3, 0.1); // reply with its echo on the microphone
    for (let i = 0; i < 30; i += 1) step(0, 0);
    step(0, 0.1);
    expect(turnMeter.turns).toEqual([]);
    expect(turnMeter.onsets.map((onset) => onset.afterSpeech)).toEqual([false, false]);
  });
});
