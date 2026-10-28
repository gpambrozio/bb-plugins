// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBrowserClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
}

describe("copyText", () => {
  it("copies through bb's writer and leaves the browser's clipboard alone", async () => {
    const browser = vi.fn(async () => {});
    stubBrowserClipboard(browser);
    const copy = vi.fn(async () => true);
    expect(await copyText("/skills/deploy/SKILL.md", copy)).toBe(true);
    expect(copy).toHaveBeenCalledWith({ text: "/skills/deploy/SKILL.md" });
    expect(browser).not.toHaveBeenCalled();
  });

  it("reports a write bb refused", async () => {
    const browser = vi.fn(async () => {});
    stubBrowserClipboard(browser);
    expect(await copyText("/p", async () => false)).toBe(false);
    expect(browser).not.toHaveBeenCalled();
  });

  // bb 0.45 has no experimental_copyToClipboard; the SDK's shim throws.
  it("falls back to the browser's clipboard where bb has no writer", async () => {
    const browser = vi.fn(async () => {});
    stubBrowserClipboard(browser);
    const missing = () => {
      throw new Error("@get-bb/plugin-sdk/app: experimental_copyToClipboard needs the bb app's plugin runtime.");
    };
    expect(await copyText("/p", missing)).toBe(true);
    expect(browser).toHaveBeenCalledWith("/p");
  });

  it("reports a fallback the browser refused, without rejecting", async () => {
    stubBrowserClipboard(async () => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    expect(await copyText("/p", async () => Promise.reject(new Error("missing")))).toBe(false);
  });

  it("reports a browser with no clipboard at all", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyText("/p", async () => Promise.reject(new Error("missing")))).toBe(false);
  });
});
