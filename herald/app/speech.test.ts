// @vitest-environment jsdom
/**
 * The WebKit unlocking rule: a press primes the one reused `<audio>` element
 * before its first await, and a refused automatic playback — which sets the
 * element's `src` too — must not stop the next press from priming it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isAudioUnlocked, playAudio, primeSpeech, resetAudioForTests } from "./speech";

const SILENT = /^data:audio\/wav;base64,UklGR/;

afterEach(() => {
  vi.restoreAllMocks();
  resetAudioForTests();
});

describe("audio unlocking", () => {
  it("primes again on the next press after an automatic playback was refused", async () => {
    const sources: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      sources.push(this.src);
      return sources.length === 1 ? Promise.reject(new DOMException("not allowed", "NotAllowedError")) : Promise.resolve();
    });
    await expect(playAudio("data:audio/wav;base64,QUJD")).rejects.toThrow();
    expect(isAudioUnlocked()).toBe(false);

    primeSpeech();
    expect(sources).toHaveLength(2);
    expect(sources[1]).toMatch(SILENT);
    await Promise.resolve();
    expect(isAudioUnlocked()).toBe(true);
  });

  it("does not prime over a page that is already unlocked", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    primeSpeech();
    await Promise.resolve();
    primeSpeech();
    expect(play).toHaveBeenCalledTimes(1);
  });
});
