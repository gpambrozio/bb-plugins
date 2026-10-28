// @vitest-environment jsdom
/** bb 0.47's build of the app has no `experimental_useTabVisible`: the tab then counts as shown. */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("useTabVisible", () => {
  it("is bb's answer where bb has the hook", async () => {
    vi.resetModules();
    vi.doMock("@get-bb/plugin-sdk/app", () => ({ experimental_useTabVisible: () => false }));
    const { useTabVisible } = await import("./tab-visible");
    expect(renderHook(() => useTabVisible()).result.current).toBe(false);
    vi.doUnmock("@get-bb/plugin-sdk/app");
  });

  it("is true where bb has none", async () => {
    vi.resetModules();
    vi.doMock("@get-bb/plugin-sdk/app", () => ({ experimental_useTabVisible: undefined }));
    const { useTabVisible } = await import("./tab-visible");
    expect(renderHook(() => useTabVisible()).result.current).toBe(true);
    vi.doUnmock("@get-bb/plugin-sdk/app");
  });
});
