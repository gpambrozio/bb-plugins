import { describe, expect, it } from "vitest";

import type { VoiceState } from "./controller";
import { pageNote } from "./page";

const idle: VoiceState = { phase: "idle", muted: false, speaking: { user: false, voice: false }, note: null, opened: null };

describe("the Voice page", () => {
  it("says what Talk does, why the last session ended, and what to ask while live", () => {
    expect(pageNote(idle)).toMatch(/says hi, names the running threads, then listens/u);
    expect(pageNote({ ...idle, note: "Voice ended: quiet for ten minutes." })).toBe("Voice ended: quiet for ten minutes.");
    expect(pageNote({ ...idle, phase: "connecting" })).toBe("Connecting to OpenAI…");
    expect(pageNote({ ...idle, phase: "live" })).toMatch(/what waits on you/u);
    expect(pageNote({ ...idle, phase: "live", muted: true })).toBe("Your microphone is muted. Tap Unmute to talk again.");
    expect(pageNote({ ...idle, phase: "paused" })).toMatch(/picks up where you left off/u);
    expect(pageNote({ ...idle, phase: "resuming" })).toBe("Picking the session up again…");
  });
});
