import { describe, expect, it } from "vitest";

import { GlobalMute, type SpeakSwitch } from "./mute";

/** The master switch in memory, counting writes; `delayMs` makes each write slow. */
function speakSwitch(on = true, delayMs = 0): SpeakSwitch & { on: boolean; writes: boolean[] } {
  const state = {
    on,
    writes: [] as boolean[],
    get: async () => state.on,
    set: async (next: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.writes.push(next);
      state.on = next;
    },
  };
  return state;
}

describe("GlobalMute", () => {
  it("is the master switch read the other way round", async () => {
    expect(await new GlobalMute(speakSwitch(true)).muted()).toBe(false);
    expect(await new GlobalMute(speakSwitch(false)).muted()).toBe(true);
  });

  it("mutes by switching speech off, and unmutes by switching it on", async () => {
    const speak = speakSwitch(true);
    const mute = new GlobalMute(speak);
    expect(await mute.set(true)).toEqual({ muted: true, changed: true });
    expect(speak.on).toBe(false);
    expect(await mute.set(false)).toEqual({ muted: false, changed: true });
    expect(speak.on).toBe(true);
  });

  it("writes nothing for a repeat", async () => {
    const speak = speakSwitch(true);
    const mute = new GlobalMute(speak);
    await mute.set(true);
    expect(await mute.set(true)).toEqual({ muted: true, changed: false });
    expect(await mute.set(true)).toEqual({ muted: true, changed: false });
    expect(speak.writes).toEqual([false]);
    expect(await new GlobalMute(speakSwitch(true)).set(false)).toEqual({ muted: false, changed: false });
  });

  it("runs requests in the order they came, so a quick mute and unmute ends unmuted", async () => {
    const speak = speakSwitch(true, 5);
    const mute = new GlobalMute(speak);
    const results = await Promise.all([mute.set(true), mute.set(false), mute.set(true), mute.set(false)]);
    expect(results.map((result) => result.muted)).toEqual([true, false, true, false]);
    expect(speak.writes).toEqual([false, true, false, true]);
    expect(speak.on).toBe(true);
  });

  it("goes on after a failed write", async () => {
    const speak = speakSwitch(true);
    let fail = true;
    const mute = new GlobalMute({
      get: speak.get,
      set: async (next) => {
        if (fail) {
          fail = false;
          throw new Error("settings are away");
        }
        await speak.set(next);
      },
    });
    await expect(mute.set(true)).rejects.toThrow("settings are away");
    expect(await mute.set(true)).toEqual({ muted: true, changed: true });
  });
});
